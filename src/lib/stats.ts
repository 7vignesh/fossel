import type Database from "better-sqlite3";

export interface HealthMetrics {
  /** Live memory count for the repo (valid_to IS NULL). */
  live: number;
  /** Superseded (tombstoned) memory count. */
  superseded: number;
  /**
   * Memories that have never been accessed (access_count = 0) and are older
   * than `staleDays`. null when access tracking is unavailable.
   */
  stale: number | null;
  /** The staleDays threshold used for the stale count. */
  staleDays: number;
  /** Memories that have an embedding vector. null when the table is absent. */
  withEmbeddings: number | null;
  /** Memories that have at least one extracted entity. null when absent. */
  withEntities: number | null;
  /** Memories that reference at least one file. null when absent. */
  withFileRefs: number | null;
}

/**
 * Read-only health metrics for a single repo, used by `fossel doctor`. Every
 * optional metric is computed defensively: if the column or side table does
 * not exist (older db, or a feature never enabled), that metric is null rather
 * than throwing, so the doctor report degrades gracefully.
 */
export function gatherHealthMetrics(
  db: Database.Database,
  repo: string,
  staleDays = 90,
): HealthMetrics {
  const counts = db
    .prepare(
      `
        SELECT
          SUM(CASE WHEN valid_to IS NULL THEN 1 ELSE 0 END) AS live,
          SUM(CASE WHEN valid_to IS NOT NULL THEN 1 ELSE 0 END) AS superseded
        FROM memories
        WHERE repo = ?
      `,
    )
    .get(repo) as { live: number | null; superseded: number | null };

  const now = Math.floor(Date.now() / 1000);
  const staleThreshold = now - staleDays * 86400;

  return {
    live: counts.live ?? 0,
    superseded: counts.superseded ?? 0,
    stale: countSafe(db, (d) =>
      (
        d
          .prepare(
            `
              SELECT COUNT(*) AS n
              FROM memories
              WHERE repo = ? AND valid_to IS NULL
                AND access_count = 0 AND updated_at < ?
            `,
          )
          .get(repo, staleThreshold) as { n: number }
      ).n,
    ),
    staleDays,
    withEmbeddings: countSafe(db, (d) => countSide(d, repo, "memory_embeddings")),
    withEntities: countSafe(db, (d) => countSide(d, repo, "memory_entities")),
    withFileRefs: countSafe(db, (d) => countSide(d, repo, "memory_file_refs")),
  };
}

/** Count live memories in `repo` that have at least one row in a side table. */
function countSide(db: Database.Database, repo: string, table: string): number {
  return (
    db
      .prepare(
        `
          SELECT COUNT(DISTINCT m.rowid) AS n
          FROM memories m
          JOIN ${table} s ON s.memory_rowid = m.rowid
          WHERE m.repo = ? AND m.valid_to IS NULL
        `,
      )
      .get(repo) as { n: number }
  ).n;
}

/** Run a count query, returning null if the underlying column/table is absent. */
function countSafe(
  db: Database.Database,
  fn: (db: Database.Database) => number,
): number | null {
  try {
    return fn(db);
  } catch {
    return null;
  }
}
