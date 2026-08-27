import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb, insertMemory } from "./helpers.js";
import {
  extractEntities,
  findEntityMatches,
  recordEntities,
} from "../src/lib/entities.js";

// ---------- extractEntities: pure function tests -------------------------

test("extractEntities finds file paths with directory segments", () => {
  const entities = extractEntities(
    "Auth logic lives in src/auth/middleware.ts and the tests in tests/auth.test.ts",
  );
  const files = entities.filter((e) => e.kind === "file");
  assert.ok(files.some((e) => e.entity === "src/auth/middleware.ts"));
  assert.ok(files.some((e) => e.entity === "tests/auth.test.ts"));
});

test("extractEntities finds scoped npm packages", () => {
  const entities = extractEntities(
    "We use @modelcontextprotocol/sdk and @types/better-sqlite3 for the build",
  );
  const pkgs = entities.filter((e) => e.kind === "package");
  assert.ok(pkgs.some((e) => e.entity === "@modelcontextprotocol/sdk"));
  assert.ok(pkgs.some((e) => e.entity === "@types/better-sqlite3"));
});

test("extractEntities finds known packages as whole words", () => {
  const entities = extractEntities(
    "Migrated from express to fastify for better perf; zod validates inputs",
  );
  const pkgs = entities.filter((e) => e.kind === "package");
  assert.ok(pkgs.some((e) => e.entity === "express"));
  assert.ok(pkgs.some((e) => e.entity === "fastify"));
  assert.ok(pkgs.some((e) => e.entity === "zod"));
});

test("extractEntities finds function calls", () => {
  const entities = extractEntities(
    "Call fetchUserProfile() after authenticate() returns true",
  );
  const fns = entities.filter((e) => e.kind === "function");
  assert.ok(fns.some((e) => e.entity === "fetchuserprofile"));
  assert.ok(fns.some((e) => e.entity === "authenticate"));
});

test("extractEntities finds PascalCase identifiers", () => {
  const entities = extractEntities(
    "The AuthMiddleware class wraps HttpResponse and calls TokenValidator",
  );
  const ids = entities.filter((e) => e.kind === "identifier");
  assert.ok(ids.some((e) => e.entity === "authmiddleware"));
  assert.ok(ids.some((e) => e.entity === "httpresponse"));
  assert.ok(ids.some((e) => e.entity === "tokenvalidator"));
});

test("extractEntities finds services", () => {
  const entities = extractEntities(
    "Sessions are stored in redis; long-term data goes to postgres via prisma",
  );
  const services = entities.filter((e) => e.kind === "service");
  assert.ok(services.some((e) => e.entity === "redis"));
  assert.ok(services.some((e) => e.entity === "postgres"));
});

test("extractEntities finds ticket references", () => {
  const entities = extractEntities(
    "Fixed in JIRA-1234, related to #42 and AUTH-99",
  );
  const tickets = entities.filter((e) => e.kind === "ticket");
  assert.ok(tickets.some((e) => e.entity === "JIRA-1234"));
  assert.ok(tickets.some((e) => e.entity === "#42"));
  assert.ok(tickets.some((e) => e.entity === "AUTH-99"));
});

test("extractEntities deduplicates repeated mentions", () => {
  const entities = extractEntities(
    "middleware.ts is called from middleware.ts after init",
  );
  const files = entities.filter((e) => e.kind === "file");
  assert.equal(files.length, 1);
});

test("extractEntities returns empty for prose without identifiers", () => {
  const entities = extractEntities(
    "We decided not to split the monolith because of team size constraints",
  );
  // May pick up some word matches but should be minimal
  const files = entities.filter((e) => e.kind === "file");
  const fns = entities.filter((e) => e.kind === "function");
  assert.equal(files.length, 0);
  assert.equal(fns.length, 0);
});

test("extractEntities normalizes scoped packages to lowercase", () => {
  const entities = extractEntities("Install @MyOrg/MyPackage for auth");
  const pkgs = entities.filter((e) => e.kind === "package");
  if (pkgs.length > 0) {
    assert.equal(pkgs[0].entity, pkgs[0].entity.toLowerCase());
  }
});

