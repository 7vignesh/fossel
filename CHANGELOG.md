# Changelog

All notable changes to Fossel are recorded in this file.

## [Unreleased] - Measured retrieval, and the defects measuring it exposed

### Added

- **Git-aware memory (staleness detection).** When a memory mentions a source
  file, Fossel now records that file's blob sha at write time (migration 008,
  `memory_file_refs`). On `get_context`, any memory whose referenced file has
  changed since — committed or uncommitted — is flagged with an advisory marker
  (`⚠ may be stale: middleware.ts changed since this was written`). This is the
  temporal-grounding idea, already shipped for relative dates, applied to code.
  Like the conflict-review notice, it only flags; the client's model decides
  whether the memory needs revising. All git access fails safe: a non-git
  workspace, an absent git binary, or an untracked path simply records no
  references and produces no advisories, identical to the feature being off.
  New `src/lib/git.ts` (headSha, fileBlobSha, changedFiles) and
  `src/lib/file-refs.ts`.

- **Batch protocol for external embedders.** `FOSSEL_EMBEDDER_CMD` previously
  spawned one process per text, so backfilling N memories cost N spawns — and for
  a real model, N model loads — which made the escape hatch impractical at any
  real size. Fossel now sends all texts in one spawn as JSONL and expects one
  JSON vector per line back, in order. Existing single-text embedders keep working
  unchanged: a non-batch-capable embedder returns the wrong number of lines, which
  is detected by validation, and Fossel falls back to per-text calls. No new
  configuration. Measured: indexing 30 additional memories costs exactly one
  further spawn. A ready-to-use reference embedder using transformers.js ships at
  `examples/embedder-transformers.mjs`; Fossel itself gains no dependency.

- **Stemmed-prefix search tier.** FTS5 has no stemming, so queries were failing
  purely on inflection — "alerts" not matching "alert channel", "file" not
  matching ".env files", "deployment" not matching "Deploys go out". A third
  match tier applies conservative suffix stripping and FTS5 prefix matching, and
  only ever *appends* to fill leftover result slots, so it can add recall but
  never displace an exact-token hit. Worth **+9.1 points of hit@5** on the
  benchmark, the single largest retrieval gain in the project. The stemmer
  guarantees its output is a prefix of the input, which is what makes `stem*`
  safe — a classic stemmer mapping "policies" to "policy" would break it.
- **Query-side IDF weighting for embeddings.** The hashed embedder gave every
  token equal weight, so "how are prices represented in the database?" spent most
  of its vector on `how`, `are`, `in` and `the`. Corpus inverse document
  frequency now weights the *query* vector. Applied to the query only, by design:
  weighting stored vectors would make every vector a function of the corpus at
  write time, so a single new memory would invalidate the whole index. Standalone
  vector-mode MRR rose 0.519 → 0.632.
- **Character n-gram embedding features**, so morphological variants overlap
  instead of hashing to unrelated dimensions. `EMBEDDING_VERSION` is bumped to 2;
  existing indexes re-embed automatically on the next search.
- **Weighted rank fusion** (`src/lib/fusion.ts`). RRF now weights its legs
  instead of treating a weak signal as equal to a strong one. The weight is
  chosen by sweeping it against the benchmark (`npx tsx bench/sweep.ts`) and is
  documented as coupled to embedder quality — it was re-swept after each
  embedder change, and the optimum moved from 0.2 to 0.8 as the vector leg
  improved.
- **Retrieval benchmark** (`npm run bench`). A committed eval set of 45 memories
  and 33 labelled queries for a fictional repo, scored with hit@k, recall@k, MRR
  and nDCG across three modes (`fts`, `vector`, `hybrid`). Results are snapshotted
  to `bench/results/` so a retrieval change shows up as a reviewable diff, and
  `npm run bench:check` fails on drift. Two surfaces are reported per mode — the
  pure search ranking and the full `get_context` output including recent-memory
  backfill — because reporting only one would mislead. See `bench/README.md` for
  metric definitions and the dataset design constraints.
- **LongMemEval-S adapter** for cross-project comparability, mapping the
  benchmark onto Fossel memories with one namespace per question. The dataset is
  not redistributed; a small schema fixture is committed so the adapter can be
  verified offline.

### Fixed

- **`get_context` returned no search results for natural-language questions.**
  `fetchRepoContext` joined every query term with `AND`, so any question
  containing a word absent from the corpus matched nothing and the tool fell back
  to recent memories only. `search_memory` already had an AND→OR fallback and the
  path/identifier-aware tokenizer; `get_context` had neither. Both now share one
  implementation in `src/lib/fts.ts`, so they cannot drift apart again. Measured
  effect: FTS-only hit@5 rose from 45.5% to 81.8% and MRR from 0.455 to 0.743.
- **`dedupe_repo` left a stale vector on the surviving memory.** Applying a merge
  rewrites the kept row's note to the longer of the two, but never re-indexed its
  embedding, so the stored vector described text the row no longer contained.
  `backfillRepoEmbeddings` could not repair it either, because it only re-indexes
  vectors that are missing or tagged with a stale version — not ones whose text
  moved on.
- **Swapping external embedders kept stale vectors.** All external embedders
  shared one version constant, so changing `FOSSEL_EMBEDDER_CMD` to a different
  model of the same dimension did not trigger the re-index the docs promised. The
  stored version is now derived from the command string. The probed dimension
  cache was keyed globally for the same reason and is now keyed per command.

