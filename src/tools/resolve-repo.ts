import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { resolveRepo } from "../lib/repo.js";

const resolveRepoInputSchema = {
  cwd: z.string().trim().min(1).optional(),
};

export function registerResolveRepoTool(server: McpServer): void {
  server.registerTool(
    "resolve_repo",
    {
      description:
        "Return the canonical repo key for a working directory along with any aliases and the detected git remote. Useful for clients that want to display which repo Fossel is targeting before making other tool calls.",
      inputSchema: resolveRepoInputSchema,
    },
    async ({ cwd }) => {
      try {
        const db = getDb();
        const target = cwd?.trim() || process.cwd();
        const resolved = resolveRepo(target, db);

        const payload = {
          canonical: resolved.canonical,
          aliases: resolved.aliases,
          cwd: resolved.cwd,
          gitRemote: resolved.gitRemote,
          source: resolved.source,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while resolving repo.";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to resolve repo: ${message}`,
            },
          ],
        };
      }
    },
  );
}
