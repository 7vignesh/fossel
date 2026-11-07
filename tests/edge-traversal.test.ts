import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, test } from "node:test";
import { fetchRepoContext } from "../src/lib/context.js";
import { recordEdge, findEdgeNeighbors } from "../src/lib/edges.js";
import { DEFAULT_FUSION_WEIGHTS } from "../src/lib/fusion.js";
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

// --- findEdgeNeighbors ----------------------------------------------------

test("findEdgeNeighbors returns the live neighbour of a seed", () => {
  const seed = insertMemory(ctx.db, REPO, "Login 500 when the cookie lacks SameSite.");
  const fix = insertMemory(ctx.db, REPO, "Set SameSite=Lax on every auth cookie.");
  recordEdge(ctx.db, idOf(ctx.db, fix), idOf(ctx.db, seed), "fixes");

  const neighbors = findEdgeNeighbors(ctx.db, REPO, [seed], 10);
  assert.deepEqual(
    neighbors.map((n) => n.row_id),
    [fix],
  );
  assert.equal(neighbors[0].edge_type, "fixes");
});

test("findEdgeNeighbors follows an edge from either endpoint", () => {
  const a = insertMemory(ctx.db, REPO, "memory A");
  const b = insertMemory(ctx.db, REPO, "memory B");
  recordEdge(ctx.db, idOf(ctx.db, a), idOf(ctx.db, b), "relates_to");

  assert.deepEqual(findEdgeNeighbors(ctx.db, REPO, [a], 10).map((n) => n.row_id), [b]);
  assert.deepEqual(findEdgeNeighbors(ctx.db, REPO, [b], 10).map((n) => n.row_id), [a]);
});

test("findEdgeNeighbors never returns a seed", () => {
  const a = insertMemory(ctx.db, REPO, "memory A");
  const b = insertMemory(ctx.db, REPO, "memory B");
  recordEdge(ctx.db, idOf(ctx.db, a), idOf(ctx.db, b), "relates_to");

  // Both ends are seeds; the only neighbour of each is the other seed, so
  // nothing new is returned.
  assert.deepEqual(findEdgeNeighbors(ctx.db, REPO, [a, b], 10), []);
});

test("findEdgeNeighbors does not cross repos", () => {
  const seed = insertMemory(ctx.db, REPO, "memory in repo A");
  const other = insertMemory(ctx.db, "other/repo", "memory in repo B");
  // A cross-repo live edge cannot be created (the trigger forbids it), so this
  // reflects reality: seed has no same-repo neighbour.
  assert.throws(() => recordEdge(ctx.db, idOf(ctx.db, seed), idOf(ctx.db, other), "relates_to"), /same repo/);
  assert.deepEqual(findEdgeNeighbors(ctx.db, REPO, [seed], 10), []);
});

test("findEdgeNeighbors excludes a tombstoned neighbour (supersession guard)", () => {
  const live = insertMemory(ctx.db, REPO, "JWT is now in an httpOnly cookie.");
  const old = insertMemory(ctx.db, REPO, "JWT lived in localStorage.");
  recordEdge(ctx.db, idOf(ctx.db, live), idOf(ctx.db, old), "supersedes");
  // Tombstone the old memory, as supersede_memory would.
  ctx.db.prepare("UPDATE memories SET valid_to = 1 WHERE rowid = ?").run(old);

  const neighbors = findEdgeNeighbors(ctx.db, REPO, [live], 10);
  assert.deepEqual(
    neighbors,
    [],
    "a live memory's supersedes edge must not pull the superseded fact back",
  );
});

test("findEdgeNeighbors excludes an ended edge even when both memories are live", () => {
  const a = insertMemory(ctx.db, REPO, "memory A");
  const b = insertMemory(ctx.db, REPO, "memory B");
  recordEdge(ctx.db, idOf(ctx.db, a), idOf(ctx.db, b), "relates_to");
  ctx.db.prepare("UPDATE memory_edges SET valid_to = 1").run();

  assert.deepEqual(findEdgeNeighbors(ctx.db, REPO, [a], 10), []);
});

