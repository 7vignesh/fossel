#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import { nanoid } from "nanoid";
import { closeDb, getDb, initDb } from "./db/client.js";
import { normalizeText } from "./lib/dedupe.js";
import {
  findMemoriesMentioningAlias,
  mergeRepoKeys,
  resolveRepo,
} from "./lib/repo.js";

const DEFAULT_DB_PATH = join(homedir(), ".fossel", "memory.db");
// New starter memory: points users at the ambient tools (`remember`,
// `get_context`) instead of the lower-level ones so the seed text matches the
// rest of the docs.
const INIT_MEMORY_TEXT =
  "Fossel is active for this repo. Say 'remember this' or call get_context to retrieve repo memories.";

function resolveDbPath(): string {
  return process.env.FOSSEL_DB_PATH?.trim() || DEFAULT_DB_PATH;
}

function ensureSampleMemoryIfEmpty(repo: string): boolean {
  const db = getDb();
  const totalRow = db
    .prepare("SELECT COUNT(*) AS count FROM memories")
    .get() as { count: number };

  if (totalRow.count > 0) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `
      INSERT INTO memories (id, repo, type, note, tags, created_at, updated_at, pinned, metadata_json, note_normalized)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, '{}', ?)
    `,
  ).run(
    nanoid(),
    repo,
    "convention",
    INIT_MEMORY_TEXT,
    "[]",
    now,
    now,
    normalizeText(INIT_MEMORY_TEXT),
  );
  return true;
}

const MCP_CONFIG_SNIPPET = JSON.stringify(
  {
    mcpServers: {
      fossel: {
        command: "npx",
        args: ["-y", "fossel"],
        // FOSSEL_WORKSPACE pins the workspace root so the server detects the
        // right repo even when the IDE launches MCP servers from another cwd.
        env: {
          FOSSEL_WORKSPACE: "${workspaceFolder}",
        },
      },
    },
  },
  null,
  2,
);

interface SiblingRepo {
  repo: string;
  count: number;
}

/**
 * Find existing repo keys that look like they refer to the same repository as
 * `canonical` so we can offer to merge them. Match on the trailing path
 * segment (e.g. canonical "7vignesh/fossel" matches legacy "fossel").
 */
function findMergeCandidates(canonical: string): SiblingRepo[] {
  const db = getDb();
  const tail = canonical.split("/").at(-1) ?? canonical;

  const rows = db
    .prepare(
      `
        SELECT repo, COUNT(*) AS count
        FROM memories
        WHERE repo != ?
        GROUP BY repo
      `,
    )
    .all(canonical) as Array<{ repo: string; count: number }>;

  return rows.filter((row) => {
    if (!row.repo) return false;
    const otherTail = row.repo.split("/").at(-1) ?? row.repo;
    return otherTail === tail || otherTail === canonical || row.repo === tail;
  });
}

/**
 * Collapse exact-text duplicate memories under `repo`. Returns the number of
 * rows removed. Runs inside a single transaction so an interruption can't
 * leave the DB half-merged.
 *
 * "Exact" here means same `note_normalized` and same `memory_type`. Near
 * duplicates remain available via `dedupe_repo` with a similarity threshold.
 */
function autoDedupeExact(repo: string): number {
  const db = getDb();
  const groups = db
    .prepare(
      `
        SELECT note_normalized, type, COUNT(*) AS count
        FROM memories
        WHERE repo = ? AND note_normalized != ''
        GROUP BY note_normalized, type
        HAVING COUNT(*) > 1
      `,
    )
    .all(repo) as Array<{ note_normalized: string; type: string; count: number }>;

  if (groups.length === 0) {
    return 0;
  }

  let removed = 0;
  const tx = db.transaction(() => {
    for (const group of groups) {
      const rows = db
        .prepare(
          `
            SELECT rowid AS row_id, pinned, updated_at
            FROM memories
            WHERE repo = ? AND note_normalized = ? AND type = ?
            ORDER BY pinned DESC, updated_at DESC, rowid DESC
          `,
        )
        .all(repo, group.note_normalized, group.type) as Array<{
        row_id: number;
        pinned: number;
        updated_at: number;
      }>;

      // Keep the first row (pinned wins, then most recent), drop the rest.
      const [keep, ...rest] = rows;
      if (!keep) continue;

      const drop = db.prepare("DELETE FROM memories WHERE rowid = ?");
      for (const row of rest) {
        drop.run(row.row_id);
        removed += 1;
      }
    }
  });
  tx();
  return removed;
}

