import type Database from "better-sqlite3";
import type { MemoryRecord } from "../db/client.js";

export type MemoryIdInput = number | string;

/**
 * Look up a memory by either numeric row_id or legacy string id. Tools accept
 * both forms so users can paste whichever id format they have on hand.
 *
 * Returns `null` when nothing matches so callers can render a consistent
 * "not found" message rather than dealing with `undefined`.
 */
export function findMemoryByAnyId(
  db: Database.Database,
  input: MemoryIdInput,
): MemoryRecord | null {
  const numeric = typeof input === "number" ? input : Number(input);
  const isNumericId =
    Number.isInteger(numeric) && numeric > 0 && String(numeric) === String(input).trim();

  if (isNumericId) {
    const row = db
      .prepare(
        `
          SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned
          FROM memories
          WHERE rowid = ?
        `,
      )
      .get(numeric) as MemoryRecord | undefined;
    if (row) {
      return row;
    }
  }

  // Fall back to legacy string id (nanoid). Some tools historically used the
  // string id even when the user passed a numeric form, so we try both.
  const stringInput = String(input).trim();
  if (stringInput.length === 0) {
    return null;
  }

  const stringRow = db
    .prepare(
      `
        SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned
        FROM memories
        WHERE id = ?
      `,
    )
    .get(stringInput) as MemoryRecord | undefined;

  return stringRow ?? null;
}
