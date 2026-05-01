import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, MEMORY_TYPES, type MemoryType } from "../db/client.js";

interface MemoryRow {
  row_id: number;
  id: string;
  repo: string;
  type: MemoryType;
  note: string;
  tags: string;
  created_at: number;
  updated_at: number;
  pinned: number;
}

const updateMemoryInputSchema = {
  id: z.number().int().positive(),
  content: z.string().trim().min(1).optional(),
  memory_type: z.enum(MEMORY_TYPES).optional(),
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

function formatMemory(memory: MemoryRow): string {
  const tags = parseTags(memory.tags);
  const tagsLine = tags.length > 0 ? tags.join(", ") : "(none)";
  return [
    `Memory ${memory.row_id} updated successfully.`,
    `id: ${memory.row_id}`,
    `legacy_id: ${memory.id}`,
    `repo: ${memory.repo}`,
    `memory_type: ${memory.type}`,
    `content: ${memory.note}`,
    `tags: ${tagsLine}`,
    `pinned: ${memory.pinned === 1 ? "true" : "false"}`,
    `created_at: ${memory.created_at}`,
    `updated_at: ${memory.updated_at}`,
  ].join("\n");
}

export function registerUpdateMemoryTool(server: McpServer): void {
  server.registerTool(
    "update_memory",
    {
      description: "Update an existing memory by numeric id with partial fields.",
      inputSchema: updateMemoryInputSchema,
    },
    async ({ id, content, memory_type }) => {
      try {
        if (!content && !memory_type) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Provide at least one field to update: content or memory_type.",
              },
            ],
          };
        }

        const db = getDb();
        const existing = db
          .prepare(
            `
              SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned
              FROM memories
              WHERE rowid = ?
            `,
          )
          .get(id) as MemoryRow | undefined;

        if (!existing) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Memory ${id} not found.`,
              },
            ],
          };
        }

        const now = Math.floor(Date.now() / 1000);
        const nextType = memory_type ?? existing.type;
        const nextNote = content ?? existing.note;

        db.prepare(
          `
            UPDATE memories
            SET type = ?, note = ?, updated_at = ?
            WHERE rowid = ?
          `,
        ).run(nextType, nextNote, now, id);

        const updated = db
          .prepare(
            `
              SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned
              FROM memories
              WHERE rowid = ?
            `,
          )
          .get(id) as MemoryRow | undefined;

        if (!updated) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Memory ${id} could not be loaded after update.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: formatMemory(updated),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while updating memory.";

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to update memory: ${message}`,
            },
          ],
        };
      }
    },
  );
}