### Tried and removed

Three ideas were implemented, measured, and deleted because the benchmark did not
support them. The reasoning is recorded in the source so nobody re-tries them
blindly:

- **Cosine score floor on the vector leg.** Relevant vector hits have a median
  cosine of 0.291 (p25 0.204) and irrelevant ones 0.143 (p75 0.211) — too much
  overlap. Every floor either changed nothing or suppressed the vector leg back
  to FTS-only behaviour. The parameter is kept at 0 because a stronger embedder
  would have cleaner separation.
- **Adaptive fusion weights** keyed on whether FTS matched via AND or fell back
  to OR. Measured completely inert: the AND-branch weight had no effect at any
  value, and the adaptive configuration scored identically to a single fixed
  weight.
- **RM3 pseudo-relevance-feedback query expansion.** Identical hit@k and miss
  count, with hybrid MRR slightly down. The queries that still miss return no
  relevant row at all, so the feedback set is entirely irrelevant documents and
  expansion just drifts the query.

### Changed

- Repo-wide near-duplicate merging moved from `src/tools/dedupe-repo.ts` into
  `src/lib/merge.ts`, leaving the tool as a thin wrapper like every other tool
  and making the planning and apply steps unit-testable.

## [1.4.0] - Temporal grounding, agent-extracted facts, pluggable embedder

### Added

- **Temporal grounding** — relative dates in a note ("last week", "3 days ago",
  "in 2 months", "yesterday") are resolved to absolute dates and appended to
  the stored note, so memories stay meaningful after the relative reference
  goes stale. Vague phrases ("recently", "soon") are deliberately left alone.
  Applies to both `remember` and `store_context`. Dependency-free.
- **`infer` parameter on `remember`** — set `infer: false` to store an
  agent-supplied fact verbatim with the supplied `type`/`tags`, skipping
  heuristic inference. The tool description now guides the client's model to
  extract a single clean, self-contained fact before calling — delegating
  high-quality fact extraction to the LLM the client already has, without
  adding an LLM dependency to Fossel. Mirrors mem0's `infer` escape hatch.
- **Optional external embedder** — set `FOSSEL_EMBEDDER_CMD` to a command that
  reads text on stdin and prints a JSON vector on stdout, to plug in a stronger
  model (transformers.js, ONNX, a local server CLI) for better semantic recall.
  Its vectors are tagged with a distinct version so they never mix with the
  built-in hashed vectors, and a failed/misconfigured embedder degrades
  gracefully to the built-in one. Default stays the zero-dependency hashed
  embedder. Requires `FOSSEL_EMBEDDINGS=1`.

## [1.3.0] - Conflict review on save

### Added

- **Conflict review on `remember`** — when a saved note relates to but does not
  duplicate existing memories, the response now lists those related memories so
  the MCP client's model can reconcile them. Notes carrying negation/replacement
  language ("no longer", "replaced", "deprecated", …) that overlap an existing
  memory are flagged as possible contradictions, prompting the agent to revise
  (`update_memory`) or remove (`delete_memory`) the superseded memory. This
  keeps memory from silently accumulating contradictions over time.
- The new memory is **always stored**; the notice is advisory. Fossel stays
  dependency-free — it surfaces candidates and delegates the judgment to the
  client's existing LLM rather than embedding one in the server.
- `findRelatedCandidates` (`src/lib/dedupe.ts`) detects the mid-band between
  "near-duplicate" (auto-merged) and "unrelated", calibrated against the blended
  word + trigram similarity metric.

## [1.2.1] - Metadata refresh

### Changed

- **Package description and keywords** now mention hybrid keyword + semantic
  search so the npm listing reflects 1.2.0's headline feature. Added
  `semantic-search` and `embeddings` keywords. No code changes.

## [1.2.0] - Hybrid semantic search

### Added

- **Optional hybrid semantic search** — set `FOSSEL_EMBEDDINGS=1` to retrieve
  memories by meaning, not just shared keywords. A query like "how does auth
  work?" now surfaces a note that says "JWT lives in localStorage" even though
  they share no words. Keyword (FTS5) and semantic results are fused with
  Reciprocal Rank Fusion, so exact-match precision for file paths, identifiers,
  and ticket numbers is preserved while semantic recall is added on top.
- **Local, dependency-free embeddings** — vectors are computed with a
  deterministic feature-hashing of token unigrams/bigrams. No model download,
  no native dependency, no network. Fully offline, instant, and true to
  Fossel's local-first promise. The `embedText` seam (`src/lib/embeddings.ts`)
  is pluggable so a stronger embedder can be swapped in later; bump
  `EMBEDDING_VERSION` to trigger automatic re-indexing.
- **Self-healing index** — memories created before enabling the flag are
  embedded on demand the first time their repo is searched. Vectors live in a
  `memory_embeddings` side table (migration 007) and are cleaned up via trigger
  when a memory is deleted.

### Changed

- **Retrieval leads with relevance when a query is present.** `get_context`
  and `search` now place matching results ahead of merely-recent ones (recent
  memories backfill any leftover slots) instead of relegating matches below
  recent. This applies to the default FTS-only path too. Pinned memories still
  lead. With no query, behavior is unchanged (pinned + recent).

### Notes

- The feature is **opt-in**. With `FOSSEL_EMBEDDINGS` unset, no vectors are
  written and retrieval is FTS-only — identical to 1.1.1.

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
