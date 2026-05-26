import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeRepoKeys,
  normalizeGitRemote,
  resolveRepoArg,
} from "../src/lib/repo.js";
import { createTestDb, insertMemory } from "./helpers.js";

test("normalizeGitRemote handles common remote URL formats", () => {
  assert.equal(
    normalizeGitRemote("git@github.com:7vignesh/fossel.git"),
    "7vignesh/fossel",
  );
  assert.equal(
    normalizeGitRemote("https://github.com/7vignesh/fossel.git"),
    "7vignesh/fossel",
  );
  assert.equal(
    normalizeGitRemote("https://gitlab.com/group/sub/project"),
    "group/sub/project",
  );
  assert.equal(
    normalizeGitRemote("ssh://git@github.com/owner/repo.git"),
    "owner/repo",
  );
  assert.equal(normalizeGitRemote(""), null);
  assert.equal(normalizeGitRemote("not a remote"), null);
});

test("resolveRepoArg falls back to folder name when no remote", () => {
  const ctx = createTestDb();
  try {
    const resolved = resolveRepoArg(undefined, "/tmp/student-manager", ctx.db);
    assert.equal(resolved.canonical, "student-manager");
    assert.equal(resolved.source, "folder");
  } finally {
    ctx.cleanup();
  }
});

test("resolveRepoArg auto-links alias to canonical when tail matches", () => {
  const ctx = createTestDb();
  try {
    // First call seeds canonical from cwd folder name.
    const first = resolveRepoArg(undefined, "/tmp/student-manager", ctx.db);
    assert.equal(first.canonical, "student-manager");

    // Caller passes a different form referring to the same repo. It should be
    // recognized as an alias because the tail segments match.
    const second = resolveRepoArg(
      "7vignesh/student-manager",
      "/tmp/student-manager",
      ctx.db,
    );
    assert.equal(second.canonical, "student-manager");
    assert.equal(second.source, "alias");

    // Subsequent direct lookups by the alias still hit the canonical.
    const third = resolveRepoArg(
      "7vignesh/student-manager",
      "/elsewhere",
      ctx.db,
    );
    assert.equal(third.canonical, "student-manager");
  } finally {
    ctx.cleanup();
  }
});

test("resolveRepoArg keeps unrelated input as its own canonical", () => {
  const ctx = createTestDb();
  try {
    resolveRepoArg(undefined, "/tmp/fossel", ctx.db);
    const resolved = resolveRepoArg("totally-different", "/tmp/fossel", ctx.db);
    assert.equal(resolved.canonical, "totally-different");
    assert.equal(resolved.source, "input");
  } finally {
    ctx.cleanup();
  }
});

test("mergeRepoKeys collapses memories under the destination canonical", () => {
  const ctx = createTestDb();
  try {
    const oldRow = insertMemory(ctx.db, "studentmanager", "Old note");
    const newRow = insertMemory(ctx.db, "7vignesh/student-manager", "New note");
    assert.ok(oldRow > 0 && newRow > 0);

    // Pretend the user previously stored memories under three forms.
    insertMemory(ctx.db, "student-manager", "Folder-name note");

    const result = mergeRepoKeys(
      ctx.db,
      "studentmanager",
      "7vignesh/student-manager",
    );
    assert.equal(result.movedMemories, 1);

    const rows = ctx.db
      .prepare("SELECT repo FROM memories ORDER BY rowid")
      .all() as Array<{ repo: string }>;
    assert.deepEqual(
      new Set(rows.map((row) => row.repo)),
      new Set(["7vignesh/student-manager", "student-manager"]),
    );

    const aliasRow = ctx.db
      .prepare("SELECT canonical FROM repo_aliases WHERE alias = ?")
      .get("studentmanager") as { canonical: string } | undefined;
    assert.equal(aliasRow?.canonical, "7vignesh/student-manager");
  } finally {
    ctx.cleanup();
  }
});
