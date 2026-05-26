#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import { nanoid } from "nanoid";
import { closeDb, getDb, initDb } from "./db/client.js";
import { mergeRepoKeys, resolveRepo } from "./lib/repo.js";

const DEFAULT_DB_PATH = join(homedir(), ".fossel", "memory.db");
const INIT_MEMORY_TEXT =
  "Fossel is active for this repo. Use store_context to save context.";

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
    INIT_MEMORY_TEXT.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(),
  );
  return true;
}

const MCP_CONFIG_SNIPPET = JSON.stringify(
  {
    mcpServers: {
      fossel: {
        command: "npx",
        args: ["-y", "fossel"],
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

function runInit(): void {
  const dbPath = resolveDbPath();
  initDb(dbPath);
  const db = getDb();

  const resolved = resolveRepo(process.cwd(), db);
  const candidates = findMergeCandidates(resolved.canonical);

  let mergedAliases = 0;
  let mergedMemories = 0;
  for (const candidate of candidates) {
    const result = mergeRepoKeys(db, candidate.repo, resolved.canonical);
    mergedAliases += result.movedAliases;
    mergedMemories += result.movedMemories;
  }

  const sampleAdded = ensureSampleMemoryIfEmpty(resolved.canonical);

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

  if (mergedAliases > 0 || mergedMemories > 0) {
    console.log(
      `Merged ${mergedMemories} memory row(s) and ${mergedAliases} alias row(s) into ${resolved.canonical}.`,
    );
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

  closeDb();
}

interface DoctorReport {
  ok: boolean;
  lines: string[];
}

function runDoctor(): void {
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
    const summary = siblings
      .map((row) => `${row.repo} (${row.count})`)
      .join(", ");
    lines.push(`⚠ Sibling repo keys detected: ${summary}. Run \`npx fossel init\` to merge.`);
  } else {
    lines.push("No sibling repo keys.");
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
      `⚠ ${duplicateRows.length} duplicate clusters covering ${total} extra row(s). Run \`dedupe_repo\` with apply=true.`,
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
    join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  ];
  // Detect a present MCP config so doctor can warn when neither client is wired up.
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

  closeDb();

  console.log(lines.join("\n"));
  console.log("");
  console.log(ok ? "Status: OK" : "Status: needs attention (see ⚠ lines above)");

  if (!ok) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command) {
    const { startServer } = await import("./index.js");
    await startServer();
    return;
  }

  if (command === "init") {
    runInit();
    return;
  }

  if (command === "doctor") {
    runDoctor();
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Usage: fossel [init | doctor]");
  process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fossel command failed: ${message}`);
  process.exit(1);
});

export { runDoctor, runInit };
