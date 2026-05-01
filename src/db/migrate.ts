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
