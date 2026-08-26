# AGENTS.md

Orientation and roadmap for agents working on Fossel.

## What Fossel is

A local-first MCP memory server for coding assistants. It stores per-repo
conventions, bug fixes, decisions and reviewer patterns in SQLite with FTS5
search, and serves them back to Cursor / Claude Desktop / any stdio MCP client.
The guiding constraint behind almost every decision: **no LLM, no model download,
no network at runtime.** Where a general memory tool would call an LLM, Fossel
either uses a heuristic or hands the judgment back to the client's own model.

## Layout

- `src/db/` — `client.ts` (singleton connection, WAL), `migrate.ts` (the runtime
  source of truth: sequential named migrations), `schema.sql` (hand-maintained
  reference of the final shape).
- `src/lib/` — domain logic: `repo.ts` (canonical repo-key resolution + alias
  merging), `context.ts` (retrieval assembly), `fts.ts` (three-tier FTS),
  `fusion.ts` (weighted RRF), `embeddings.ts`, `idf.ts`, `vector-index.ts`,
  `merge.ts` (dedupe), `dedupe.ts`, `inference.ts`, `temporal.ts`.
- `src/tools/` — thin MCP tool registrations. Each resolves the repo, calls a lib
  function, and returns `{ content: [{ type: "text" }] }`, catching errors into
  `isError: true` rather than throwing. **Keep tools thin; put logic in `lib`.**
- `bench/` — retrieval benchmark. `npm run bench` scores fts/vector/hybrid on a
  committed eval set; `npm run bench:check` fails on drift; `npx tsx
  bench/sweep.ts` tunes constants.

## Working agreement

- **Measure retrieval changes.** Anything touching search must be run through
  `npm run bench` and the results snapshot committed. Keep a change only if the
  numbers support it; several ideas have been implemented, measured, and removed
  (see the "tried and rejected" notes in `fusion.ts` and `fts.ts`). Do not
  re-try those blindly.
- **Verify before claiming done.** `npm run ci` (typecheck + typecheck:bench +
  tests + build + smoke) must pass. Commits should be independently green.
- **Windows dev shell is PowerShell 5** — use `;` not `&&`; multi-line commit
  messages go through a file (`git commit -F`), not inline `-m`.
- **The fusion weight is coupled to embedder quality.** Re-sweep
  `DEFAULT_VECTOR_WEIGHT` whenever the embedder changes.
- Stored embedding vectors must stay a pure function of their own text, or every
  vector goes stale on any corpus change (forcing a full re-index). Corpus-derived
  weighting (IDF) is applied to the *query* side only for this reason.

## Roadmap

Phases 0–3 are done and pushed: defect fixes (stale dedupe vector, per-command
embedder versioning), the benchmark harness, retrieval quality (shared FTS with
OR + stemmed-prefix tiers, weighted RRF, query-side IDF, character n-grams), and
the external-embedder batch protocol.

### Phase 4 — Git-aware memory (the differentiator)

This is the feature competitors structurally cannot copy, because they are not
local and repo-scoped. It extends the repo-identity work that is already the best
in the category into retrieval and correctness.

**4a. Git introspection helpers (`src/lib/git.ts`).**
- `headSha(cwd)` → current `HEAD` commit sha, or null.
- `fileBlobSha(cwd, path)` → `git rev-parse HEAD:<path>`, the blob sha of a file
  at HEAD, or null if the file is untracked/absent.
- `changedFiles(cwd)` → files differing from HEAD (`git status --porcelain` +
  optionally the current diff), normalized to repo-relative paths.
- All must fail safe: return null / empty when git is absent, the cwd is not a
  repo, or the command errors. Never throw into a tool. Use `spawnSync` with a
  short timeout, mirroring `repo.ts`.
- Unit tests build real temporary git repos (init, commit, mutate) rather than
  mocking git.

**4b. Record file references on write (migration 008).**
- New table `memory_file_refs(memory_rowid, path, blob_sha)` with a
  delete-cascade trigger mirroring the `memory_embeddings` pattern (trigger, not
  FK, because `memories.rowid` is the implicit rowid).
- On `remember` / `store_context`, extract file-path-like tokens from the note
  (reuse the path/identifier extraction already in `inference.ts`), and for each
  path that exists at HEAD, record its current blob sha.
- Keep this behind the same "fail safe when not a git repo" guard — a
  non-git workspace simply records no refs.

**4c. Code-drift staleness detection.**
- On retrieval, for memories that reference files, compare the recorded blob sha
  against the current `fileBlobSha`. When they differ, the code the memory talks
  about has changed since the memory was written.
- Surface this as an **advisory marker** in `get_context` output (e.g. a `⚠ may
  be stale: middleware.ts changed since this was written` line), following the
  existing conflict-review notice pattern in `remember.ts`: Fossel flags the
  candidate and lets the client's model judge. Do **not** auto-delete or
  auto-edit.
- This is the temporal-grounding idea (already shipped for dates) applied to
  code. Consider prioritising memories whose referenced files are in
  `changedFiles` — those are the most relevant to what the agent is doing right
  now — but measure any ranking change on the benchmark first (the eval set will
  need git-aware fixtures, or a separate dataset).

### Phase 5 — Completeness

**5a. `supersede_memory` with tombstones.**
- Migration adding `valid_from` / `valid_to` to `memories`.
- Live reads (`fetchRepoContext`, search) filter on `valid_to IS NULL`.
- New `supersede_memory` tool: set `valid_to` (a tombstone) instead of deleting,
  optionally pointing at the superseding memory. History survives; the superseded
  fact stops surfacing. This completes the conflict-review loop, which currently
  only offers `delete_memory`. This is the Zep fact-supersession pattern:
  invalidate, never delete.

**5b. Export / import.**
- `export_memories` → a versioned JSON envelope (`{ format, version, memories,
  aliases }`). Do **not** export embeddings; re-derive them on import so the file
  stays small and model-agnostic.
- `import_memories` → additive and idempotent: `INSERT OR IGNORE` on the source
  id, so re-importing the same file is a no-op and never clobbers an existing
  row. No replace mode; to wipe, delete the db file.
- This is the strongest possible proof of the local-first / "your data" promise.

**5c. Write the invocation hint on `fossel init`.**
- Detect `AGENTS.md` / `CLAUDE.md` / `.cursor/rules` in the workspace and add one
  line telling the agent to call `get_context` at the start of a session.
- Must be idempotent (never duplicate the line) and never clobber existing
  content — append a marked block, check for the marker before writing.
- This is a growth feature in engineering clothes: it is the difference between
  Fossel being installed and being actually used.

## Known loose ends

- `memories.tags` are stored but **not** indexed in FTS — the virtual table is
  `fts5(repo, note)` only. The inference layer already generates good tags, so
  indexing them is likely free recall. Needs a migration rebuilding the
  external-content FTS table and its three triggers.
- Synonym queries sit at 33% (the honest ceiling of feature hashing). The path
  past it is a real embedder via `FOSSEL_EMBEDDER_CMD` (batch protocol now makes
  this practical), not more tuning of the built-in one.
