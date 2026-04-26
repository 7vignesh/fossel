#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDb } from "./db/client.js";
import { registerDeleteMemoryTool } from "./tools/delete.js";
import { registerGetRepoContextTool } from "./tools/get-repo.js";
import { registerSearchMemoryTool } from "./tools/search.js";
import { registerStoreContextTool } from "./tools/store.js";

async function main(): Promise<void> {
  const dbPath =
    process.env.FOSSYL_DB_PATH?.trim() || join(homedir(), ".fossyl", "memory.db");
  initDb(dbPath);

  const server = new McpServer({
    name: "fossel",
    version: "1.0.0",
  });

  registerStoreContextTool(server);
  registerGetRepoContextTool(server);
  registerSearchMemoryTool(server);
  registerDeleteMemoryTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fossyl server failed to start: ${message}`);
  process.exit(1);
});
