import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "./migrate.js";

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
  row_id: number;
  id: string;
  repo: string;
  type: MemoryType;
  note: string;
  tags: string;
  created_at: number;
  updated_at: number;
  pinned: number;
}

let dbInstance: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  dbInstance = db;
  return db;
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error("Database has not been initialized. Call initDb() first.");
  }

  return dbInstance;
}

export function closeDb(): void {
  if (!dbInstance) {
    return;
  }

  dbInstance.close();
  dbInstance = null;
}
