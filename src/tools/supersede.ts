import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { findMemoryByAnyId } from "../lib/memory.js";
import { getWorkspaceRoot } from "../lib/workspace.js";

const supersedeMemoryInputSchema = {
  // Accept either the numeric row_id or the legacy nanoid string, matching the
  // other id-taking tools so callers can paste whichever form they have.
  id: z.union([z.number().int().positive(), z.string().trim().min(1)]),
  // The memory that replaces the superseded one, if there is one. Same dual
  // id form as `id`.
  superseded_by: z
    .union([z.number().int().positive(), z.string().trim().min(1)])
    .optional(),
  reason: z.string().trim().min(1).optional(),
};

interface MetadataChangelogEntry {
  at: number;
  action: string;
  superseded_by?: number;
  reason?: string;
}

interface StoredMetadata {
  changelog?: MetadataChangelogEntry[];
  [key: string]: unknown;
}

function parseMetadata(raw: string): StoredMetadata {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StoredMetadata;
    }
  } catch {
    /* fall through to empty metadata */
  }
  return {};
}

export function registerSupersedeMemoryTool(server: McpServer): void {
  server.registerTool(
    "supersede_memory",
    {
      description:
        "Tombstone a memory so it stops surfacing in live retrieval while preserving the row and its history (Zep invalidate-never-delete pattern). Accepts either the numeric row_id or the legacy nanoid string.",
      inputSchema: supersedeMemoryInputSchema,
    },
    async ({ id, superseded_by, reason }) => {
      try {
        // Resolve the workspace up front so failures surface consistently with
        // the other tools, even though the row lookup is id-based.
        getWorkspaceRoot();
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

        const current = db
          .prepare(
            "SELECT valid_to, metadata_json FROM memories WHERE rowid = ?",
          )
          .get(memory.row_id) as
          | { valid_to: number | null; metadata_json: string }
          | undefined;

        if (!current) {
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

        if (current.valid_to !== null) {
          return {
            content: [
              {
                type: "text",
                text: `Memory ${memory.row_id} is already superseded.`,
              },
            ],
          };
        }

        const now = Math.floor(Date.now() / 1000);
        const metadata = parseMetadata(current.metadata_json);
        const changelog = metadata.changelog ?? [];
        const entry: MetadataChangelogEntry = {
          at: now,
          action: "superseded",
        };

        if (superseded_by !== undefined) {
          const supersededMemory = findMemoryByAnyId(db, superseded_by);
          if (!supersededMemory) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Memory ${superseded_by} not found.`,
                },
              ],
            };
          }
          entry.superseded_by = supersededMemory.row_id;
        }

        if (reason !== undefined) {
          entry.reason = reason;
        }

        changelog.push(entry);
        metadata.changelog = changelog;

        const supersedeTx = db.transaction((rowId: number) => {
          db.prepare(
            "UPDATE memories SET valid_to = ?, metadata_json = ? WHERE rowid = ?",
          ).run(now, JSON.stringify(metadata), rowId);
        });

        supersedeTx(memory.row_id);

        return {
          content: [
            {
              type: "text",
              text: `Superseded memory ${memory.row_id}. It will no longer appear in live retrieval but the row is preserved.`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown error while superseding memory.";

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to supersede memory: ${message}`,
            },
          ],
        };
      }
    },
  );
}
