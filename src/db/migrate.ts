import type Database from "better-sqlite3";

interface Migration {
  name: string;
  apply: (db: Database.Database) => void;
}

function hasColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  return columns.some((column) => column.name === columnName);
}

function normalizeNoteForMigration(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const migrations: Migration[] = [
  {
    name: "001_init_memories_schema",
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('convention', 'bug_fix', 'reviewer_pattern', 'decision', 'issue', 'general')),
          note TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
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
      `);
    },
  },
  {
    name: "002_add_memories_updated_at",
    apply: (db) => {
      if (!hasColumn(db, "memories", "updated_at")) {
        db.exec(`
          ALTER TABLE memories
          ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
        `);
        db.exec(`
          UPDATE memories
          SET updated_at = created_at
          WHERE updated_at = 0;
        `);
      }
    },
  },
  {
    name: "003_add_memories_pinned",
    apply: (db) => {
      if (!hasColumn(db, "memories", "pinned")) {
        db.exec(`
          ALTER TABLE memories
          ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        `);
      }
    },
  },
  {
    name: "004_add_repo_aliases",
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS repo_aliases (
          alias TEXT PRIMARY KEY,
          canonical TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_repo_aliases_canonical
          ON repo_aliases (canonical);
      `);
    },
  },
  {
    name: "005_add_memories_metadata_json",
    apply: (db) => {
      if (!hasColumn(db, "memories", "metadata_json")) {
        db.exec(`
          ALTER TABLE memories
          ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
        `);
      }
    },
  },
  {
    name: "006_add_memories_note_normalized",
    apply: (db) => {
      if (!hasColumn(db, "memories", "note_normalized")) {
        db.exec(`
          ALTER TABLE memories
          ADD COLUMN note_normalized TEXT NOT NULL DEFAULT '';
        `);
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_note_normalized
          ON memories (repo, note_normalized);
      `);

      const rows = db
        .prepare("SELECT rowid AS row_id, note FROM memories WHERE note_normalized = ''")
        .all() as Array<{ row_id: number; note: string }>;

      if (rows.length > 0) {
        const update = db.prepare(
          "UPDATE memories SET note_normalized = ? WHERE rowid = ?",
        );
        const tx = db.transaction((batch: typeof rows) => {
          for (const row of batch) {
            update.run(normalizeNoteForMigration(row.note), row.row_id);
          }
        });
        tx(rows);
      }
    },
  },
  {
    name: "007_add_memory_embeddings",
    apply: (db) => {
      // Vectors are stored in a side table keyed by the memory rowid so the
      // base `memories` table and its FTS triggers stay untouched. A row here
      // is optional: it only exists when semantic indexing has run for that
      // memory. `dim` and `version` let us detect and re-index stale vectors
      // if the embedding algorithm changes. The vector itself is a BLOB of
      // little-endian float32 values.
      //
      // We cannot use a SQLite FOREIGN KEY here: `memories.rowid` is an alias
      // for the implicit rowid (the declared PK is the TEXT `id`), and FKs may
      // only reference a column with a PRIMARY KEY / UNIQUE constraint. Instead
      // a trigger removes the embedding when its memory is deleted, mirroring
      // the existing FTS delete-trigger pattern.
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_embeddings (
          memory_rowid INTEGER PRIMARY KEY,
          dim INTEGER NOT NULL,
          version INTEGER NOT NULL,
          vector BLOB NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TRIGGER IF NOT EXISTS memories_embeddings_ad
        AFTER DELETE ON memories BEGIN
          DELETE FROM memory_embeddings WHERE memory_rowid = old.rowid;
        END;
      `);
    },
  },
  {
    name: "008_add_memory_file_refs",
    apply: (db) => {
      // Ties a memory to the files it mentions and the blob sha each file had at
      // write time, so retrieval can notice the code has changed since. Keyed by
      // memory rowid; one memory may reference several files. A trigger cascades
      // deletes, mirroring memory_embeddings — a FK cannot be used because
      // memories.rowid is the implicit rowid alias, not the declared TEXT PK.
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_file_refs (
          memory_rowid INTEGER NOT NULL,
          path TEXT NOT NULL,
          blob_sha TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (memory_rowid, path)
        );

        CREATE INDEX IF NOT EXISTS idx_memory_file_refs_path
          ON memory_file_refs (path);

        CREATE TRIGGER IF NOT EXISTS memories_file_refs_ad
        AFTER DELETE ON memories BEGIN
          DELETE FROM memory_file_refs WHERE memory_rowid = old.rowid;
        END;
      `);
    },
  },
  {
    name: "009_add_memories_validity",
    apply: (db) => {
      // Bi-temporal validity for fact supersession. `valid_to IS NULL` means the
      // memory is live; setting it to a timestamp tombstones the memory — it
      // stops surfacing in live reads but the row (and its history) survives.
      // This is the Zep invalidate-never-delete pattern. valid_from defaults to
      // the memory's creation time so existing rows are all live.
      if (!hasColumn(db, "memories", "valid_from")) {
        db.exec(`
          ALTER TABLE memories
          ADD COLUMN valid_from INTEGER NOT NULL DEFAULT 0;
        `);
        db.exec(`
          UPDATE memories SET valid_from = created_at WHERE valid_from = 0;
        `);
      }
      if (!hasColumn(db, "memories", "valid_to")) {
        // Nullable: NULL is the live state, so no default backfill is needed and
        // every existing memory stays live.
        db.exec(`
          ALTER TABLE memories
          ADD COLUMN valid_to INTEGER;
        `);
      }
      // Partial index over live rows — the common read path filters valid_to IS
      // NULL, and a partial index keeps that lookup cheap without indexing
      // tombstoned rows.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_live
          ON memories (repo, updated_at DESC)
          WHERE valid_to IS NULL;
      `);
    },
  },
  {
    name: '010_add_memory_entities',
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_entities (
          memory_rowid INTEGER NOT NULL,
          entity TEXT NOT NULL,
          kind TEXT NOT NULL,
          PRIMARY KEY (memory_rowid, entity)
        );

        CREATE INDEX IF NOT EXISTS idx_memory_entities_entity
          ON memory_entities (entity);

        CREATE INDEX IF NOT EXISTS idx_memory_entities_kind
          ON memory_entities (kind, entity);

        CREATE TRIGGER IF NOT EXISTS memories_entities_ad
        AFTER DELETE ON memories BEGIN
          DELETE FROM memory_entities WHERE memory_rowid = old.rowid;
        END;
      `);
    },
  },
  {
    name: '011_add_access_tracking',
    apply: (db) => {
      if (!hasColumn(db, 'memories', 'last_accessed_at')) {
        db.exec(`
          ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0;
        `);
        // Backfill: treat created_at as the initial access time
        db.exec(`UPDATE memories SET last_accessed_at = created_at WHERE last_accessed_at = 0;`);
      }
      if (!hasColumn(db, 'memories', 'access_count')) {
        db.exec(`
          ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
        `);
      }
    },
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = db
    .prepare("SELECT name FROM migrations")
    .all() as Array<{ name: string }>;
  const applied = new Set(appliedRows.map((row) => row.name));

  const insertMigration = db.prepare(`
    INSERT INTO migrations (name, applied_at)
    VALUES (?, ?)
  `);

  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      continue;
    }

    const applyTx = db.transaction(() => {
      migration.apply(db);
      insertMigration.run(migration.name, Math.floor(Date.now() / 1000));
    });

    applyTx();
  }
}
