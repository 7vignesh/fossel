import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getDb, MEMORY_TYPES } from "../db/client.js";
import { normalizeText } from "../lib/dedupe.js";
import { resolveRepoArg } from "../lib/repo.js";
import { groundTemporalReferences } from "../lib/temporal.js";
import { indexMemoryEmbedding } from "../lib/vector-index.js";
import { getWorkspaceRoot } from "../lib/workspace.js";

const storeContextInputSchema = {
  repo: z.string().trim().min(1).optional(),
  type: z.enum(MEMORY_TYPES),
  note: z.string().trim().min(1, "note is required"),
  tags: z.array(z.string().trim().min(1)).optional(),
};

export function registerStoreContextTool(server: McpServer): void {
  server.registerTool(
    "store_context",
    {
      description:
        "Store repository-specific contributor context such as bug fixes, conventions, and decisions. The repo argument is resolved to a canonical key automatically; pass it explicitly only when targeting a different repo than the current workspace.",
      inputSchema: storeContextInputSchema,
    },
    async ({ repo, type, note: rawNote, tags }) => {
      try {
        const db = getDb();
        const resolved = resolveRepoArg(repo, getWorkspaceRoot(), db);
        // Ground relative dates so the memory stays meaningful over time.
        const note = groundTemporalReferences(rawNote);
        const now = Math.floor(Date.now() / 1000);
        const id = nanoid();
        const normalizedTags = Array.from(
          new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
        );

        db.prepare(
          `
            INSERT INTO memories (id, repo, type, note, tags, created_at, updated_at, pinned, metadata_json, note_normalized)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, '{}', ?)
          `,
        ).run(
          id,
          resolved.canonical,
          type,
          note,
          JSON.stringify(normalizedTags),
          now,
          now,
          normalizeText(note),
        );

        const stored = db
          .prepare(
            `
              SELECT rowid AS row_id, id
              FROM memories
              WHERE id = ?
            `,
          )
          .get(id) as { row_id: number; id: string } | undefined;

        if (stored) {
          indexMemoryEmbedding(db, stored.row_id, note);
        }

        return {
          content: [
            {
              type: "text",
              text: `Stored memory ${id} (numeric id: ${stored?.row_id ?? "unknown"}) for ${resolved.canonical} (${type}).`,
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
