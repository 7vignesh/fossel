import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/client.js";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  exportMemories,
  importMemories,
  type ExportEnvelope,
} from "../lib/portability.js";
import { resolveRepoArg } from "../lib/repo.js";
import { getWorkspaceRoot } from "../lib/workspace.js";

const exportInputSchema = {
  repo: z.string().trim().min(1).optional(),
};

export function registerExportMemoriesTool(server: McpServer): void {
  server.registerTool(
    "export_memories",
    {
      description:
        "Export all memories (and repo aliases) as a portable JSON envelope. " +
        "Embeddings are not included — they are re-derived on import so the file stays small " +
        "and model-agnostic. Pass a repo to scope the export; omit to export everything.",
      inputSchema: exportInputSchema,
    },
    async ({ repo }) => {
      try {
        const db = getDb();
        const resolved = repo
          ? resolveRepoArg(repo, getWorkspaceRoot(), db).canonical
          : undefined;
        const envelope = exportMemories(db, resolved);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(envelope, null, 2),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while exporting.";
        return {
          isError: true,
          content: [{ type: "text", text: `Export failed: ${message}` }],
        };
      }
    },
  );
}

const importInputSchema = {
  data: z.string().trim().min(1, "data is required (the JSON envelope)"),
};

export function registerImportMemoriesTool(server: McpServer): void {
  server.registerTool(
    "import_memories",
    {
      description:
        "Import memories from a JSON envelope produced by export_memories. " +
        "Additive and idempotent: existing memories with the same id are never overwritten, " +
        "so re-importing the same file is a no-op. Embeddings and file references are " +
        "re-derived on import.",
      inputSchema: importInputSchema,
    },
    async ({ data }) => {
      try {
        const db = getDb();
        let envelope: ExportEnvelope;
        try {
          const parsed = JSON.parse(data) as unknown;
          if (
            !parsed ||
            typeof parsed !== "object" ||
            (parsed as Record<string, unknown>).format !== EXPORT_FORMAT
          ) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Invalid envelope: expected format "${EXPORT_FORMAT}".`,
                },
              ],
            };
          }
          envelope = parsed as ExportEnvelope;
        } catch {
          return {
            isError: true,
            content: [{ type: "text", text: "Invalid JSON in the data field." }],
          };
        }

        const result = importMemories(db, envelope, getWorkspaceRoot());
        return {
          content: [
            {
              type: "text",
              text:
                `Imported ${result.memoriesImported} memory(s), ` +
                `skipped ${result.memoriesSkipped} existing. ` +
                `Aliases: ${result.aliasesImported} imported, ${result.aliasesSkipped} existing.`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while importing.";
        return {
          isError: true,
          content: [{ type: "text", text: `Import failed: ${message}` }],
        };
      }
    },
  );
}
