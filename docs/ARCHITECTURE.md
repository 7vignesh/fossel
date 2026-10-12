# Fossel architecture

How retrieval fits together, and the conventions that keep it local-first. If
you are changing anything under `src/lib/`, read this before the module
comments; the module headers carry the "why" for the details this page only
sketches.

The guiding constraint behind almost every decision is: **no LLM, no model
download, no network at runtime.** Where a general memory tool would call a
model, Fossel either uses a heuristic or hands the judgment back to the
client's own model.

## Layout

- `src/db/` — `client.ts` (singleton SQLite connection, WAL), `migrate.ts`
  (sequential named migrations, the runtime source of truth), `schema.sql`
  (a hand-maintained reference of the final shape, kept in sync by hand).
- `src/lib/` — domain logic: `repo.ts` (canonical repo-key resolution and
  alias merging), `context.ts` (retrieval assembly), `fts.ts` (three-tier
  keyword search), `vector-index.ts` (optional semantic leg), `entities.ts`
  (entity leg), `fusion.ts` (rank fusion), `embeddings.ts`, `idf.ts`, plus
  the non-retrieval layers `dedupe.ts`, `merge.ts`, `inference.ts`,
  `temporal.ts`, `git.ts`, `file-refs.ts`.
- `src/tools/` — thin MCP tool registrations. Each resolves the repo, calls a
  `lib/` function, and returns `{ content: [{ type: "text" }] }`, catching
  errors into `isError: true` rather than throwing. **Keep tools thin; put
  logic in `lib`.**
- `bench/` — the retrieval benchmark and its committed eval set.

## The retrieval pipeline

`get_context` (`fetchRepoContext` in `context.ts`) is where the pieces are
assembled. With a query it produces a single ranked list by:

1. **Pinned** memories first (most recently updated), always winning their
   slot.
2. **Keyword search** via `fts.ts` (`searchFts`): a three-tier match that narrows
   first and broadens only as needed —
   1. **AND** — every token present; highest precision, tried first.
   2. **OR** — any token present; runs when AND found nothing, so a
      prose-phrased question still returns its relevant rows.
   3. **Stemmed prefix** — `"token"*` expressions; fills leftover slots only,
      so it can add recall but never displace an exact hit. It exists because
      FTS5 has no stemming, which made queries fail purely on inflection
      ("alerts" vs "alert"). The single largest retrieval gain in the project.
   BM25 (`bm25(memories_fts)`) handles the ordering throughout.
3. **Semantic search** via `vector-index.ts` (`vectorSearch`), only when
   `FOSSEL_EMBEDDINGS` is set. Vectors are a dependency-free feature-hash of
   token unigrams/bigrams; the query side is weighted by inverse document
   frequency (`idf.ts`) so common words contribute less, while stored vectors
   stay a pure function of their own text (weighting both sides would force a
   full re-index on any corpus change).
4. **Entity search** via `entities.ts`: named entities (file paths, packages,
   functions, identifiers, services, tickets) are extracted from the query and
   matched against entities stored when memories were written. High precision
   — sharing a file path or ticket reference is a strong relevance signal.
5. **Fusion** via `fusion.ts` (`fuseRrf`): weighted Reciprocal Rank Fusion
   combines the keyword, semantic and entity legs. RRF does not need the legs'
   score scales to be comparable, and the per-leg **weights are tuned, not
   equal** — the vector leg is down-weighted because it is measurably the
   weaker retriever. The default weight is coupled to embedder quality and must
   be re-swept whenever the embedder changes (see the notes in `fusion.ts`).
6. **Recent backfill**: any slots the search legs left empty are filled with
   recent non-pinned memories, and rows are deduplicated by `row_id` and by
   normalized note text so the same idea never appears twice in a block.

When embeddings are disabled the pipeline collapses to the original
keyword-only behaviour (FTS, then recent).

## Migrations

Schema changes go in `migrate.ts` as a new, sequentially **named** migration
(`001_init_memories_schema`, ...). Migrations are **append-only**: never edit
an already-shipped one, because existing databases have already run it.
Keep `schema.sql` in sync as the hand-maintained reference of the final shape.

## Conventions

- **Thin tools, fat `lib`.** Tool files wire up; logic lives in `lib`.
- **Measure retrieval changes.** Anything touching search must be run through
  `npm run bench` with the results snapshot committed. Keep a change only if the
  numbers support it. `npm run bench:check` fails on drift. Several ideas have
  been implemented, measured and removed (see the "tried and rejected" notes
  in `fusion.ts` and `fts.ts`) — do not re-try them without new evidence.
- **Stay dependency-light.** No network, model download, or LLM at runtime.
  The optional stronger embedder is a user-supplied command
  (`FOSSEL_EMBEDDER_CMD`), not a Fossel dependency.
- **Verify before claiming done.** `npm run ci` (typecheck + typecheck:bench +
  test + build + smoke) must pass; commits should be independently green.
