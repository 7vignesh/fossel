import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMBEDDING_DIM,
  bufferToVector,
  cosineSimilarity,
  embedText,
  embeddingsEnabled,
  vectorToBuffer,
} from "../src/lib/embeddings.js";

test("embedText returns a fixed-dimension vector", () => {
  const v = embedText("JWT lives in localStorage");
  assert.equal(v.length, EMBEDDING_DIM);
});

test("embedText is L2-normalized for non-empty text", () => {
  const v = embedText("use pnpm workspaces for all scripts");
  let norm = 0;
  for (const x of v) norm += x * x;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-6);
});

test("embedText returns a zero vector for empty/punctuation-only input", () => {
  for (const input of ["", "   ", "!!! ??? ..."]) {
    const v = embedText(input);
    const norm = v.reduce((acc, x) => acc + x * x, 0);
    assert.equal(norm, 0, `expected zero vector for "${input}"`);
  }
});

test("embedText is deterministic", () => {
  const a = embedText("authentication and authorization rules");
  const b = embedText("authentication and authorization rules");
  assert.deepEqual(Array.from(a), Array.from(b));
});

test("identical text has cosine similarity 1", () => {
  const a = embedText("the queue is idempotent to avoid double processing");
  const b = embedText("the queue is idempotent to avoid double processing");
  assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-6);
});

test("related text scores higher than unrelated text", () => {
  const query = embedText("how does authentication work");
  const related = embedText("authentication uses JWT tokens and login redirects");
  const unrelated = embedText("the build uses tsup to bundle the cli");

  const relatedScore = cosineSimilarity(query, related);
  const unrelatedScore = cosineSimilarity(query, unrelated);

  assert.ok(
    relatedScore > unrelatedScore,
    `expected related (${relatedScore}) > unrelated (${unrelatedScore})`,
  );
});

test("vector buffer round-trips without loss", () => {
  const v = embedText("round trip serialization check for vectors");
  const restored = bufferToVector(vectorToBuffer(v));
  assert.equal(restored.length, v.length);
  for (let i = 0; i < v.length; i += 1) {
    assert.ok(Math.abs(restored[i] - v[i]) < 1e-6);
  }
});

test("cosineSimilarity returns 0 for mismatched dimensions", () => {
  assert.equal(cosineSimilarity(new Float32Array(4), new Float32Array(8)), 0);
});

test("embeddingsEnabled reflects the env flag", () => {
  const original = process.env.FOSSEL_EMBEDDINGS;
  try {
    for (const truthy of ["1", "true", "on", "yes", "TRUE", " On "]) {
      process.env.FOSSEL_EMBEDDINGS = truthy;
      assert.equal(embeddingsEnabled(), true, `expected enabled for "${truthy}"`);
    }
    for (const falsy of ["", "0", "false", "off", "no", undefined]) {
      if (falsy === undefined) {
        delete process.env.FOSSEL_EMBEDDINGS;
      } else {
        process.env.FOSSEL_EMBEDDINGS = falsy;
      }
      assert.equal(embeddingsEnabled(), false, `expected disabled for "${falsy}"`);
    }
  } finally {
    if (original === undefined) {
      delete process.env.FOSSEL_EMBEDDINGS;
    } else {
      process.env.FOSSEL_EMBEDDINGS = original;
    }
  }
});
