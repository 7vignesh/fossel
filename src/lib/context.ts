import type Database from "better-sqlite3";
import {
  MEMORY_TYPES,
  type MemoryRecord,
  type MemoryType,
} from "../db/client.js";

export interface ContextRow extends MemoryRecord {
  source: "pinned" | "recent" | "search";
  rank?: number;
}

interface FtsRow extends MemoryRecord {
  rank: number;
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

function buildFtsQuery(query: string): string | null {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, '""'))
    .filter((term) => term.length > 0);

  if (terms.length === 0) {
    return null;
  }

  return terms.map((term) => `"${term}"`).join(" AND ");
}

/**
 * Collect a unified ranked list of memories for a repo:
 *   1. pinned (most recently updated first)
 *   2. recent non-pinned
 *   3. FTS search hits when `query` is provided
 *
 * The returned rows are deduplicated by row_id while preserving the order
 * above so callers can format the result without further bookkeeping.
 */
export function fetchRepoContext(
  db: Database.Database,
  repo: string,
  limit: number,
  query?: string,
): ContextRow[] {
  const rows: ContextRow[] = [];
  const seen = new Set<number>();

  const push = (memory: MemoryRecord, source: ContextRow["source"], rank?: number) => {
    if (seen.has(memory.row_id)) {
      return;
    }
    seen.add(memory.row_id);
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

  if (rows.length < limit) {
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
      .all(repo, limit - rows.length) as MemoryRecord[];
    for (const row of recent) {
      push(row, "recent");
    }
  }

  if (query && rows.length < limit) {
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery) {
      try {
        const matches = db
          .prepare(
            `
              SELECT m.rowid AS row_id, m.id, m.repo, m.type, m.note, m.tags,
                     m.created_at, m.updated_at, m.pinned, bm25(memories_fts) AS rank
              FROM memories_fts
              JOIN memories AS m ON m.rowid = memories_fts.rowid
              WHERE memories_fts MATCH ? AND m.repo = ?
              ORDER BY rank
              LIMIT ?
            `,
          )
          .all(ftsQuery, repo, limit) as FtsRow[];
        for (const row of matches) {
          push(row, "search", row.rank);
          if (rows.length >= limit) {
            break;
          }
        }
      } catch {
        // FTS rejects some inputs (e.g. only stop characters). Failing soft
        // here keeps the pinned/recent results useful.
      }
    }
  }

  return rows.slice(0, limit);
}

export interface FormatContextOptions {
  repo: string;
  query?: string;
  format?: "text" | "markdown";
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
  const { repo, query, format = "text" } = options;

  if (rows.length === 0) {
    if (format === "markdown") {
      return `# Fossel context: ${repo}\n\nNo memories found${query ? ` for "${query}"` : ""}.`;
    }
    return `No memories found for ${repo}${query ? ` matching "${query}"` : ""}.`;
  }

  if (format === "markdown") {
    return formatMarkdown(rows, repo, query);
  }

  return formatText(rows, repo, query);
}

function formatMarkdown(rows: ContextRow[], repo: string, query?: string): string {
  const sections: string[] = [`# Fossel context: ${repo}`];
  if (query) {
    sections.push(`Query: \`${query}\``);
  }

  const pinned = rows.filter((row) => row.pinned === 1);
  if (pinned.length > 0) {
    sections.push(["## 📌 Pinned", ...pinned.map(renderMarkdownRow)].join("\n"));
  }

  for (const type of MEMORY_TYPES) {
    const entries = rows.filter((row) => row.pinned !== 1 && row.type === type);
    if (entries.length === 0) {
      continue;
    }
    sections.push(
      [`## ${SECTION_TITLES[type]}`, ...entries.map(renderMarkdownRow)].join("\n"),
    );
  }

  return sections.join("\n\n");
}

function renderMarkdownRow(row: ContextRow): string {
  const tags = parseTags(row.tags);
  const tagSuffix = tags.length > 0 ? ` _(${tags.join(", ")})_` : "";
  return `- (${row.row_id}) ${row.note}${tagSuffix}`;
}

function formatText(rows: ContextRow[], repo: string, query?: string): string {
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
      `- (${row.row_id} | ${row.type})${sourceLabel} ${pinPrefix}${row.note}${tagSuffix}`,
    );
  }

  return lines.join("\n");
}
