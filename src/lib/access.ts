import type Database from "better-sqlite3";

/**
 * Record that a set of memories were accessed (returned to the user).
 * Called after fetchRepoContext assembles its result set.
 * Batches the UPDATE into a single transaction for performance.
 */
export function recordAccess(db: Database.Database, rowIds: number[]): void {
  if (rowIds.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(
    `UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE rowid = ?`,
  );
  const batch = db.transaction((ids: number[]) => {
    for (const id of ids) {
      stmt.run(now, id);
    }
  });
  batch(rowIds);
}
