/**
 * Inverse document frequency over a repo's memories, used to weight *query*
 * embeddings.
 *
 * The built-in hashed embedder gives every token the same weight, so a query
 * like "how are prices represented in the database?" spends most of its vector
 * on `how`, `are`, `in` and `the` — words that appear in half the corpus and
 * discriminate nothing. BM25 already handles this on the keyword side (that is
 * what its IDF term does); the vector side had no equivalent. This supplies one.
 *
 * **Query side only, deliberately.** Applying corpus-derived weights when
 * *storing* a vector would make every stored vector a function of the corpus at
 * write time, so adding a memory would silently invalidate the vectors of every
 * other memory and force a full re-index. Weighting only the query keeps stored
 * vectors a pure function of their own text — no migration, no
 * `EMBEDDING_VERSION` bump, no re-index — and asymmetric query/document
 * weighting is a standard tf-idf variant, not a hack.
 *
 * Features are counted over the same unigram + bigram space the embedder hashes,
 * so weights line up with the features they scale.
 */

import type Database from "better-sqlite3";
import { tokenizeForEmbedding } from "./embeddings.js";

export interface RepoIdf {
  /** Number of memories the statistics were computed over. */
  documentCount: number;
  /** Weight for a feature; 1 for features never seen in the corpus. */
  weightFor: (feature: string) => number;
}

/**
 * Smoothed IDF. `ln(1 + N/df)` is always positive, grows as a feature gets
 * rarer, and avoids the negative weights that plain `ln(N/df)` produces for
 * features present in more than half the corpus.
 */
function idf(documentCount: number, documentFrequency: number): number {
  return Math.log(1 + documentCount / documentFrequency);
}

/** Extract the unigram + bigram feature set of a note, deduplicated — document
 * frequency counts documents, not occurrences. */
function featuresOf(text: string): Set<string> {
  const tokens = tokenizeForEmbedding(text);
  const features = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    features.add(tokens[i]);
    if (i + 1 < tokens.length) {
      features.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
  }
  return features;
}

interface CacheEntry {
  documentCount: number;
  frequencies: Map<string, number>;
}

/**
 * Cache keyed by repo. Invalidated when the repo's memory count changes, which
 * is a cheap proxy for "the corpus moved". An edit that leaves the count
 * unchanged will reuse slightly stale weights until the next insert or delete —
 * an acceptable trade, because these weights only reorder query terms and a
 * marginally stale IDF cannot produce a wrong result, only a slightly
 * differently ranked one.
 */
const cache = new Map<string, CacheEntry>();

/** Drop cached statistics. Exported for tests. */
export function clearIdfCache(): void {
  cache.clear();
}

/**
 * Compute (or reuse) IDF statistics for a repo. Returns weights of 1 for an
 * empty corpus, which makes the weighted embedding identical to the unweighted
 * one — so enabling this can never make a fresh repo behave differently.
 */
export function computeRepoIdf(db: Database.Database, repo: string): RepoIdf {
  const countRow = db
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE repo = ?")
    .get(repo) as { count: number };
  const documentCount = countRow.count;

  if (documentCount === 0) {
    return { documentCount: 0, weightFor: () => 1 };
  }

  const cached = cache.get(repo);
  if (cached && cached.documentCount === documentCount) {
    return {
      documentCount,
      weightFor: (feature) => {
        const df = cached.frequencies.get(feature);
        return df === undefined ? 1 : idf(documentCount, df);
      },
    };
  }

  const rows = db
    .prepare("SELECT note FROM memories WHERE repo = ?")
    .all(repo) as Array<{ note: string }>;

  const frequencies = new Map<string, number>();
  for (const row of rows) {
    for (const feature of featuresOf(row.note)) {
      frequencies.set(feature, (frequencies.get(feature) ?? 0) + 1);
    }
  }

  cache.set(repo, { documentCount, frequencies });

  return {
    documentCount,
    weightFor: (feature) => {
      const df = frequencies.get(feature);
      // A feature absent from the corpus cannot be discriminated on, but it also
      // should not be suppressed — leave it at neutral weight.
      return df === undefined ? 1 : idf(documentCount, df);
    },
  };
}
