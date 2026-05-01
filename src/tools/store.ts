import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getDb, MEMORY_TYPES } from "../db/client.js";

const storeContextInputSchema = {
  repo: z.string().trim().min(1, "repo is required"),
  type: z.enum(MEMORY_TYPES),
  note: z.string().trim().min(1, "note is required"),
  tags: z.array(z.string().trim().min(1)).optional(),
};

export function registerStoreContextTool(server: McpServer): void {
  server.registerTool(
    "store_context",
    {
      description:
        "Store repository-specific contributor context such as bug fixes, conventions, and decisions.",
      inputSchema: storeContextInputSchema,
    },
    async ({ repo, type, note, tags }) => {
      try {
        const db = getDb();
        const now = Math.floor(Date.now() / 1000);
        const id = nanoid();
        const normalizedTags = Array.from(
          new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
        );

        db.prepare(
          `
            INSERT INTO memories (id, repo, type, note, tags, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(id, repo, type, note, JSON.stringify(normalizedTags), now, now);
        const stored = db
          .prepare(
            `
              SELECT rowid AS row_id, id
              FROM memories
              WHERE id = ?
            `,
          )
          .get(id) as { row_id: number; id: string } | undefined;

        return {
          content: [
            {
              type: "text",
              text: `Stored memory ${id} (numeric id: ${stored?.row_id ?? "unknown"}) for ${repo} (${type}).`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while storing memory.";

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to store memory: ${message}`,
            },
          ],
        };
      }
    },
  );
}
