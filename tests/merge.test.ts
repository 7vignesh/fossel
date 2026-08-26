import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cosineSimilarity, bufferToVector, embedText } from "../src/lib/embeddings.js";
import {
  applyMerges,
  fetchMergeCandidates,
  planMerges,
} from "../src/lib/merge.js";
import { indexMemoryEmbedding } from "../src/lib/vector-index.js";
import { createTestDb, insertMemory, type TestDb } from "./helpers.js";

const REPO = "acme/webapp";

let ctx: TestDb;

beforeEach(() => {
  ctx = createTestDb();
  process.env.FOSSEL_EMBEDDINGS = "1";
});

afterEach(() => {
  delete process.env.FOSSEL_EMBEDDINGS;
  ctx.cleanup();
});

function storedVector(db: TestDb["db"], rowId: number): Float32Array | null {
  const row = db
    .prepare("SELECT vector FROM memory_embeddings WHERE memory_rowid = ?")
    .get(rowId) as { vector: Buffer } | undefined;
  return row ? bufferToVector(row.vector) : null;
}

// Similarity scores below are measured against the blended word+trigram metric
// in lib/dedupe.ts, not guessed: the paraphrase pairs used here score 0.57-0.86
// while the unrelated note scores 0.03, so the thresholds sit comfortably
// between the two bands.
test("planMerges pairs near-duplicates and leaves distinct notes alone", () => {
  const a = insertMemory(ctx.db, REPO, "Use pnpm workspaces for all package scripts.", {
    type: "convention",
    updatedAt: 200,
  });
  const b = insertMemory(ctx.db, REPO, "Use pnpm workspaces for every package script.", {
    type: "convention",
    updatedAt: 100,
  });
  const c = insertMemory(ctx.db, REPO, "Rate limiting is enforced at the edge worker.", {
    type: "convention",
    updatedAt: 50,
  });

  const rows = fetchMergeCandidates(ctx.db, REPO);
  // The pair scores 0.62; the unrelated note scores 0.03 against both.
  const plan = planMerges(rows, 0.6);

  assert.equal(plan.length, 1, "only the paraphrase pair should merge");
  assert.equal(plan[0].keep, a, "the most recently updated row survives");
  assert.equal(plan[0].drop, b);
  assert.ok(
    !plan.some((entry) => entry.keep === c || entry.drop === c),
    "the unrelated note must not participate",
  );
});

test("planMerges never merges across memory types", () => {
  insertMemory(ctx.db, REPO, "We chose Postgres over SQLite for the API.", {
    type: "decision",
    updatedAt: 200,
  });
  insertMemory(ctx.db, REPO, "We chose Postgres over SQLite for the API.", {
    type: "convention",
    updatedAt: 100,
  });

  const plan = planMerges(fetchMergeCandidates(ctx.db, REPO), 0.85);
  assert.equal(plan.length, 0, "identical text of differing type must not collapse");
});

test("applyMerges re-indexes the surviving row when the note changes", () => {
  // The shorter note is the newer row, so the merge replaces the survivor's
  // text with the longer note from the row being dropped. That is exactly the
  // case where a stale vector used to survive.
  const keep = insertMemory(
    ctx.db,
    REPO,
    "JWT is stored in localStorage and 401 redirects to /login.",
    { type: "convention", updatedAt: 200 },
  );
  const drop = insertMemory(
    ctx.db,
    REPO,
    "JWT is stored in localStorage and a 401 redirects the user to /login.",
    { type: "convention", updatedAt: 100 },
  );

  indexMemoryEmbedding(
    ctx.db,
    keep,
    "JWT is stored in localStorage and 401 redirects to /login.",
  );
  indexMemoryEmbedding(
    ctx.db,
    drop,
    "JWT is stored in localStorage and a 401 redirects the user to /login.",
  );

  const rows = fetchMergeCandidates(ctx.db, REPO);
  // The pair scores 0.82.
  const plan = planMerges(rows, 0.8);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].keep, keep);

  const merged = applyMerges(ctx.db, rows, plan);
  assert.equal(merged, 1);

  const finalNote = (
    ctx.db.prepare("SELECT note FROM memories WHERE rowid = ?").get(keep) as {
      note: string;
    }
  ).note;
  assert.match(finalNote, /the user/, "survivor should absorb the longer note");

  const vector = storedVector(ctx.db, keep);
  assert.ok(vector, "survivor must still have a vector");
  const expected = embedText(finalNote);
  assert.ok(
    Math.abs(cosineSimilarity(vector, expected) - 1) < 1e-6,
    "stored vector must match the survivor's current note text, not the pre-merge text",
  );
});

test("applyMerges deletes the dropped row and cascades its embedding", () => {
  const keep = insertMemory(ctx.db, REPO, "Run the migration before deploying.", {
    type: "convention",
    updatedAt: 200,
  });
  const drop = insertMemory(ctx.db, REPO, "Run the migrations before deploy.", {
    type: "convention",
    updatedAt: 100,
  });
  indexMemoryEmbedding(ctx.db, keep, "Run the migration before deploying.");
  indexMemoryEmbedding(ctx.db, drop, "Run the migrations before deploy.");

  const rows = fetchMergeCandidates(ctx.db, REPO);
  // The pair scores 0.57.
  const merged = applyMerges(ctx.db, rows, planMerges(rows, 0.55));
  assert.equal(merged, 1);

  const remaining = ctx.db
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE rowid = ?")
    .get(drop) as { count: number };
  assert.equal(remaining.count, 0, "dropped row must be deleted");

  assert.equal(
    storedVector(ctx.db, drop),
    null,
    "the delete trigger must cascade to memory_embeddings",
  );
  assert.ok(storedVector(ctx.db, keep), "survivor keeps its vector");
});

test("applyMerges records a deduped changelog entry on the survivor", () => {
  const keep = insertMemory(ctx.db, REPO, "Lint with biome before pushing changes.", {
    type: "convention",
    tags: ["lint"],
    updatedAt: 200,
  });
  insertMemory(ctx.db, REPO, "Lint with biome before pushing any changes.", {
    type: "convention",
    tags: ["biome"],
    updatedAt: 100,
  });

  const rows = fetchMergeCandidates(ctx.db, REPO);
  // The pair scores 0.86.
  applyMerges(ctx.db, rows, planMerges(rows, 0.85));

  const row = ctx.db
    .prepare("SELECT tags, metadata_json FROM memories WHERE rowid = ?")
    .get(keep) as { tags: string; metadata_json: string };

  const metadata = JSON.parse(row.metadata_json) as {
    changelog?: Array<{ action: string; merged_from?: number }>;
  };
  assert.ok(
    metadata.changelog?.some((entry) => entry.action === "deduped"),
    "survivor must carry a deduped changelog entry",
  );

  const tags = JSON.parse(row.tags) as string[];
  assert.deepEqual(tags.sort(), ["biome", "lint"], "tag lists must be unioned");
});
