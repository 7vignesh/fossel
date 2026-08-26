/**
 * Benchmark harness.
 *
 * Ingests a labelled dataset into a throwaway SQLite database and evaluates
 * Fossel's retrieval paths against it. Three properties matter:
 *
 *  1. **Deterministic ingest.** Memories are inserted with direct SQL rather
 *     than through `remember`, because `remember` infers types, grounds relative
 *     dates, and merges near-duplicates — all of which would silently rewrite
 *     the dataset and make the labels wrong. This benchmark measures retrieval,
 *     so the write path is deliberately held constant.
 *
 *  2. **Isolated modes.** Each mode gets a fresh database, so vectors written
 *     under one configuration can never leak into another.
 *
 *  3. **Two surfaces per mode.** `search` is the pure ranked search
 *     contribution; `context` is everything `get_context` actually hands to the
 *     model, including the recent-memory backfill that fills leftover slots.
 *     Reporting only `context` would flatter the numbers (backfill can catch a
 *     relevant row by luck); reporting only `search` would not describe what the
 *     model really sees. Both are published.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../src/db/migrate.js";
import { fetchRepoContext } from "../../src/lib/context.js";
import { normalizeText } from "../../src/lib/dedupe.js";
import type { FusionWeights } from "../../src/lib/fusion.js";
import { backfillRepoEmbeddings, vectorSearch } from "../../src/lib/vector-index.js";
import { summarize, summarizeByCategory, type MetricSummary, type QueryOutcome } from "./metrics.js";

export type RetrievalMode = "fts" | "vector" | "hybrid";

export const ALL_MODES: RetrievalMode[] = ["fts", "vector", "hybrid"];

export type MemoryType =
  | "convention"
  | "bug_fix"
  | "reviewer_pattern"
  | "decision"
  | "issue"
  | "general";

export interface BenchMemory {
  /** Stable label used by queries to point at this memory. */
  key: string;
  note: string;
  type?: MemoryType;
  tags?: string[];
  /** Overrides the dataset-level repo. Needed by datasets like LongMemEval
   * where every question carries its own isolated haystack. */
  repo?: string;
}

export interface BenchQuery {
  id: string;
  query: string;
  /** Keys of the memories that count as correct for this query. */
  relevant: string[];
  /** Free-form grouping label, e.g. "paraphrase" or "identifier". */
  category: string;
  /** Optional note explaining what the case is probing. */
  rationale?: string;
  /** Repo to search. Defaults to the dataset-level repo. */
  repo?: string;
}

export interface BenchDataset {
  name: string;
  description?: string;
  repo: string;
  memories: BenchMemory[];
  queries: BenchQuery[];
}

/**
 * Base timestamp for ingest. Memories are written with `updated_at = BASE - i`,
 * so the dataset array order *is* the recency order (first entry is newest).
 * Making this explicit keeps the recent-memory backfill deterministic instead of
 * depending on insertion wall-clock time.
 */
const BASE_TIMESTAMP = 1_700_000_000;

export interface IngestedDb {
  db: Database.Database;
  /** dataset key -> sqlite rowid */
  keyToRowId: Map<string, number>;
  /** sqlite rowid -> dataset key */
  rowIdToKey: Map<number, string>;
  /** Every distinct repo the dataset wrote into. */
  repos: Set<string>;
  cleanup: () => void;
}

