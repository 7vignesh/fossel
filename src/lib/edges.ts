/**
 * Typed edges between memories (#62).
 *
 * Edges are keyed by `memories.id` (the nanoid), never by rowid: SQLite reuses
 * the rowid of a deleted row, but edges outlive their endpoints as history.
 * Deleting a memory ends its edges (sets `valid_to`) via the trigger from
 * migration 014; nothing here hard-deletes an edge.
 *
 * Writes are idempotent through the (src_id, dst_id, type) primary key and
 * `ON CONFLICT DO NOTHING`, because conflict review proposes the same edge on
 * every `remember`.
 */

import type Database from "better-sqlite3";
import type { RelatedCandidate } from "./dedupe.js";

export const EDGE_TYPES = ["fixes", "contradicts", "supersedes", "relates_to"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** Edge types with no direction. Stored with src_id < dst_id so A->B and B->A
 * are the same row. */
const SYMMETRIC: ReadonlySet<EdgeType> = new Set(["contradicts", "relates_to"]);

export interface MemoryEdge {
  src_id: string;
  dst_id: string;
  type: EdgeType;
  weight: number | null;
  created_at: number;
  valid_from: number;
  valid_to: number | null;
}

/** Order the endpoints the way the table stores them. */
export function normalizeEdge(
  srcId: string,
  dstId: string,
  type: EdgeType,
): { src_id: string; dst_id: string } {
  if (SYMMETRIC.has(type) && dstId < srcId) {
    return { src_id: dstId, dst_id: srcId };
  }
  return { src_id: srcId, dst_id: dstId };
}

/**
 * Record a live edge. Returns true when a row was written, false when the edge
 * already existed (live or ended). Throws if the endpoints are not two existing
 * memories in the same repo (enforced by the table's trigger).
 *
 * Re-recording an edge that already ended does not revive it: the ended row is
 * history, and the primary key leaves no room for a second row.
 */
export function recordEdge(
  db: Database.Database,
  srcId: string,
  dstId: string,
  type: EdgeType,
  options: { weight?: number; now?: number } = {},
): boolean {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const { src_id, dst_id } = normalizeEdge(srcId, dstId, type);
  const result = db
    .prepare(
      `
        INSERT INTO memory_edges (src_id, dst_id, type, weight, created_at, valid_from)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `,
    )
    .run(src_id, dst_id, type, options.weight ?? null, now, now);
  return result.changes > 0;
}

/**
 * Persist the conflict-review result of a newly written memory as edges:
 * a flagged possible contradiction becomes `contradicts`, anything else
 * `relates_to`. The similarity is kept as the edge weight. Returns the number
 * of new edges written.
 */
export function recordRelatedEdges(
  db: Database.Database,
  memoryId: string,
  related: RelatedCandidate[],
): number {
  let written = 0;
  for (const candidate of related) {
    if (candidate.memory.id === memoryId) continue;
    const type: EdgeType = candidate.possibleContradiction ? "contradicts" : "relates_to";
    if (
      recordEdge(db, memoryId, candidate.memory.id, type, {
        weight: Number(candidate.similarity.toFixed(3)),
      })
    ) {
      written += 1;
    }
  }
  return written;
}

/**
 * Move a memory's edges onto another memory before the first is deleted
 * (dedupe). Edges that would duplicate one the survivor already has, or that
 * would connect the survivor to itself, are dropped: the survivor's own row
 * carries the relationship. Live and ended edges are both moved, so history
 * survives the merge.
 *
 * Runs per edge rather than as one `UPDATE OR IGNORE`, because symmetric types
 * may need their endpoints swapped to keep src_id < dst_id.
 */
export function repointEdges(db: Database.Database, fromId: string, toId: string): number {
  if (fromId === toId) return 0;

  const edges = db
    .prepare(
      "SELECT * FROM memory_edges WHERE src_id = ? OR dst_id = ?",
    )
    .all(fromId, fromId) as MemoryEdge[];

  const insert = db.prepare(
    `
      INSERT INTO memory_edges (src_id, dst_id, type, weight, created_at, valid_from, valid_to)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `,
  );
  const remove = db.prepare(
    "DELETE FROM memory_edges WHERE src_id = ? AND dst_id = ? AND type = ?",
  );

  let moved = 0;
  for (const edge of edges) {
    const src = edge.src_id === fromId ? toId : edge.src_id;
    const dst = edge.dst_id === fromId ? toId : edge.dst_id;
    remove.run(edge.src_id, edge.dst_id, edge.type);
    if (src === dst) continue;
    const ordered = normalizeEdge(src, dst, edge.type);
    const result = insert.run(
      ordered.src_id,
      ordered.dst_id,
      edge.type,
      edge.weight,
      edge.created_at,
      edge.valid_from,
      edge.valid_to,
    );
    if (result.changes > 0) moved += 1;
  }
  return moved;
}

/** Every edge with at least one endpoint in `memoryIds`, live and ended. */
export function edgesForMemories(db: Database.Database, memoryIds: string[]): MemoryEdge[] {
  if (memoryIds.length === 0) return [];
  // Chunk to stay well under SQLite's bound-parameter limit.
  const out = new Map<string, MemoryEdge>();
  const CHUNK = 400;
  for (let i = 0; i < memoryIds.length; i += CHUNK) {
    const chunk = memoryIds.slice(i, i + CHUNK);
    const marks = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `
          SELECT * FROM memory_edges
          WHERE src_id IN (${marks}) OR dst_id IN (${marks})
        `,
      )
      .all(...chunk, ...chunk) as MemoryEdge[];
    for (const row of rows) {
      out.set(`${row.src_id}\u0000${row.dst_id}\u0000${row.type}`, row);
    }
  }
  return Array.from(out.values()).sort(
    (a, b) =>
      a.src_id.localeCompare(b.src_id) ||
      a.dst_id.localeCompare(b.dst_id) ||
      a.type.localeCompare(b.type),
  );
}
