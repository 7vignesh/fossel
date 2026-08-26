import type Database from "better-sqlite3";
import {
  MEMORY_TYPES,
  type MemoryRecord,
  type MemoryType,
} from "../db/client.js";
import { embeddingsEnabled } from "./embeddings.js";
import type { StaleFileRef } from "./file-refs.js";
import { searchFts, type FtsRow } from "./fts.js";
import {
  DEFAULT_FUSION_WEIGHTS,
  DEFAULT_VECTOR_SCORE_FLOOR,
  fuseRrf,
  type FusionWeights,
} from "./fusion.js";
import { vectorSearch } from "./vector-index.js";

export interface ContextRow extends MemoryRecord {
  source: "pinned" | "recent" | "search";
  rank?: number;
}

const SECTION_TITLES: Record<MemoryType, string> = {
  convention: "Conventions",
  bug_fix: "Bug Fixes",
  reviewer_pattern: "Reviewer Patterns",
  decision: "Decisions",
  issue: "Issues",
  general: "General",
};

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

/**
 * Lightweight read-time normalizer used to collapse near-identical notes when
 * rendering a context block. Mirrors `lib/dedupe.normalizeText` but is kept
 * local so this module doesn't depend on the dedupe layer.
 */
function normalizeNoteForReadDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface FetchContextOptions {
  /** Override the RRF leg weights. Exists so the benchmark can sweep them;
   * production callers use the measured defaults. */
  weights?: Partial<FusionWeights>;
  /** Override the minimum cosine a vector hit needs to enter the fusion.
   * Sweepable for the same reason. */
  vectorScoreFloor?: number;
}

/**
 * Collect a unified ranked list of memories for a repo:
 *   1. pinned (most recently updated first)
 *   2. recent non-pinned
 *   3. FTS search hits when `query` is provided
 *
 * The returned rows are deduplicated both by row_id and by normalized note
 * text so the same idea never appears twice in a single context block, even
 * if the database still has lingering near-duplicates that haven't been
 * collapsed by `dedupe_repo`.
 */
export function fetchRepoContext(
  db: Database.Database,
  repo: string,
  limit: number,
  query?: string,
  options: FetchContextOptions = {},
): ContextRow[] {
  const weights: FusionWeights = {
    ...DEFAULT_FUSION_WEIGHTS,
    ...options.weights,
  };
  const vectorScoreFloor =
    options.vectorScoreFloor ?? DEFAULT_VECTOR_SCORE_FLOOR;
  const rows: ContextRow[] = [];
  const seen = new Set<number>();
  const seenNormalized = new Set<string>();

  const push = (memory: MemoryRecord, source: ContextRow["source"], rank?: number) => {
    if (seen.has(memory.row_id)) {
      return;
    }
    const normalized = normalizeNoteForReadDedupe(memory.note);
    // Pinned rows always win their normalized slot, so we record them first
    // and let recent/search rows skip when they collide. We never dedupe an
    // empty normalized form (could happen for purely punctuation notes) so
    // those rare rows still surface.
    if (normalized && seenNormalized.has(normalized)) {
      return;
    }
    seen.add(memory.row_id);
    if (normalized) {
      seenNormalized.add(normalized);
    }
    rows.push({ ...memory, source, rank });
  };

  const pinned = db
    .prepare(
      `
        SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned
        FROM memories
        WHERE repo = ? AND pinned = 1
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(repo, limit) as MemoryRecord[];
  for (const row of pinned) {
    push(row, "pinned");
  }

  // Recent backfill. When a query is present we defer this until AFTER search
  // so relevant matches lead and recent rows only fill leftover slots; without
  // a query, recent fills immediately (pinned + recent context block).
  const pushRecent = () => {
    if (rows.length >= limit) {
      return;
    }
    const recent = db
      .prepare(
        `
          SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned
          FROM memories
          WHERE repo = ? AND pinned = 0
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(repo, limit) as MemoryRecord[];
    for (const row of recent) {
      push(row, "recent");
      if (rows.length >= limit) {
        break;
      }
    }
  };

  if (!query) {
    pushRecent();
  }

  if (query && rows.length < limit) {
    const ftsRows = searchFts(db, query, { repo, limit }).rows;

    // Hybrid retrieval: when embeddings are enabled, run a semantic vector
    // search alongside FTS and fuse the two ranked lists with weighted
    // Reciprocal Rank Fusion. RRF rewards rows that rank highly in either list
    // without needing the two score scales to be comparable. The vector leg is
    // down-weighted because it is measurably the weaker retriever — see
    // lib/fusion.ts for the numbers behind the default. When embeddings are
    // disabled this collapses to the original FTS-only behavior.
    const vectorRows = embeddingsEnabled()
      ? vectorSearch(db, repo, query, limit).filter(
          (row) => row.score >= vectorScoreFloor,
        )
      : [];

    if (vectorRows.length > 0) {
      const FTS_LIST = 0;
      const fused = fuseRrf<MemoryRecord>(
        [
          { items: ftsRows, weight: weights.fts },
          { items: vectorRows, weight: weights.vector },
        ],
        (memory) => memory.row_id,
      );

      for (const entry of fused) {
        // Preserve the BM25 rank when the row came from the keyword leg, so
        // callers that surface `rank` still see a meaningful value.
        const ftsPosition = entry.positions.get(FTS_LIST);
        const rank =
          ftsPosition === undefined
            ? undefined
            : (ftsRows[ftsPosition] as FtsRow | undefined)?.rank;
        push(entry.item, "search", rank);
        if (rows.length >= limit) {
          break;
        }
      }
    } else {
      for (const row of ftsRows) {
        push(row, "search", row.rank);
        if (rows.length >= limit) {
          break;
        }
      }
    }

    // Backfill any slots search didn't fill with recent memories so a query
    // with few/no matches still returns useful context.
    pushRecent();
  }

  return rows.slice(0, limit);
}

