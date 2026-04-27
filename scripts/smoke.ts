import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function extractFirstText(result: ToolResult): string {
  const textContent = result.content?.find((item) => item.type === "text");
  if (!textContent?.text) {
    throw new Error("Tool result did not include text content.");
  }

  return textContent.text;
}

function assertToolSuccess(result: ToolResult, toolName: string): void {
  if (result.isError) {
    throw new Error(`${toolName} returned an MCP error: ${extractFirstText(result)}`);
  }
}

function extractMemoryId(message: string): string {
  const match = /Stored memory ([A-Za-z0-9_-]+)/.exec(message);
  if (!match?.[1]) {
    throw new Error(`Could not parse memory id from message: ${message}`);
  }

  return match[1];
}

async function main(): Promise<void> {
  const repo = "RocketChat/Rocket.Chat";
  const client = new Client({
    name: "fossel-smoke-client",
    version: "0.1.0",
  });

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      FOSSEL_DB_PATH: join(tmpdir(), `fossel-smoke-${Date.now()}.db`),
    },
    stderr: "inherit",
  });

  await client.connect(transport);

  try {
    const storeResult = await client.callTool({
      name: "store_context",
      arguments: {
        repo,
        type: "bug_fix",
        note: "Fixed websocket reconnect race by awaiting auth handshake.",
        tags: ["websocket", "race-condition"],
      },
    });
    assertToolSuccess(storeResult, "store_context");

    const storedText = extractFirstText(storeResult);
    const id = extractMemoryId(storedText);
    console.log("store_context:", storedText);

    const getRepoResult = await client.callTool({
      name: "get_repo_context",
      arguments: { repo, limit: 10 },
    });
    assertToolSuccess(getRepoResult, "get_repo_context");
    console.log("get_repo_context:", extractFirstText(getRepoResult));

    const searchResult = await client.callTool({
      name: "search_memory",
      arguments: { query: "websocket reconnect auth handshake", repo, limit: 5 },
    });
    assertToolSuccess(searchResult, "search_memory");
    console.log("search_memory:", extractFirstText(searchResult));

    const deleteResult = await client.callTool({
      name: "delete_memory",
      arguments: { id },
    });
    assertToolSuccess(deleteResult, "delete_memory");
    console.log("delete_memory:", extractFirstText(deleteResult));

    console.log("Smoke test passed.");
  } finally {
    await transport.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Smoke test failed: ${message}`);
  process.exit(1);
});
