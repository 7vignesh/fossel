import test from "node:test";
import assert from "node:assert/strict";
import { inferMemoryFromNote, inferMemoryType, inferTags } from "../src/lib/inference.js";

test("infers bug_fix from fix-related language", () => {
  assert.equal(
    inferMemoryType("Fixed websocket reconnect race by awaiting auth handshake."),
    "bug_fix",
  );
  assert.equal(inferMemoryType("Root cause was a stale cache on writes."), "bug_fix");
});

test("infers decision when choice-like language is present", () => {
  assert.equal(
    inferMemoryType("We decided to use JWT in localStorage instead of cookies."),
    "decision",
  );
  assert.equal(
    inferMemoryType("Chose Postgres over MongoDB for stronger consistency."),
    "decision",
  );
});

test("infers convention for factual auth statements", () => {
  assert.equal(
    inferMemoryType("JWT lives in localStorage; 401 redirects to /login."),
    "convention",
  );
});

test("infers issue when ticket numbers appear", () => {
  assert.equal(inferMemoryType("Issue #123 covers the import bug."), "issue");
});

test("infers reviewer_pattern from review-style notes", () => {
  assert.equal(
    inferMemoryType("Reviewers prefer explicit return types on exported functions."),
    "reviewer_pattern",
  );
});

test("falls back to convention for ambiguous notes", () => {
  assert.equal(inferMemoryType("Use eslint-config-prettier."), "convention");
});

test("inferTags returns 2–5 lower-cased deduped tags", () => {
  const tags = inferTags(
    "API base URL is http://localhost:5000/api, routes /api/auth and /api/students",
  );
  assert.ok(tags.length >= 2 && tags.length <= 5, `got ${tags.length} tags: ${tags.join(",")}`);
  assert.equal(new Set(tags).size, tags.length);
  assert.ok(tags.includes("api"));
  assert.ok(tags.includes("auth"));
  for (const tag of tags) {
    assert.equal(tag, tag.toLowerCase());
  }
});

test("inferMemoryFromNote returns both type and tags", () => {
  const result = inferMemoryFromNote(
    "Fixed JWT refresh bug by rotating the signing key on logout.",
  );
  assert.equal(result.type, "bug_fix");
  assert.ok(result.tags.length >= 2);
  assert.ok(result.tags.includes("jwt") || result.tags.includes("auth"));
});
