import test from "node:test";
import assert from "node:assert/strict";
import { listRepos } from "../src/lib/repo.js";
import { createTestDb, insertMemory } from "./helpers.js";

test("listRepos returns empty for a fresh db", () => {
  const ctx = createTestDb();
  try {
    assert.deepEqual(listRepos(ctx.db), []);
  } finally {
    ctx.cleanup();
  }
});

test("listRepos counts live memories per repo, ordered by live count desc", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "acme/app", "one");
    insertMemory(ctx.db, "acme/app", "two");
    insertMemory(ctx.db, "acme/lib", "three");

    const repos = listRepos(ctx.db);
    assert.equal(repos.length, 2);
    assert.equal(repos[0].repo, "acme/app");
    assert.equal(repos[0].live, 2);
    assert.equal(repos[1].repo, "acme/lib");
    assert.equal(repos[1].live, 1);
  } finally {
    ctx.cleanup();
  }
});

test("listRepos separates live from superseded and counts pinned", () => {
  const ctx = createTestDb();
  try {
    const live = insertMemory(ctx.db, "acme/app", "live note");
    const tombstoned = insertMemory(ctx.db, "acme/app", "old note");
    ctx.db
      .prepare("UPDATE memories SET valid_to = ? WHERE rowid = ?")
      .run(Math.floor(Date.now() / 1000), tombstoned);
    ctx.db.prepare("UPDATE memories SET pinned = 1 WHERE rowid = ?").run(live);

    const [repo] = listRepos(ctx.db);
    assert.equal(repo.repo, "acme/app");
    assert.equal(repo.live, 1, "only the non-tombstoned memory is live");
    assert.equal(repo.superseded, 1);
    assert.equal(repo.pinned, 1);
    assert.ok(repo.lastUpdated !== null && repo.lastUpdated > 0);
  } finally {
    ctx.cleanup();
  }
});

test("listRepos does not count a superseded memory as pinned", () => {
  const ctx = createTestDb();
  try {
    const row = insertMemory(ctx.db, "acme/app", "note");
    // Pin it, then supersede it: it should count as superseded, not pinned.
    ctx.db
      .prepare("UPDATE memories SET pinned = 1, valid_to = ? WHERE rowid = ?")
      .run(Math.floor(Date.now() / 1000), row);

    const [repo] = listRepos(ctx.db);
    assert.equal(repo.live, 0);
    assert.equal(repo.superseded, 1);
    assert.equal(repo.pinned, 0, "pinned count only includes live memories");
  } finally {
    ctx.cleanup();
  }
});
