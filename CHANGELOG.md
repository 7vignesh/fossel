# Changelog

All notable changes to Fossel are recorded in this file.

## [1.1.1] - Phase 1 follow-ups: workspace pinning, ID parity, smarter search

### Fixed

- **Repo resolution under wrong cwd** — added `FOSSEL_WORKSPACE` environment
  variable. The MCP server uses it as its workspace root before falling back
  to `process.cwd()`. The MCP config snippet printed by `fossel init` now
  includes `FOSSEL_WORKSPACE: "${workspaceFolder}"` so Cursor and Claude
  Desktop pin Fossel to the right project even when they spawn the server
  from another directory.
- **Stale text after alias merge** — `mergeRepoKeys` now rewrites note text
  that mentions a deprecated repo key, with the original text preserved in
  `metadata_json.changelog`. `fossel doctor` flags any remaining stale
  mentions.
- **`search_memory` empty results on punctuation-heavy queries** — the FTS
  query is now built from sanitized tokens (paths like `/api/auth` split into
  `["api", "auth"]`). When the AND query misses, the tool retries with OR;
  when both miss but the repo has memories, it falls back to pinned + recent
  context with a clear "no exact match" header.
- **Inconsistent ID types** — `delete_memory`, `pin_memory`, `unpin_memory`,
  and `update_memory` now accept either numeric `row_id` or the legacy
  string `id`. A new shared `findMemoryByAnyId` helper handles both.
- **Read-time duplicates in `get_context`** — `fetchRepoContext` collapses
  rows whose normalized note text matches, so a missed dedupe on storage
  doesn't surface as duplicate context lines for the LLM.
- **Outdated starter memory text** — `fossel init` seeds a fresh convention
  pointing users at `remember` and `get_context` instead of the older tools.

### Added

- **`fossel doctor --fix`** — applies safe automated fixes in one shot:
  merges sibling repo keys, rewrites stale alias mentions, and removes
  exact-text duplicates.
- **`fossel init --no-dedupe`** — opt out of the new automatic exact-duplicate
  cleanup that runs at the end of `init`.
- **`lib/workspace.ts`** — single helper (`getWorkspaceRoot`) used by every
  tool so future workspace-detection changes stay in one place.
- **`lib/memory.ts`** — `findMemoryByAnyId` shared helper used by all id-aware
  tools.

### Compatibility

- No schema migrations in this release; existing databases continue to work.
- All tool signatures are backwards-compatible. Numeric ID schemas widened to
  `number | string` so previous numeric callers keep working.

## [1.1.0] - Phase 1: ambient memory

### Added

- **`remember` tool** — natural-language wrapper that auto-infers `memory_type`,
  generates 2–5 tags, and resolves the repo. Use this in chat instead of
  `store_context` for everyday saves.
- **`get_context` tool** — unified retrieval that returns pinned memories first,
  then recent ones, then FTS matches when a `query` is provided. Default limit
  of 8 is tuned for direct LLM-context injection. Supports `format: "markdown"`
  for PR-ready briefs.
- **`resolve_repo` tool** — returns the canonical repo key, detected git
  remote, and stored aliases for the current workspace.
- **`dedupe_repo` tool** — scans a repo for near-duplicate memories. Returns a
  plan by default; pass `apply: true` to merge them, with a changelog entry
  appended to `metadata_json`.
- **Canonical repo resolution** — `git remote get-url origin` is normalized to
  `owner/repo` (GitHub/GitLab, https/ssh/git formats). Falls back to folder
  basename. Aliases are stored in a new `repo_aliases` table so memories
  saved under any alias are reachable from the canonical key.
- **Automatic dedupe** — `remember` looks for near-duplicate notes (Jaccard
  word + trigram overlap) and merges into the existing row instead of
  inserting a new one.
- **Startup context resource** — clients that auto-list MCP resources
  (Cursor, Claude Desktop) now see `fossel://context/current-repo`, a
  pre-rendered markdown view of the workspace's pinned + recent memories.
- **`fossel doctor`** — diagnoses repo-key sprawl, exact-duplicate clusters,
  and missing MCP configs.

### Changed

- `fossel init` now prints the canonical repo key, auto-migrates legacy alias
  keys (e.g. `studentmanager` → `7vignesh/student-manager`), and only inserts
  the starter memory when the database is empty.
- `store_context`, `get_repo_context`, `search_memory`, and
  `summarize_repo_context` resolve the `repo` argument to its canonical key
  automatically. The `repo` argument is now optional — Fossel infers it from
  the workspace when omitted.
- `update_memory` now keeps `note_normalized` in sync so dedupe stays accurate
  after edits.

### Database migrations

- `004_add_repo_aliases` — new `repo_aliases(alias PK, canonical, created_at)`.
- `005_add_memories_metadata_json` — adds `metadata_json TEXT NOT NULL DEFAULT '{}'`
  to `memories` for changelogs and audit trail.
- `006_add_memories_note_normalized` — adds `note_normalized TEXT NOT NULL
  DEFAULT ''` (with composite index on `repo, note_normalized`) and backfills
  it from existing rows.

All migrations are additive and run inside transactions; existing data is
preserved.

### Compatibility

- No breaking changes. Every existing tool retains its original signature; the
  `repo` argument simply became optional.
- Existing databases pick up the new schema on first launch under v1.1.0.
