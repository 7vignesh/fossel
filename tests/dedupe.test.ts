import test from "node:test";
import assert from "node:assert/strict";
import { findDuplicate, normalizeText, similarity } from "../src/lib/dedupe.js";
import { createTestDb, insertMemory } from "./helpers.js";

test("normalizeText lowercases and strips punctuation", () => {
  assert.equal(
    normalizeText("Use   `JWT` in localStorage!!"),
    "use jwt in localstorage",
  );
});

test("similarity scores identical text as 1", () => {
  assert.equal(similarity("hello world", "hello world"), 1);
});

test("similarity recognizes paraphrased duplicates", () => {
  const score = similarity(
    "Fixed websocket reconnect race by awaiting auth handshake.",
    "Fixed websocket reconnect race by awaiting the auth handshake!",
  );
  assert.ok(score > 0.85, `expected >0.85 got ${score}`);
});

test("similarity reports low score for unrelated notes", () => {
  const score = similarity(
    "JWT lives in localStorage.",
    "Use Postgres for transactional workloads.",
  );
  assert.ok(score < 0.4, `expected <0.4 got ${score}`);
});

test("findDuplicate returns existing memory when a near match exists", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "owner/repo", "JWT lives in localStorage.");
    const match = findDuplicate(
      ctx.db,
      "owner/repo",
      "JWT lives in localstorage",
    );
    assert.ok(match, "expected duplicate match");
    assert.ok(match!.similarity >= 0.85);
  } finally {
    ctx.cleanup();
  }
});

test("findDuplicate returns null when no candidate is similar enough", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "owner/repo", "Use Postgres for transactions.");
    const match = findDuplicate(
      ctx.db,
      "owner/repo",
      "Reviewers prefer explicit return types.",
    );
    assert.equal(match, null);
  } finally {
    ctx.cleanup();
  }
});
