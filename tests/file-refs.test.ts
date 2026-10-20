import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runMigrations } from "../src/db/migrate.js";
import {
  extractFilePaths,
  findStaleFileRefs,
  findUnverifiedFileRefs,
  recordFileRefs,
} from "../src/lib/file-refs.js";

const GIT_AVAILABLE = (() => {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();

// --- extractFilePaths: pure, no git needed -------------------------------

test("extractFilePaths keeps full relative paths, not just basenames", () => {
  const paths = extractFilePaths(
    "Permission checks go through canAccess() in src/auth/rbac.ts; never the claim.",
  );
  assert.deepEqual(paths, ["src/auth/rbac.ts"]);
});

test("extractFilePaths finds multiple distinct files", () => {
  const paths = extractFilePaths(
    "The refresh worker in refreshWorker.ts reads config from env.schema.ts.",
  );
  assert.ok(paths.includes("refreshWorker.ts"));
  assert.ok(paths.includes("env.schema.ts"));
});

test("extractFilePaths strips a leading ./ or /", () => {
  assert.deepEqual(extractFilePaths("see ./src/index.ts"), ["src/index.ts"]);
  assert.deepEqual(extractFilePaths("mounted at /app/server.js"), ["app/server.js"]);
});

test("extractFilePaths ignores prose without a code file", () => {
  assert.deepEqual(
    extractFilePaths("We decided not to split the monolith into microservices."),
    [],
  );
});

test("extractFilePaths deduplicates repeated mentions", () => {
  assert.deepEqual(
    extractFilePaths("middleware.ts is the entry; middleware.ts also does auth"),
    ["middleware.ts"],
  );
});

// --- recording + drift: real git repo ------------------------------------

let dir: string;
let db: Database.Database;

function run(args: string[]): void {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function initRepo(): void {
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "T"]);
  run(["config", "commit.gpgsign", "false"]);
}

function writeCommit(path: string, content: string, message: string): void {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
  run(["add", path]);
  run(["commit", "-q", "-m", message]);
}

function insertMemoryRow(note: string): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `
        INSERT INTO memories (id, repo, type, note, tags, created_at, updated_at, pinned, metadata_json, note_normalized)
        VALUES (?, 'acme/app', 'convention', ?, '[]', ?, ?, 0, '{}', ?)
      `,
    )
    .run(`m-${Math.random().toString(36).slice(2)}`, note, now, now, note.toLowerCase());
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fossel-fileref-"));
  db = new Database(join(dir, "memory.db"));
  db.pragma("journal_mode = WAL");
  runMigrations(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
});

test("recordFileRefs is a no-op outside a git repo", () => {
  const rowId = insertMemoryRow("auth lives in src/auth/rbac.ts");
  const recorded = recordFileRefs(db, rowId, "auth lives in src/auth/rbac.ts", dir);
  assert.equal(recorded, 0, "no refs without a git repo");
  const count = db
    .prepare("SELECT COUNT(*) AS c FROM memory_file_refs")
    .get() as { c: number };
  assert.equal(count.c, 0);
});

test("recordFileRefs records every named path, tracking what git can resolve", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  writeCommit("src/auth.ts", "export const jwt = 1;", "add auth");

  const rowId = insertMemoryRow("jwt handling is in src/auth.ts, not in made-up.ts");
  const recorded = recordFileRefs(
    db,
    rowId,
    "jwt handling is in src/auth.ts, not in made-up.ts",
    dir,
  );

  assert.equal(recorded, 2, "both named paths are recorded");
  const rows = db
    .prepare("SELECT path, tracked FROM memory_file_refs WHERE memory_rowid = ? ORDER BY path")
    .all(rowId) as Array<{ path: string; tracked: number }>;
  assert.deepEqual(
    rows.map((r) => [r.path, r.tracked]),
    [
      ["made-up.ts", 0],
      ["src/auth.ts", 1],
    ],
    "the resolved path is tracked, the made-up one is not",
  );
});

test("findUnverifiedFileRefs reports named-but-unresolved paths", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  writeCommit("src/auth.ts", "export const jwt = 1;", "add auth");

  const rowId = insertMemoryRow("auth lives in src/auth.ts, and in docs/never-committed.md");
  recordFileRefs(
    db,
    rowId,
    "auth lives in src/auth.ts, and in docs/never-committed.md",
    dir,
  );

  const unverified = findUnverifiedFileRefs(db, [rowId]);
  assert.deepEqual(unverified.get(rowId), ["docs/never-committed.md"]);
});

test("findUnverifiedFileRefs is empty for a fully tracked memory", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  writeCommit("src/auth.ts", "export const jwt = 1;", "add auth");

  const rowId = insertMemoryRow("jwt handling is in src/auth.ts");
  recordFileRefs(db, rowId, "jwt handling is in src/auth.ts", dir);

  const unverified = findUnverifiedFileRefs(db, [rowId]);
  assert.equal(unverified.size, 0);
});

