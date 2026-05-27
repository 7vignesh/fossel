import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { findMemoryByAnyId } from "../lib/memory.js";

const deleteMemoryInputSchema = {
  // Accept either the numeric row_id or the legacy nanoid string. Tools used
  // to disagree about which form to take; this unifies them so callers can
  // paste whichever id they have in front of them.
  id: z.union([z.number().int().positive(), z.string().trim().min(1)]),
};

export function registerDeleteMemoryTool(server: McpServer): void {
  server.registerTool(
    "delete_memory",
    {
      description:
        "Delete a memory from storage by id. Accepts either the numeric row id or the legacy string id.",
      inputSchema: deleteMemoryInputSchema,
    },
    async ({ id }) => {
      try {
        const db = getDb();
        const memory = findMemoryByAnyId(db, id);

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

        const deleteTx = db.transaction((rowId: number) => {
          // The delete trigger on memories keeps the FTS table synchronized.
          db.prepare("DELETE FROM memories WHERE rowid = ?").run(rowId);
        });

        deleteTx(memory.row_id);

        return {
          content: [
            {
              type: "text",
              text: `Deleted memory ${memory.row_id} (legacy: ${memory.id}).`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while deleting memory.";

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to delete memory: ${message}`,
            },
          ],
        };
      }
    },
  );
}
