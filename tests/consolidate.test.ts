import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb, insertMemory } from "./helpers.js";
import {
  analyzeRepo,
  formatConsolidationReport,
} from "../src/lib/consolidate.js";

// ---------- analyzeRepo: stale detection ---------------------------------

test("analyzeRepo detects stale memories (never accessed, old)", () => {
  const ctx = createTestDb();
  try {
    const oldTime = Math.floor(Date.now() / 1000) - 120 * 86400; // 120 days ago
    insertMemory(ctx.db, "acme/app", "An old convention nobody uses", {
      updatedAt: oldTime,
    });
    // Ensure access_count stays at 0 (default from migration)

    const report = analyzeRepo(ctx.db, "acme/app", { staleDays: 90 });
    assert.ok(report.candidates.length >= 1);
    const stale = report.candidates.filter((c) => c.issue === "stale");
    assert.ok(stale.length >= 1, "should detect stale memory");
    assert.match(stale[0].details, /Never retrieved/);
  } finally {
    ctx.cleanup();
  }
});

test("analyzeRepo does not flag a recently created memory as stale", () => {
  const ctx = createTestDb();
  try {
    const now = Math.floor(Date.now() / 1000);
    insertMemory(ctx.db, "acme/app", "A fresh memory", { updatedAt: now });

    const report = analyzeRepo(ctx.db, "acme/app", { staleDays: 90 });
    const stale = report.candidates.filter((c) => c.issue === "stale");
    assert.equal(stale.length, 0, "recent memories should not be flagged stale");
  } finally {
    ctx.cleanup();
  }
});

test("analyzeRepo does not flag accessed memories as stale", () => {
  const ctx = createTestDb();
  try {
    const oldTime = Math.floor(Date.now() / 1000) - 120 * 86400;
    const id = insertMemory(ctx.db, "acme/app", "Old but used memory", {
      updatedAt: oldTime,
    });

    // Mark it as accessed
    ctx.db
      .prepare("UPDATE memories SET access_count = 3, last_accessed_at = ? WHERE rowid = ?")
      .run(Math.floor(Date.now() / 1000), id);

    const report = analyzeRepo(ctx.db, "acme/app", { staleDays: 90 });
    const stale = report.candidates.filter((c) => c.issue === "stale");
    assert.equal(stale.length, 0, "accessed memories should not be stale");
  } finally {
    ctx.cleanup();
  }
});

test("analyzeRepo does not flag pinned memories as stale", () => {
  const ctx = createTestDb();
  try {
    const oldTime = Math.floor(Date.now() / 1000) - 120 * 86400;
    insertMemory(ctx.db, "acme/app", "Important pinned memory", {
      updatedAt: oldTime,
      pinned: true,
    });

    const report = analyzeRepo(ctx.db, "acme/app", { staleDays: 90 });
    const stale = report.candidates.filter((c) => c.issue === "stale");
    assert.equal(stale.length, 0, "pinned memories should not be stale");
  } finally {
    ctx.cleanup();
  }
});

// ---------- analyzeRepo: redundancy detection ----------------------------

test("analyzeRepo detects redundant memory pairs", () => {
  const ctx = createTestDb();
  try {
    // These two notes are nearly identical — just minor wording differences.
    // The blended Jaccard (55% word + 45% trigram) should be well above 0.70.
    insertMemory(ctx.db, "acme/app", "JWT token lives in localStorage and 401 redirects to /login page");
    insertMemory(ctx.db, "acme/app", "JWT token lives in localStorage and 401 redirects to the /login page");

    const report = analyzeRepo(ctx.db, "acme/app");
    const redundant = report.candidates.filter((c) => c.issue === "redundant");
    assert.ok(redundant.length >= 1, "should detect near-duplicate pair");
    assert.match(redundant[0].details, /similar to memory/);
  } finally {
    ctx.cleanup();
  }
});

test("analyzeRepo does not flag distinct memories as redundant", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "acme/app", "Use pnpm workspaces for all scripts");
    insertMemory(ctx.db, "acme/app", "Deployment goes through GitHub Actions with docker compose");

    const report = analyzeRepo(ctx.db, "acme/app");
    const redundant = report.candidates.filter((c) => c.issue === "redundant");
    assert.equal(redundant.length, 0, "distinct notes should not be flagged");
  } finally {
    ctx.cleanup();
  }
});

// ---------- analyzeRepo: contradiction detection -------------------------

test("analyzeRepo detects potential contradictions via negation language", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "acme/app", "JWT no longer lives in localStorage; we moved to httpOnly cookies");
    insertMemory(ctx.db, "acme/app", "JWT lives in localStorage and 401 redirects to /login");

    const report = analyzeRepo(ctx.db, "acme/app");
    const contradicted = report.candidates.filter((c) => c.issue === "contradicted");
    assert.ok(contradicted.length >= 1, "should detect contradiction");
    assert.match(contradicted[0].details, /contradicted/);
  } finally {
    ctx.cleanup();
  }
});

test("analyzeRepo does not flag two affirmative notes as contradicted", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "acme/app", "We use React for the frontend");
    insertMemory(ctx.db, "acme/app", "The frontend is built with React and TypeScript");

    const report = analyzeRepo(ctx.db, "acme/app");
    const contradicted = report.candidates.filter((c) => c.issue === "contradicted");
    assert.equal(contradicted.length, 0);
  } finally {
    ctx.cleanup();
  }
});

// ---------- analyzeRepo: scoping and limits ------------------------------

