import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/db/migrate.js";

export interface TestDb {
  db: Database.Database;
  dir: string;
  path: string;
  cleanup: () => void;
}

/**
 * Spin up an isolated SQLite database with all migrations applied. Each test
 * gets its own temp directory so parallel runs cannot collide.
 */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "fossel-test-"));
  const path = join(dir, "memory.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  return {
    db,
    dir,
    path,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface InsertOptions {
  pinned?: boolean;
  tags?: string[];
  type?:
    | "convention"
    | "bug_fix"
    | "reviewer_pattern"
    | "decision"
    | "issue"
    | "general";
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Direct insert helper that bypasses the MCP layer. Tests use it to seed
 * deterministic state before exercising library-level code paths.
 */
export function insertMemory(
  db: Database.Database,
  repo: string,
  note: string,
  options: InsertOptions = {},
): number {
  const now = options.updatedAt ?? Math.floor(Date.now() / 1000);
  const stmt = db.prepare(
    `
      INSERT INTO memories (id, repo, type, note, tags, created_at, updated_at, pinned, metadata_json, note_normalized)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const id = `t-${Math.random().toString(36).slice(2, 10)}`;
  const result = stmt.run(
    id,
    repo,
    options.type ?? "general",
    note,
    JSON.stringify(options.tags ?? []),
    now,
    now,
    options.pinned ? 1 : 0,
    JSON.stringify(options.metadata ?? {}),
    note.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(),
  );
  return Number(result.lastInsertRowid);
}
