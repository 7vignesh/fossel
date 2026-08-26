/**
 * Vector index helpers: persist and query memory embeddings.
 *
 * All functions here are no-ops or empty results when embeddings are disabled
 * (`FOSSEL_EMBEDDINGS` unset), so callers can invoke them unconditionally and
 * the zero-config default stays untouched.
 */

import type Database from "better-sqlite3";
import type { MemoryRecord } from "../db/client.js";
import {
  activeEmbeddingMeta,
  bufferToVector,
  cosineSimilarity,
  embedBatchExternal,
  embedText,
  embedTextHashed,
  embeddingsEnabled,
  externalEmbedderConfigured,
  vectorToBuffer,
} from "./embeddings.js";
import { computeRepoIdf } from "./idf.js";

export interface VectorMatch extends MemoryRecord {
  score: number;
}

/**
 * Compute and store the embedding for a single memory row. Safe to call on
 * every write; does nothing when embeddings are disabled.
 */
export function indexMemoryEmbedding(
  db: Database.Database,
  rowId: number,
  note: string,
): void {
  if (!embeddingsEnabled()) {
    return;
  }
  const vector = embedText(note);
  const { dim, version } = activeEmbeddingMeta();
  db.prepare(
    `
      INSERT INTO memory_embeddings (memory_rowid, dim, version, vector, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(memory_rowid) DO UPDATE SET
        dim = excluded.dim,
        version = excluded.version,
        vector = excluded.vector,
        updated_at = excluded.updated_at
    `,
  ).run(
    rowId,
    dim,
    version,
    vectorToBuffer(vector),
    Math.floor(Date.now() / 1000),
  );
}

/**
 * Backfill embeddings for any memories in `repo` that are missing a current
 * vector (never indexed, or indexed under a stale algorithm version). Returns
 * the number of rows indexed. No-op when embeddings are disabled.
 */
export function backfillRepoEmbeddings(
  db: Database.Database,
  repo: string,
): number {
  if (!embeddingsEnabled()) {
    return 0;
  }

  const { dim, version } = activeEmbeddingMeta();
  const rows = db
    .prepare(
      `
        SELECT m.rowid AS row_id, m.note
        FROM memories AS m
        LEFT JOIN memory_embeddings AS e ON e.memory_rowid = m.rowid
        WHERE m.repo = ?
          AND (e.memory_rowid IS NULL OR e.version != ? OR e.dim != ?)
      `,
    )
    .all(repo, version, dim) as Array<{
    row_id: number;
    note: string;
  }>;

  if (rows.length === 0) {
    return 0;
  }

  // With an external embedder, embed the whole batch in one process spawn.
  // Doing it per row would cost one spawn — and for a real model, one model
  // load — per memory, which is what made the external embedder impractical to
  // backfill at any real size. A null result means the embedder does not speak
  // the batch protocol (or failed), so we fall through to the per-row path.
  if (externalEmbedderConfigured() && rows.length > 1) {
    const vectors = embedBatchExternal(rows.map((row) => row.note));
    if (vectors && vectors.length === rows.length) {
      const write = db.prepare(
        `
          INSERT INTO memory_embeddings (memory_rowid, dim, version, vector, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(memory_rowid) DO UPDATE SET
            dim = excluded.dim,
            version = excluded.version,
            vector = excluded.vector,
            updated_at = excluded.updated_at
        `,
      );
      const now = Math.floor(Date.now() / 1000);
      const batchTx = db.transaction(() => {
        rows.forEach((row, index) => {
          const vector = vectors[index];
          write.run(
            row.row_id,
            vector.length,
            version,
            vectorToBuffer(vector),
            now,
          );
        });
      });
      batchTx();
      return rows.length;
    }
  }

  const tx = db.transaction((batch: typeof rows) => {
    for (const row of batch) {
      indexMemoryEmbedding(db, row.row_id, row.note);
    }
  });
  tx(rows);
  return rows.length;
}

/**
 * Rank memories in `repo` by cosine similarity to `query`. Brute-force over
 * the repo's vectors, which is fast for a local per-repo store (hundreds to a
 * few thousand rows). Returns up to `limit` matches sorted best-first. Returns
 * an empty list when embeddings are disabled or the repo has no vectors.
 */
export function vectorSearch(
  db: Database.Database,
  repo: string,
  query: string,
  limit: number,
): VectorMatch[] {
  if (!embeddingsEnabled()) {
    return [];
  }

  // Make sure anything written before the feature was enabled is searchable.
  backfillRepoEmbeddings(db, repo);

  // Weight the *query* by inverse document frequency so common words contribute
  // less of its direction. Stored vectors stay unweighted pure-TF — see
  // lib/idf.ts for why weighting both sides would force a full re-index. An
  // external embedder owns its own weighting, so IDF only applies to the
  // built-in hashed path.
  const queryVector = externalEmbedderConfigured()
    ? embedText(query)
    : embedTextHashed(query, {
        featureWeight: computeRepoIdf(db, repo).weightFor,
      });
  // An all-zero query vector (empty/punctuation-only) can't match anything.
  let queryNorm = 0;
  for (let i = 0; i < queryVector.length; i += 1) {
    queryNorm += queryVector[i] * queryVector[i];
  }
  if (queryNorm === 0) {
    return [];
  }

  const { dim, version } = activeEmbeddingMeta();
  const rows = db
    .prepare(
      `
        SELECT m.rowid AS row_id, m.id, m.repo, m.type, m.note, m.tags,
               m.created_at, m.updated_at, m.pinned, e.vector AS vector
        FROM memory_embeddings AS e
        JOIN memories AS m ON m.rowid = e.memory_rowid
        WHERE m.repo = ? AND e.dim = ? AND e.version = ? AND m.valid_to IS NULL
      `,
    )
    .all(repo, dim, version) as Array<
    MemoryRecord & { vector: Buffer }
  >;

  const scored: VectorMatch[] = [];
  for (const row of rows) {
    const { vector, ...memory } = row;
    const score = cosineSimilarity(queryVector, bufferToVector(vector));
    if (score > 0) {
      scored.push({ ...memory, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
