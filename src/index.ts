#!/usr/bin/env node

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDb } from "./db/client.js";
import { registerDeleteMemoryTool } from "./tools/delete.js";
import { registerGetRepoContextTool } from "./tools/get-repo.js";
import { registerPinMemoryTool, registerUnpinMemoryTool } from "./tools/pin.js";
import { registerSearchMemoryTool } from "./tools/search.js";
import { registerStoreContextTool } from "./tools/store.js";
import { registerSummarizeRepoContextTool } from "./tools/summarize.js";
import { registerUpdateMemoryTool } from "./tools/update.js";

export function resolveDbPath(): string {
  return (
    process.env.FOSSEL_DB_PATH?.trim() || join(homedir(), ".fossel", "memory.db")
  );
}

export async function startServer(): Promise<void> {
  const dbPath = resolveDbPath();
  initDb(dbPath);

  const server = new McpServer({
    name: "fossel",
    version: "1.0.0",
  });

  registerStoreContextTool(server);
  registerGetRepoContextTool(server);
  registerSearchMemoryTool(server);
  registerDeleteMemoryTool(server);
  registerUpdateMemoryTool(server);
  registerPinMemoryTool(server);
  registerUnpinMemoryTool(server);
  registerSummarizeRepoContextTool(server);

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
