import test from "node:test";
import assert from "node:assert/strict";
import { fetchRepoContext, formatContext } from "../src/lib/context.js";
import { createTestDb, insertMemory } from "./helpers.js";

test("fetchRepoContext orders pinned first, then recent, then matches", () => {
  const ctx = createTestDb();
  try {
    const repo = "owner/repo";
    const oldest = insertMemory(ctx.db, repo, "Old non-pinned note", {
      updatedAt: 100,
    });
    const newest = insertMemory(ctx.db, repo, "Newest non-pinned note", {
      updatedAt: 300,
    });
    const pinned = insertMemory(ctx.db, repo, "Pinned policy note", {
      updatedAt: 200,
      pinned: true,
    });

    const rows = fetchRepoContext(ctx.db, repo, 5);
    assert.equal(rows[0]?.row_id, pinned, "pinned should come first");
    assert.equal(rows[1]?.row_id, newest, "newest non-pinned should come next");
    assert.equal(rows[2]?.row_id, oldest);
    assert.equal(rows[0]?.source, "pinned");
    assert.equal(rows[1]?.source, "recent");
  } finally {
    ctx.cleanup();
  }
});

test("fetchRepoContext folds search results below pinned/recent without dupes", () => {
  const ctx = createTestDb();
  try {
    const repo = "owner/repo";
    const a = insertMemory(ctx.db, repo, "JWT lives in localStorage.", { updatedAt: 100 });
    const b = insertMemory(ctx.db, repo, "Webhook retries are idempotent.", { updatedAt: 200 });
    const c = insertMemory(ctx.db, repo, "Pinned: review checklist", {
      updatedAt: 150,
      pinned: true,
    });

    const rows = fetchRepoContext(ctx.db, repo, 10, "webhook");
    const ids = rows.map((row) => row.row_id);
    // Each id appears at most once.
    assert.equal(new Set(ids).size, ids.length);
    // Pinned still leads.
    assert.equal(rows[0]?.row_id, c);
    // When a query is present, the matching row leads the non-pinned results
    // (search-first ordering), ahead of the unrelated recent row.
    const bIndex = ids.indexOf(b);
    const aIndex = ids.indexOf(a);
    assert.ok(bIndex !== -1 && aIndex !== -1, "both rows present");
    assert.ok(bIndex < aIndex, "the matching webhook row precedes the unrelated row");
  } finally {
    ctx.cleanup();
  }
});

test("formatContext emits markdown sections grouped by type", () => {
  const ctx = createTestDb();
  try {
    const repo = "owner/repo";
    insertMemory(ctx.db, repo, "Lint TS files", { type: "convention", updatedAt: 100 });
    insertMemory(ctx.db, repo, "Fix race condition", {
      type: "bug_fix",
      updatedAt: 200,
    });
    insertMemory(ctx.db, repo, "Pinned policy", {
      type: "decision",
      pinned: true,
      updatedAt: 150,
    });

    const rows = fetchRepoContext(ctx.db, repo, 10);
    const md = formatContext(rows, { repo, format: "markdown" });
    assert.match(md, /# Fossel context: owner\/repo/);
    assert.match(md, /## 📌 Pinned/);
    assert.match(md, /## Bug Fixes/);
    assert.match(md, /## Conventions/);
  } finally {
    ctx.cleanup();
  }
});

test("formatContext returns a friendly empty message", () => {
  const ctx = createTestDb();
  try {
    const rows = fetchRepoContext(ctx.db, "owner/repo", 10);
    assert.equal(rows.length, 0);
    const text = formatContext(rows, { repo: "owner/repo" });
    assert.match(text, /No memories found for owner\/repo/);
  } finally {
    ctx.cleanup();
  }
});
