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
