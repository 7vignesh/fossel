-- Reference schema. Source of truth at runtime is src/db/migrate.ts.
-- Keep this file in sync when adding migrations so contributors can grok the
-- final shape of the database without replaying every migration step.

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('convention', 'bug_fix', 'reviewer_pattern', 'decision', 'issue', 'general')),
  note TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  note_normalized TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_memories_repo ON memories (repo);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_note_normalized
  ON memories (repo, note_normalized);

CREATE TABLE IF NOT EXISTS repo_aliases (
  alias TEXT PRIMARY KEY,
  canonical TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repo_aliases_canonical
  ON repo_aliases (canonical);

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