function runInit(options: { autoDedupe: boolean }): void {
  const dbPath = resolveDbPath();
  initDb(dbPath);
  const db = getDb();

  // CLI is always invoked from the user's project root. The MCP server uses
  // FOSSEL_WORKSPACE for the same purpose; the CLI doesn't need it.
  const resolved = resolveRepo(process.cwd(), db);
  const candidates = findMergeCandidates(resolved.canonical);

  let mergedAliases = 0;
  let mergedMemories = 0;
  let rewrittenNotes = 0;
  for (const candidate of candidates) {
    const result = mergeRepoKeys(db, candidate.repo, resolved.canonical);
    mergedAliases += result.movedAliases;
    mergedMemories += result.movedMemories;
    rewrittenNotes += result.rewrittenNotes;
  }

  const sampleAdded = ensureSampleMemoryIfEmpty(resolved.canonical);

  let autoMerged = 0;
  if (options.autoDedupe) {
    autoMerged = autoDedupeExact(resolved.canonical);
  }

  const countRow = db
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE repo = ?")
    .get(resolved.canonical) as { count: number };

  console.log("Fossel — local-first MCP memory for your repos.\n");
  console.log(`Canonical repo key: ${resolved.canonical}`);
  console.log(`  source: ${resolved.source}`);
  if (resolved.gitRemote) {
    console.log(`  git remote: ${resolved.gitRemote}`);
  }
  if (resolved.aliases.length > 0) {
    console.log(`  aliases: ${resolved.aliases.join(", ")}`);
  }
  console.log("");

  if (mergedAliases > 0 || mergedMemories > 0 || rewrittenNotes > 0) {
    console.log(
      `Merged ${mergedMemories} memory row(s), ${mergedAliases} alias row(s), and rewrote ${rewrittenNotes} stale mention(s) into ${resolved.canonical}.`,
    );
    console.log("");
  }

  if (autoMerged > 0) {
    console.log(`Auto-deduped ${autoMerged} exact duplicate row(s).`);
    console.log("");
  }

  console.log("MCP config (Cursor: ~/.cursor/mcp.json, Claude Desktop: settings):");
  console.log(MCP_CONFIG_SNIPPET);
  console.log("");

  console.log(`DB path: ${dbPath}`);
  console.log(`Memories for ${resolved.canonical}: ${countRow.count}`);
  if (sampleAdded) {
    console.log("Inserted one starter memory because the database was empty.");
  }
  console.log("");

  console.log("Quick usage in chat:");
  console.log("  remember           — natural-language save (no type/tags needed)");
  console.log("  get_context        — pinned + recent + matching memories");
  console.log("  resolve_repo       — show which repo key Fossel will use");
  console.log("  store_context      — explicit save (advanced)");
  console.log("  dedupe_repo        — merge near-duplicate memories");
  console.log("");
  console.log("Set FOSSEL_WORKSPACE in your MCP config to your project root if Fossel detects the wrong repo.");

  closeDb();
}

interface DoctorReport {
  ok: boolean;
  lines: string[];
  duplicateClusters: number;
  staleMentions: Array<{ alias: string; row_id: number; note: string }>;
}

