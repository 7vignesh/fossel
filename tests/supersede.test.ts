import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fetchRepoContext } from "../src/lib/context.js";
import { findMemoryByAnyId } from "../src/lib/memory.js";
import { createTestDb, insertMemory, type TestDb } from "./helpers.js";

const REPO = "acme/app";

let ctx: TestDb;

beforeEach(() => {
  ctx = createTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

function supersede(rowId: number, supersededBy?: number): void {
  if (supersededBy !== undefined) {
    const target = findMemoryByAnyId(ctx.db, supersededBy);
    if (!target) {
      throw new Error(`Memory ${supersededBy} not found.`);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const row = ctx.db
    .prepare("SELECT metadata_json FROM memories WHERE rowid = ?")
    .get(rowId) as { metadata_json: string } | undefined;
  const metadata = row ? JSON.parse(row.metadata_json) : {};
  metadata.changelog = metadata.changelog ?? [];
  metadata.changelog.push({
    at: now,
    action: "superseded",
    ...(supersededBy !== undefined && { superseded_by: supersededBy }),
  });
  ctx.db
    .prepare("UPDATE memories SET valid_to = ?, metadata_json = ? WHERE rowid = ?")
    .run(now, JSON.stringify(metadata), rowId);
}

test("a superseded memory does not appear in fetchRepoContext", () => {
  const live = insertMemory(ctx.db, REPO, "Use httpOnly cookies for the session JWT.");
  const old = insertMemory(ctx.db, REPO, "JWT is stored in localStorage.");
  supersede(old, live);

  const rows = fetchRepoContext(ctx.db, REPO, 10);
  const ids = rows.map((row) => row.row_id);
  assert.ok(ids.includes(live), "the live memory must surface");
  assert.ok(!ids.includes(old), "the superseded memory must be hidden");
});

test("a superseded memory does not appear in query results", () => {
  insertMemory(ctx.db, REPO, "JWT is stored in localStorage.");
  const newer = insertMemory(ctx.db, REPO, "JWT is now in an httpOnly cookie named sf_session.");
  const older = ctx.db
    .prepare("SELECT rowid AS row_id FROM memories WHERE note LIKE '%localStorage%'")
    .get() as { row_id: number };
  supersede(older.row_id, newer);

  const rows = fetchRepoContext(ctx.db, REPO, 10, "jwt localStorage");
  assert.ok(
    !rows.some((row) => row.row_id === older.row_id),
    "a keyword query must not surface a superseded memory even if it matches",
  );
});

test("findMemoryByAnyId does not find a superseded memory", () => {
  const id = insertMemory(ctx.db, REPO, "old fact");
  supersede(id);
  assert.equal(
    findMemoryByAnyId(ctx.db, id),
    null,
    "superseded memories are hidden from findMemoryByAnyId",
  );
});

test("the row itself survives supersession (never deleted)", () => {
  const id = insertMemory(ctx.db, REPO, "historical fact");
  supersede(id);

  // Direct read without the valid_to filter proves the row is still there.
  const row = ctx.db
    .prepare("SELECT valid_to, metadata_json FROM memories WHERE rowid = ?")
    .get(id) as { valid_to: number | null; metadata_json: string };
  assert.ok(row, "the row must still exist in the database");
  assert.ok(typeof row.valid_to === "number" && row.valid_to > 0, "valid_to must be set");
  const meta = JSON.parse(row.metadata_json) as {
    changelog?: Array<{ action: string }>;
  };
  assert.ok(
    meta.changelog?.some((entry) => entry.action === "superseded"),
    "the supersession must be recorded in the changelog",
  );
});

test("superseding is idempotent — a second call does not error", () => {
  const id = insertMemory(ctx.db, REPO, "old");
  supersede(id);
  const row = ctx.db
    .prepare("SELECT valid_to FROM memories WHERE rowid = ?")
    .get(id) as { valid_to: number };
  const before = row.valid_to;
  supersede(id);
  const after = (
    ctx.db
      .prepare("SELECT valid_to FROM memories WHERE rowid = ?")
      .get(id) as { valid_to: number }
  ).valid_to;
  assert.ok(after >= before);
});

test("superseding with nonexistent superseded_by throws an error", () => {
  const id = insertMemory(ctx.db, REPO, "fact to supersede");
  const nonExistentId = 999999;

  assert.throws(
    () => supersede(id, nonExistentId),
    (err: Error) => {
      assert.match(err.message, /Memory 999999 not found\./);
      return true;
    },
  );
});

test("superseding with valid superseded_by records the link in changelog", () => {
  const oldId = insertMemory(ctx.db, REPO, "outdated note");
  const newId = insertMemory(ctx.db, REPO, "updated note");

  supersede(oldId, newId);

  const row = ctx.db
    .prepare("SELECT metadata_json FROM memories WHERE rowid = ?")
    .get(oldId) as { metadata_json: string };
  const meta = JSON.parse(row.metadata_json) as {
    changelog?: Array<{ action: string; superseded_by?: number }>;
  };

  const entry = meta.changelog?.find((e) => e.action === "superseded");
  assert.ok(entry, "superseded action exists in changelog");
  assert.equal(entry?.superseded_by, newId, "superseded_by matches the target row_id");
});
