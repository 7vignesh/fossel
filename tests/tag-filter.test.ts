import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fetchRepoContext } from "../src/lib/context.js";
import { createTestDb, insertMemory, type TestDb } from "./helpers.js";

const REPO = "acme/storefront";

let ctx: TestDb;

beforeEach(() => {
  ctx = createTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

function seed(): void {
  insertMemory(ctx.db, REPO, "JWT lives in an httpOnly cookie.", {
    tags: ["auth", "security"],
  });
  insertMemory(ctx.db, REPO, "Rate limiting is enforced at the edge.", {
    tags: ["security", "infra"],
  });
  insertMemory(ctx.db, REPO, "Deploys go out on tag push.", {
    tags: ["ci", "infra"],
  });
  insertMemory(ctx.db, REPO, "Prices are stored in integer cents.", {
    tags: ["money"],
  });
}

function notes(rows: { note: string }[]): string[] {
  return rows.map((row) => row.note).sort();
}

test("no tag filter returns the full recent set unchanged", () => {
  seed();
  const withNone = fetchRepoContext(ctx.db, REPO, 10);
  const withEmpty = fetchRepoContext(ctx.db, REPO, 10, undefined, { tags: [] });
  assert.equal(withNone.length, 4);
  assert.deepEqual(notes(withEmpty), notes(withNone));
});

test("single tag keeps only memories carrying it", () => {
  seed();
  const rows = fetchRepoContext(ctx.db, REPO, 10, undefined, {
    tags: ["security"],
  });
  assert.deepEqual(notes(rows), [
    "JWT lives in an httpOnly cookie.",
    "Rate limiting is enforced at the edge.",
  ]);
});

test("tagMatch 'and' requires every listed tag", () => {
  seed();
  const rows = fetchRepoContext(ctx.db, REPO, 10, undefined, {
    tags: ["security", "infra"],
    tagMatch: "and",
  });
  // Only the rate-limiting note carries both tags.
  assert.deepEqual(notes(rows), ["Rate limiting is enforced at the edge."]);
});

test("tagMatch 'or' (default) keeps memories sharing any listed tag", () => {
  seed();
  const rows = fetchRepoContext(ctx.db, REPO, 10, undefined, {
    tags: ["auth", "money"],
  });
  assert.deepEqual(notes(rows), [
    "JWT lives in an httpOnly cookie.",
    "Prices are stored in integer cents.",
  ]);
});

test("a tag that matches nothing returns no rows", () => {
  seed();
  const rows = fetchRepoContext(ctx.db, REPO, 10, undefined, {
    tags: ["nonexistent"],
  });
  assert.deepEqual(rows, []);
});

test("tag matching is case-insensitive", () => {
  seed();
  const rows = fetchRepoContext(ctx.db, REPO, 10, undefined, {
    tags: ["SECURITY"],
  });
  assert.equal(rows.length, 2);
});

test("tag filter applies to search hits, not just the recent backfill", () => {
  seed();
  // Many fillers so the relevant 'security' rows would fall outside a narrow
  // fetch window if the filter were a naive post-slice; the widened candidate
  // pool must still surface them.
  for (let i = 0; i < 20; i += 1) {
    insertMemory(ctx.db, REPO, `Filler note ${i} about builds.`, {
      tags: ["filler"],
    });
  }
  const rows = fetchRepoContext(ctx.db, REPO, 5, "how is auth handled", {
    tags: ["security"],
  });
  assert.ok(rows.length > 0, "a filtered query must still return matches");
  assert.ok(
    rows.every((row) => /"security"/.test(row.tags)),
    "every returned row must carry the filter tag",
  );
});
