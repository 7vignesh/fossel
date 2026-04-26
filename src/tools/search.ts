import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, type MemoryRecord } from "../db/client.js";

interface SearchRow extends MemoryRecord {
  rank: number;
}

const searchMemoryInputSchema = {
  query: z.string().trim().min(1, "query is required"),
  repo: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(50).default(5),
};

function normalizeFtsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replaceAll('"', '""'))
    .filter(Boolean);

  if (terms.length === 0) {
    throw new Error("query must contain searchable text");
  }

  return terms.map((term) => `"${term}"`).join(" AND ");
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export function registerSearchMemoryTool(server: McpServer): void {
  server.registerTool(
    "search_memory",
    {
      description: "Search memories using full-text search with optional repository filtering.",
      inputSchema: searchMemoryInputSchema,
    },
    async ({ query, repo, limit }) => {
      try {
        const db = getDb();
        const ftsQuery = normalizeFtsQuery(query);

        const rows = (repo
          ? db
              .prepare(
                `
                  SELECT m.id, m.repo, m.type, m.note, m.tags, m.created_at, m.updated_at, bm25(memories_fts) AS rank
                  FROM memories_fts
                  JOIN memories AS m ON m.rowid = memories_fts.rowid
                  WHERE memories_fts MATCH ? AND m.repo = ?
                  ORDER BY rank
                  LIMIT ?
                `,
              )
              .all(ftsQuery, repo, limit)
          : db
              .prepare(
                `
                  SELECT m.id, m.repo, m.type, m.note, m.tags, m.created_at, m.updated_at, bm25(memories_fts) AS rank
                  FROM memories_fts
                  JOIN memories AS m ON m.rowid = memories_fts.rowid
                  WHERE memories_fts MATCH ?
                  ORDER BY rank
                  LIMIT ?
                `,
              )
              .all(ftsQuery, limit)) as SearchRow[];

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: repo
                  ? `No memories matched "${query}" in ${repo}.`
                  : `No memories matched "${query}".`,
              },
            ],
          };
        }

        const formatted = rows
          .map((row, index) => {
            const tags = parseTags(row.tags);
            const tagsText = tags.length > 0 ? ` | tags: ${tags.join(", ")}` : "";
            return `${index + 1}. [${row.repo}] ${row.type} (${row.id})\n${row.note}${tagsText}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Search results for "${query}"${repo ? ` in ${repo}` : ""}:\n\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while searching memory.";

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to search memories: ${message}`,
            },
          ],
        };
      }
    },
  );
}
