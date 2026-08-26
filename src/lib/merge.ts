/**
 * Repo-wide near-duplicate merging.
 *
 * `lib/dedupe.ts` owns the similarity primitives (how alike are two notes?).
 * This module owns the *operation* built on top of them: scan a repo, decide
 * which rows collapse into which, and apply the merge. It lives in `lib` rather
 * than inside the MCP tool so the planning and apply steps are unit-testable
 * without standing up a server, matching how the rest of the domain logic is
 * organized.
 */

import type Database from "better-sqlite3";
import type { MemoryRecord } from "../db/client.js";
import { normalizeText, similarity } from "./dedupe.js";
import { indexMemoryEmbedding } from "./vector-index.js";

export interface MergeCandidate extends MemoryRecord {
  metadata_json: string;
}

export interface MergePlanEntry {
  /** rowid of the row that survives the merge. */
  keep: number;
  /** rowid of the row that gets folded into `keep` and deleted. */
  drop: number;
  similarity: number;
}

interface MetadataChangelogEntry {
  at: number;
  action: "merged" | "created" | "deduped";
  similarity?: number;
  previous_note?: string;
  merged_from?: number;
}

interface StoredMetadata {
  changelog?: MetadataChangelogEntry[];
  [key: string]: unknown;
}

export function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function parseMetadata(raw: string): StoredMetadata {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StoredMetadata;
    }
  } catch {
    /* fall through */
  }
  return {};
}

export function mergeTagLists(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const value of list) {
      const trimmed = value.trim().toLowerCase();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/** Load every memory in `repo`, newest-updated first, with metadata attached. */
export function fetchMergeCandidates(
  db: Database.Database,
  repo: string,
): MergeCandidate[] {
  return db
    .prepare(
      `
        SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned, metadata_json
        FROM memories
        WHERE repo = ?
        ORDER BY updated_at DESC
      `,
    )
    .all(repo) as MergeCandidate[];
}

/**
 * Greedy clustering: walk newest-first and fold older similar rows into the
 * newer "keep" row. Each row participates in at most one merge, so the plan is
 * always a set of disjoint pairs and can be applied in any order.
 *
 * Rows of differing `type` are never merged, so a `decision` can't be collapsed
 * into a `convention`.
 */
export function planMerges(
  rows: MergeCandidate[],
  threshold: number,
): MergePlanEntry[] {
  const consumed = new Set<number>();
  const plan: MergePlanEntry[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const keep = rows[i];
    if (!keep || consumed.has(keep.row_id)) continue;

    for (let j = i + 1; j < rows.length; j += 1) {
      const other = rows[j];
      if (!other || consumed.has(other.row_id)) continue;
      if (other.type !== keep.type) continue;

      const score = similarity(keep.note, other.note);
      if (score >= threshold) {
        plan.push({ keep: keep.row_id, drop: other.row_id, similarity: score });
        consumed.add(other.row_id);
      }
    }
  }

  return plan;
}

/**
 * Apply a merge plan inside a single transaction. For each pair the kept row
 * absorbs the longer note and the union of both tag lists, inherits a pin from
 * either side, records a `deduped` changelog entry, and the dropped row is
 * deleted. Returns the number of pairs merged.
 */
export function applyMerges(
  db: Database.Database,
  rows: MergeCandidate[],
  plan: MergePlanEntry[],
): number {
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const now = Math.floor(Date.now() / 1000);
  let merged = 0;

  const update = db.prepare(
    `
      UPDATE memories
      SET note = ?, note_normalized = ?, tags = ?, metadata_json = ?, updated_at = ?,
          pinned = CASE WHEN pinned = 1 OR ? = 1 THEN 1 ELSE pinned END
      WHERE rowid = ?
    `,
  );
  const drop = db.prepare("DELETE FROM memories WHERE rowid = ?");

  const tx = db.transaction((entries: MergePlanEntry[]) => {
    for (const entry of entries) {
      const keep = byId.get(entry.keep);
      const dropRow = byId.get(entry.drop);
      if (!keep || !dropRow) continue;

      const longerNote =
        keep.note.length >= dropRow.note.length ? keep.note : dropRow.note;
      const mergedTags = mergeTagLists(
        parseTags(keep.tags),
        parseTags(dropRow.tags),
      );
      const metadata = parseMetadata(keep.metadata_json);
      const changelog = metadata.changelog ?? [];
      changelog.push({
        at: now,
        action: "deduped",
        similarity: Number(entry.similarity.toFixed(3)),
        merged_from: dropRow.row_id,
        previous_note: dropRow.note,
      });
      metadata.changelog = changelog;

      update.run(
        longerNote,
        normalizeText(longerNote),
        JSON.stringify(mergedTags),
        JSON.stringify(metadata),
        now,
        dropRow.pinned,
        keep.row_id,
      );
      drop.run(dropRow.row_id);

      // Re-index the survivor. The merge may have replaced its note with the
      // longer one, in which case its stored vector would otherwise describe
      // text the row no longer contains. `backfillRepoEmbeddings` cannot repair
      // this: it only re-indexes rows whose vector is missing or tagged with a
      // stale version/dim, not one whose *text* moved on. No-op when embeddings
      // are disabled. Kept inside the transaction so a rollback also discards
      // the vector write.
      indexMemoryEmbedding(db, keep.row_id, longerNote);

      merged += 1;
    }
  });

  tx(plan);
  return merged;
}
