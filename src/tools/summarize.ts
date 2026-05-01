import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, MEMORY_TYPES, type MemoryType } from "../db/client.js";

interface SummaryRow {
  row_id: number;
  type: MemoryType;
  note: string;
  pinned: number;
}

const summarizeRepoContextInputSchema = {
  repo: z.string().trim().min(1, "repo is required"),
};

const sectionTitleByType: Record<MemoryType, string> = {
  convention: "Conventions",
  bug_fix: "Bug Fixes",
  reviewer_pattern: "Reviewer Patterns",
  decision: "Decisions",
  issue: "Issues",
  general: "General",
};

export function registerSummarizeRepoContextTool(server: McpServer): void {
  server.registerTool(
    "summarize_repo_context",
    {
      description: "Generate a structured markdown summary of all memories for a repository.",
      inputSchema: summarizeRepoContextInputSchema,
    },
    async ({ repo }) => {
      try {
        const db = getDb();
        const rows = db
          .prepare(
            `
              SELECT rowid AS row_id, type, note, pinned
              FROM memories
              WHERE repo = ?
              ORDER BY pinned DESC, updated_at DESC
            `,
          )
          .all(repo) as SummaryRow[];

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Fossel Context Summary: ${repo}\n\nNo memories found.`,
              },
            ],
          };
        }

        const pinnedLines = rows
          .filter((row) => row.pinned === 1)
          .map((row) => `- (${row.row_id}) ${row.note}`);

        const sections: string[] = [`Fossel Context Summary: ${repo}`];

        if (pinnedLines.length > 0) {
          sections.push(`📌 Pinned\n${pinnedLines.join("\n")}`);
        }

        for (const type of MEMORY_TYPES) {
          const entries = rows
            .filter((row) => row.type === type)
            .map((row) => `- (${row.row_id}) ${row.note}`);

          if (entries.length === 0) {
            continue;
          }

          sections.push(`${sectionTitleByType[type]}\n${entries.join("\n")}`);
        }

        return {
          content: [
            {
              type: "text",
              text: sections.join("\n\n"),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown error while summarizing repository context.";

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to summarize repository context: ${message}`,
            },
          ],
        };
      }
    },
  );
}
