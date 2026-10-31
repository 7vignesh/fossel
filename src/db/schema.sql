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
  -- 1 = the path resolved at HEAD when the memory was written; 0 = the note
  -- named the path but git could not resolve it (untracked or missing), so
  -- nothing was ever checked. Read time tells the two apart.
  tracked INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_rowid, path)
);

CREATE INDEX IF NOT EXISTS idx_memory_file_refs_path
  ON memory_file_refs (path);

CREATE TRIGGER IF NOT EXISTS memories_file_refs_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memory_file_refs WHERE memory_rowid = old.rowid;
END;

-- Typed relationships between memories. Keyed by memories.id (never reused)
-- rather than rowid (reused after deleting the highest row). Deleting a memory
-- tombstones its edges (sets valid_to) instead of removing them, so history
-- such as a `supersedes` edge stays readable. No FK, because a FK would forbid
-- keeping an edge whose endpoint was deleted; a trigger enforces that live edges
-- connect two existing memories in the same repo. Symmetric types are stored
-- with src_id < dst_id.
CREATE TABLE IF NOT EXISTS memory_edges (
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  type TEXT NOT NULL
    CHECK (type IN ('fixes', 'contradicts', 'supersedes', 'relates_to')),
  weight REAL,
  created_at INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  PRIMARY KEY (src_id, dst_id, type),
  CHECK (src_id <> dst_id),
  CHECK (type NOT IN ('contradicts', 'relates_to') OR src_id < dst_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_edges_dst ON memory_edges (dst_id);

CREATE TRIGGER IF NOT EXISTS memory_edges_same_repo
BEFORE INSERT ON memory_edges
WHEN NEW.valid_to IS NULL
BEGIN
  SELECT RAISE(ABORT, 'memory_edges: both endpoints must exist in the same repo')
  WHERE (SELECT repo FROM memories WHERE id = NEW.src_id) IS NULL
     OR (SELECT repo FROM memories WHERE id = NEW.src_id)
        IS NOT (SELECT repo FROM memories WHERE id = NEW.dst_id);
END;

CREATE TRIGGER IF NOT EXISTS memories_edges_ad AFTER DELETE ON memories BEGIN
  UPDATE memory_edges
  SET valid_to = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE (src_id = old.id OR dst_id = old.id) AND valid_to IS NULL;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  repo,
  note,
  tags,
  content = 'memories',
  content_rowid = 'rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, repo, note, tags) VALUES (new.rowid, new.repo, new.note, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, repo, note, tags) VALUES ('delete', old.rowid, old.repo, old.note, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, repo, note, tags) VALUES ('delete', old.rowid, old.repo, old.note, old.tags);
  INSERT INTO memories_fts(rowid, repo, note, tags) VALUES (new.rowid, new.repo, new.note, new.tags);
END;