test("an untracked path becomes verifiable once committed and re-recorded", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  writeCommit("src/auth.ts", "export const jwt = 1;", "add auth");
  const note = "auth in src/auth.ts, spec in docs/spec.md";
  const rowId = insertMemoryRow(note);

  // docs/spec.md does not exist yet: the memory reads back as unverified.
  recordFileRefs(db, rowId, note, dir);
  assert.deepEqual(
    findUnverifiedFileRefs(db, [rowId]).get(rowId),
    ["docs/spec.md"],
    "the uncommitted path starts unverified",
  );

  // Commit the file, then re-record (the write path flips tracked, a commit
  // alone does not touch stored refs).
  writeCommit("docs/spec.md", "# spec", "add spec");
  recordFileRefs(db, rowId, note, dir);

  assert.equal(
    findUnverifiedFileRefs(db, [rowId]).size,
    0,
    "re-recording after the commit clears the unverified state",
  );
  const tracked = db
    .prepare("SELECT tracked FROM memory_file_refs WHERE memory_rowid = ? AND path = ?")
    .get(rowId, "docs/spec.md") as { tracked: number };
  assert.equal(tracked.tracked, 1, "the path is now tracked");

  // And it is now subject to drift detection rather than staying silent.
  writeCommit("docs/spec.md", "# spec v2", "edit spec");
  assert.ok(
    findStaleFileRefs(db, [rowId], dir).has(rowId),
    "a once-untracked path, once tracked, participates in drift detection",
  );
});

test("a deleted tracked file reads as stale, never as unverified", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  writeCommit("src/auth.ts", "export const jwt = 1;", "add auth");
  const rowId = insertMemoryRow("jwt handling is in src/auth.ts");
  recordFileRefs(db, rowId, "jwt handling is in src/auth.ts", dir);

  // Delete and commit the referenced file.
  run(["rm", "-q", "src/auth.ts"]);
  run(["commit", "-q", "-m", "remove auth"]);

  // A deleted tracked file is drift, not "never checked": the row is still
  // tracked = 1, so it must surface as stale and never as unverified.
  assert.ok(
    findStaleFileRefs(db, [rowId], dir).has(rowId),
    "a deleted tracked file must be flagged as stale",
  );
  assert.equal(
    findUnverifiedFileRefs(db, [rowId]).size,
    0,
    "a deleted tracked file must not be reclassified as unverified",
  );
});

test("findStaleFileRefs reports nothing when the file is unchanged", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  writeCommit("src/auth.ts", "export const jwt = 1;", "add auth");
  const rowId = insertMemoryRow("jwt handling is in src/auth.ts");
  recordFileRefs(db, rowId, "jwt handling is in src/auth.ts", dir);

  const stale = findStaleFileRefs(db, [rowId], dir);
  assert.equal(stale.size, 0, "an untouched file must not be flagged");
});

test("findStaleFileRefs flags a memory when its file's committed content changes", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  writeCommit("src/auth.ts", "export const jwt = 1;", "add auth");
  const rowId = insertMemoryRow("jwt handling is in src/auth.ts");
  recordFileRefs(db, rowId, "jwt handling is in src/auth.ts", dir);

  // Rewrite and commit the referenced file.
  writeCommit("src/auth.ts", "export const jwt = 2; // rewritten", "change auth");

  const stale = findStaleFileRefs(db, [rowId], dir);
  assert.ok(stale.has(rowId), "the memory must be flagged as possibly stale");
  const refs = stale.get(rowId)!;
  assert.equal(refs[0].path, "src/auth.ts");
  assert.equal(refs[0].changedInWorkingTree, false, "the change was committed, not a working-tree edit");
});

test("findStaleFileRefs distinguishes an uncommitted working-tree change", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  writeCommit("src/auth.ts", "export const jwt = 1;", "add auth");
  const rowId = insertMemoryRow("jwt handling is in src/auth.ts");
  recordFileRefs(db, rowId, "jwt handling is in src/auth.ts", dir);

  // Edit without committing.
  writeFileSync(join(dir, "src/auth.ts"), "export const jwt = 3;", "utf8");

  const refs = findStaleFileRefs(db, [rowId], dir).get(rowId);
  assert.ok(refs);
  assert.equal(refs[0].changedInWorkingTree, true, "an uncommitted edit must be marked as such");
});

test("recordFileRefs replaces refs when a note is re-recorded", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  writeCommit("a.ts", "1", "add a");
  writeCommit("b.ts", "2", "add b");
  const rowId = insertMemoryRow("see a.ts");
  recordFileRefs(db, rowId, "see a.ts", dir);

  // Re-record with a different file; the old ref must not linger.
  recordFileRefs(db, rowId, "now see b.ts instead", dir);

  const rows = db
    .prepare("SELECT path FROM memory_file_refs WHERE memory_rowid = ? ORDER BY path")
    .all(rowId) as Array<{ path: string }>;
  assert.deepEqual(rows.map((r) => r.path), ["b.ts"]);
});

test("deleting a memory cascades to its file refs", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  writeCommit("src/auth.ts", "x", "add");
  const rowId = insertMemoryRow("auth in src/auth.ts");
  recordFileRefs(db, rowId, "auth in src/auth.ts", dir);

  db.prepare("DELETE FROM memories WHERE rowid = ?").run(rowId);

  const count = db
    .prepare("SELECT COUNT(*) AS c FROM memory_file_refs WHERE memory_rowid = ?")
    .get(rowId) as { c: number };
  assert.equal(count.c, 0, "the delete trigger must clean up file refs");
});
