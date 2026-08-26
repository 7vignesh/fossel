import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  EMBEDDING_DIM,
  cosineSimilarity,
  embedTextHashed,
} from "../src/lib/embeddings.js";
import { clearIdfCache, computeRepoIdf } from "../src/lib/idf.js";
import { createTestDb, insertMemory, type TestDb } from "./helpers.js";

const REPO = "acme/storefront";

let ctx: TestDb;

beforeEach(() => {
  ctx = createTestDb();
  clearIdfCache();
});

afterEach(() => {
  clearIdfCache();
  ctx.cleanup();
});

test("computeRepoIdf gives neutral weights for an empty repo", () => {
  const idf = computeRepoIdf(ctx.db, REPO);
  assert.equal(idf.documentCount, 0);
  assert.equal(idf.weightFor("anything"), 1);
});

test("computeRepoIdf weights rare features above common ones", () => {
  // "the" appears in every note; "diacritics" in exactly one.
  for (let i = 0; i < 8; i += 1) {
    insertMemory(ctx.db, REPO, `the build step number ${i} runs on the runner`);
  }
  insertMemory(ctx.db, REPO, "the search normalizes diacritics before indexing");

  const idf = computeRepoIdf(ctx.db, REPO);
  assert.ok(
    idf.weightFor("diacritics") > idf.weightFor("the"),
    "a feature in 1 of 9 documents must outweigh one in all 9",
  );
});

test("computeRepoIdf covers bigram features, matching the embedder's space", () => {
  insertMemory(ctx.db, REPO, "rate limiting is enforced at the edge worker");
  insertMemory(ctx.db, REPO, "the edge worker terminates tls");

  const idf = computeRepoIdf(ctx.db, REPO);
  // "edge worker" is a bigram present in both notes, so it must be known
  // (weight below the neutral 1-for-unknown fallback is not required, only that
  // it was counted).
  assert.notEqual(
    idf.weightFor("edge worker"),
    idf.weightFor("nonexistent bigram here"),
    "bigrams must be counted, not just unigrams",
  );
});

test("computeRepoIdf cache invalidates when the memory count changes", () => {
  insertMemory(ctx.db, REPO, "alpha beta gamma delta");
  const before = computeRepoIdf(ctx.db, REPO).documentCount;
  insertMemory(ctx.db, REPO, "epsilon zeta eta theta");
  const after = computeRepoIdf(ctx.db, REPO).documentCount;

  assert.equal(before, 1);
  assert.equal(after, 2, "adding a memory must refresh the statistics");
});

test("IDF weighting changes the query vector but not the document vector", () => {
  insertMemory(ctx.db, REPO, "the deployment pipeline runs on tag push");
  for (let i = 0; i < 5; i += 1) {
    insertMemory(ctx.db, REPO, `the pipeline step ${i} is the usual thing`);
  }

  const idf = computeRepoIdf(ctx.db, REPO);
  const plain = embedTextHashed("the deployment pipeline");
  const weighted = embedTextHashed("the deployment pipeline", {
    featureWeight: idf.weightFor,
  });

  assert.equal(plain.length, EMBEDDING_DIM);
  assert.equal(weighted.length, EMBEDDING_DIM);
  assert.ok(
    cosineSimilarity(plain, weighted) < 0.9999,
    "weighting must actually change the query direction",
  );

  // The invariant that means no re-indexing is needed: embedding without options
  // is unchanged by the existence of IDF. Tolerance is 1e-6 because the vectors
  // are float32, whose precision is around 1e-7.
  const again = embedTextHashed("the deployment pipeline");
  assert.ok(
    Math.abs(cosineSimilarity(plain, again) - 1) < 1e-6,
    "unweighted embedding must stay a pure function of its own text",
  );
});

test("a zero feature weight drops the feature entirely", () => {
  const kept = embedTextHashed("alpha", { featureWeight: () => 1 });
  const dropped = embedTextHashed("alpha", { featureWeight: () => 0 });
  assert.ok(kept.some((v) => v !== 0));
  assert.ok(
    dropped.every((v) => v === 0),
    "zero-weighting every feature must yield the zero vector",
  );
});
