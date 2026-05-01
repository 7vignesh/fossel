#!/usr/bin/env node

import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { nanoid } from "nanoid";
import { closeDb, getDb, initDb } from "./db/client.js";

const DEFAULT_DB_PATH = join(homedir(), ".fossel", "memory.db");
const INIT_MEMORY_TEXT =
  "Fossel is active for this repo. Use store_context to save context.";

function resolveDbPath(): string {
  return process.env.FOSSEL_DB_PATH?.trim() || DEFAULT_DB_PATH;
}

function detectRepoFromRemote(cwd: string): string | null {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return null;
  }

  const remote = result.stdout.trim();
  if (!remote) {
    return null;
  }

  const normalized = remote.replace(/\\/g, "/").replace(/\/+$/, "");
  const lastSegment = normalized.split("/").at(-1);
  if (!lastSegment) {
    return null;
  }

  return lastSegment.replace(/\.git$/i, "");
}

function detectRepoName(cwd: string): string {
  return detectRepoFromRemote(cwd) ?? basename(cwd);
}

function ensureSampleMemory(repo: string): void {
  const db = getDb();
  const existing = db
    .prepare(
      `
        SELECT rowid AS row_id
        FROM memories
        WHERE repo = ? AND type = 'convention' AND note = ?
        LIMIT 1
      `,
    )
    .get(repo, INIT_MEMORY_TEXT) as { row_id: number } | undefined;

  if (existing) {
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `
      INSERT INTO memories (id, repo, type, note, tags, created_at, updated_at, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(nanoid(), repo, "convention", INIT_MEMORY_TEXT, "[]", now, now, 0);
}

function formatCursorConfig(): string {
  return JSON.stringify(
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
}

function formatClaudeDesktopConfig(): string {
  return JSON.stringify(
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
}

function printInitOutput(repo: string, dbPath: string): void {
  const db = getDb();
  const countRow = db
    .prepare("SELECT COUNT(*) AS count FROM memories")
    .get() as { count: number };

  console.log("Fossel remembers project context locally for each repository.");
  console.log("Store conventions, fixes, and decisions once; retrieve them when needed.");
  console.log("Everything stays in your local SQLite database.\n");

  console.log(`Detected repository: ${repo}\n`);

  console.log("Cursor MCP config (~/.cursor/mcp.json):");
  console.log(formatCursorConfig());
  console.log("");

  console.log("Claude Desktop MCP config:");
  console.log(formatClaudeDesktopConfig());
  console.log("");

  console.log(`DB Path: ${dbPath}`);
  console.log(`Total memories: ${countRow.count}`);
  console.log("");

  console.log("Quick commands");
  console.log("Command                  Description");
  console.log("-----------------------  --------------------------------------------");
  console.log("npx -y fossel            Start Fossel MCP server over stdio");
  console.log("npx -y fossel init       Initialize Fossel for current repository");
  console.log("store_context            Save context memory");
  console.log("get_repo_context         Retrieve recent repo memories");
  console.log("summarize_repo_context   Generate markdown context summary");
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command) {
    const { startServer } = await import("./index.js");
    await startServer();
    return;
  }

  if (command === "init") {
    const dbPath = resolveDbPath();
    initDb(dbPath);

    const repo = detectRepoName(process.cwd());
    ensureSampleMemory(repo);
    printInitOutput(repo, dbPath);
    closeDb();
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Usage: fossel [init]");
  process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fossel command failed: ${message}`);
  process.exit(1);
});
