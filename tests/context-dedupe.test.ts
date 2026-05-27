import test from "node:test";
import assert from "node:assert/strict";
import { fetchRepoContext } from "../src/lib/context.js";
import { createTestDb, insertMemory } from "./helpers.js";

test("fetchRepoContext collapses near-identical notes at read time", () => {
  const ctx = createTestDb();
  try {
    const repo = "owner/repo";
    insertMemory(ctx.db, repo, "JWT lives in localStorage.", { updatedAt: 100 });
    insertMemory(ctx.db, repo, "JWT lives in localStorage!!!", { updatedAt: 200 });
    insertMemory(ctx.db, repo, "Webhook retries are idempotent.", {
      updatedAt: 300,
    });

    const rows = fetchRepoContext(ctx.db, repo, 10);
    const notes = rows.map((row) => row.note);

    // JWT note should appear only once (the more recent variant) even though
    // two near-identical rows exist in the database.
    const jwtMatches = notes.filter((note) => /JWT lives in localStorage/.test(note));
    assert.equal(jwtMatches.length, 1, `unexpected duplicates: ${notes.join(" | ")}`);
    assert.ok(notes.some((note) => /Webhook retries/.test(note)));
  } finally {
    ctx.cleanup();
  }
});
