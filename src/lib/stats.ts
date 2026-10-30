import type Database from "better-sqlite3";
import { MEMORY_TYPES, type MemoryType } from "../db/client.js";
import { parseTags } from "./context.js";
import { findStaleFileRefs } from "./file-refs.js";

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

export interface RepoStats {
  /** Live memory count per type. Every type is present, zero when unused. */
  byType: Record<MemoryType, number>;
  /** Live pinned memories. */
  pinned: number;
  /** Live memories referencing at least one file that changed since the memory
   * was written (git drift). 0 outside a git repo. */
  drifted: number;
  /** Most frequent tags on live memories, highest count first. */
  topTags: Array<{ tag: string; count: number }>;
  /** Most frequent extracted entities on live memories. null when the entity
   * table is absent. */
  topEntities: Array<{ entity: string; kind: string; count: number }> | null;
}

/**
 * Read-only summary of what Fossel holds for one repo, used by `fossel stats`.
 * Only live memories (valid_to IS NULL) are counted. `cwd` is the workspace
 * used for the git-drift check.
 */
export function gatherRepoStats(
  db: Database.Database,
  repo: string,
  cwd: string,
  top = 5,
): RepoStats {
  const live = db
    .prepare(
      `
        SELECT rowid AS row_id, type, tags, pinned
        FROM memories
        WHERE repo = ? AND valid_to IS NULL
      `,
    )
    .all(repo) as Array<{ row_id: number; type: MemoryType; tags: string; pinned: number }>;

  const byType = Object.fromEntries(MEMORY_TYPES.map((type) => [type, 0])) as Record<
    MemoryType,
    number
  >;
  const tagCounts = new Map<string, number>();
  let pinned = 0;
  for (const row of live) {
    byType[row.type] += 1;
    if (row.pinned === 1) pinned += 1;
    for (const tag of parseTags(row.tags)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const topTags = Array.from(tagCounts, ([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, top);

  let topEntities: RepoStats["topEntities"];
  try {
    topEntities = db
      .prepare(
        `
          SELECT e.entity, e.kind, COUNT(*) AS count
          FROM memory_entities e
          JOIN memories m ON m.rowid = e.memory_rowid
          WHERE m.repo = ? AND m.valid_to IS NULL
          GROUP BY e.entity, e.kind
          ORDER BY count DESC, e.entity ASC
          LIMIT ?
        `,
      )
      .all(repo, top) as Array<{ entity: string; kind: string; count: number }>;
  } catch {
    topEntities = null;
  }

  // Only memories with a tracked file ref can drift, so check just those. This
  // also keeps the IN (...) list in findStaleFileRefs small on large repos.
  const withRefs = db
    .prepare(
      `
        SELECT DISTINCT r.memory_rowid AS row_id
        FROM memory_file_refs r
        JOIN memories m ON m.rowid = r.memory_rowid
        WHERE m.repo = ? AND m.valid_to IS NULL AND r.tracked = 1
      `,
    )
    .all(repo) as Array<{ row_id: number }>;
  const drifted = findStaleFileRefs(
    db,
    withRefs.map((row) => row.row_id),
    cwd,
  ).size;

  return { byType, pinned, drifted, topTags, topEntities };
}
