import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, test } from "node:test";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, initDb } from "../src/db/client.js";
import { registerStoreContextTool } from "../src/tools/store.js";

type StoreArgs = {
  repo?: string;
  type: string;
  note: string;
  tags?: string[];
};
type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};
type Handler = (args: StoreArgs) => Promise<ToolResponse>;

let dir: string;
let prevWorkspace: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fossel-store-test-"));
  // Point both the db and the workspace at the temp dir so the real tool
  // handler operates in isolation.
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
  registerStoreContextTool(fakeServer);
  assert.ok(handler, "store_context handler should register");
  return handler;
}

test("store_context records entities so stored memories are searchable by entity", async () => {
  const handler = captureHandler();
  const response = await handler({
    type: "bug_fix",
    note: "Rewrote the token check in src/auth.ts",
  });
  assert.equal(response.isError, undefined);

  const db = initDb(join(dir, "memory.db"));
  const row = db
    .prepare("SELECT rowid AS id FROM memories ORDER BY rowid DESC LIMIT 1")
    .get() as { id: number };
  const entities = db
    .prepare("SELECT entity FROM memory_entities WHERE memory_rowid = ?")
    .all(row.id) as Array<{ entity: string }>;

  assert.ok(
    entities.some((e) => e.entity === "src/auth.ts"),
    "store_context must record the file entity for entity-based retrieval",
  );
});
