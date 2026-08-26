import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, type MemoryRecord } from "../db/client.js";
import { fetchRepoContext } from "../lib/context.js";
import { embeddingsEnabled } from "../lib/embeddings.js";
import { searchFts } from "../lib/fts.js";
import { resolveRepoArg } from "../lib/repo.js";
import { vectorSearch } from "../lib/vector-index.js";
import { getWorkspaceRoot } from "../lib/workspace.js";

interface SearchRow extends MemoryRecord {
  rank: number;
}

const searchMemoryInputSchema = {
  query: z.string().trim().min(1, "query is required"),
  repo: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(50).default(5),
};

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
      description:
        "Search memories using full-text search with optional repository filtering. Falls back to recent + pinned context when the query has no exact matches.",
      inputSchema: searchMemoryInputSchema,
    },
    async ({ query, repo, limit }) => {
      try {
        const db = getDb();
        const resolvedRepo = repo
          ? resolveRepoArg(repo, getWorkspaceRoot(), db).canonical
          : undefined;

        // Narrow AND first, broadening to OR only when AND finds nothing.
        let rows: SearchRow[] = searchFts(db, query, {
          repo: resolvedRepo,
          limit,
        }).rows;

        // Semantic backstop: when keyword search finds nothing but embeddings
        // are enabled, fall back to vector similarity so paraphrased queries
        // still surface relevant memories. Only runs with a known repo.
        if (rows.length === 0 && resolvedRepo && embeddingsEnabled()) {
          const semantic = vectorSearch(db, resolvedRepo, query, limit);
          rows = semantic.map(({ score, ...row }) => ({
            ...row,
            rank: score,
          }));
        }

        // Last-resort fallback: surface pinned + recent for the resolved repo
        // so a complex query never returns "no memories" when the repo has
        // useful context. Only triggers when a repo is known.
        let usedFallback = false;
        if (rows.length === 0 && resolvedRepo) {
          const fallback = fetchRepoContext(db, resolvedRepo, limit);
          rows = fallback.map((row) => ({ ...row, rank: 0 }));
          usedFallback = fallback.length > 0;
        }

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: resolvedRepo
                  ? `No memories matched "${query}" in ${resolvedRepo}.`
                  : `No memories matched "${query}".`,
              },
            ],
          };
        }

        const formatted = rows
          .map((row, index) => {
            const tags = parseTags(row.tags);
            const tagsText = tags.length > 0 ? ` | tags: ${tags.join(", ")}` : "";
            const pinPrefix = row.pinned ? "📌 Pinned " : "";
            return `${index + 1}. [${row.repo}] ${row.type} (${row.row_id} | legacy: ${row.id})\n${pinPrefix}${row.note}${tagsText}`;
          })
          .join("\n\n");

        const header = usedFallback
          ? `No exact match for "${query}"${resolvedRepo ? ` in ${resolvedRepo}` : ""}; showing recent + pinned context:`
          : `Search results for "${query}"${resolvedRepo ? ` in ${resolvedRepo}` : ""}:`;

        return {
          content: [
            {
              type: "text",
              text: `${header}\n\n${formatted}`,
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
