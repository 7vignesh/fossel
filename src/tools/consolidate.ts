import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { analyzeRepo, formatConsolidationReport } from "../lib/consolidate.js";
import { resolveRepoArg } from "../lib/repo.js";
import { getWorkspaceRoot } from "../lib/workspace.js";

const consolidateInputSchema = {
  repo: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Repository key (auto-detected from workspace if omitted)"),
  max_candidates: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum candidates to surface (default: 20)"),
  stale_days: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Days without access before a memory is considered stale (default: 90)",
    ),
};

export function registerConsolidateTool(server: McpServer): void {
  server.registerTool(
    "consolidate_memory",
    {
      description:
        "Analyze repo memories for stale, redundant, or contradicted entries. Returns a prompt-ready report with suggested actions. Does not modify any data — read-only analysis.",
      inputSchema: consolidateInputSchema,
    },
    async ({ repo, max_candidates, stale_days }) => {
      try {
        const db = getDb();
        const resolved = resolveRepoArg(repo, getWorkspaceRoot(), db);
        const report = analyzeRepo(db, resolved.canonical, {
          maxCandidates: max_candidates,
          staleDays: stale_days,
        });
        const formatted = formatConsolidationReport(report);
        return { content: [{ type: "text", text: formatted }] };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown error while analyzing repo.";
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to consolidate: ${message}` }],
        };
      }
    },
  );
}
