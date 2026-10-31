import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, test } from "node:test";
import { closeDb, getDb, initDb } from "../src/db/client.js";
import { runDoctor } from "../src/cli.js";
import { normalizeEdge, recordEdge, repointEdges } from "../src/lib/edges.js";
import { resolveRepo } from "../src/lib/repo.js";
import { applyMerges, fetchMergeCandidates, planMerges } from "../src/lib/merge.js";
import { exportMemories, importMemories } from "../src/lib/portability.js";
import { registerRememberTool } from "../src/tools/remember.js";
import { registerSupersedeMemoryTool } from "../src/tools/supersede.js";
import { createTestDb, insertMemory } from "./helpers.js";

const REPO = "acme/app";

type ToolResponse = { isError?: boolean; content: Array<{ type: string; text: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResponse>;

function capture(register: (server: McpServer) => void): Handler {
  let handler: Handler | undefined;
  register({
    registerTool: (_name: string, _config: unknown, h: Handler) => {
      handler = h;
    },
  } as unknown as McpServer);
  assert.ok(handler);
  return handler;
}

function idOf(db: Database.Database, rowId: number): string {
  return (db.prepare("SELECT id FROM memories WHERE rowid = ?").get(rowId) as { id: string }).id;
}

function edges(db: Database.Database) {
  return db
    .prepare(
      "SELECT src_id, dst_id, type, weight, valid_to FROM memory_edges ORDER BY type, src_id, dst_id",
    )
    .all() as Array<{
    src_id: string;
    dst_id: string;
    type: string;
    weight: number | null;
    valid_to: number | null;
  }>;
}

// --- remember / supersede_memory, through the real tool handlers ----------

let dir: string;
let prevWorkspace: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fossel-edges-write-"));
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

test("remember records a contradicts edge for a flagged contradiction", async () => {
  const db = getDb();
  const old = idOf(db, insertMemory(db, REPO, "We use Redis for caching across the API layer."));
  const remember = capture(registerRememberTool);

  const res = await remember({ note: "We no longer use Redis for caching in the API layer.", repo: REPO });
  assert.ok(!res.isError, res.content[0]?.text);
  assert.match(res.content[0].text, /may contradict\/supersede/);

  const [edge, ...rest] = edges(db);
  assert.equal(rest.length, 0);
  assert.equal(edge.type, "contradicts");
  assert.ok([edge.src_id, edge.dst_id].includes(old));
  assert.ok(edge.src_id < edge.dst_id, "symmetric type is stored ordered");
  assert.ok(edge.weight !== null && edge.weight > 0 && edge.weight < 1, "similarity kept as weight");
  assert.equal(edge.valid_to, null);
});

test("remember records a relates_to edge for a related, non-contradicting note", async () => {
  const db = getDb();
  insertMemory(db, REPO, "We use Redis for caching across the API layer.");
  const remember = capture(registerRememberTool);

  await remember({ note: "Redis caching has high latency under load in the API layer.", repo: REPO });
  assert.deepEqual(edges(db).map((e) => e.type), ["relates_to"]);
});

test("remember records no edge when nothing is related", async () => {
  const db = getDb();
  insertMemory(db, REPO, "The CI pipeline runs on GitHub Actions with a node 20 matrix.");
  const remember = capture(registerRememberTool);

  await remember({ note: "Coffee tastes better with oat milk in the morning.", repo: REPO });
  assert.deepEqual(edges(db), []);
});

test("re-saving the same related note does not duplicate edges", async () => {
  const db = getDb();
  insertMemory(db, REPO, "We use Redis for caching across the API layer.");
  const remember = capture(registerRememberTool);
  const note = "Redis caching has high latency under load in the API layer.";

  await remember({ note, repo: REPO });
  // Second save merges into the memory written by the first, then conflict
  // review is not re-run, so no new edge either way.
  const res = await remember({ note, repo: REPO });
  assert.match(res.content[0].text, /Merged into memory/);
  assert.equal(edges(db).length, 1);
});

test("supersede_memory with superseded_by records a directed supersedes edge", async () => {
  const db = getDb();
  const oldRow = insertMemory(db, REPO, "JWT lives in localStorage.");
  const newRow = insertMemory(db, REPO, "JWT moved to httpOnly cookies.");
  const supersede = capture(registerSupersedeMemoryTool);

  const res = await supersede({ id: oldRow, superseded_by: newRow });
  assert.ok(!res.isError, res.content[0]?.text);

  const [edge] = edges(db);
  assert.deepEqual(
    { src: edge.src_id, dst: edge.dst_id, type: edge.type, valid_to: edge.valid_to },
    { src: idOf(db, newRow), dst: idOf(db, oldRow), type: "supersedes", valid_to: null },
  );

  // The point of tombstoning: the edge is still readable after the client
  // deletes the superseded memory, as remember/consolidate tell it to.
  db.prepare("DELETE FROM memories WHERE rowid = ?").run(oldRow);
  const after = edges(db);
  assert.equal(after.length, 1);
  assert.equal(after[0].type, "supersedes");
  assert.ok(after[0].valid_to !== null);
});

test("supersede_memory without superseded_by records no edge", async () => {
  const db = getDb();
  const row = insertMemory(db, REPO, "JWT lives in localStorage.");
  await capture(registerSupersedeMemoryTool)({ id: row });
  assert.deepEqual(edges(db), []);
});

test("supersede_memory across repos keeps the changelog link but writes no edge", async () => {
  const db = getDb();
  const oldRow = insertMemory(db, REPO, "JWT lives in localStorage.");
  const otherRow = insertMemory(db, "other/repo", "JWT moved to httpOnly cookies.");

  const res = await capture(registerSupersedeMemoryTool)({ id: oldRow, superseded_by: otherRow });
  assert.ok(!res.isError, res.content[0]?.text);
  assert.deepEqual(edges(db), []);
});

test("fossel doctor --fix moves an exact duplicate's edges to the survivor", () => {
  // runDoctor resolves the repo from process.cwd(), so run it from the temp dir.
  const prevCwd = process.cwd();
  const prevDbPath = process.env.FOSSEL_DB_PATH;
  const prevLog = console.log;
  process.env.FOSSEL_DB_PATH = join(dir, "memory.db");
  process.chdir(dir);
  try {
    const db = getDb();
    const repo = resolveRepo(dir, db).canonical;
    const keep = idOf(db, insertMemory(db, repo, "Use pnpm.", { type: "convention", updatedAt: 200 }));
    const drop = idOf(db, insertMemory(db, repo, "Use pnpm.", { type: "convention", updatedAt: 100 }));
    const other = idOf(db, insertMemory(db, repo, "CI runs on GitHub Actions.", { type: "convention" }));
    recordEdge(db, drop, other, "fixes");

    console.log = () => {};
    runDoctor({ fix: true });
    console.log = prevLog;

    initDb(join(dir, "memory.db"));
    const after = edges(getDb());
    assert.deepEqual(
      after.map((e) => [e.src_id, e.dst_id, e.type, e.valid_to]),
      [[keep, other, "fixes", null]],
    );
  } finally {
    console.log = prevLog;
    process.chdir(prevCwd);
    if (prevDbPath === undefined) {
      delete process.env.FOSSEL_DB_PATH;
    } else {
      process.env.FOSSEL_DB_PATH = prevDbPath;
    }
  }
});

// --- lib: ordering, re-pointing on merge, export/import -------------------

test("normalizeEdge orders symmetric types only", () => {
  assert.deepEqual(normalizeEdge("b", "a", "relates_to"), { src_id: "a", dst_id: "b" });
  assert.deepEqual(normalizeEdge("b", "a", "contradicts"), { src_id: "a", dst_id: "b" });
  assert.deepEqual(normalizeEdge("b", "a", "supersedes"), { src_id: "b", dst_id: "a" });
  assert.deepEqual(normalizeEdge("b", "a", "fixes"), { src_id: "b", dst_id: "a" });
});

test("recordEdge is idempotent and does not revive an ended edge", () => {
  const ctx = createTestDb();
  try {
    const a = idOf(ctx.db, insertMemory(ctx.db, REPO, "a"));
    const b = idOf(ctx.db, insertMemory(ctx.db, REPO, "b"));
    assert.equal(recordEdge(ctx.db, a, b, "fixes"), true);
    assert.equal(recordEdge(ctx.db, a, b, "fixes"), false);
    // Same symmetric edge given the other way round is the same row.
    assert.equal(recordEdge(ctx.db, b, a, "relates_to"), true);
    assert.equal(recordEdge(ctx.db, a, b, "relates_to"), false);

    ctx.db.prepare("UPDATE memory_edges SET valid_to = 7 WHERE type = 'fixes'").run();
    assert.equal(recordEdge(ctx.db, a, b, "fixes"), false);
    assert.equal(
      (ctx.db.prepare("SELECT valid_to FROM memory_edges WHERE type = 'fixes'").get() as { valid_to: number }).valid_to,
      7,
    );
  } finally {
    ctx.cleanup();
  }
});

test("dedupe moves the dropped duplicate's edges to the survivor", () => {
  const ctx = createTestDb();
  try {
    const keepRow = insertMemory(ctx.db, REPO, "Use pnpm workspaces for every package script.", { updatedAt: 200 });
    const dropRow = insertMemory(ctx.db, REPO, "Use pnpm workspaces for every package script!", { updatedAt: 100 });
    const other = idOf(ctx.db, insertMemory(ctx.db, REPO, "CI runs on GitHub Actions."));
    const third = idOf(ctx.db, insertMemory(ctx.db, REPO, "Releases are tagged v*."));
    const keep = idOf(ctx.db, keepRow);
    const drop = idOf(ctx.db, dropRow);

    recordEdge(ctx.db, drop, other, "fixes");
    recordEdge(ctx.db, drop, third, "relates_to");
    recordEdge(ctx.db, keep, third, "relates_to"); // survivor already has this one
    recordEdge(ctx.db, drop, keep, "relates_to"); // would become a self-edge

    const rows = fetchMergeCandidates(ctx.db, REPO);
    const plan = planMerges(rows, 0.85);
    assert.deepEqual(plan.map((p) => [p.keep, p.drop]), [[keepRow, dropRow]]);
    applyMerges(ctx.db, rows, plan);

    const after = edges(ctx.db);
    assert.ok(after.every((e) => e.src_id !== drop && e.dst_id !== drop), "nothing points at the deleted row");
    assert.ok(after.every((e) => e.valid_to === null), "moved edges stay live");
    assert.equal(after.length, 2, "fixes moved; duplicate relates_to and self-edge dropped");
    assert.ok(after.some((e) => e.type === "fixes" && e.src_id === keep && e.dst_id === other));
  } finally {
    ctx.cleanup();
  }
});

test("repointEdges keeps symmetric edges ordered after the move", () => {
  const ctx = createTestDb();
  try {
    const ids = ["x", "y", "z"].map((n) => idOf(ctx.db, insertMemory(ctx.db, REPO, n))).sort();
    const [low, mid, high] = ids;
    recordEdge(ctx.db, low, mid, "relates_to");
    // Moving `low` onto `high` turns (low, mid) into (high, mid), which has to
    // be stored as (mid, high).
    repointEdges(ctx.db, low, high);
    assert.deepEqual(
      edges(ctx.db).map((e) => [e.src_id, e.dst_id]),
      [[mid, high]],
    );
  } finally {
    ctx.cleanup();
  }
});

test("export includes edges and import restores them idempotently", () => {
  const src = createTestDb();
  const dst = createTestDb();
  try {
    const oldId = idOf(src.db, insertMemory(src.db, REPO, "JWT lives in localStorage."));
    const newId = idOf(src.db, insertMemory(src.db, REPO, "JWT moved to httpOnly cookies."));
    const otherId = idOf(src.db, insertMemory(src.db, REPO, "CI runs on GitHub Actions."));
    recordEdge(src.db, newId, oldId, "supersedes");
    recordEdge(src.db, newId, otherId, "relates_to");
    // Ended edge whose endpoint is gone: history that must survive the trip.
    src.db.prepare("DELETE FROM memories WHERE id = ?").run(otherId);

    const envelope = exportMemories(src.db);
    assert.equal(envelope.version, 3);
    assert.equal(envelope.edges.length, 2);

    const first = importMemories(dst.db, JSON.parse(JSON.stringify(envelope)), dst.dir);
    assert.equal(first.edgesImported, 2);
    assert.equal(first.edgesFailed, 0);
    assert.deepEqual(edges(dst.db), edges(src.db));

    const second = importMemories(dst.db, JSON.parse(JSON.stringify(envelope)), dst.dir);
    assert.equal(second.edgesImported, 0);
    assert.equal(second.edgesSkipped, 2);
    assert.deepEqual(edges(dst.db), edges(src.db));
  } finally {
    src.cleanup();
    dst.cleanup();
  }
});

test("import counts a malformed or dangling live edge as failed and keeps going", () => {
  const ctx = createTestDb();
  try {
    const a = idOf(ctx.db, insertMemory(ctx.db, REPO, "a"));
    const b = idOf(ctx.db, insertMemory(ctx.db, REPO, "b"));
    const envelope = { ...exportMemories(ctx.db) };
    const base = { weight: null, created_at: 1, valid_from: 1, valid_to: null };
    envelope.edges = [
      { src_id: a, dst_id: b, type: "fixes", ...base },
      { src_id: a, dst_id: "missing", type: "fixes", ...base },
      { src_id: a, dst_id: b, type: "causes", ...base },
    ] as typeof envelope.edges;

    const result = importMemories(ctx.db, JSON.parse(JSON.stringify(envelope)), ctx.dir);
    assert.equal(result.edgesImported, 1);
    assert.equal(result.edgesFailed, 2);
  } finally {
    ctx.cleanup();
  }
});

test("a v2 envelope without edges still imports", () => {
  const src = createTestDb();
  const dst = createTestDb();
  try {
    insertMemory(src.db, REPO, "a");
    const { edges: _omit, ...v2 } = { ...exportMemories(src.db), version: 2 };
    const result = importMemories(dst.db, JSON.parse(JSON.stringify(v2)), dst.dir);
    assert.equal(result.memoriesImported, 1);
    assert.equal(result.edgesImported, 0);
  } finally {
    src.cleanup();
    dst.cleanup();
  }
});
