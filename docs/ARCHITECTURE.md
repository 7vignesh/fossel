# Fossel architecture

Fossel is a local-first MCP memory server for coding assistants. It stores
per-repo conventions, bug fixes, decisions and reviewer patterns in SQLite
with FTS5 search, and serves them back to Cursor / Claude Desktop / any
stdio MCP client. One constraint drives almost every design choice:

> **No LLM, no model download, no network at runtime.**

Where a general memory tool would call an LLM, Fossel uses a heuristic and
hands the judgment back to the client's own model. Everything below is a
consequence of that.

## Layout

| Area | Where | Role |
|------|-------|------|
| Connection | `src/db/client.ts` | Single SQLite connection (WAL), the `MemoryRecord` type. |
| Schema | `src/db/migrate.ts`, `src/db/schema.sql` | Sequential named migrations; the runtime source of truth. |
| Domain logic | `src/lib/*` | Retrieval, embeddings, entities, fusion, repo-key resolution, git-aware refs. |
| MCP tools | `src/tools/*` | Thin registrations: resolve the repo, call a `lib` function, return text. |
| CLI | `src/cli.ts` | `fossel init` and friends, built on the same `lib` functions. |
| Benchmark | `bench/` | A reproducible retrieval quality harness (`repo-memory` + `longmemeval`). |

The one rule to hold onto: **tools stay thin; the logic lives in `lib/`.**
A tool resolves which repo it is in (`repo.ts`), calls one or two `lib`
functions, and returns `{ content: [{ type: "text" }] }`. Errors are caught
and returned as `isError: true` rather than thrown, so one bad call cannot
take the MCP session down.

## The retrieval pipeline

Both retrieval tools — `get_context` (`fetchRepoContext` in
`src/lib/context.ts`) and `search_memory` — run the same pipeline. Only the
assembling (`context.ts`) and the presentation differ.

```
query
  ├─► FTS5 (three tiers)          src/lib/fts.ts
  ├─► vector search (embeddings)  src/lib/vector-index.ts + embeddings.ts
  ├─► entity matches              src/lib/entities.ts
  └─► weighted RRF fusion         src/lib/fusion.ts
        + recent-memory backfill, pinned-first ordering
```

### FTS: three tiers, not one

`searchFts` (in `src/lib/fts.ts`) narrows first and only broadens when the
narrower pass matched nothing:

1. **AND** — every term must be present. Highest precision, tried first.
2. **OR** — any term present. Runs when AND matched nothing, so a prose
   question with one unmatched qualifier still returns its relevant rows.
   BM25 does the ordering; because BM25 already discounts common terms, the
   words that broaden the query contribute little to the ranking.
3. **Stemmed prefix** — `"alert"*`, `"deploy"*`. FTS5 has no stemmer, so this
   fills the *remaining* slots with rows the exact-token tiers missed,
   without reordering what they found — it can only add recall, never
   displace an exact hit. `lightStem` is a deliberately conservative suffix
   strip (not Porter), with an invariant that the stem is always a *prefix*
   of the input, which is exactly what FTS5 prefix matching needs.

Keeping this one implementation shared between the two tools is what stops
them drifting apart: the historical bug was that `search_memory` had the OR
fallback and a path/identifier-aware tokenizer while `get_context` had
neither.

### Embeddings: a local feature-hashing stand-in

`embeddings.ts` implements a deterministic unigram+bigram feature-hash
embedding — offline, instant, no native deps, no download. It is
*intentionally* not a semantic transformer, and it is pluggable: `embedText`
is the single entry point so a real model (transformers.js, ONNX, or a remote
embedder) can be dropped in without touching callers. Vectors are L2
normalised so cosine similarity reduces to a dot product, and the whole path
is a no-op when `FOSSEL_EMBEDDINGS` is unset, so the zero-config default is
untouched.

**Query-side IDF** (`idf.ts`) weights the *query* embedding by inverse
document frequency over the repo. It is applied on the query side only,
deliberately: a corpus-derived weight on the *stored* vector would make every
stored vector a function of the whole corpus at write time, so adding one
memory would silently invalidate every other vector and force a full
re-index. Asymmetric query/document weighting keeps stored vectors a pure
function of their own text.

### Entities: a third retrieval leg

`entities.ts` extracts structured entities (file paths, packages,
identifiers, tickets, …) from note text with regex heuristics and stores them
in a side table. `findEntityMatches` returns the memories that share named
entities with the query; that list is a third input to fusion.

### Fusion: weighted Reciprocal Rank Fusion

`fusion.ts` combines the ranked lists with RRF, `weight / (k + rank)`. The
weights exist because the legs are not equally strong — the built-in
feature-hash embedder is weaker than BM25 near the top of the list, so
fusing at equal weight let the weak leg displace good keyword hits. The
vector weight is **coupled to embedder quality and was chosen by sweeping it
against the benchmark** (`npx tsx bench/sweep.ts`), not by feel. If the
embedder changes, re-sweep it.

## The migration model

`migrate.ts` is the runtime source of truth: an ordered array of **named**
migrations, applied once and remembered. The working rule:

- Migrations are **append-only**. Add a new named migration for every schema
  change; never edit or reorder one that has shipped.
- `schema.sql` is a hand-maintained reference of the *final* shape, not what
  the runtime applies.

## Conventions

- **Measure retrieval changes.** Anything touching search goes through
  `npm run bench`; keep the change only if the committed numbers support it.
  The benchmark is the working agreement, and `npm run bench:check` is the CI
  gate that fails on unexplained drift.
- **No LLM, no network.** Any idea that reaches for a model or a fetch is
  either a heuristic or it is handed back to the client's model.
- **Stored vectors stay a pure function of their own text** (see the
  query-side IDF note above).

See `AGENTS.md` for the full working agreement and the "tried and rejected"
retrieval experiments, and `bench/README.md` for how to add a benchmark case.