// --- fetchRepoContext with the edge leg -----------------------------------

const EDGE_ON = { weights: { ...DEFAULT_FUSION_WEIGHTS, edge: 0.4 } };
const EDGE_OFF = { weights: { ...DEFAULT_FUSION_WEIGHTS, edge: 0 } };

test("edge traversal surfaces a neighbour that FTS alone misses", () => {
  const hit = insertMemory(ctx.db, REPO, "Login returned a 500 when the session cookie was missing SameSite.");
  // The neighbour shares no term with the query below, so FTS cannot reach it;
  // only the edge from the lexical hit can.
  const neighbour = insertMemory(ctx.db, REPO, "Middleware now always stamps the Lax attribute on responses.");
  // Fillers so the neighbour is not picked up by the recent backfill within
  // the limit.
  for (let i = 0; i < 8; i += 1) {
    insertMemory(ctx.db, REPO, `Unrelated note ${i} about deploys and config.`);
  }
  recordEdge(ctx.db, idOf(ctx.db, neighbour), idOf(ctx.db, hit), "fixes");

  const query = "login 500 missing session cookie";
  const withoutEdge = fetchRepoContext(ctx.db, REPO, 5, query, EDGE_OFF)
    .filter((r) => r.source === "search")
    .map((r) => r.row_id);
  const withEdge = fetchRepoContext(ctx.db, REPO, 5, query, EDGE_ON)
    .filter((r) => r.source === "search")
    .map((r) => r.row_id);

  assert.ok(withoutEdge.includes(hit), "the lexical hit is found either way");
  assert.ok(!withoutEdge.includes(neighbour), "FTS alone misses the neighbour");
  assert.ok(withEdge.includes(neighbour), "the edge leg recovers the neighbour");
});

test("the edge leg does not surface a superseded neighbour through get_context", () => {
  const live = insertMemory(ctx.db, REPO, "The session JWT is in an httpOnly cookie named sf_session.");
  const old = insertMemory(ctx.db, REPO, "The session JWT was kept in localStorage before 3.2.");
  recordEdge(ctx.db, idOf(ctx.db, live), idOf(ctx.db, old), "supersedes");
  ctx.db.prepare("UPDATE memories SET valid_to = 1 WHERE rowid = ?").run(old);

  const rows = fetchRepoContext(ctx.db, REPO, 5, "where is the session jwt stored", EDGE_ON);
  const ids = rows.map((r) => r.row_id);
  assert.ok(ids.includes(live), "the live memory surfaces");
  assert.ok(!ids.includes(old), "the superseded memory must never surface");
});

test("the edge leg is inert at weight 0 (default-off parity)", () => {
  const hit = insertMemory(ctx.db, REPO, "Checkout timed out on payment confirmation under load.");
  const neighbour = insertMemory(ctx.db, REPO, "Added an idempotency key to the charge call.");
  for (let i = 0; i < 8; i += 1) {
    insertMemory(ctx.db, REPO, `Filler ${i}.`);
  }
  recordEdge(ctx.db, idOf(ctx.db, neighbour), idOf(ctx.db, hit), "fixes");

  const withEdgeOff = fetchRepoContext(ctx.db, REPO, 5, "checkout payment timeout", EDGE_OFF)
    .filter((r) => r.source === "search")
    .map((r) => r.row_id);
  assert.ok(!withEdgeOff.includes(neighbour), "weight 0 contributes no neighbour");
});

test("edge traversal preserves pinned-first ordering", () => {
  const pinned = insertMemory(ctx.db, REPO, "Pinned policy note.", { pinned: true });
  const hit = insertMemory(ctx.db, REPO, "Login 500 missing session cookie bug.");
  const neighbour = insertMemory(ctx.db, REPO, "Set SameSite=Lax on auth cookies.");
  recordEdge(ctx.db, idOf(ctx.db, neighbour), idOf(ctx.db, hit), "fixes");

  const rows = fetchRepoContext(ctx.db, REPO, 5, "login 500 missing session cookie", EDGE_ON);
  assert.equal(rows[0].row_id, pinned, "pinned memory stays first regardless of the edge leg");
});