export interface FormatContextOptions {
  repo: string;
  query?: string;
  format?: "text" | "markdown";
  /** Per-memory staleness advisories: files a memory references whose content
   * has changed since the memory was written. Rendered as an advisory marker,
   * following the conflict-review pattern — Fossel flags, the client's model
   * judges. */
  staleRefs?: Map<number, StaleFileRef[]>;
}

/**
 * Render a unified list of memories into either a compact text block or a
 * markdown brief grouped by memory type. Both formats are designed to drop
 * straight into an LLM system message.
 */
export function formatContext(
  rows: ContextRow[],
  options: FormatContextOptions,
): string {
  const { repo, query, format = "text", staleRefs } = options;

  if (rows.length === 0) {
    if (format === "markdown") {
      return `# Fossel context: ${repo}\n\nNo memories found${query ? ` for "${query}"` : ""}.`;
    }
    return `No memories found for ${repo}${query ? ` matching "${query}"` : ""}.`;
  }

  if (format === "markdown") {
    return formatMarkdown(rows, repo, query, staleRefs);
  }

  return formatText(rows, repo, query, staleRefs);
}

/**
 * Build the staleness marker for a memory, or an empty string when nothing it
 * references has drifted. Advisory only: it names the changed files and leaves
 * the judgment to the reader, matching the conflict-review notice pattern.
 */
function staleMarker(
  rowId: number,
  staleRefs?: Map<number, StaleFileRef[]>,
): string {
  const refs = staleRefs?.get(rowId);
  if (!refs || refs.length === 0) {
    return "";
  }
  const names = refs.map((ref) => ref.path).join(", ");
  const anyDirty = refs.some((ref) => ref.changedInWorkingTree);
  const verb = anyDirty ? "has uncommitted changes" : "changed";
  return ` ⚠ may be stale: ${names} ${verb} since this was written`;
}

function formatMarkdown(
  rows: ContextRow[],
  repo: string,
  query?: string,
  staleRefs?: Map<number, StaleFileRef[]>,
): string {
  const sections: string[] = [`# Fossel context: ${repo}`];
  if (query) {
    sections.push(`Query: \`${query}\``);
  }

  const render = (row: ContextRow) => renderMarkdownRow(row, staleRefs);

  const pinned = rows.filter((row) => row.pinned === 1);
  if (pinned.length > 0) {
    sections.push(["## 📌 Pinned", ...pinned.map(render)].join("\n"));
  }

  for (const type of MEMORY_TYPES) {
    const entries = rows.filter((row) => row.pinned !== 1 && row.type === type);
    if (entries.length === 0) {
      continue;
    }
    sections.push(
      [`## ${SECTION_TITLES[type]}`, ...entries.map(render)].join("\n"),
    );
  }

  return sections.join("\n\n");
}

function renderMarkdownRow(
  row: ContextRow,
  staleRefs?: Map<number, StaleFileRef[]>,
): string {
  const tags = parseTags(row.tags);
  const tagSuffix = tags.length > 0 ? ` _(${tags.join(", ")})_` : "";
  return `- (${row.row_id}) ${row.note}${tagSuffix}${staleMarker(row.row_id, staleRefs)}`;
}

function formatText(
  rows: ContextRow[],
  repo: string,
  query?: string,
  staleRefs?: Map<number, StaleFileRef[]>,
): string {
  const header = query
    ? `Repository context for ${repo} (query: "${query}")`
    : `Repository context for ${repo}`;

  const lines: string[] = [header, `Total: ${rows.length}`, ""];

  for (const row of rows) {
    const tags = parseTags(row.tags);
    const tagSuffix = tags.length > 0 ? ` [tags: ${tags.join(", ")}]` : "";
    const pinPrefix = row.pinned ? "📌 " : "";
    const sourceLabel = row.source === "search" ? " [match]" : "";
    lines.push(
      `- (${row.row_id} | ${row.type})${sourceLabel} ${pinPrefix}${row.note}${tagSuffix}${staleMarker(row.row_id, staleRefs)}`,
    );
  }

  return lines.join("\n");
}
