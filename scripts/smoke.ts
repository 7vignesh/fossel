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
    const storeResult = (await client.callTool({
      name: "store_context",
      arguments: {
        repo,
        type: "bug_fix",
        note: "Fixed websocket reconnect race by awaiting auth handshake.",
        tags: ["websocket", "race-condition"],
      },
    })) as ToolResult;
    assertToolSuccess(storeResult, "store_context");

    const storedText = extractFirstText(storeResult);
    const id = extractMemoryId(storedText);
    console.log("store_context:", storedText);

    // remember should auto-infer type/tags and store a fresh row.
    const rememberResult = (await client.callTool({
      name: "remember",
      arguments: {
        repo,
        note: "JWT lives in localStorage and 401 redirects the user to /login.",
      },
    })) as ToolResult;
    assertToolSuccess(rememberResult, "remember");
    console.log("remember:", extractFirstText(rememberResult));

    // Storing the same note again (only punctuation differs) should merge via
    // the normalized fast path instead of creating a second row.
    const rememberAgain = (await client.callTool({
      name: "remember",
      arguments: {
        repo,
        note: "JWT lives in localStorage and 401 redirects the user to /login!!!",
      },
    })) as ToolResult;
    assertToolSuccess(rememberAgain, "remember (dedupe)");
    const dedupedText = extractFirstText(rememberAgain);
    if (!/Merged into memory/.test(dedupedText)) {
      throw new Error(`Expected merge but got: ${dedupedText}`);
    }
    console.log("remember (dedupe):", dedupedText);

    const getContextResult = (await client.callTool({
      name: "get_context",
      arguments: { repo, query: "auth", limit: 5, format: "markdown" },
    })) as ToolResult;
    assertToolSuccess(getContextResult, "get_context");
    console.log("get_context:", extractFirstText(getContextResult));

    const resolveResult = (await client.callTool({
      name: "resolve_repo",
      arguments: {},
    })) as ToolResult;
    assertToolSuccess(resolveResult, "resolve_repo");
    console.log("resolve_repo:", extractFirstText(resolveResult));

    const dedupeResult = (await client.callTool({
      name: "dedupe_repo",
      arguments: { repo, apply: false },
    })) as ToolResult;
    assertToolSuccess(dedupeResult, "dedupe_repo");
    console.log("dedupe_repo:", extractFirstText(dedupeResult));

    const getRepoResult = (await client.callTool({
      name: "get_repo_context",
      arguments: { repo, limit: 10 },
    })) as ToolResult;
    assertToolSuccess(getRepoResult, "get_repo_context");
    console.log("get_repo_context:", extractFirstText(getRepoResult));

    const searchResult = (await client.callTool({
      name: "search_memory",
      arguments: { query: "websocket reconnect auth handshake", repo, limit: 5 },
    })) as ToolResult;
    assertToolSuccess(searchResult, "search_memory");
    console.log("search_memory:", extractFirstText(searchResult));

    const deleteResult = (await client.callTool({
      name: "delete_memory",
      arguments: { id },
    })) as ToolResult;
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
