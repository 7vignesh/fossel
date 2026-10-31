import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, test } from "node:test";
import { createTestDb, insertMemory, type TestDb } from "./helpers.js";

const REPO = "acme/app";

let ctx: TestDb;

beforeEach(() => {
  ctx = createTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

function idOf(db: Database.Database, rowId: number): string {
  return (db.prepare("SELECT id FROM memories WHERE rowid = ?").get(rowId) as { id: string }).id;
}

function addEdge(
  db: Database.Database,
  src: string,
  dst: string,
  type: string,
  validTo: number | null = null,
): void {
  db.prepare(
    `INSERT INTO memory_edges (src_id, dst_id, type, created_at, valid_from, valid_to)
     VALUES (?, ?, ?, 100, 100, ?)`,
  ).run(src, dst, type, validTo);
}

function edges(db: Database.Database) {
  return db
    .prepare("SELECT src_id, dst_id, type, valid_to FROM memory_edges ORDER BY src_id, dst_id, type")
    .all() as Array<{ src_id: string; dst_id: string; type: string; valid_to: number | null }>;
}

test("deleting a memory tombstones its edges instead of removing them", () => {
  const oldFact = idOf(ctx.db, insertMemory(ctx.db, REPO, "JWT lives in localStorage."));
  const newFact = idOf(ctx.db, insertMemory(ctx.db, REPO, "JWT moved to httpOnly cookies."));
  addEdge(ctx.db, newFact, oldFact, "supersedes");

  ctx.db.prepare("DELETE FROM memories WHERE id = ?").run(oldFact);

  const rows = edges(ctx.db);
  assert.equal(rows.length, 1, "the supersedes edge must still be readable");
  assert.equal(rows[0].type, "supersedes");
  assert.equal(rows[0].src_id, newFact);
  assert.equal(rows[0].dst_id, oldFact);
  assert.ok(rows[0].valid_to !== null, "the edge is ended, not left live");
});

test("deleting a memory leaves unrelated edges live", () => {
  const [a, b, c] = ["a", "b", "c"].map((n) => idOf(ctx.db, insertMemory(ctx.db, REPO, n)));
  addEdge(ctx.db, a, b, "fixes");
  addEdge(ctx.db, b, c, "fixes");

  ctx.db.prepare("DELETE FROM memories WHERE id = ?").run(a);

  const byPair = new Map(edges(ctx.db).map((e) => [`${e.src_id}>${e.dst_id}`, e.valid_to]));
  assert.notEqual(byPair.get(`${a}>${b}`), null, "the edge touching the deleted memory ends");
  assert.equal(byPair.get(`${b}>${c}`), null, "an edge between two live memories stays live");
});

test("an already-ended edge keeps its original valid_to when an endpoint is deleted", () => {
  const a = idOf(ctx.db, insertMemory(ctx.db, REPO, "a"));
  const b = idOf(ctx.db, insertMemory(ctx.db, REPO, "b"));
  addEdge(ctx.db, a, b, "fixes");
  ctx.db.prepare("UPDATE memory_edges SET valid_to = 555").run();

  ctx.db.prepare("DELETE FROM memories WHERE id = ?").run(a);
  assert.equal(edges(ctx.db)[0].valid_to, 555);
});

test("a reused rowid does not attach an old edge to a new memory", () => {
  // SQLite reuses the rowid of the highest deleted row. Edges are keyed by
  // memories.id, so a new memory that gets the same rowid has no edges.
  const a = idOf(ctx.db, insertMemory(ctx.db, REPO, "a"));
  const bRow = insertMemory(ctx.db, REPO, "b");
  const b = idOf(ctx.db, bRow);
  addEdge(ctx.db, a, b, "fixes");
  ctx.db.prepare("DELETE FROM memories WHERE id = ?").run(b);

  const cRow = insertMemory(ctx.db, REPO, "c");
  assert.equal(cRow, bRow, "precondition: SQLite reused the rowid");
  const c = idOf(ctx.db, cRow);

  const touchingC = edges(ctx.db).filter((e) => e.src_id === c || e.dst_id === c);
  assert.deepEqual(touchingC, []);
});

test("one edge per (src_id, dst_id, type); ON CONFLICT DO NOTHING is a no-op", () => {
  const a = idOf(ctx.db, insertMemory(ctx.db, REPO, "a"));
  const b = idOf(ctx.db, insertMemory(ctx.db, REPO, "b"));
  addEdge(ctx.db, a, b, "fixes");

  assert.throws(() => addEdge(ctx.db, a, b, "fixes"), /UNIQUE|PRIMARY KEY/);

  const result = ctx.db
    .prepare(
      `INSERT INTO memory_edges (src_id, dst_id, type, created_at, valid_from)
       VALUES (?, ?, 'fixes', 1, 1) ON CONFLICT DO NOTHING`,
    )
    .run(a, b);
  assert.equal(result.changes, 0);

  // A different type between the same pair is a separate edge.
  addEdge(ctx.db, a, b, "supersedes");
  assert.equal(edges(ctx.db).length, 2);
});

test("symmetric types must be stored with src_id < dst_id", () => {
  const ids = ["a", "b"].map((n) => idOf(ctx.db, insertMemory(ctx.db, REPO, n))).sort();
  const [low, high] = ids;

  for (const type of ["contradicts", "relates_to"]) {
    assert.throws(() => addEdge(ctx.db, high, low, type), /CHECK/, `${type} high->low`);
    addEdge(ctx.db, low, high, type);
  }
  // Directed types may point either way.
  addEdge(ctx.db, high, low, "supersedes");
  addEdge(ctx.db, low, high, "supersedes");
});

test("rejects self-edges and unknown types", () => {
  const a = idOf(ctx.db, insertMemory(ctx.db, REPO, "a"));
  const b = idOf(ctx.db, insertMemory(ctx.db, REPO, "b"));
  assert.throws(() => addEdge(ctx.db, a, a, "fixes"), /CHECK/);
  assert.throws(() => addEdge(ctx.db, a, b, "causes"), /CHECK/);
});

test("live edges must connect two existing memories in the same repo", () => {
  const a = idOf(ctx.db, insertMemory(ctx.db, REPO, "a"));
  const b = idOf(ctx.db, insertMemory(ctx.db, REPO, "b"));
  const other = idOf(ctx.db, insertMemory(ctx.db, "other/repo", "x"));

  assert.throws(() => addEdge(ctx.db, a, other, "fixes"), /same repo/);
  assert.throws(() => addEdge(ctx.db, a, "no-such-id", "fixes"), /same repo/);
  assert.throws(() => addEdge(ctx.db, "no-such-id", a, "fixes"), /same repo/);
  addEdge(ctx.db, a, b, "fixes");
});

test("an already-ended edge may name a deleted memory, so history can be imported", () => {
  const a = idOf(ctx.db, insertMemory(ctx.db, REPO, "a"));
  addEdge(ctx.db, a, "deleted-long-ago", "supersedes", 123);
  assert.equal(edges(ctx.db)[0].valid_to, 123);
});

test("superseding a memory does not change its edges", () => {
  const a = idOf(ctx.db, insertMemory(ctx.db, REPO, "a"));
  const b = idOf(ctx.db, insertMemory(ctx.db, REPO, "b"));
  addEdge(ctx.db, b, a, "supersedes");

  ctx.db.prepare("UPDATE memories SET valid_to = 999 WHERE id = ?").run(a);
  assert.equal(edges(ctx.db)[0].valid_to, null);
});

test("the edges migration applies to a database that already has memories", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { runMigrations } = await import("../src/db/migrate.js");
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    db.prepare("DELETE FROM migrations WHERE name = '014_add_memory_edges'").run();
    db.exec(`
      DROP TRIGGER memories_edges_ad;
      DROP TRIGGER memory_edges_same_repo;
      DROP TABLE memory_edges;
    `);
    insertMemory(db, REPO, "existing memory");

    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('memory_edges', 'memories_edges_ad', 'memory_edges_same_repo') ORDER BY name")
      .all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((t) => t.name), ["memories_edges_ad", "memory_edges", "memory_edges_same_repo"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n, 1);
  } finally {
    db.close();
  }
});
