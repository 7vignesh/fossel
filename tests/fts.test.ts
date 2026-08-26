import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fetchRepoContext } from "../src/lib/context.js";
import {
  buildMatchExpression,
  buildPrefixExpression,
  lightStem,
  searchFts,
  tokenizeQuery,
} from "../src/lib/fts.js";
import { createTestDb, insertMemory, type TestDb } from "./helpers.js";

const REPO = "acme/storefront";

let ctx: TestDb;

beforeEach(() => {
  ctx = createTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

test("tokenizeQuery splits paths, filenames and identifiers", () => {
  assert.deepEqual(tokenizeQuery("/api/v2/orders"), ["api", "v2", "orders"]);
  assert.deepEqual(tokenizeQuery("env.schema.ts"), ["env", "schema", "ts"]);
  assert.deepEqual(tokenizeQuery("src/auth/rbac.ts"), ["src", "auth", "rbac", "ts"]);
});

test("tokenizeQuery drops single-character noise and punctuation", () => {
  assert.deepEqual(tokenizeQuery("a big (query)!"), ["big", "query"]);
  assert.deepEqual(tokenizeQuery("???"), []);
});

test("buildMatchExpression quotes every token so input cannot be FTS syntax", () => {
  assert.equal(buildMatchExpression(["auth", "jwt"], "AND"), '"auth" AND "jwt"');
  assert.equal(buildMatchExpression(["auth", "jwt"], "OR"), '"auth" OR "jwt"');
  assert.equal(buildMatchExpression([], "AND"), null);
});

test("searchFts prefers a narrow AND match when every term is present", () => {
  insertMemory(ctx.db, REPO, "Use pnpm workspaces for all package scripts.");
  insertMemory(ctx.db, REPO, "Lint with Biome before pushing.");

  const result = searchFts(ctx.db, "pnpm workspaces", { repo: REPO, limit: 5 });
  assert.equal(result.matched, "AND");
  assert.equal(result.rows.length, 1);
  assert.match(result.rows[0].note, /pnpm workspaces/);
});

test("searchFts falls back to OR when AND matches nothing", () => {
  insertMemory(
    ctx.db,
    REPO,
    "The session JWT is kept in an httpOnly cookie and never in localStorage.",
  );
  insertMemory(ctx.db, REPO, "Deploys go out through the release workflow on tag push.");

  // "how does authentication work here" shares only the word "authentication"
  // with nothing at all, so AND must fail; OR should still find the JWT note
  // via a partial term. Use a query where one term does match.
  const result = searchFts(ctx.db, "where is the session token kept", {
    repo: REPO,
    limit: 5,
  });

  assert.equal(result.matched, "OR", "AND cannot match every term, so OR must run");
  assert.ok(result.rows.length > 0, "OR fallback must return the partially matching row");
  assert.match(result.rows[0].note, /session JWT/);
});

test("searchFts returns nothing when no term matches at all", () => {
  insertMemory(ctx.db, REPO, "Deploys go out through the release workflow.");
  const result = searchFts(ctx.db, "quantum entanglement thermodynamics", {
    repo: REPO,
    limit: 5,
  });
  assert.equal(result.matched, null);
  assert.deepEqual(result.rows, []);
});

test("searchFts scopes to the requested repo", () => {
  insertMemory(ctx.db, REPO, "Rate limiting is enforced at the edge worker.");
  insertMemory(ctx.db, "other/repo", "Rate limiting is enforced at the edge worker.");

  const scoped = searchFts(ctx.db, "rate limiting", { repo: REPO, limit: 10 });
  assert.equal(scoped.rows.length, 1);
  assert.equal(scoped.rows[0].repo, REPO);

  const unscoped = searchFts(ctx.db, "rate limiting", { limit: 10 });
  assert.equal(unscoped.rows.length, 2, "omitting repo searches every repo");
});

test("get_context answers a natural-language question (regression)", () => {
  // Before the shared FTS layer, fetchRepoContext joined every term with AND,
  // so a question like this returned no search hits at all — only the recent
  // backfill. Guard the fix: the auth note must arrive as a *search* result.
  insertMemory(
    ctx.db,
    REPO,
    "The session JWT is kept in an httpOnly cookie named sf_session.",
  );
  for (let i = 0; i < 12; i += 1) {
    insertMemory(ctx.db, REPO, `Unrelated filler memory number ${i} about builds.`);
  }

  const rows = fetchRepoContext(ctx.db, REPO, 5, "where is the session jwt stored?");
  const searchHits = rows.filter((row) => row.source === "search");

  assert.ok(searchHits.length > 0, "the query must produce search hits, not just backfill");
  assert.ok(
    searchHits.some((row) => /session JWT/.test(row.note)),
    "the relevant memory must be retrieved as a search hit",
  );
});


test("lightStem strips common inflections conservatively", () => {
  assert.equal(lightStem("alerts"), "alert");
  assert.equal(lightStem("files"), "file");
  assert.equal(lightStem("deployment"), "deploy");
  assert.equal(lightStem("migrations"), "migration");
  assert.equal(lightStem("policies"), "polic");
});

test("lightStem refuses to produce a dangerously short stem", () => {
  // Stripping would leave fewer than 4 characters, so the token is left alone
  // rather than becoming a prefix that matches half the corpus.
  assert.equal(lightStem("cats"), "cats");
  assert.equal(lightStem("ties"), "ties");
  assert.equal(lightStem("is"), "is");
});

test("lightStem always returns a prefix of its input", () => {
  // This is the property that makes the stem safe to use with FTS5 prefix
  // matching: `stem*` must still match the original token. A stemmer that maps
  // "policies" -> "policy" would break it.
  const tokens = [
    "alerts",
    "files",
    "deployment",
    "deployments",
    "migrations",
    "policies",
    "postgres",
    "rollback",
    "jwt",
    "indexing",
    "reviewers",
    "enforced",
  ];
  for (const token of tokens) {
    const stem = lightStem(token);
    assert.ok(
      token.startsWith(stem),
      `lightStem("${token}") returned "${stem}", which is not a prefix`,
    );
    assert.ok(stem.length > 0);
  }
});

test("buildPrefixExpression emits quoted FTS5 prefix terms", () => {
  assert.equal(buildPrefixExpression(["alerts"]), '"alert"*');
  assert.equal(
    buildPrefixExpression(["alerts", "deployment"]),
    '"alert"* OR "deploy"*',
  );
});

test("buildPrefixExpression drops tokens too short to prefix safely", () => {
  assert.equal(buildPrefixExpression(["is", "of"]), null);
});

test("buildPrefixExpression deduplicates tokens sharing a stem", () => {
  // "deploys" and "deployment" both stem to "deploy"; one prefix term suffices.
  assert.equal(buildPrefixExpression(["deploys", "deployment"]), '"deploy"*');
});

test("searchFts matches across inflection via the stemmed-prefix tier", () => {
  // FTS5 has no stemming, so "alerts" cannot match "alert channel" with an
  // exact-token query. Tier 3 is what rescues it.
  insertMemory(
    ctx.db,
    REPO,
    "The on-call engineer owns the alert channel for the whole week.",
  );

  const result = searchFts(ctx.db, "who watches alerts", { repo: REPO, limit: 5 });
  assert.ok(result.usedPrefix, "the prefix tier must be what produced the match");
  assert.ok(
    result.rows.some((row) => /alert channel/.test(row.note)),
    "singular 'alert' must be reachable from the plural query term",
  );
});

test("the prefix tier appends rather than displacing exact-token hits", () => {
  // "deployment" matches m-nextjs exactly; "deploy*" additionally reaches
  // "Deploys". The exact hit must stay in front.
  insertMemory(
    ctx.db,
    REPO,
    "We chose Next.js; the deciding factor was the existing Vercel deployment.",
  );
  insertMemory(ctx.db, REPO, "Deploys go out through the release workflow on tag push.");

  const result = searchFts(ctx.db, "deployment", { repo: REPO, limit: 5 });
  assert.ok(result.rows.length >= 2, "both rows should be reachable");
  assert.match(
    result.rows[0].note,
    /Vercel deployment/,
    "the exact-token match must rank ahead of the prefix-only match",
  );
});
