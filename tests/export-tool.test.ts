import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, test } from "node:test";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, getDb, initDb } from "../src/db/client.js";
import { registerExportMemoriesTool } from "../src/tools/portability.js";

type ExportArgs = { repo?: string; path?: string };
type ToolResponse = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};
type Handler = (args: ExportArgs) => Promise<ToolResponse>;

let dir: string;
let prevWorkspace: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fossel-export-test-"));
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
  registerExportMemoriesTool(fakeServer);
  assert.ok(handler, "export_memories handler should register");
  return handler;
}

function seedMemory(note: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO memories (id, repo, type, note, tags, created_at, updated_at, pinned, metadata_json, note_normalized)
     VALUES (?, 'acme/app', 'general', ?, '[]', ?, ?, 0, '{}', ?)`,
  ).run(`id-${Math.random().toString(36).slice(2)}`, note, now, now, note.toLowerCase());
}

test("export_memories returns the full JSON inline when no path is given", async () => {
  seedMemory("inline fact");
  const handler = captureHandler();
  const res = await handler({});
  assert.equal(res.isError, undefined);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.format, "fossel-export");
  assert.ok(parsed.memories.some((m: { note: string }) => m.note === "inline fact"));
});

test("export_memories writes to a file and returns a summary when path is given", async () => {
  seedMemory("file fact");
  const handler = captureHandler();
  const res = await handler({ path: "backup.json" });

  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /Exported 1 memory/);
  assert.doesNotMatch(res.content[0].text, /"format"/, "summary, not the full JSON");

  const written = JSON.parse(readFileSync(join(dir, "backup.json"), "utf8"));
  assert.equal(written.format, "fossel-export");
  assert.ok(written.memories.some((m: { note: string }) => m.note === "file fact"));
});

test("export_memories writes into a nested path inside the workspace", async () => {
  // The directory must already exist; the point here is the path resolves
  // safely within the workspace, not that we create directories.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "sub"));
  seedMemory("nested");
  const handler = captureHandler();
  const res = await handler({ path: "sub/backup.json" });
  assert.equal(res.isError, undefined);
  assert.ok(readFileSync(join(dir, "sub", "backup.json"), "utf8").includes("fossel-export"));
});

test("export_memories refuses a path that escapes the workspace", async () => {
  seedMemory("fact");
  const handler = captureHandler();
  const res = await handler({ path: "../escape.json" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /outside the workspace/);
});

test("export_memories refuses an absolute path outside the workspace", async () => {
  seedMemory("fact");
  const handler = captureHandler();
  const outside = join(tmpdir(), "fossel-outside.json");
  const res = await handler({ path: outside });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /outside the workspace/);
});
