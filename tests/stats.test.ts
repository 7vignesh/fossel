import test from "node:test";
import assert from "node:assert/strict";
import { gatherHealthMetrics } from "../src/lib/stats.js";
import { createTestDb, insertMemory } from "./helpers.js";

const REPO = "acme/app";

test("gatherHealthMetrics counts live vs superseded for the repo", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, REPO, "one");
    const old = insertMemory(ctx.db, REPO, "two");
    ctx.db
      .prepare("UPDATE memories SET valid_to = ? WHERE rowid = ?")
      .run(Math.floor(Date.now() / 1000), old);
    // A different repo must not leak into the counts.
    insertMemory(ctx.db, "other/repo", "three");

    const m = gatherHealthMetrics(ctx.db, REPO);
    assert.equal(m.live, 1);
    assert.equal(m.superseded, 1);
  } finally {
    ctx.cleanup();
  }
});

test("gatherHealthMetrics flags never-accessed memories older than staleDays", () => {
  const ctx = createTestDb();
  try {
    const now = Math.floor(Date.now() / 1000);
    const oldTs = now - 200 * 86400; // 200 days ago
    const stale = insertMemory(ctx.db, REPO, "ancient", { updatedAt: oldTs });
    // access_count defaults to 0; this one is old and untouched -> stale.
    insertMemory(ctx.db, REPO, "fresh"); // recent -> not stale

    const m = gatherHealthMetrics(ctx.db, REPO, 90);
    assert.equal(m.stale, 1, "only the old, never-accessed memory is stale");
    assert.equal(m.staleDays, 90);

    // Accessing the old one should drop it out of the stale count.
    ctx.db
      .prepare("UPDATE memories SET access_count = 1 WHERE rowid = ?")
      .run(stale);
    assert.equal(gatherHealthMetrics(ctx.db, REPO, 90).stale, 0);
  } finally {
    ctx.cleanup();
  }
});

test("gatherHealthMetrics reports side-table coverage", () => {
  const ctx = createTestDb();
  try {
    const row = insertMemory(ctx.db, REPO, "has entity");
    insertMemory(ctx.db, REPO, "no entity");
    ctx.db
      .prepare(
        "INSERT INTO memory_entities (memory_rowid, entity, kind) VALUES (?, ?, ?)",
      )
      .run(row, "src/auth.ts", "file");

    const m = gatherHealthMetrics(ctx.db, REPO);
    assert.equal(m.withEntities, 1, "one of two live memories has an entity");
    // Embeddings and file refs are present-but-empty tables -> 0, not null.
    assert.equal(m.withEmbeddings, 0);
    assert.equal(m.withFileRefs, 0);
  } finally {
    ctx.cleanup();
  }
});

test("gatherHealthMetrics returns null for a metric whose table is absent", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, REPO, "note");
    // Drop a side table to simulate an older db that never had it.
    ctx.db.exec("DROP TABLE memory_entities");

    const m = gatherHealthMetrics(ctx.db, REPO);
    assert.equal(m.withEntities, null, "absent table yields null, not a throw");
    // Other metrics still work.
    assert.equal(m.live, 1);
  } finally {
    ctx.cleanup();
  }
});