function gatherDoctorReport(): DoctorReport {
  const dbPath = resolveDbPath();
  const lines: string[] = [];
  let ok = true;

  initDb(dbPath);
  const db = getDb();

  lines.push(`DB path: ${dbPath}`);

  const resolved = resolveRepo(process.cwd(), db);
  lines.push(`Canonical repo key: ${resolved.canonical} (source: ${resolved.source})`);
  if (resolved.gitRemote) {
    lines.push(`Git remote: ${resolved.gitRemote}`);
  } else {
    lines.push("Git remote: not detected (using folder name).");
  }
  if (resolved.aliases.length > 0) {
    lines.push(`Aliases: ${resolved.aliases.join(", ")}`);
  }

  // Repo key sprawl: any sibling keys mapping to a non-canonical form?
  const siblings = findMergeCandidates(resolved.canonical);
  if (siblings.length > 0) {
    ok = false;
    const summary = siblings.map((row) => `${row.repo} (${row.count})`).join(", ");
    lines.push(`⚠ Sibling repo keys detected: ${summary}. Run \`npx fossel init\` to merge.`);
  } else {
    lines.push("No sibling repo keys.");
  }

  // Memories whose text still mentions any deprecated alias for this repo.
  const staleMentions: DoctorReport["staleMentions"] = [];
  for (const alias of resolved.aliases) {
    if (alias === resolved.canonical) continue;
    const found = findMemoriesMentioningAlias(db, alias, resolved.canonical);
    for (const row of found) {
      staleMentions.push({ alias, row_id: row.row_id, note: row.note });
    }
  }
  if (staleMentions.length > 0) {
    ok = false;
    lines.push(
      `⚠ ${staleMentions.length} memory note(s) still mention a deprecated repo key. Run \`fossel doctor --fix\` to rewrite them.`,
    );
  } else {
    lines.push("No memory notes reference deprecated repo keys.");
  }

  // Duplicate memories under the canonical repo (cheap exact-text count).
  const duplicateRows = db
    .prepare(
      `
        SELECT note_normalized, COUNT(*) AS count
        FROM memories
        WHERE repo = ? AND note_normalized != ''
        GROUP BY note_normalized
        HAVING COUNT(*) > 1
      `,
    )
    .all(resolved.canonical) as Array<{ note_normalized: string; count: number }>;
  if (duplicateRows.length > 0) {
    ok = false;
    const total = duplicateRows.reduce((sum, row) => sum + row.count - 1, 0);
    lines.push(
      `⚠ ${duplicateRows.length} duplicate clusters covering ${total} extra row(s). Run \`fossel doctor --fix\` (or \`dedupe_repo\` with apply=true) to merge.`,
    );
  } else {
    lines.push("No exact-duplicate memory clusters.");
  }

  // MCP config: presence check (read-only).
  const mcpConfigCandidates = [
    join(homedir(), ".cursor", "mcp.json"),
    join(
      homedir(),
      "AppData",
      "Roaming",
      "Claude",
      "claude_desktop_config.json",
    ),
    join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    ),
  ];
  const found = mcpConfigCandidates.filter((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
  if (found.length === 0) {
    lines.push(
      "⚠ Could not find Cursor or Claude Desktop MCP config. Run `npx fossel init` and paste the snippet.",
    );
  } else {
    lines.push(`Detected MCP config(s): ${found.join(", ")}`);
  }

  const totalRow = db
    .prepare("SELECT COUNT(*) AS count FROM memories")
    .get() as { count: number };
  lines.push(`Total memories across all repos: ${totalRow.count}`);

  return { ok, lines, duplicateClusters: duplicateRows.length, staleMentions };
}

function runDoctor(options: { fix: boolean }): void {
  const report = gatherDoctorReport();
  console.log(report.lines.join("\n"));
  console.log("");

  if (!options.fix) {
    console.log(report.ok ? "Status: OK" : "Status: needs attention (see ⚠ lines above)");
    if (!report.ok) {
      process.exitCode = 1;
    }
    closeDb();
    return;
  }

  // Apply fixes.
  const db = getDb();
  const resolved = resolveRepo(process.cwd(), db);

  // 1. Merge any sibling repo keys (this also rewrites stale mentions).
  const candidates = findMergeCandidates(resolved.canonical);
  let movedMemories = 0;
  let rewrittenNotes = 0;
  for (const candidate of candidates) {
    const result = mergeRepoKeys(db, candidate.repo, resolved.canonical);
    movedMemories += result.movedMemories;
    rewrittenNotes += result.rewrittenNotes;
  }

  // 2. Auto-dedupe exact duplicates.
  const removed = autoDedupeExact(resolved.canonical);

  console.log("Applied fixes:");
  console.log(`  merged repo memory rows:  ${movedMemories}`);
  console.log(`  rewrote stale mentions:   ${rewrittenNotes}`);
  console.log(`  removed exact duplicates: ${removed}`);
  console.log("");
  console.log("Re-run `fossel doctor` to verify.");
  closeDb();
}

function parseFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command) {
    const { startServer } = await import("./index.js");
    await startServer();
    return;
  }

  if (command === "init") {
    const args = process.argv.slice(3);
    // init auto-dedupes exact duplicates by default; pass --no-dedupe to skip.
    const autoDedupe = !parseFlag(args, "no-dedupe");
    runInit({ autoDedupe });
    return;
  }

  if (command === "doctor") {
    const args = process.argv.slice(3);
    runDoctor({ fix: parseFlag(args, "fix") });
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Usage: fossel [init [--no-dedupe] | doctor [--fix]]");
  process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fossel command failed: ${message}`);
  process.exit(1);
});

export { runDoctor, runInit };
