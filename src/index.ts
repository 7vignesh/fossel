#!/usr/bin/env node

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDb, initDb } from "./db/client.js";
import { fetchRepoContext, formatContext } from "./lib/context.js";
import { resolveRepo } from "./lib/repo.js";
import { getWorkspaceRoot } from "./lib/workspace.js";
import { registerDedupeRepoTool } from "./tools/dedupe-repo.js";
import { registerDeleteMemoryTool } from "./tools/delete.js";
import { registerGetContextTool } from "./tools/get-context.js";
import { registerGetRepoContextTool } from "./tools/get-repo.js";
import { registerPinMemoryTool, registerUnpinMemoryTool } from "./tools/pin.js";
import { registerRememberTool } from "./tools/remember.js";
import { registerResolveRepoTool } from "./tools/resolve-repo.js";
import { registerSearchMemoryTool } from "./tools/search.js";
import { registerStoreContextTool } from "./tools/store.js";
import { registerSummarizeRepoContextTool } from "./tools/summarize.js";
import { registerUpdateMemoryTool } from "./tools/update.js";

export function resolveDbPath(): string {
  return (
    process.env.FOSSEL_DB_PATH?.trim() || join(homedir(), ".fossel", "memory.db")
  );
}

/**
 * Register a static MCP resource that previews the workspace's top memories.
 * Clients that auto-list resources on connect (Cursor, Claude Desktop) will
 * surface this without a tool call, giving Fossel a "the agent just knows"
 * feel on session start. Clients that don't list resources can still call
 * `get_context` for the same data.
 */
function registerStartupContextResource(server: McpServer): void {
  server.registerResource(
    "fossel-startup-context",
    "fossel://context/current-repo",
    {
      title: "Fossel: current repo context",
      description:
        "Top pinned and recent memories for the current workspace. Read this at the start of a session to ground the conversation in prior context.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      try {
        const db = getDb();
        const resolved = resolveRepo(getWorkspaceRoot(), db);
        const rows = fetchRepoContext(db, resolved.canonical, 5);
        const text = formatContext(rows, {
          repo: resolved.canonical,
          format: "markdown",
        });

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: `# Fossel context unavailable\n\n${message}`,
            },
          ],
        };
      }
    },
  );
}

export async function startServer(): Promise<void> {
  const dbPath = resolveDbPath();
  initDb(dbPath);

  const server = new McpServer({
    name: "fossel",
    version: "1.4.0",
  });

  // Phase 1 ambient tools
  registerRememberTool(server);
  registerGetContextTool(server);
  registerResolveRepoTool(server);
  registerDedupeRepoTool(server);

  // Existing power-user tools (kept for backwards compatibility)
  registerStoreContextTool(server);
  registerGetRepoContextTool(server);
  registerSearchMemoryTool(server);
  registerDeleteMemoryTool(server);
  registerUpdateMemoryTool(server);
  registerPinMemoryTool(server);
  registerUnpinMemoryTool(server);
  registerSummarizeRepoContextTool(server);

  registerStartupContextResource(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const entryPath = process.argv[1];
const currentPath = fileURLToPath(import.meta.url);

if (entryPath && currentPath === resolve(entryPath)) {
  startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Fossel server failed to start: ${message}`);
    process.exit(1);
  });
}
