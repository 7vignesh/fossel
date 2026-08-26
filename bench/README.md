# Fossel retrieval benchmark

A reproducible measurement of Fossel's retrieval quality, so changes to search
can be verified instead of asserted.

```bash
npm run bench                     # repo-memory dataset, all three modes
npm run bench -- --mode hybrid    # one mode
npm run bench -- --verbose        # list every missed query
npm run bench:check               # fail if results drift from the snapshot
```

Results are written to `bench/results/<dataset>.json` and committed, so a
retrieval change shows up as a reviewable diff. `npm run bench:check` is the CI
form; it is deliberately **not** part of `npm run ci`, which stays offline and
dependency-free.

## Modes

| Mode | What runs |
|------|-----------|
| `fts` | FTS5 + BM25 only (`FOSSEL_EMBEDDINGS` unset) |
| `vector` | `vectorSearch` only — pure cosine over the embedding index |
| `hybrid` | FTS5 and vector fused with Reciprocal Rank Fusion (`FOSSEL_EMBEDDINGS=1`) |

## Surfaces

Two numbers are reported for every mode, because reporting only one would
mislead:

- **search** — the pure ranked search contribution. Comparable across all three
  modes; this is the retrieval quality number.
- **context** — everything `get_context` actually hands to the model, including
  the recent-memory backfill that fills leftover slots. Higher than `search` by
  construction, because backfill sometimes catches a relevant row by luck.

## Metrics

Definitions are explicit because "R@5" is used inconsistently across projects:

- **hit@k** — fraction of queries with *at least one* relevant memory in the top
  k. This is what agent-memory leaderboards usually call R@k.
- **recall@k** — mean of `|relevant ∩ topK| / |relevant|`. How much of the full
  answer set was recovered, which matters for multi-answer queries.
- **MRR** — mean reciprocal rank of the first relevant memory.
- **nDCG@k** — normalized discounted cumulative gain, binary relevance.

## Datasets

### `repo-memory` (committed, offline)

45 memories and 33 labelled queries for a fictional e-commerce codebase. This is
the domain-accurate eval: it measures the thing Fossel is actually for.

Query categories are chosen to be fair rather than flattering:

| Category | What it probes |
|----------|----------------|
| `exact` | literal term overlap — keyword search should win outright |
| `identifier` | camelCase symbols and filenames — embeddings cannot help |
| `path` | `/api/v2`, `src/auth/rbac.ts` — tests tokenization |
| `ticket` | `#412`, `JIRA-2291` |
| `paraphrase` | natural-language questions with little term overlap |
| `synonym` | requires connecting unrelated vocabulary — the honest ceiling |
| `multi` | several memories are correct; tests recall, not just hit |
| `superseded` | an outdated memory is planted that outranks the current one lexically |

Design constraints that keep the numbers honest:

- No pinned memories. Pinned rows always lead `fetchRepoContext` regardless of
  the query, so including them would measure pinning instead of search.
- Memories are ingested with direct SQL, not through `remember`. The write path
  infers types, grounds relative dates and merges near-duplicates, all of which
  would silently rewrite the dataset and invalidate the labels.
- Array order is recency order, and rarely-queried memories are placed first on
  purpose, so the recent-memory backfill cannot inflate the `context` numbers.

### `longmemeval` (requires a download)

[LongMemEval-S](https://huggingface.co/datasets/xiaowu0162/longmemeval)
(ICLR 2025) is included for cross-project comparability — it is the number
comparable memory projects quote. The dataset is **not** redistributed here.

```bash
npm run bench -- --dataset longmemeval --file ./longmemeval_s.json
npm run bench -- --dataset longmemeval --file ./longmemeval_s.json --max-questions 50
npm run bench -- --dataset longmemeval --file ./longmemeval_s.json --granularity turn
```

Be clear about what it does and does not measure: LongMemEval is a
*conversational* memory benchmark (chat sessions, questions about what a user
said). The retrieval mechanics under test are the same, but the domain is not
Fossel's. The `repo-memory` set is the one that measures the product.

Mapping decisions: one namespace per question (`lme/<question_id>`), because
each question ships its own haystack and pooling them would create a different,
harder task; session granularity by default, matching the session-level recall
figures usually quoted.

To verify the adapter without downloading anything:

```bash
npm run bench -- --dataset longmemeval --file bench/fixtures/longmemeval-sample.json --no-write
```

## Tuning sweeps

Retrieval constants are chosen by measurement, not by feel:

```bash
npx tsx bench/sweep.ts                  # sweep the vector-leg fusion weight
npx tsx bench/sweep.ts --sweep floor    # sweep the vector cosine floor
npx tsx bench/sweep.ts --sweep vector --values 0,0.2,0.5,1
```

Every sweep prints an `fts-only` row measured in the same run, so each setting is
compared against the keyword-only baseline rather than against a remembered
number.

One lesson worth repeating: **the fusion weight is coupled to embedder quality
and must be re-swept whenever the embedder changes.** It moved from 0.2 to 0.8
over the course of Phase 2 as IDF weighting and character n-grams made the vector
leg stronger.

## Reading the output

The most useful section is the per-mode miss list at the bottom — the actual
queries that returned nothing relevant, with what came back instead. Aggregate
percentages tell you whether something moved; the miss list tells you why, and it
is what drove the largest improvement in the project (the stemmed-prefix tier was
designed by reading it, not by guessing).
