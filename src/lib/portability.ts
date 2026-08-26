/**
 * Export / import.
 *
 * `export_memories` produces a versioned JSON envelope containing everything
 * Fossel knows — memories (live and superseded) and repo aliases. Embeddings
 * are deliberately NOT exported; they are re-derived on import so the file
 * stays small and model-agnostic.
 *
 * `import_memories` is additive and idempotent: `INSERT OR IGNORE` on the
 * source nanoid, so re-importing the same file is a no-op and never clobbers an
 * existing row. There is no "replace" mode; to wipe, delete the database file.
 * This is the strongest possible proof of the local-first "your data" promise.
 */

import type Database from "better-sqlite3";
import { normalizeText } from "./dedupe.js";
import { indexMemoryEmbedding } from "./vector-index.js";
import { recordFileRefs } from "./file-refs.js";

export const EXPORT_FORMAT = "fossel-export";
export const EXPORT_VERSION = 1;

export interface ExportedMemory {
  id: string;
  repo: string;
  type: string;
  note: string;
  tags: string[];
  created_at: number;
  updated_at: number;
  pinned: number;
  metadata_json: string;
  valid_from: number;
  valid_to: number | null;
}

export interface ExportedAlias {
  alias: string;
  canonical: string;
  created_at: number;
}

export interface ExportEnvelope {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exported_at: string;
  memories: ExportedMemory[];
  aliases: ExportedAlias[];
}

export function exportMemories(db: Database.Database, repo?: string): ExportEnvelope {
  const whereClause = repo ? "WHERE repo = ?" : "";
  const params = repo ? [repo] : [];

  const memories = db
    .prepare(
      `
        SELECT id, repo, type, note, tags, created_at, updated_at, pinned,
               metadata_json, valid_from, valid_to
        FROM memories
        ${whereClause}
        ORDER BY created_at ASC
      `,
    )
    .all(...params) as Array<{
    id: string;
    repo: string;
    type: string;
    note: string;
    tags: string;
    created_at: number;
    updated_at: number;
    pinned: number;
    metadata_json: string;
    valid_from: number;
    valid_to: number | null;
  }>;

  const aliases = db
    .prepare("SELECT alias, canonical, created_at FROM repo_aliases ORDER BY alias")
    .all() as ExportedAlias[];

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    memories: memories.map((row) => ({
      ...row,
      tags: JSON.parse(row.tags) as string[],
    })),
    aliases,
  };
}

export interface ImportResult {
  memoriesImported: number;
  memoriesSkipped: number;
  aliasesImported: number;
  aliasesSkipped: number;
}

export function importMemories(
  db: Database.Database,
  envelope: ExportEnvelope,
  cwd: string,
): ImportResult {
  if (envelope.format !== EXPORT_FORMAT) {
    throw new Error(
      `Unsupported format: "${envelope.format}". Expected "${EXPORT_FORMAT}".`,
    );
  }
  if (envelope.version > EXPORT_VERSION) {
    throw new Error(
      `Unsupported version: ${envelope.version}. This version of Fossel supports up to ${EXPORT_VERSION}.`,
    );
  }

  const result: ImportResult = {
    memoriesImported: 0,
    memoriesSkipped: 0,
    aliasesImported: 0,
    aliasesSkipped: 0,
  };

  const insertMemory = db.prepare(
    `
      INSERT OR IGNORE INTO memories
        (id, repo, type, note, tags, created_at, updated_at, pinned, metadata_json, note_normalized, valid_from, valid_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );

  const insertAlias = db.prepare(
    `
      INSERT OR IGNORE INTO repo_aliases (alias, canonical, created_at)
      VALUES (?, ?, ?)
    `,
  );

  const tx = db.transaction(() => {
    // Aliases first so repo resolution works for any memory that needs it.
    for (const alias of envelope.aliases) {
      const res = insertAlias.run(alias.alias, alias.canonical, alias.created_at);
      if (res.changes > 0) {
        result.aliasesImported += 1;
      } else {
        result.aliasesSkipped += 1;
      }
    }

    for (const memory of envelope.memories) {
      const res = insertMemory.run(
        memory.id,
        memory.repo,
        memory.type,
        memory.note,
        JSON.stringify(memory.tags),
        memory.created_at,
        memory.updated_at,
        memory.pinned,
        memory.metadata_json,
        normalizeText(memory.note),
        memory.valid_from,
        memory.valid_to,
      );
      if (res.changes > 0) {
        result.memoriesImported += 1;
        // Re-derive the embedding and file refs for the imported memory.
        const inserted = db
          .prepare("SELECT rowid AS row_id FROM memories WHERE id = ?")
          .get(memory.id) as { row_id: number } | undefined;
        if (inserted) {
          indexMemoryEmbedding(db, inserted.row_id, memory.note);
          recordFileRefs(db, inserted.row_id, memory.note, cwd);
        }
      } else {
        result.memoriesSkipped += 1;
      }
    }
  });
  tx();

  return result;
}
