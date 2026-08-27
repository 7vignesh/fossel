# Fossel

**Local-first MCP memory for every repo you work on.** Store conventions, bug fixes, reviewer patterns, and decisions in **SQLite on your machine** (with FTS5 search). Works with **Cursor**, **Claude Desktop**, and any **stdio MCP** client. **No accounts, no cloud.**

---

## Quick start (~2 minutes)

1. **Onboard** (prints copy-paste MCP config + creates a sample memory):

   ```bash
   npx -y fossel init
   ```

2. **Add the JSON** from the output to **Cursor** (`~/.cursor/mcp.json`) or **Claude Desktop** MCP settings, then restart the app.

3. **Run the server** (what the IDE launches; you can also run it manually for testing):

   ```bash
   npx -y fossel
   ```

4. In chat, say:

   ```
   remember: [anything about this repo]
   ```

   Then ask:

   ```
   what does Fossel remember about [topic]?
   ```

5. **Verify it works** — paste this in your AI chat:

   ```
   remember: Fossel is working in this repo
   ```

   Then immediately ask:

   ```
   what does Fossel remember?
   ```

   You should see your memory returned.

**Database path:** `~/.fossel/memory.db` (override with `FOSSEL_DB_PATH`).

---

## Why Fossel?

| You get | Details |
|--------|---------|
| **Local data** | SQLite + migrations; nothing leaves your disk unless you share it. |
| **Repo-scoped memory** | One canonical key per repo; aliases collapse automatically. |
| **Find anything** | FTS5 + entity matching + optional semantic search; pin what matters. |
| **Ambient capture** | Natural-language `remember`; dedupes near-duplicates on save. |
| **Conflict review** | Flags related memories on save so the agent can reconcile contradictions. |
| **Smart retrieval** | Entity-aware ranking, access frequency tiebreaker, git-staleness markers. |
| **Proactive maintenance** | `consolidate_memory` surfaces stale, redundant, and contradicted entries. |
| **Evolving schema** | Startup migrations keep upgrades safe for existing databases. |

---

## Simple mode (recommended)

Two tools cover the 80% case. Neither needs you to specify `type` or `tags`.

### `remember` — save a memory

Just send a sentence. Fossel infers the memory type, generates tags, resolves the repo, and merges near-duplicates into the existing row.

> **You:** Remember: JWT lives in localStorage and 401 redirects to /login.
>
> **Agent calls** `remember({ note: "JWT lives in localStorage and 401 redirects to /login." })`
>
> **Fossel:** Stored as `convention` with tags `jwt, auth, login` for `7vignesh/fossel`.

### `get_context` — pull repo context

Pinned first, then recent, then FTS matches if you pass a `query`. Default limit of 8 is tuned for LLM context injection.

> **You:** What does Fossel remember about auth here?
>
> **Agent calls** `get_context({ query: "auth" })`
>
> **Fossel:** returns a markdown block ready to drop into the system prompt.

That's it for daily use. The repo is detected from your `cwd` automatically.

### Conflict review on save

When you save a note that *relates to but does not duplicate* an existing
memory, `remember` appends a short notice listing the related memories — and
flags ones that look like they may be contradicted or superseded (e.g. you say
you *no longer* use something). The new memory is always stored; the notice is
advisory so your AI assistant can decide whether to revise the old memory
(`update_memory`) or remove it (`delete_memory`).

> **You:** Remember: JWT no longer lives in localStorage; we moved it to httpOnly cookies.
>
> **Fossel:** Stored memory 3 …
> Related existing memories you may want to reconcile:
> - #2 (similarity 0.50) ⚠ may contradict/supersede: JWT lives in localStorage and 401 redirects to /login.

This keeps memory from silently accumulating contradictions over time. Fossel
stays dependency-free: it surfaces the candidates and lets the MCP client's own
model make the judgment, rather than embedding an LLM in the server.

### Temporal grounding

Relative dates rot: "fixed it last week" is useless six months later. When you
save a note, Fossel resolves common relative-date phrases to absolute dates and
appends them to the stored note, so the memory stays meaningful over time.

> **You:** Remember: migrated the cron scheduler to a queue last week.
>
> **Stored as:** "migrated the cron scheduler to a queue last week (last week = 2026-06-19)"

It handles `yesterday`/`today`/`tomorrow`, `last`/`next week`/`month`,
`N days/weeks/months ago`, and `in N days/weeks/months`. Vague phrases
("recently", "soon") are left untouched rather than guessed at. No dependency.

### Git-aware staleness

Temporal grounding for *code*. When a memory mentions a source file, Fossel
records that file's git blob sha at write time. On retrieval, if the file has
changed since — whether committed or sitting uncommitted in your working tree —
the memory is flagged:

