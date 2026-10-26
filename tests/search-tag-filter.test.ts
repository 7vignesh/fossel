import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, test } from "node:test";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, getDb, initDb } from "../src/db/client.js";
import { registerSearchMemoryTool } from "../src/tools/search.js";
import { insertMemory } from "./helpers.js";

const REPO = "acme/storefront";

type SearchArgs = {
  query: string;
  repo?: string;
  limit?: number;
  tags?: string[];
  tagMatch?: "and" | "or";
};
type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};
type Handler = (args: SearchArgs) => Promise<ToolResponse>;

let dir: string;
let prevWorkspace: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fossel-search-test-"));
  initDb(join(dir, "memory.db"));
  prevWorkspace = process.env.FOSSEL_WORKSPACE;
  process.env.FOSSEL_WORKSPACE = dir;
});

afterEach(() => {
  closeDb();
  if (prevWorkspace === undefined) {
    delete process.env.FOSSEL_WORKSPACE;
  } else {
    process.env.FOSSEL_WORKSPACE = prevWorkspace;
  }
  rmSync(dir, { recursive: true, force: true });
});

function captureHandler(): Handler {
  let handler: Handler | undefined;
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, h: Handler) => {
      handler = h;
    },
  } as unknown as McpServer;
  registerSearchMemoryTool(fakeServer);
  assert.ok(handler, "search_memory handler should register");
  return handler;
}

test("search_memory restricts hits to the requested tag", async () => {
  const db = getDb();
  insertMemory(db, REPO, "Rate limiting is enforced at the edge.", {
    tags: ["security"],
  });
  insertMemory(db, REPO, "Rate limiting the deploy cadence.", {
    tags: ["ci"],
  });

  const handler = captureHandler();
  const response = await handler({
    query: "rate limiting",
    repo: REPO,
    tags: ["security"],
    limit: 5,
    tagMatch: "or",
  });

  assert.ok(!response.isError);
  const text = response.content[0]?.text ?? "";
  assert.match(text, /enforced at the edge/);
  assert.doesNotMatch(text, /deploy cadence/);
});
