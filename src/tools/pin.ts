import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/client.js";

interface MemoryPinRow {
  row_id: number;
  note: string;
  pinned: number;
}

const pinInputSchema = {
  id: z.number().int().positive(),
};

function setPinnedState(memoryId: number, pinned: 0 | 1): MemoryPinRow | null {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const updateResult = db
    .prepare(
      `
        UPDATE memories
        SET pinned = ?, updated_at = ?
        WHERE rowid = ?
      `,
    )
    .run(pinned, now, memoryId);

  if (updateResult.changes === 0) {
    return null;
  }

  return db
    .prepare(
      `
        SELECT rowid AS row_id, note, pinned
        FROM memories
        WHERE rowid = ?
      `,
    )
    .get(memoryId) as MemoryPinRow;
}

export function registerPinMemoryTool(server: McpServer): void {
  server.registerTool(
    "pin_memory",
    {
      description: "Pin a memory to keep it at the top of repository context.",
      inputSchema: pinInputSchema,
    },
    async ({ id }) => {
      try {
        const memory = setPinnedState(id, 1);
        if (!memory) {
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

        return {
          content: [
            {
              type: "text",
              text: `Pinned memory ${memory.row_id}: ${memory.note}`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while pinning memory.";

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to pin memory: ${message}`,
            },
          ],
        };
      }
    },
  );
}

export function registerUnpinMemoryTool(server: McpServer): void {
  server.registerTool(
    "unpin_memory",
    {
      description: "Unpin a previously pinned memory.",
      inputSchema: pinInputSchema,
    },
    async ({ id }) => {
      try {
        const memory = setPinnedState(id, 0);
        if (!memory) {
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

        return {
          content: [
            {
              type: "text",
              text: `Unpinned memory ${memory.row_id}.`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while unpinning memory.";

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to unpin memory: ${message}`,
            },
          ],
        };
      }
    },
  );
}