> **You:** what does Fossel remember about auth?
>
> **Fossel:**
> - (12) Auth is enforced in `middleware.ts` before every route. ⚠ may be stale: middleware.ts changed since this was written

The memory is never auto-deleted or auto-edited — the marker is advisory, so
your AI assistant can decide whether the note still holds after reading the
current file. This is the same "flag it, let the model judge" pattern as conflict
review.

It fails safe end to end: outside a git repo, without git installed, or for a
file that isn't tracked, Fossel simply records no reference and shows no marker —
the feature is invisible until it has something real to say.

### Fact supersession (`supersede_memory`)

When a memory becomes outdated, use `supersede_memory` instead of deleting it.
The memory stops surfacing in live retrieval but the row and its history are
preserved - this is the Zep invalidate-never-delete pattern. Optionally point at
the memory that replaces it:

```json
{ "id": 2, "superseded_by": 5, "reason": "Moved JWT to httpOnly cookies" }
```

The superseded memory keeps its changelog in `metadata_json` so you can trace
what was believed when. Use `delete_memory` only when a fact was entered by
mistake; use `supersede_memory` when it was true but is no longer.

### Export / import

Your data is yours. Export everything Fossel knows as a portable JSON file:

```json
{ "repo": "7vignesh/fossel" }
```

The envelope contains memories (including superseded ones) and repo aliases.
Embeddings are deliberately excluded - they are re-derived on import so the
file stays small and model-agnostic.

`import_memories` is additive and idempotent: it uses `INSERT OR IGNORE` on the
source id, so re-importing the same file is a no-op and never clobbers existing
rows. There is no replace mode; to wipe, delete the database file.

### Invocation hint on `fossel init`

When you run `fossel init`, Fossel detects agent rule files in your workspace
(AGENTS.md, CLAUDE.md, .cursor/rules) and appends a one-line hint telling the
agent to call `get_context` at the start of a session. This is the difference
between Fossel being installed and being actually used.

The hint is idempotent (a marker prevents duplicates) and never clobbers
existing content - it only appends, and only to files that already exist.

### High-quality fact extraction (`infer`)

For the best memories, have your AI assistant extract a single clean,
self-contained fact (resolving pronouns and vague references) before calling
`remember`, and pass an explicit `type`/`tags` with `infer: false` to store it
verbatim:

```json
{ "note": "Build artifacts are uploaded to the releases bucket.", "type": "convention", "tags": ["build", "release"], "infer": false }
```

This delegates extraction to the LLM the client already has — getting
high-quality, atomic facts without adding an LLM dependency to Fossel. Omit
`infer` (the default) to let Fossel's built-in heuristics infer type and tags.

### Zero-prompt usage in Cursor

Fossel exposes a static MCP resource at `fossel://context/current-repo`. Cursor and Claude Desktop list resources on session start, so Fossel's pinned + recent memories show up before you type anything. Clients that don't list resources can still call `get_context` from the agent's first turn — that's all the prompting needed.

### Entity-aware retrieval

When you save a memory, Fossel extracts named entities from the note — file
paths, packages, function names, services, class names, and ticket references —
and stores them in a side table. When you query, the same extraction runs on
your question and memories sharing entities with the query get a retrieval
boost via a third fusion leg (alongside FTS and vector search).

> **You:** what does Fossel remember about express?
>
> **Fossel:** boosts all memories mentioning `express` as an entity, even if
> the word "express" doesn't appear in the FTS match.

This is the same pattern Mem0 v3 uses for entity matching — adapted for code
memory where identifiers are the entities. No LLM, no spaCy, no model download.
Six entity kinds are extracted via regex heuristics: `file`, `package`,
`function`, `identifier`, `service`, `ticket`.

### Access tracking

Fossel tracks which memories are actually useful. Every time a memory is
returned to you (via `get_context` or `search_memory`), its `access_count` is
incremented and `last_accessed_at` is updated. This data is used as a
tiebreaker in retrieval — between two equally-recent memories, the one that's
been useful before surfaces first.

Access data also powers the consolidation tool (below) which identifies
memories that were never retrieved and may be stale.

### Memory consolidation (`consolidate_memory`)

Over time, repos accumulate contradictions, near-duplicates, and forgotten
memories. `consolidate_memory` is a read-only analysis tool that surfaces
candidates for cleanup without modifying any data:

> **You:** run consolidate_memory for this repo
>
> **Fossel:** returns a markdown report listing:
> - 🕸️ **Stale**: never accessed, older than 90 days, not pinned
> - 🔁 **Redundant**: ≥70% similar to another memory
> - ⚠️ **Contradicted**: negation language overlapping with an existing fact
>
> Plus suggested actions for each (supersede, merge, delete).

