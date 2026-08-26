import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/client.js";
import {
  applyMerges,
  fetchMergeCandidates,
  planMerges,
} from "../lib/merge.js";
import { resolveRepoArg } from "../lib/repo.js";
import { getWorkspaceRoot } from "../lib/workspace.js";

const dedupeRepoInputSchema = {
  repo: z.string().trim().min(1).optional(),
  threshold: z.number().min(0.5).max(1).default(0.85),
  apply: z.boolean().default(false),
};

export function registerDedupeRepoTool(server: McpServer): void {
  server.registerTool(
    "dedupe_repo",
    {
      description:
        "Scan a repository for near-duplicate memories. Returns a plan by default; pass apply=true to merge duplicates into the most recently updated row, appending a changelog entry to metadata_json.",
      inputSchema: dedupeRepoInputSchema,
    },
    async ({ repo, threshold, apply }) => {
      try {
        const db = getDb();
        const resolved = resolveRepoArg(repo, getWorkspaceRoot(), db);
        const rows = fetchMergeCandidates(db, resolved.canonical);

        if (rows.length < 2) {
          return {
            content: [
              {
                type: "text",
                text: `No duplicates possible: only ${rows.length} memory in ${resolved.canonical}.`,
              },
            ],
          };
        }

        const plan = planMerges(rows, threshold);

        if (plan.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No duplicates ≥ ${threshold} found in ${resolved.canonical} (${rows.length} memories scanned).`,
              },
            ],
          };
        }

        if (!apply) {
          const lines = plan.map(
            (entry) =>
              `- keep ${entry.keep}, drop ${entry.drop} (similarity ${entry.similarity.toFixed(2)})`,
          );
          return {
            content: [
              {
                type: "text",
                text:
                  `Dry run for ${resolved.canonical}. Found ${plan.length} duplicate pair(s):\n` +
                  `${lines.join("\n")}\n\nRe-run with apply=true to merge.`,
              },
            ],
          };
        }

        const merged = applyMerges(db, rows, plan);

        return {
          content: [
            {
              type: "text",
              text: `Merged ${merged} duplicate pair(s) in ${resolved.canonical}.`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while deduping repo.";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to dedupe repo: ${message}`,
            },
          ],
        };
      }
    },
  );
}
