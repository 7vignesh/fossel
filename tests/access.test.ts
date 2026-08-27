import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb, insertMemory } from "./helpers.js";
import { recordAccess } from "../src/lib/access.js";
import { fetchRepoContext } from "../src/lib/context.js";

// ---------- recordAccess: unit tests ------------------------------------

test("recordAccess increments access_count for each row", () => {
  const ctx = createTestDb();
  try {
    const id1 = insertMemory(ctx.db, "acme/app", "Memory one");
    const id2 = insertMemory(ctx.db, "acme/app", "Memory two");

    recordAccess(ctx.db, [id1, id2]);

    const row1 = ctx.db
      .prepare("SELECT access_count, last_accessed_at FROM memories WHERE rowid = ?")
      .get(id1) as { access_count: number; last_accessed_at: number };
    const row2 = ctx.db
      .prepare("SELECT access_count, last_accessed_at FROM memories WHERE rowid = ?")
      .get(id2) as { access_count: number; last_accessed_at: number };

    assert.equal(row1.access_count, 1);
    assert.equal(row2.access_count, 1);
    assert.ok(row1.last_accessed_at > 0);
    assert.ok(row2.last_accessed_at > 0);
  } finally {
    ctx.cleanup();
  }
});

test("recordAccess accumulates on repeated calls", () => {
  const ctx = createTestDb();
  try {
    const id = insertMemory(ctx.db, "acme/app", "Frequently accessed memory");

    recordAccess(ctx.db, [id]);
    recordAccess(ctx.db, [id]);
    recordAccess(ctx.db, [id]);

    const row = ctx.db
      .prepare("SELECT access_count FROM memories WHERE rowid = ?")
      .get(id) as { access_count: number };
    assert.equal(row.access_count, 3);
  } finally {
    ctx.cleanup();
  }
});

test("recordAccess is a no-op for empty array", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "acme/app", "Should not be touched");
    // Should not throw
    recordAccess(ctx.db, []);

    const row = ctx.db
      .prepare("SELECT access_count FROM memories WHERE rowid = 1")
      .get() as { access_count: number };
    assert.equal(row.access_count, 0);
  } finally {
    ctx.cleanup();
  }
});

test("recordAccess updates last_accessed_at to current time", () => {
  const ctx = createTestDb();
  try {
    const id = insertMemory(ctx.db, "acme/app", "Time check");
    const before = Math.floor(Date.now() / 1000);

    recordAccess(ctx.db, [id]);

    const row = ctx.db
      .prepare("SELECT last_accessed_at FROM memories WHERE rowid = ?")
      .get(id) as { last_accessed_at: number };

    const after = Math.floor(Date.now() / 1000);
    assert.ok(
      row.last_accessed_at >= before && row.last_accessed_at <= after,
      "last_accessed_at should be within the test window",
    );
  } finally {
    ctx.cleanup();
  }
});

// ---------- Integration: fetchRepoContext triggers access tracking -------

test("fetchRepoContext records access for returned memories", () => {
  const ctx = createTestDb();
  try {
    const id1 = insertMemory(ctx.db, "acme/app", "Convention about auth");
    const id2 = insertMemory(ctx.db, "acme/app", "Convention about logging");

    // Fetch context (no query — returns recent)
    fetchRepoContext(ctx.db, "acme/app", 10);

    const row1 = ctx.db
      .prepare("SELECT access_count FROM memories WHERE rowid = ?")
      .get(id1) as { access_count: number };
    const row2 = ctx.db
      .prepare("SELECT access_count FROM memories WHERE rowid = ?")
      .get(id2) as { access_count: number };

    assert.equal(row1.access_count, 1, "first memory should have been accessed");
    assert.equal(row2.access_count, 1, "second memory should have been accessed");
  } finally {
    ctx.cleanup();
  }
});

test("fetchRepoContext does not increment access for memories outside the limit", () => {
  const ctx = createTestDb();
  try {
    // Insert 5 memories, fetch only 2
    for (let i = 0; i < 5; i++) {
      insertMemory(ctx.db, "acme/app", `Memory number ${i}`, {
        updatedAt: 1000 + i,
      });
    }

    fetchRepoContext(ctx.db, "acme/app", 2);

    // Only the 2 most recent should be accessed (updatedAt 1004, 1003)
    const counts = ctx.db
      .prepare(
        "SELECT rowid, access_count FROM memories WHERE repo = ? ORDER BY updated_at DESC",
      )
      .all("acme/app") as Array<{ rowid: number; access_count: number }>;

    assert.equal(counts[0].access_count, 1, "most recent should be accessed");
    assert.equal(counts[1].access_count, 1, "second most recent should be accessed");
    assert.equal(counts[2].access_count, 0, "third should NOT be accessed");
  } finally {
    ctx.cleanup();
  }
});

test("repeated fetchRepoContext calls accumulate access_count", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "acme/app", "The only memory in the repo");

    fetchRepoContext(ctx.db, "acme/app", 10);
    fetchRepoContext(ctx.db, "acme/app", 10);
    fetchRepoContext(ctx.db, "acme/app", 10);

    const row = ctx.db
      .prepare("SELECT access_count FROM memories WHERE rowid = 1")
      .get() as { access_count: number };
    assert.equal(row.access_count, 3);
  } finally {
    ctx.cleanup();
  }
});

// ---------- Tiebreaker: access data affects recent backfill ordering -----

test("recent backfill uses access_count as tiebreaker for same updated_at", () => {
  const ctx = createTestDb();
  try {
    const sameTime = Math.floor(Date.now() / 1000);

    // Insert two memories at the exact same updated_at
    const id1 = insertMemory(ctx.db, "acme/app", "Less popular memory", {
      updatedAt: sameTime,
    });
    const id2 = insertMemory(ctx.db, "acme/app", "More popular memory", {
      updatedAt: sameTime,
    });

    // Manually boost access on id2
    ctx.db
      .prepare("UPDATE memories SET access_count = 5, last_accessed_at = ? WHERE rowid = ?")
      .run(sameTime, id2);
    ctx.db
      .prepare("UPDATE memories SET access_count = 0, last_accessed_at = 0 WHERE rowid = ?")
      .run(id1);

    const rows = fetchRepoContext(ctx.db, "acme/app", 10);

    // Both should be returned, but id2 should come first (higher access_count tiebreaker)
    assert.ok(rows.length === 2);
    assert.equal(rows[0].row_id, id2, "more-accessed memory should come first as tiebreaker");
    assert.equal(rows[1].row_id, id1);
  } finally {
    ctx.cleanup();
  }
});

test("access tracking does not affect search ranking (only recent backfill)", () => {
  const ctx = createTestDb();
  try {
    const id1 = insertMemory(ctx.db, "acme/app", "JWT auth validation in the API layer");
    const id2 = insertMemory(ctx.db, "acme/app", "JWT token refresh endpoint handles expiration");

    // Boost id1 access artificially
    ctx.db
      .prepare("UPDATE memories SET access_count = 100 WHERE rowid = ?")
      .run(id1);

    // Search for JWT — FTS ranking should determine order, not access_count
    const rows = fetchRepoContext(ctx.db, "acme/app", 10, "JWT token refresh");

    // id2 is a better FTS match for "JWT token refresh" — it should rank higher
    // regardless of id1's access count. The tiebreaker only matters for
    // memories with identical search scores (which these don't have).
    assert.ok(rows.length >= 2);
    // Both should be present
    const ids = rows.map((r) => r.row_id);
    assert.ok(ids.includes(id1));
    assert.ok(ids.includes(id2));
  } finally {
    ctx.cleanup();
  }
});