This is Fossel's version of Letta's "sleep-time compute" — without the LLM.
The report is prompt-ready so your AI assistant can act on it immediately.
The tool never auto-edits or auto-deletes; it flags and the model judges.

---

## Advanced mode

Every original tool is still available for power users.

| Tool | Purpose |
|------|---------|
| `remember` | Save a memory in natural language — auto-infers type, tags, and repo |
| `get_context` | Retrieve relevant memories, pinned first then recent |
| `search_memory` | FTS search across notes, optional repo filter |
| `pin_memory` / `unpin_memory` | Pin important memories to always appear first |
| `delete_memory` | Delete by id |
| `update_memory` | Edit an existing memory by id |
| `supersede_memory` | Tombstone a memory so it stops surfacing but the row survives |
| `export_memories` | Export all memories as a portable JSON envelope |
| `import_memories` | Import memories from a JSON envelope (additive, idempotent) |
| `dedupe_repo` | Merge near-duplicate memories |
| `consolidate_memory` | Surface stale, redundant, and contradicted memories for review |
| `summarize_repo_context` | Markdown summary — useful for PR descriptions |

### Memory types

`convention`, `bug_fix`, `reviewer_pattern`, `decision`, `issue`, `general`.

### Tool examples

`store_context` (explicit form):

```json
{
  "repo": "7vignesh/fossel",
  "type": "convention",
  "note": "Use pnpm workspaces for all package scripts.",
  "tags": ["pnpm", "workspaces"]
}
```

`pin_memory`:

```json
{ "id": 12 }
```

`summarize_repo_context`:

```json
{ "repo": "RocketChat/Rocket.Chat" }
```

```md
Fossel Context Summary: RocketChat/Rocket.Chat

📌 Pinned
- (12) Always run test matrix before merge.

Conventions
- (3) Use feature flags for UI experiments.

Bug Fixes
- (5) Fixed webhook retries by making queue idempotent.
```

`dedupe_repo` (dry run, then apply):

```json
{ "repo": "7vignesh/fossel", "apply": false }
{ "repo": "7vignesh/fossel", "apply": true, "threshold": 0.85 }
```

---

## Repo identity

Fossel resolves the canonical key for your workspace in this order:

1. `git remote get-url origin` → normalized to `owner/repo`
2. folder basename
3. anything you pass explicitly is recorded as an alias of the above

Memories saved under any alias are reachable from the canonical key, and `npx fossel init` automatically merges legacy alias rows (e.g. `studentmanager` → `7vignesh/student-manager`).

---

## Commands

```bash
npx -y fossel          # MCP server over stdio
npx -y fossel init     # onboarding + canonical key + safe alias merge
npx -y fossel doctor   # diagnose repo sprawl, duplicates, MCP config
```

### `fossel init`

Detects the canonical repo key, prints **Cursor** and **Claude Desktop** MCP snippets, merges legacy alias rows into the canonical key, and inserts a starter memory only when the database is empty.

### `fossel doctor`

Reports on:

- canonical repo key for the workspace
- sibling keys that look like the same repo (offers a fix)
- exact-duplicate memory clusters (suggests `fossel doctor --fix` or `dedupe_repo`)
- memory notes that still mention deprecated repo keys
- detected MCP config files

Pass `--fix` to apply safe automated cleanup in one go: merge sibling repo keys, rewrite stale alias mentions, and remove exact-text duplicates. Without `--fix` it's read-only and exits non-zero on issues so it can run in CI.

---

