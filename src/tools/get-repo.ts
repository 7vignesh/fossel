import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, type MemoryRecord, MEMORY_TYPES, type MemoryType } from "../db/client.js";

const getRepoContextInputSchema = {
  repo: z.string().trim().min(1, "repo is required"),
  limit: z.number().int().positive().max(100).default(10),
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

function formatTypeHeading(type: MemoryType): string {
  return type
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function registerGetRepoContextTool(server: McpServer): void {
  server.registerTool(
    "get_repo_context",
    {
      description: "Get recent memories for a repository grouped by memory type.",
      inputSchema: getRepoContextInputSchema,
    },
    async ({ repo, limit }) => {
      try {
        const db = getDb();
        const rows = db
          .prepare(
            `
              SELECT id, repo, type, note, tags, created_at, updated_at
              FROM memories
              WHERE repo = ?
              ORDER BY updated_at DESC
              LIMIT ?
            `,
          )
          .all(repo, limit) as MemoryRecord[];

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No memories found for ${repo}.`,
              },
            ],
          };
        }

        const grouped = new Map<MemoryType, string[]>();
        for (const memory of rows) {
          const tags = parseTags(memory.tags);
          const tagSuffix = tags.length > 0 ? ` [tags: ${tags.join(", ")}]` : "";
          const item = `- (${memory.id}) ${memory.note}${tagSuffix}`;
          const existing = grouped.get(memory.type) ?? [];
          existing.push(item);
          grouped.set(memory.type, existing);
        }

        const sections: string[] = [];
        for (const type of MEMORY_TYPES) {
          const entries = grouped.get(type);
          if (!entries || entries.length === 0) {
            continue;
          }

          sections.push(`${formatTypeHeading(type)}\n${entries.join("\n")}`);
        }

        return {
          content: [
            {
              type: "text",
              text: `Repository context for ${repo}\nTotal memories: ${rows.length}\n\n${sections.join("\n\n")}`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown error while retrieving repository context.";

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to fetch repository context: ${message}`,
            },
          ],
        };
      }
    },
  );
}