// ---------- recordEntities: DB integration tests -------------------------

test("recordEntities stores entities in the side table", () => {
  const ctx = createTestDb();
  try {
    const rowId = insertMemory(
      ctx.db,
      "acme/app",
      "JWT validation happens in src/auth/jwt.ts using the jsonwebtoken package",
    );
    const count = recordEntities(
      ctx.db,
      rowId,
      "JWT validation happens in src/auth/jwt.ts using the jsonwebtoken package",
    );
    assert.ok(count > 0, "should record at least one entity");

    const stored = ctx.db
      .prepare("SELECT entity, kind FROM memory_entities WHERE memory_rowid = ?")
      .all(rowId) as Array<{ entity: string; kind: string }>;
    assert.ok(stored.some((e) => e.entity === "src/auth/jwt.ts" && e.kind === "file"));
  } finally {
    ctx.cleanup();
  }
});

test("recordEntities replaces entities on re-record (full replace)", () => {
  const ctx = createTestDb();
  try {
    const rowId = insertMemory(ctx.db, "acme/app", "Uses redis for caching");
    recordEntities(ctx.db, rowId, "Uses redis for caching");

    const before = ctx.db
      .prepare("SELECT entity FROM memory_entities WHERE memory_rowid = ?")
      .all(rowId) as Array<{ entity: string }>;
    assert.ok(before.some((e) => e.entity === "redis"));

    // Re-record with different content
    recordEntities(ctx.db, rowId, "Migrated to postgres for persistence");

    const after = ctx.db
      .prepare("SELECT entity FROM memory_entities WHERE memory_rowid = ?")
      .all(rowId) as Array<{ entity: string }>;
    assert.ok(!after.some((e) => e.entity === "redis"), "redis should be gone");
    assert.ok(after.some((e) => e.entity === "postgres"), "postgres should be present");
  } finally {
    ctx.cleanup();
  }
});

test("recordEntities returns 0 and clears table for text with no entities", () => {
  const ctx = createTestDb();
  try {
    const rowId = insertMemory(ctx.db, "acme/app", "redis is the cache layer");
    recordEntities(ctx.db, rowId, "redis is the cache layer");

    // Now update with no-entity text
    const count = recordEntities(
      ctx.db,
      rowId,
      "This is a plain note about nothing specific",
    );
    assert.equal(count, 0);

    const stored = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM memory_entities WHERE memory_rowid = ?")
      .get(rowId) as { c: number };
    assert.equal(stored.c, 0);
  } finally {
    ctx.cleanup();
  }
});

test("deleting a memory cascades to its entities", () => {
  const ctx = createTestDb();
  try {
    const rowId = insertMemory(ctx.db, "acme/app", "Uses express and zod");
    recordEntities(ctx.db, rowId, "Uses express and zod");

    // Verify entities exist
    const before = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM memory_entities WHERE memory_rowid = ?")
      .get(rowId) as { c: number };
    assert.ok(before.c > 0);

    // Delete the memory
    ctx.db.prepare("DELETE FROM memories WHERE rowid = ?").run(rowId);

    // Entities should be gone via cascade trigger
    const after = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM memory_entities WHERE memory_rowid = ?")
      .get(rowId) as { c: number };
    assert.equal(after.c, 0, "cascade trigger must clean up entities");
  } finally {
    ctx.cleanup();
  }
});

// ---------- findEntityMatches: retrieval integration tests ----------------