## Cursor MCP config

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "fossel": {
      "command": "npx",
      "args": ["-y", "fossel"],
      "env": {
        "FOSSEL_WORKSPACE": "${workspaceFolder}"
      }
    }
  }
}
```

## Claude Desktop MCP config

```json
{
  "mcpServers": {
    "fossel": {
      "command": "npx",
      "args": ["-y", "fossel"],
      "env": {
        "FOSSEL_WORKSPACE": "/path/to/your/project"
      }
    }
  }
}
```

`FOSSEL_WORKSPACE` pins Fossel to your project root. Without it, the server falls back to `process.cwd()`, which is occasionally wrong — Cursor and Claude Desktop sometimes spawn MCP servers from your home directory, which would silently route memories to the wrong repo. Cursor expands `${workspaceFolder}` automatically; Claude Desktop needs an absolute path.

---

## Development (from source)

```bash
npm install
npm run dev          # MCP server over stdio
npm run typecheck
npm test             # unit tests (node:test via tsx)
npm run smoke        # end-to-end MCP roundtrip
npm run bench        # retrieval benchmark (see bench/README.md)
npm run build
npm run start        # node dist/index.js
npm run ci           # typecheck + tests + build + smoke
```

## Notes

- **Local-first:** data stays on your machine.
- **Search:** FTS5 keyword search by default. Optional **hybrid semantic search**
  via `FOSSEL_EMBEDDINGS=1` (see below).
- **`FOSSEL_DB_PATH`:** optional override for DB location (e.g. tests).
- **Schema:** migrations live in `src/db/migrate.ts`; reference shape in `src/db/schema.sql`.

## Hybrid semantic search (optional)

By default Fossel retrieves memories with FTS5 keyword search. Keyword search
misses paraphrases — a query like "how does authentication work?" won't match a
note that says "JWT lives in localStorage" because they share no words.

Set `FOSSEL_EMBEDDINGS=1` to enable **hybrid retrieval**: a local, dependency-free
embedding is computed for every memory and fused with the keyword results
(Reciprocal Rank Fusion). This adds semantic recall while keeping FTS5's exact-
match precision for identifiers, file paths, and ticket numbers.

```json
{
  "mcpServers": {
    "fossel": {
      "command": "npx",
      "args": ["-y", "fossel"],
      "env": {
        "FOSSEL_WORKSPACE": "${workspaceFolder}",
        "FOSSEL_EMBEDDINGS": "1"
      }
    }
  }
}
```

Properties:

- **Zero install weight / fully offline.** The embedding is a deterministic
  feature-hashing of token unigrams and bigrams — no model download, no native
  dependency, no network. It runs instantly and keeps the local-first promise.
- **Opt-in.** With the flag unset, Fossel behaves exactly as before: no vectors
  are written and retrieval is FTS-only.
- **Self-healing index.** Memories created before enabling the flag are embedded
  on demand the first time the repo is searched.
- **Pluggable.** `embedText` in `src/lib/embeddings.ts` is the single entry
  point, so a stronger embedder (transformers.js, ONNX, or a remote model) can
  be swapped in later without touching callers. Bump `EMBEDDING_VERSION` to
  trigger automatic re-indexing of stale vectors.

Vectors are stored in a `memory_embeddings` side table keyed by memory rowid and
cleaned up via trigger when a memory is deleted.

### Plugging in a stronger embedder (optional)

The built-in hashed embedder catches lexical and n-gram overlap but not pure
synonyms — the benchmark puts that ceiling at 33% on synonym queries. For higher
quality semantic recall, point `FOSSEL_EMBEDDER_CMD` at a command that reads text
on **stdin** and prints vectors on **stdout**:

```json
{
  "env": {
    "FOSSEL_EMBEDDINGS": "1",
    "FOSSEL_EMBEDDER_CMD": "node /path/to/my-embedder.js"
  }
}
```

A ready-to-use reference implementation is included at
[`examples/embedder-transformers.mjs`](examples/embedder-transformers.mjs). It
uses transformers.js with a quantized MiniLM model (~30 MB, downloaded once then
fully offline). You install the runtime yourself:

```bash
npm i @huggingface/transformers
```

Fossel gains no dependency from this — that's the point of the hook.

#### Protocol

Fossel speaks two shapes, and an embedder should handle both:

| Shape | stdin | stdout |
|-------|-------|--------|
| **Batch** (2+ texts) | one JSON-encoded string per line | one JSON array of numbers per line, same order |
| **Single** (1 text) | the raw text | one JSON array of numbers |

**Batching is not optional in practice.** Embedding is done per memory, so under
a one-text-per-spawn protocol indexing a repo means one process spawn — and for a
real model, one model load — per memory. Batching makes the whole index cost a
single spawn regardless of size: in the test suite, indexing 30 additional
memories costs exactly one further invocation.

Existing single-text embedders keep working unchanged. Fossel detects a
non-batch-capable embedder by validating that it got back exactly as many vectors
as it sent texts, and falls back to per-text calls when it did not — so
compatibility is handled by validation, not by extra configuration.

Properties:

- **You own the model.** Fossel stays dependency-free; the embedder is your
  script (a transformers.js/ONNX runner, a local model server CLI, etc.).
- **Isolated vectors.** External vectors are tagged with a version derived from
  the embedder command, so they are never compared against the built-in hashed
  vectors and switching embedders re-indexes automatically.
- **Graceful degradation.** If the command fails, times out, mis-implements the
  batch protocol, or returns invalid output, Fossel falls back to the built-in
  embedder so a write is never lost.

## Repository intake / reproducible setup

### Build the Docker image

```bash
docker build -t fossel:local .
```

This runs the full CI pipeline (typecheck, test, build, smoke) during the build
stage. If the image builds successfully, the repo is validated.

### Run validation inside Docker

The multi-stage build validates during `docker build`. If the image builds
successfully, all checks have already passed. To inspect the runtime image:

```bash
docker run --rm fossel:local node -e "require('./dist/index.js')"
```

To re-run the full CI pipeline in a fresh container (without layer cache):

```bash
docker build --no-cache --target builder -t fossel:ci .
```

### Commands expected to pass

| Command | Purpose |
|---------|----------|
| `npm run typecheck` | TypeScript strict-mode type checking |
| `npm run test` | Unit tests (node:test via tsx) |
| `npm run build` | Production build via tsup |
| `npm run smoke` | End-to-end MCP roundtrip against a temp DB |
| `npm run ci` | All of the above in sequence |

### Assumptions

- Node 22.x (pinned in Dockerfile as `node:22.12.0-bookworm-slim`)
- No network access required at runtime or during tests
- No environment variables required for validation (test DB is ephemeral via `FOSSEL_DB_PATH`)
- `better-sqlite3` requires native compilation (build tools present in builder stage)

---

## Benchmarks

Retrieval quality is measured, not asserted. `npm run bench` runs a committed
eval set of 45 memories and 33 labelled queries for a fictional repo and reports
hit@k, recall@k, MRR and nDCG for each retrieval mode.

Search surface (pure ranked search contribution), limit 10:

| Mode | hit@1 | hit@3 | hit@5 | hit@10 | recall@5 | MRR | nDCG@10 |
|------|-------|-------|-------|--------|----------|-----|---------|
| `fts` | 72.7% | 87.9% | **90.9%** | 90.9% | **85.6%** | 0.794 | 0.792 |
| `vector` | 51.5% | 69.7% | 72.7% | 84.9% | 70.2% | 0.632 | 0.668 |
| `hybrid` | **78.8%** | 87.9% | 87.9% | 90.9% | 82.6% | **0.832** | **0.809** |

hit@5 by query category:

| Category | `fts` | `vector` | `hybrid` |
|----------|-------|----------|----------|
| exact | 100% | 100% | 100% |
| identifier | 100% | 100% | 100% |
| path | 100% | 100% | 100% |
| ticket | 100% | 100% | 100% |
| superseded | 100% | 100% | 100% |
| multi | 100% | 66.7% | 100% |
| paraphrase | 90.0% | 50.0% | 80.0% |
| synonym | 33.3% | 0% | 33.3% |

What these numbers say, including the parts that aren't flattering:

- **Keyword search carries most of the weight.** BM25 plus a three-tier match
  strategy — AND, then OR, then stemmed-prefix — reaches 90.9% hit@5 on its own.
  The stemmed-prefix tier alone was worth +9.1 points of hit@5: FTS5 has no
  stemming, so queries were failing purely on inflection ("alerts" not matching
  "alert channel").
- **Hybrid buys the top slot, and costs a little breadth.** It wins hit@1 by 6.1
  points and has clearly the best MRR and nDCG@10, which is what matters when the
  result is injected into a prompt and the first entry gets read most carefully.
  It is 3 points *behind* FTS-only at hit@5 and recall@5, because the built-in
  hashed embedder is still the weaker signal and fusing it in displaces some good
  keyword hits. That trade is deliberate and measured, not accidental.
- **Synonym queries are still the weak spot.** Connecting "why is this still one
  deployable unit?" to a note about *microservices* needs real semantic
  understanding, which feature-hashed embeddings do not have. 33% is the honest
  ceiling of the zero-dependency approach; a stronger embedder via
  `FOSSEL_EMBEDDER_CMD` is the way past it.

Three ideas were implemented, measured, and **removed** because the numbers did
not support them: a cosine score floor on the vector leg, adaptive fusion weights
keyed on FTS match strength, and RM3 pseudo-relevance-feedback query expansion.
The reasoning for each is recorded in `src/lib/fusion.ts` and `src/lib/fts.ts` so
nobody re-tries them blindly.

A [LongMemEval-S](https://huggingface.co/datasets/xiaowu0162/longmemeval)
adapter is included for cross-project comparability; that dataset is not
redistributed and must be downloaded. See [`bench/README.md`](bench/README.md)
for metric definitions, the dataset design constraints, and how to run it.

---

## Community

If Fossel saves you time, **[star the repo](https://github.com/7vignesh/fossel)** and **[open an issue](https://github.com/7vignesh/fossel/issues)** for bugs or ideas - that helps others discover it too.
