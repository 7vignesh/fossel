import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { fetchRepoContext, formatContext } from "../lib/context.js";
import { resolveRepoArg } from "../lib/repo.js";

const getContextInputSchema = {
  repo: z.string().trim().min(1).optional(),
  query: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(50).default(8),
  format: z.enum(["text", "markdown"]).default("text"),
};

export function registerGetContextTool(server: McpServer): void {
  server.registerTool(
    "get_context",
    {
      description:
        "Unified retrieval tool. Returns pinned memories first, then recent ones, then FTS matches when a query is provided. Default limit is tuned for direct injection into an LLM system prompt. Use format='markdown' for a PR-ready brief.",
      inputSchema: getContextInputSchema,
    },
    async ({ repo, query, limit, format }) => {
      try {
        const db = getDb();
        const resolved = resolveRepoArg(repo, process.cwd(), db);
        const rows = fetchRepoContext(db, resolved.canonical, limit, query);
        const text = formatContext(rows, {
          repo: resolved.canonical,
          query,
          format,
        });

        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while fetching context.";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to fetch context: ${message}`,
            },
          ],
        };
      }
    },
  );
}
