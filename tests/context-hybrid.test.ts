import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fetchRepoContext } from "../src/lib/context.js";
import { backfillRepoEmbeddings } from "../src/lib/vector-index.js";
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

test("disabled: keyword query that matches still returns via FTS", () => {
  delete process.env.FOSSEL_EMBEDDINGS;
  insertMemory(ctx.db, "owner/repo", "authentication uses jwt tokens");
  const rows = fetchRepoContext(ctx.db, "owner/repo", 8, "authentication");
  assert.ok(rows.some((r) => /authentication/.test(r.note)));
});

test("disabled: behavior is FTS-only (no semantic recall)", () => {
  // Query shares NO keyword tokens with the note. Without embeddings, the
  // only reason it could surface is the recent/pinned fallback — which it
  // does, but as a "recent" row, not a "search" hit.
  delete process.env.FOSSEL_EMBEDDINGS;
  insertMemory(ctx.db, "owner/repo", "JWT lives in localStorage and 401 redirects");
  const rows = fetchRepoContext(ctx.db, "owner/repo", 8, "credential handling approach");
  const searchHits = rows.filter((r) => r.source === "search");
  assert.equal(searchHits.length, 0, "no semantic search hits expected when disabled");
});

test("enabled: hybrid retrieval surfaces a semantically related note", () => {
  process.env.FOSSEL_EMBEDDINGS = "1";
  // The auth note is the OLDEST. With a query present, search now leads and
  // recent only backfills, so the relevant note surfaces even when many newer
  // unrelated notes exist.
  insertMemory(
    ctx.db,
    "owner/repo",
    "login flow stores jwt tokens and handles 401 redirects",
    { updatedAt: 1000 },
  );
  for (let i = 0; i < 12; i += 1) {
    insertMemory(ctx.db, "owner/repo", `unrelated filler note number ${i} about builds`, {
      updatedAt: 2000 + i,
    });
  }
  backfillRepoEmbeddings(ctx.db, "owner/repo");

  const rows = fetchRepoContext(ctx.db, "owner/repo", 8, "authentication and login handling");
  assert.ok(
    rows.some((r) => /login flow stores jwt/.test(r.note)),
    "expected the auth note to surface via hybrid retrieval",
  );
});

test("enabled: fused results still respect the limit", () => {
  process.env.FOSSEL_EMBEDDINGS = "1";
  for (let i = 0; i < 20; i += 1) {
    insertMemory(ctx.db, "owner/repo", `memory ${i} about routing and endpoints`);
  }
  backfillRepoEmbeddings(ctx.db, "owner/repo");
  const rows = fetchRepoContext(ctx.db, "owner/repo", 5, "routing endpoints");
  assert.ok(rows.length <= 5);
});

test("enabled: no query returns pinned+recent without invoking search", () => {
  process.env.FOSSEL_EMBEDDINGS = "1";
  insertMemory(ctx.db, "owner/repo", "pinned thing", { pinned: true });
  insertMemory(ctx.db, "owner/repo", "recent thing");
  backfillRepoEmbeddings(ctx.db, "owner/repo");
  const rows = fetchRepoContext(ctx.db, "owner/repo", 8);
  assert.ok(rows.length === 2);
  assert.ok(rows.every((r) => r.source !== "search"));
});

test("enabled: results are deduplicated by normalized note", () => {
  process.env.FOSSEL_EMBEDDINGS = "1";
  insertMemory(ctx.db, "owner/repo", "Use pnpm workspaces.");
  insertMemory(ctx.db, "owner/repo", "use pnpm workspaces");
  backfillRepoEmbeddings(ctx.db, "owner/repo");
  const rows = fetchRepoContext(ctx.db, "owner/repo", 8, "pnpm workspaces");
  const pnpmRows = rows.filter((r) => /pnpm workspaces/i.test(r.note));
  assert.equal(pnpmRows.length, 1, "near-identical notes should collapse");
});

test("recency decay off by default: old and new equal-score notes keep fusion order", () => {
  // Two notes score symmetrically on the query via FTS + vector; the only
  // difference is age. With decay off (default) the fusion order stands.
  process.env.FOSSEL_EMBEDDINGS = "1";
  const DAY = 86_400;
  const now = 2_000_000_000;
  insertMemory(ctx.db, "owner/repo", "deploy uses blue green rollout", {
    updatedAt: now - 400 * DAY,
  });
  insertMemory(ctx.db, "owner/repo", "deploy uses canary rollout", {
    updatedAt: now,
  });
  backfillRepoEmbeddings(ctx.db, "owner/repo");

  const rows = fetchRepoContext(ctx.db, "owner/repo", 8, "deploy rollout");
  const hits = rows.filter((r) => /rollout/.test(r.note));
  assert.equal(hits.length, 2, "both rollout notes should surface");
});

test("recency decay on: a much older note is demoted below a newer tie", () => {
  // Same two notes, but turn decay on with a short half-life. The 400-day-old
  // note's score is multiplied toward zero, so the fresh note must rank first.
  process.env.FOSSEL_EMBEDDINGS = "1";
  const DAY = 86_400;
  const now = 2_000_000_000;
  insertMemory(ctx.db, "owner/repo", "deploy uses blue green rollout", {
    updatedAt: now - 400 * DAY,
  });
  insertMemory(ctx.db, "owner/repo", "deploy uses canary rollout", {
    updatedAt: now,
  });
  backfillRepoEmbeddings(ctx.db, "owner/repo");

  const rows = fetchRepoContext(ctx.db, "owner/repo", 8, "deploy rollout", {
    recencyHalfLifeDays: 30,
  });
  const searchHits = rows.filter(
    (r) => r.source === "search" && /rollout/.test(r.note),
  );
  assert.ok(searchHits.length >= 1, "at least one rollout note surfaces");
  assert.match(
    searchHits[0].note,
    /canary/,
    "the fresh note must outrank the 400-day-old one under decay",
  );
});
