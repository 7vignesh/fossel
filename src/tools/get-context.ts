import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { fetchRepoContext, formatContext } from "../lib/context.js";
import { findStaleFileRefs, findUnverifiedFileRefs } from "../lib/file-refs.js";
import { resolveRepoArg } from "../lib/repo.js";
import { getWorkspaceRoot } from "../lib/workspace.js";

const getContextInputSchema = {
  repo: z.string().trim().min(1).optional(),
  query: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(50).default(8),
  format: z.enum(["text", "markdown"]).default("text"),
  tags: z.array(z.string().trim().min(1)).optional(),
  tagMatch: z.enum(["and", "or"]).default("or"),
};

export function registerGetContextTool(server: McpServer): void {
  server.registerTool(
    "get_context",
    {
      description:
        "Unified retrieval tool. Returns pinned memories first, then recent ones, then FTS matches when a query is provided. Optionally restrict to memories carrying given tags (tagMatch 'or' keeps any, 'and' requires all). Default limit is tuned for direct injection into an LLM system prompt. Use format='markdown' for a PR-ready brief.",
      inputSchema: getContextInputSchema,
    },
    async ({ repo, query, limit, format, tags, tagMatch }) => {
      try {
        const db = getDb();
        const resolved = resolveRepoArg(repo, getWorkspaceRoot(), db);
        const rows = fetchRepoContext(db, resolved.canonical, limit, query, {
          tags,
          tagMatch,
        });
        // Flag any memory whose referenced files have changed since it was
        // written. Fails safe to no advisories outside a git repo.
        const staleRefs = findStaleFileRefs(
          db,
          rows.map((row) => row.row_id),
          getWorkspaceRoot(),
        );
        // Paths a note named that git could not resolve: named, never checked.
        // Reported apart from drift so the two are not read as the same thing.
        const unverifiedRefs = findUnverifiedFileRefs(
          db,
          rows.map((row) => row.row_id),
        );
        const text = formatContext(rows, {
          repo: resolved.canonical,
          query,
          format,
          staleRefs,
          unverifiedRefs,
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
