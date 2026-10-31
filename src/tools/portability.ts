import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { getDb } from "../db/client.js";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  exportMemories,
  importMemories,
  validateExportEnvelope,
} from "../lib/portability.js";
import { resolveRepoArg } from "../lib/repo.js";
import { getWorkspaceRoot } from "../lib/workspace.js";

const exportInputSchema = {
  repo: z.string().trim().min(1).optional(),
  path: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional file path to write the envelope to (resolved within the " +
        "workspace). When set, the response is a short summary instead of the " +
        "full JSON.",
    ),
};

/**
 * Resolve a user-supplied export path against the workspace root and reject
 * anything that escapes it. Prevents a tool call from writing outside the
 * project (path traversal / absolute paths pointing elsewhere).
 */
function resolveExportPath(userPath: string, workspace: string): string {
  const root = resolve(workspace);
  const target = isAbsolute(userPath) ? resolve(userPath) : resolve(root, userPath);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Refusing to write outside the workspace: "${userPath}" resolves outside ${root}.`,
    );
  }
  return target;
}

export function registerExportMemoriesTool(server: McpServer): void {
  server.registerTool(
    "export_memories",
    {
      description:
        "Export all memories (with repo aliases and the edges between memories) as a portable JSON envelope. " +
        "Embeddings are not included — they are re-derived on import so the file stays small " +
        "and model-agnostic. Pass a repo to scope the export; omit to export everything. " +
        "Pass a path to write the envelope to a file (within the workspace) and get a short " +
        "summary back instead of the full JSON.",
      inputSchema: exportInputSchema,
    },
    async ({ repo, path }) => {
      try {
        const db = getDb();
        const resolved = repo
          ? resolveRepoArg(repo, getWorkspaceRoot(), db).canonical
          : undefined;
        const envelope = exportMemories(db, resolved);
        const json = JSON.stringify(envelope, null, 2);

        if (path) {
          const target = resolveExportPath(path, getWorkspaceRoot());
          writeFileSync(target, json, "utf8");
          const scope = resolved ? ` for ${resolved}` : "";
          return {
            content: [
              {
                type: "text",
                text:
                  `Exported ${envelope.memories.length} memory(s), ` +
                  `${envelope.aliases.length} alias(es) and ` +
                  `${envelope.edges.length} edge(s)${scope} to ${target}.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: json,
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

export const MAX_IMPORT_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export const importInputSchema = {
  data: z
    .string()
    .trim()
    .min(1, "data is required (the JSON envelope)")
    .max(
      MAX_IMPORT_PAYLOAD_BYTES,
      `Payload exceeds maximum size of ${MAX_IMPORT_PAYLOAD_BYTES / (1024 * 1024)}MB.`,
    ),
};

export function registerImportMemoriesTool(server: McpServer): void {
  server.registerTool(
    "import_memories",
    {
      description:
        "Import memories from a JSON envelope produced by export_memories. " +
        "Additive and idempotent: existing memories with the same id are never overwritten, " +
        "so re-importing the same file is a no-op. Embeddings, file references and entities are " +
        "re-derived on import.",
      inputSchema: importInputSchema,
    },
    async ({ data }) => {
      if (data.length > MAX_IMPORT_PAYLOAD_BYTES) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Payload exceeds maximum size of ${MAX_IMPORT_PAYLOAD_BYTES / (1024 * 1024)}MB.`,
            },
          ],
        };
      }
      try {
        const db = getDb();
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return {
            isError: true,
            content: [{ type: "text", text: "Invalid JSON in the data field." }],
          };
        }

        let envelope: unknown;
        try {
          envelope = validateExportEnvelope(parsed);
        } catch (validationError) {
          const message =
            validationError instanceof Error
              ? validationError.message
              : "Invalid envelope.";
          return {
            isError: true,
            content: [{ type: "text", text: message }],
          };
        }

        const result = importMemories(db, envelope, getWorkspaceRoot());
        const failedPart =
          result.memoriesFailed > 0 ? `, failed ${result.memoriesFailed}` : "";
        const edgesFailedPart =
          result.edgesFailed > 0 ? `, failed ${result.edgesFailed}` : "";
        return {
          content: [
            {
              type: "text",
              text:
                `Imported ${result.memoriesImported} memory(s), ` +
                `skipped ${result.memoriesSkipped} existing${failedPart}. ` +
                `Aliases: ${result.aliasesImported} imported, ${result.aliasesSkipped} existing. ` +
                `Edges: ${result.edgesImported} imported, ${result.edgesSkipped} existing${edgesFailedPart}.`,
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
