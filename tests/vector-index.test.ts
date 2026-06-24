import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  backfillRepoEmbeddings,
  indexMemoryEmbedding,
  vectorSearch,
} from "../src/lib/vector-index.js";
import { createTestDb, insertMemory, type TestDb } from "./helpers.js";

let ctx: TestDb;
const originalFlag = process.env.FOSSEL_EMBEDDINGS;

beforeEach(() => {
  ctx = createTestDb();
});

afterEach(() => {
  ctx.cleanup();
  if (originalFlag === undefined) {
    delete process.env.FOSSEL_EMBEDDINGS;
  } else {
    process.env.FOSSEL_EMBEDDINGS = originalFlag;
  }
});

function countEmbeddings(): number {
  const row = ctx.db
    .prepare("SELECT COUNT(*) AS c FROM memory_embeddings")
    .get() as { c: number };
  return row.c;
}

test("indexMemoryEmbedding is a no-op when embeddings are disabled", () => {
  delete process.env.FOSSEL_EMBEDDINGS;
  const id = insertMemory(ctx.db, "owner/repo", "auth uses jwt tokens");
  indexMemoryEmbedding(ctx.db, id, "auth uses jwt tokens");
  assert.equal(countEmbeddings(), 0);
});

test("indexMemoryEmbedding stores a vector when enabled", () => {
  process.env.FOSSEL_EMBEDDINGS = "1";
  const id = insertMemory(ctx.db, "owner/repo", "auth uses jwt tokens");
  indexMemoryEmbedding(ctx.db, id, "auth uses jwt tokens");
  assert.equal(countEmbeddings(), 1);
});

test("indexMemoryEmbedding upserts (no duplicate rows on re-index)", () => {
  process.env.FOSSEL_EMBEDDINGS = "1";
  const id = insertMemory(ctx.db, "owner/repo", "original note");
  indexMemoryEmbedding(ctx.db, id, "original note");
  indexMemoryEmbedding(ctx.db, id, "edited note text");
  assert.equal(countEmbeddings(), 1);
});

test("backfillRepoEmbeddings indexes all un-indexed memories", () => {
  process.env.FOSSEL_EMBEDDINGS = "1";
  insertMemory(ctx.db, "owner/repo", "first memory about routing");
  insertMemory(ctx.db, "owner/repo", "second memory about caching");
  insertMemory(ctx.db, "other/repo", "unrelated repo memory");

  const indexed = backfillRepoEmbeddings(ctx.db, "owner/repo");
  assert.equal(indexed, 2);
  assert.equal(countEmbeddings(), 2);
});

test("backfillRepoEmbeddings is idempotent", () => {
  process.env.FOSSEL_EMBEDDINGS = "1";
  insertMemory(ctx.db, "owner/repo", "a note worth indexing");
  assert.equal(backfillRepoEmbeddings(ctx.db, "owner/repo"), 1);
  assert.equal(backfillRepoEmbeddings(ctx.db, "owner/repo"), 0);
});

test("vectorSearch returns empty when disabled", () => {
  delete process.env.FOSSEL_EMBEDDINGS;
  insertMemory(ctx.db, "owner/repo", "auth uses jwt tokens");
  assert.deepEqual(vectorSearch(ctx.db, "owner/repo", "authentication", 5), []);
});

test("vectorSearch finds the most relevant memory and ranks it first", () => {
  process.env.FOSSEL_EMBEDDINGS = "1";
  insertMemory(ctx.db, "owner/repo", "authentication uses jwt tokens and login redirects");
  insertMemory(ctx.db, "owner/repo", "the build uses tsup to bundle the cli output");
  insertMemory(ctx.db, "owner/repo", "tests run with node test runner via tsx");
  backfillRepoEmbeddings(ctx.db, "owner/repo");

  const results = vectorSearch(ctx.db, "owner/repo", "how does authentication and login work", 5);
  assert.ok(results.length > 0, "expected at least one match");
  assert.match(results[0].note, /authentication/);
  // Scores must be sorted descending.
  for (let i = 1; i < results.length; i += 1) {
    assert.ok(results[i - 1].score >= results[i].score);
  }
});

test("vectorSearch scopes to the requested repo only", () => {
  process.env.FOSSEL_EMBEDDINGS = "1";
  insertMemory(ctx.db, "owner/repo", "deployment uses github actions pipeline");
  insertMemory(ctx.db, "other/repo", "deployment uses github actions pipeline");
  backfillRepoEmbeddings(ctx.db, "owner/repo");
  backfillRepoEmbeddings(ctx.db, "other/repo");

  const results = vectorSearch(ctx.db, "owner/repo", "deployment pipeline", 5);
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.repo === "owner/repo"));
});

test("vectorSearch backfills on demand for pre-existing memories", () => {
  // Memory inserted while disabled (no vector), then enabled and queried.
  delete process.env.FOSSEL_EMBEDDINGS;
  insertMemory(ctx.db, "owner/repo", "logging uses structured json telemetry");
  assert.equal(countEmbeddings(), 0);

  process.env.FOSSEL_EMBEDDINGS = "1";
  const results = vectorSearch(ctx.db, "owner/repo", "structured logging telemetry", 5);
  assert.ok(results.length > 0, "expected on-demand backfill to make it searchable");
  assert.equal(countEmbeddings(), 1);
});

test("vectorSearch returns empty for an empty query", () => {
  process.env.FOSSEL_EMBEDDINGS = "1";
  insertMemory(ctx.db, "owner/repo", "some indexed memory");
  backfillRepoEmbeddings(ctx.db, "owner/repo");
  assert.deepEqual(vectorSearch(ctx.db, "owner/repo", "   ", 5), []);
});

test("deleting a memory cascades to its embedding", () => {
  process.env.FOSSEL_EMBEDDINGS = "1";
  // Cascade is handled by the memories_embeddings_ad trigger, not a FK.
  const id = insertMemory(ctx.db, "owner/repo", "memory to be deleted");
  indexMemoryEmbedding(ctx.db, id, "memory to be deleted");
  assert.equal(countEmbeddings(), 1);

  ctx.db.prepare("DELETE FROM memories WHERE rowid = ?").run(id);
  assert.equal(countEmbeddings(), 0);
});
