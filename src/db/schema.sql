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

-- Optional semantic index. One row per memory that has been embedded; absent
-- when semantic search (FOSSEL_EMBEDDINGS) has never run for that memory.
-- `vector` is a BLOB of little-endian float32 values; `dim`/`version` allow
-- stale-vector detection and re-indexing. Populated by src/lib/vector-index.ts.
-- A trigger (not a FK) cascades deletes, because `memories.rowid` is the
-- implicit rowid alias and SQLite FKs can't reference it.
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_rowid INTEGER PRIMARY KEY,
  dim INTEGER NOT NULL,
  version INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS memories_embeddings_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memory_embeddings WHERE memory_rowid = old.rowid;
END;

-- Git-aware file references. One row per (memory, file) pair recording the blob
-- sha the file had when the memory was written, so retrieval can flag a memory
-- as possibly stale when the file's content has since changed. Populated by
-- src/lib/file-refs.ts, and only in a git workspace; a non-git workspace records
-- nothing. Cascade-deleted via trigger for the same reason as memory_embeddings.
CREATE TABLE IF NOT EXISTS memory_file_refs (
  memory_rowid INTEGER NOT NULL,
  path TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_rowid, path)
);

CREATE INDEX IF NOT EXISTS idx_memory_file_refs_path
  ON memory_file_refs (path);

CREATE TRIGGER IF NOT EXISTS memories_file_refs_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memory_file_refs WHERE memory_rowid = old.rowid;
END;

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
