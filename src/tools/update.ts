import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, MEMORY_TYPES, type MemoryType } from "../db/client.js";
import { normalizeText } from "../lib/dedupe.js";
import { findMemoryByAnyId } from "../lib/memory.js";
import { indexMemoryEmbedding } from "../lib/vector-index.js";

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
  // Accept numeric row_id or legacy string id so callers can paste whichever
  // form they have.
  id: z.union([z.number().int().positive(), z.string().trim().min(1)]),
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
      description:
        "Update an existing memory by id (numeric or legacy string) with partial fields.",
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
        const target = findMemoryByAnyId(db, id);
        if (!target) {
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

        const existing = db
          .prepare(
            `
              SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned
              FROM memories
              WHERE rowid = ?
            `,
          )
          .get(target.row_id) as MemoryRow;

        const now = Math.floor(Date.now() / 1000);
        const nextType = memory_type ?? existing.type;
        const nextNote = content ?? existing.note;
        const nextNormalized = content ? normalizeText(content) : null;

        if (nextNormalized !== null) {
          db.prepare(
            `
              UPDATE memories
              SET type = ?, note = ?, note_normalized = ?, updated_at = ?
              WHERE rowid = ?
            `,
          ).run(nextType, nextNote, nextNormalized, now, existing.row_id);
          // Note text changed, so the stored vector is stale; re-index.
          indexMemoryEmbedding(db, existing.row_id, nextNote);
        } else {
          db.prepare(
            `
              UPDATE memories
              SET type = ?, note = ?, updated_at = ?
              WHERE rowid = ?
            `,
          ).run(nextType, nextNote, now, existing.row_id);
        }

        const updated = db
          .prepare(
            `
              SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned
              FROM memories
              WHERE rowid = ?
            `,
          )
          .get(existing.row_id) as MemoryRow | undefined;

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
