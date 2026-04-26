import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/client.js";

const deleteMemoryInputSchema = {
  id: z.string().trim().min(1, "id is required"),
};

export function registerDeleteMemoryTool(server: McpServer): void {
  server.registerTool(
    "delete_memory",
    {
      description: "Delete a memory from storage by id.",
      inputSchema: deleteMemoryInputSchema,
    },
    async ({ id }) => {
      try {
        const db = getDb();
        const row = db.prepare("SELECT id FROM memories WHERE id = ?").get(id) as
          | { id: string }
          | undefined;

        if (!row) {
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

        const deleteTx = db.transaction((memoryId: string) => {
          // The delete trigger on memories keeps the FTS table synchronized.
          db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
        });

        deleteTx(id);

        return {
          content: [
            {
              type: "text",
              text: `Deleted memory ${id}.`,
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
