import assert from "node:assert/strict";
import { test } from "node:test";
import { findDuplicate, findRelatedCandidates } from "../src/lib/dedupe.js";
import { createTestDb, insertMemory } from "./helpers.js";

test("findRelatedCandidates returns nothing when the repo is empty", () => {
  const ctx = createTestDb();
  try {
    assert.deepEqual(
      findRelatedCandidates(ctx.db, "owner/repo", "we use postgres for storage"),
      [],
    );
  } finally {
    ctx.cleanup();
  }
});

test("findRelatedCandidates excludes near-duplicates (handled by findDuplicate)", () => {
  const ctx = createTestDb();
  try {
    const repo = "owner/repo";
    insertMemory(ctx.db, repo, "We use Redis for caching the session store.");
    // A near-identical note: findDuplicate should catch it, findRelated should not.
    const note = "We use Redis for caching the session store";
    const dup = findDuplicate(ctx.db, repo, note);
    assert.ok(dup, "expected a duplicate match");
    const related = findRelatedCandidates(ctx.db, repo, note);
    assert.equal(related.length, 0, "duplicates must not appear as related candidates");
  } finally {
    ctx.cleanup();
  }
});

test("findRelatedCandidates excludes unrelated notes", () => {
  const ctx = createTestDb();
  try {
    const repo = "owner/repo";
    insertMemory(ctx.db, repo, "The CI pipeline runs on GitHub Actions with a node 20 matrix.");
    const related = findRelatedCandidates(
      ctx.db,
      repo,
      "Coffee tastes better with oat milk in the morning.",
    );
    assert.equal(related.length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("findRelatedCandidates surfaces a related-but-not-duplicate memory", () => {
  const ctx = createTestDb();
  try {
    const repo = "owner/repo";
    insertMemory(ctx.db, repo, "We use Redis for caching across the API layer.");
    // Same topic (caching/Redis) but a meaningfully different statement.
    const related = findRelatedCandidates(
      ctx.db,
      repo,
      "Redis caching has high latency under load in the API layer.",
    );
    assert.ok(related.length >= 1, "expected at least one related candidate");
    assert.match(related[0].memory.note, /Redis/);
  } finally {
    ctx.cleanup();
  }
});

test("findRelatedCandidates flags a possible contradiction via negation cue", () => {
  const ctx = createTestDb();
  try {
    const repo = "owner/repo";
    insertMemory(ctx.db, repo, "We use Redis for caching across the API layer.");
    // New note carries replacement/negation language the old one lacks.
    const related = findRelatedCandidates(
      ctx.db,
      repo,
      "We no longer use Redis for caching across the API layer; replaced it.",
    );
    assert.ok(related.length >= 1, "expected a related candidate");
    assert.equal(
      related[0].possibleContradiction,
      true,
      "negation/replacement language should flag a possible contradiction",
    );
  } finally {
    ctx.cleanup();
  }
});

test("findRelatedCandidates does not flag contradiction when both notes are affirmative", () => {
  const ctx = createTestDb();
  try {
    const repo = "owner/repo";
    insertMemory(ctx.db, repo, "We use Redis for caching across the API layer.");
    const related = findRelatedCandidates(
      ctx.db,
      repo,
      "Redis caching is configured with a 60 second TTL in the API layer.",
    );
    assert.ok(related.length >= 1);
    assert.equal(related[0].possibleContradiction, false);
  } finally {
    ctx.cleanup();
  }
});

test("findRelatedCandidates is sorted best-first and capped", () => {
  const ctx = createTestDb();
  try {
    const repo = "owner/repo";
    for (let i = 0; i < 6; i += 1) {
      insertMemory(ctx.db, repo, `Redis caching note variant number ${i} for the API layer`);
    }
    const related = findRelatedCandidates(
      ctx.db,
      repo,
      "Redis caching behaviour in the API layer needs review",
      { max: 3 },
    );
    assert.ok(related.length <= 3, "respects the max cap");
    for (let i = 1; i < related.length; i += 1) {
      assert.ok(related[i - 1].similarity >= related[i].similarity);
    }
  } finally {
    ctx.cleanup();
  }
});

test("findRelatedCandidates scopes to the requested repo", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "owner/repo", "Redis caching across the API layer.");
    insertMemory(ctx.db, "other/repo", "Redis caching across the API layer (other).");
    const related = findRelatedCandidates(
      ctx.db,
      "owner/repo",
      "Redis caching latency in the API layer",
    );
    assert.ok(related.every((c) => c.memory.repo === "owner/repo"));
  } finally {
    ctx.cleanup();
  }
});

test("findRelatedCandidates returns nothing for empty/punctuation-only input", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "owner/repo", "Some real memory about deployments.");
    assert.deepEqual(findRelatedCandidates(ctx.db, "owner/repo", "   "), []);
    assert.deepEqual(findRelatedCandidates(ctx.db, "owner/repo", "!!! ???"), []);
  } finally {
    ctx.cleanup();
  }
});
