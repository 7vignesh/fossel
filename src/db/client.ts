import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const MEMORY_TYPES = [
  "convention",
  "bug_fix",
  "reviewer_pattern",
  "decision",
  "issue",
  "general",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryRecord {
  id: string;
  repo: string;
  type: MemoryType;
  note: string;
  tags: string;
  created_at: number;
  updated_at: number;
}

let dbInstance: Database.Database | null = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('convention', 'bug_fix', 'reviewer_pattern', 'decision', 'issue', 'general')),
  note TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_repo ON memories (repo);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  repo,
  note,
  content = 'memories',
  content_rowid = 'rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, repo, note) VALUES (new.rowid, new.repo, new.note);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, repo, note) VALUES ('delete', old.rowid, old.repo, old.note);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, repo, note) VALUES ('delete', old.rowid, old.repo, old.note);
  INSERT INTO memories_fts(rowid, repo, note) VALUES (new.rowid, new.repo, new.note);
END;
`;

export function initDb(dbPath: string): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  dbInstance = db;
  return db;
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error("Database has not been initialized. Call initDb() first.");
  }

  return dbInstance;
}