export function ingest(dataset: BenchDataset): IngestedDb {
  const dir = mkdtempSync(join(tmpdir(), "fossel-bench-"));
  const db = new Database(join(dir, "bench.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  const insert = db.prepare(
    `
      INSERT INTO memories (id, repo, type, note, tags, created_at, updated_at, pinned, metadata_json, note_normalized)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, '{}', ?)
    `,
  );

  const keyToRowId = new Map<string, number>();
  const rowIdToKey = new Map<number, string>();
  const repos = new Set<string>();

  const tx = db.transaction(() => {
    dataset.memories.forEach((memory, index) => {
      const timestamp = BASE_TIMESTAMP - index;
      const repo = memory.repo ?? dataset.repo;
      repos.add(repo);
      const result = insert.run(
        `bench-${memory.key}`,
        repo,
        memory.type ?? "general",
        memory.note,
        JSON.stringify(memory.tags ?? []),
        timestamp,
        timestamp,
        normalizeText(memory.note),
      );
      const rowId = Number(result.lastInsertRowid);
      keyToRowId.set(memory.key, rowId);
      rowIdToKey.set(rowId, memory.key);
    });
  });
  tx();

  return {
    db,
    keyToRowId,
    rowIdToKey,
    repos,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Toggle the embeddings flag for the duration of a callback, restoring the
 * previous value afterwards. `embeddingsEnabled()` reads the env var at call
 * time, so modes can be switched in-process without spawning subprocesses.
 */
function withEmbeddings<T>(enabled: boolean, fn: () => T): T {
  const previous = process.env.FOSSEL_EMBEDDINGS;
  if (enabled) {
    process.env.FOSSEL_EMBEDDINGS = "1";
  } else {
    delete process.env.FOSSEL_EMBEDDINGS;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.FOSSEL_EMBEDDINGS;
    } else {
      process.env.FOSSEL_EMBEDDINGS = previous;
    }
  }
}

interface RankedLists {
  /** Pure search ranking, comparable across all three modes. */
  search: string[];
  /** What `get_context` returns, backfill included. */
  context: string[];
}

export interface TuningOverrides {
  weights?: Partial<FusionWeights>;
  vectorScoreFloor?: number;
}

function retrieve(
  ingested: IngestedDb,
  repo: string,
  mode: RetrievalMode,
  query: string,
  limit: number,
  tuning: TuningOverrides = {},
): RankedLists {
  const { db, rowIdToKey } = ingested;
  const toKeys = (rowIds: number[]): string[] =>
    rowIds
      .map((rowId) => rowIdToKey.get(rowId))
      .filter((key): key is string => key !== undefined);

  if (mode === "vector") {
    return withEmbeddings(true, () => {
      const matches = vectorSearch(db, repo, query, limit);
      const keys = toKeys(matches.map((row) => row.row_id));
      // Vector-only has no recent backfill; the two surfaces coincide.
      return { search: keys, context: keys };
    });
  }

  return withEmbeddings(mode === "hybrid", () => {
    const rows = fetchRepoContext(db, repo, limit, query, tuning);
    return {
      search: toKeys(
        rows.filter((row) => row.source === "search").map((row) => row.row_id),
      ),
      context: toKeys(rows.map((row) => row.row_id)),
    };
  });
}

export interface ModeResult {
  mode: RetrievalMode;
  limit: number;
  search: MetricSummary;
  context: MetricSummary;
  byCategory: Record<string, MetricSummary>;
  /** Queries where the pure search surface returned nothing relevant in the
   * top `limit`. The most useful output of the whole harness. */
  failures: Array<{
    id: string;
    query: string;
    category: string;
    expected: string[];
    got: string[];
  }>;
}

export function evaluate(
  dataset: BenchDataset,
  mode: RetrievalMode,
  limit = 10,
  tuning: TuningOverrides = {},
): ModeResult {
  const ingested = ingest(dataset);
  try {
    if (mode !== "fts") {
      // Populate vectors up front so the first query isn't charged for the
      // whole repo's backfill.
      withEmbeddings(true, () => {
        for (const repo of ingested.repos) {
          backfillRepoEmbeddings(ingested.db, repo);
        }
      });
    }

    const searchOutcomes: QueryOutcome[] = [];
    const contextOutcomes: QueryOutcome[] = [];
    const labelled: Array<{ category: string; outcome: QueryOutcome }> = [];
    const failures: ModeResult["failures"] = [];

    for (const query of dataset.queries) {
      const lists = retrieve(
        ingested,
        query.repo ?? dataset.repo,
        mode,
        query.query,
        limit,
        tuning,
      );

      const searchOutcome: QueryOutcome = {
        retrieved: lists.search,
        relevant: query.relevant,
      };
      searchOutcomes.push(searchOutcome);
      contextOutcomes.push({ retrieved: lists.context, relevant: query.relevant });
      labelled.push({ category: query.category, outcome: searchOutcome });

      const relevant = new Set(query.relevant);
      if (!lists.search.some((key) => relevant.has(key))) {
        failures.push({
          id: query.id,
          query: query.query,
          category: query.category,
          expected: query.relevant,
          got: lists.search.slice(0, 5),
        });
      }
    }

    return {
      mode,
      limit,
      search: summarize(searchOutcomes),
      context: summarize(contextOutcomes),
      byCategory: summarizeByCategory(labelled),
      failures,
    };
  } finally {
    ingested.cleanup();
  }
}


/**
 * Evaluate hybrid mode under specific tuning overrides. Used by the sweep tool.
 * A vector weight of 0 makes this exactly FTS-only, which is a useful same-run
 * baseline.
 */
export function evaluateHybridTuned(
  dataset: BenchDataset,
  tuning: TuningOverrides,
  limit = 10,
): ModeResult {
  return evaluate(dataset, "hybrid", limit, tuning);
}
