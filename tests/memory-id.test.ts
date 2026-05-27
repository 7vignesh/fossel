import test from "node:test";
import assert from "node:assert/strict";
import { findMemoryByAnyId } from "../src/lib/memory.js";
import { createTestDb, insertMemory } from "./helpers.js";

test("findMemoryByAnyId resolves numeric row_id", () => {
  const ctx = createTestDb();
  try {
    const rowId = insertMemory(ctx.db, "owner/repo", "First note.");
    const row = findMemoryByAnyId(ctx.db, rowId);
    assert.ok(row, "expected row");
    assert.equal(row!.row_id, rowId);
  } finally {
    ctx.cleanup();
  }
});

test("findMemoryByAnyId resolves legacy nanoid string id", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "owner/repo", "Some note.");
    const stringId = (
      ctx.db.prepare("SELECT id FROM memories LIMIT 1").get() as { id: string }
    ).id;

    const row = findMemoryByAnyId(ctx.db, stringId);
    assert.ok(row, "expected row");
    assert.equal(row!.id, stringId);
  } finally {
    ctx.cleanup();
  }
});

test("findMemoryByAnyId returns null for unknown ids", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "owner/repo", "Existing");
    assert.equal(findMemoryByAnyId(ctx.db, 9999), null);
    assert.equal(findMemoryByAnyId(ctx.db, "no-such-id"), null);
  } finally {
    ctx.cleanup();
  }
});