test("analyzeRepo scopes to a single repo", () => {
  const ctx = createTestDb();
  try {
    const oldTime = Math.floor(Date.now() / 1000) - 120 * 86400;
    insertMemory(ctx.db, "acme/app", "Old stale memory in acme/app", {
      updatedAt: oldTime,
    });
    insertMemory(ctx.db, "other/repo", "Old stale memory in other/repo", {
      updatedAt: oldTime,
    });

    const report = analyzeRepo(ctx.db, "acme/app");
    assert.equal(report.totalMemories, 1);
  } finally {
    ctx.cleanup();
  }
});

test("analyzeRepo respects maxCandidates limit", () => {
  const ctx = createTestDb();
  try {
    const oldTime = Math.floor(Date.now() / 1000) - 120 * 86400;
    for (let i = 0; i < 10; i++) {
      insertMemory(ctx.db, "acme/app", `Stale memory number ${i}`, {
        updatedAt: oldTime,
      });
    }

    const report = analyzeRepo(ctx.db, "acme/app", { maxCandidates: 3 });
    assert.ok(report.candidates.length <= 3, "should respect maxCandidates");
  } finally {
    ctx.cleanup();
  }
});

test("analyzeRepo excludes superseded memories", () => {
  const ctx = createTestDb();
  try {
    const oldTime = Math.floor(Date.now() / 1000) - 120 * 86400;
    const id = insertMemory(ctx.db, "acme/app", "Superseded old memory", {
      updatedAt: oldTime,
    });
    ctx.db
      .prepare("UPDATE memories SET valid_to = ? WHERE rowid = ?")
      .run(Math.floor(Date.now() / 1000), id);

    const report = analyzeRepo(ctx.db, "acme/app");
    assert.equal(report.totalMemories, 0);
    assert.equal(report.candidates.length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("analyzeRepo returns clean report for empty repo", () => {
  const ctx = createTestDb();
  try {
    const report = analyzeRepo(ctx.db, "acme/empty-repo");
    assert.equal(report.totalMemories, 0);
    assert.equal(report.candidates.length, 0);
    assert.match(report.summary, /No maintenance candidates/);
  } finally {
    ctx.cleanup();
  }
});

test("analyzeRepo uses custom staleDays threshold", () => {
  const ctx = createTestDb();
  try {
    // Memory is 10 days old
    const tenDaysAgo = Math.floor(Date.now() / 1000) - 10 * 86400;
    insertMemory(ctx.db, "acme/app", "Somewhat old memory", {
      updatedAt: tenDaysAgo,
    });

    // With default 90 days, should not be stale
    const report90 = analyzeRepo(ctx.db, "acme/app", { staleDays: 90 });
    const stale90 = report90.candidates.filter((c) => c.issue === "stale");
    assert.equal(stale90.length, 0);

    // With 5 days threshold, should be stale
    const report5 = analyzeRepo(ctx.db, "acme/app", { staleDays: 5 });
    const stale5 = report5.candidates.filter((c) => c.issue === "stale");
    assert.ok(stale5.length >= 1);
  } finally {
    ctx.cleanup();
  }
});

// ---------- formatConsolidationReport: output format ---------------------

test("formatConsolidationReport renders markdown for empty report", () => {
  const report = {
    repo: "acme/app",
    totalMemories: 5,
    candidates: [],
    summary: "Analyzed 5 live memories for acme/app.\nNo maintenance candidates found. Memory is clean.",
  };
  const output = formatConsolidationReport(report);
  assert.match(output, /# Memory Consolidation Report/);
  assert.match(output, /No maintenance candidates/);
  assert.ok(!output.includes("## Candidates for review"));
});

test("formatConsolidationReport renders candidates with badges", () => {
  const report = {
    repo: "acme/app",
    totalMemories: 10,
    candidates: [
      {
        memory: {
          row_id: 1,
          id: "t-abc",
          repo: "acme/app",
          type: "convention" as const,
          note: "Old unused convention about something",
          tags: "[]",
          created_at: 1000,
          updated_at: 1000,
          pinned: 0,
        },
        issue: "stale" as const,
        details: "Never retrieved since creation (120 days old).",
      },
      {
        memory: {
          row_id: 2,
          id: "t-def",
          repo: "acme/app",
          type: "convention" as const,
          note: "A redundant note that duplicates something",
          tags: "[]",
          created_at: 1000,
          updated_at: 1000,
          pinned: 0,
        },
        issue: "redundant" as const,
        details: "85% similar to memory #3",
        relatedIds: [3],
      },
    ],
    summary: "Found 2 candidates for review.",
  };
  const output = formatConsolidationReport(report);
  assert.match(output, /🕸️/); // stale badge
  assert.match(output, /🔁/); // redundant badge
  assert.match(output, /## Suggested actions/);
  assert.match(output, /supersede_memory/);
});

test("formatConsolidationReport includes contradiction badge", () => {
  const report = {
    repo: "acme/app",
    totalMemories: 5,
    candidates: [
      {
        memory: {
          row_id: 4,
          id: "t-ghi",
          repo: "acme/app",
          type: "convention" as const,
          note: "JWT lives in localStorage",
          tags: "[]",
          created_at: 1000,
          updated_at: 1000,
          pinned: 0,
        },
        issue: "contradicted" as const,
        details: 'May be contradicted by memory #5: "JWT no longer lives in localStorage"',
        relatedIds: [5],
      },
    ],
    summary: "Found 1 candidates for review.",
  };
  const output = formatConsolidationReport(report);
  assert.match(output, /⚠️/);
  assert.match(output, /contradicted/);
});