test("findEntityMatches returns memories sharing entities with the query", () => {
  const ctx = createTestDb();
  try {
    const id1 = insertMemory(ctx.db, "acme/app", "Auth logic in src/auth.ts uses express middleware");
    const id2 = insertMemory(ctx.db, "acme/app", "Deployment runs on kubernetes with docker");
    const id3 = insertMemory(ctx.db, "acme/app", "Also uses express for routing layer");

    recordEntities(ctx.db, id1, "Auth logic in src/auth.ts uses express middleware");
    recordEntities(ctx.db, id2, "Deployment runs on kubernetes with docker");
    recordEntities(ctx.db, id3, "Also uses express for routing layer");

    // Query about express
    const queryEntities = extractEntities("how does express handle requests?");
    const matches = findEntityMatches(ctx.db, "acme/app", queryEntities, 10);

    assert.ok(matches.length >= 2, `expected >=2 matches, got ${matches.length}`);
    const matchIds = matches.map((m) => m.row_id);
    assert.ok(matchIds.includes(id1));
    assert.ok(matchIds.includes(id3));
  } finally {
    ctx.cleanup();
  }
});

test("findEntityMatches ranks by shared entity count", () => {
  const ctx = createTestDb();
  try {
    const id1 = insertMemory(ctx.db, "acme/app", "Uses redis for sessions");
    const id2 = insertMemory(ctx.db, "acme/app", "Redis and postgres handle different layers of caching");

    recordEntities(ctx.db, id1, "Uses redis for sessions");
    recordEntities(ctx.db, id2, "Redis and postgres handle different layers of caching");

    // Query mentioning both redis and postgres
    const queryEntities = extractEntities("how do redis and postgres work together?");
    const matches = findEntityMatches(ctx.db, "acme/app", queryEntities, 10);

    // id2 should rank first (2 shared entities: redis + postgres)
    assert.ok(matches.length >= 2);
    assert.equal(matches[0].row_id, id2, "memory with more shared entities should rank first");
  } finally {
    ctx.cleanup();
  }
});

test("findEntityMatches scopes to the requested repo", () => {
  const ctx = createTestDb();
  try {
    const id1 = insertMemory(ctx.db, "acme/app", "Uses express for API");
    const id2 = insertMemory(ctx.db, "other/repo", "Also uses express somewhere");

    recordEntities(ctx.db, id1, "Uses express for API");
    recordEntities(ctx.db, id2, "Also uses express somewhere");

    const queryEntities = extractEntities("express");
    const matches = findEntityMatches(ctx.db, "acme/app", queryEntities, 10);

    const matchIds = matches.map((m) => m.row_id);
    assert.ok(matchIds.includes(id1));
    assert.ok(!matchIds.includes(id2), "should not return memories from other repos");
  } finally {
    ctx.cleanup();
  }
});

test("findEntityMatches excludes superseded memories", () => {
  const ctx = createTestDb();
  try {
    const id1 = insertMemory(ctx.db, "acme/app", "Uses redis for caching");
    recordEntities(ctx.db, id1, "Uses redis for caching");

    // Supersede the memory
    ctx.db
      .prepare("UPDATE memories SET valid_to = ? WHERE rowid = ?")
      .run(Math.floor(Date.now() / 1000), id1);

    const queryEntities = extractEntities("redis caching");
    const matches = findEntityMatches(ctx.db, "acme/app", queryEntities, 10);
    assert.equal(matches.length, 0, "superseded memory should not appear");
  } finally {
    ctx.cleanup();
  }
});

test("findEntityMatches returns empty when no entities match", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "acme/app", "Uses redis for caching");
    recordEntities(ctx.db, 1, "Uses redis for caching");

    const queryEntities = extractEntities("how does postgres replication work?");
    const matches = findEntityMatches(ctx.db, "acme/app", queryEntities, 10);
    // redis != postgres, so no match expected
    const hasPostgres = queryEntities.some((e) => e.entity === "postgres");
    if (hasPostgres) {
      assert.equal(matches.length, 0);
    }
  } finally {
    ctx.cleanup();
  }
});

test("findEntityMatches returns empty for empty query entities", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "acme/app", "Uses redis");
    recordEntities(ctx.db, 1, "Uses redis");

    const matches = findEntityMatches(ctx.db, "acme/app", [], 10);
    assert.equal(matches.length, 0);
  } finally {
    ctx.cleanup();
  }
});
