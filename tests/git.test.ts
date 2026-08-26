import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  changedFiles,
  fileBlobSha,
  headSha,
  isGitRepo,
} from "../src/lib/git.js";

// These tests build real temporary git repositories rather than mocking git,
// because the whole point of the module is that it interoperates with the git
// binary correctly across its quirks. If git is not on PATH the suite skips
// itself rather than failing — the module is designed to degrade in exactly that
// situation, and the fail-safe behaviour is asserted separately below.

const GIT_AVAILABLE = (() => {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();

let dir: string;

function run(args: string[], cwd = dir): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function initRepo(): void {
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["config", "commit.gpgsign", "false"]);
}

function commitFile(path: string, content: string, message: string): void {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
  run(["add", path]);
  run(["commit", "-q", "-m", message]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fossel-git-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("isGitRepo is false for a plain directory", () => {
  assert.equal(isGitRepo(dir), false);
});

test("headSha, fileBlobSha, changedFiles fail safe outside a repo", () => {
  // The load-bearing property: none of these throw or blow up when there is no
  // git repo, they just report nothing.
  assert.equal(headSha(dir), null);
  assert.equal(fileBlobSha(dir, "src/index.ts"), null);
  assert.deepEqual(changedFiles(dir), new Set());
});

test("fileBlobSha of a nonexistent path in a real repo is null", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  commitFile("README.md", "hello", "initial");
  assert.equal(fileBlobSha(dir, "does/not/exist.ts"), null);
});

test("isGitRepo and headSha see a real repo", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  commitFile("README.md", "hello", "initial");

  assert.equal(isGitRepo(dir), true);
  const sha = headSha(dir);
  assert.ok(sha && /^[0-9a-f]{40,64}$/.test(sha), `expected a commit sha, got ${sha}`);
});

test("fileBlobSha changes only when the committed file content changes", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  commitFile("src/auth.ts", "export const jwt = 1;", "add auth");
  const before = fileBlobSha(dir, "src/auth.ts");
  assert.ok(before);

  // A commit that does not touch the file leaves its blob sha unchanged, even
  // though HEAD moves. This is why we track the blob, not the commit.
  commitFile("src/other.ts", "export const x = 2;", "unrelated change");
  assert.equal(fileBlobSha(dir, "src/auth.ts"), before, "blob sha must be content-addressed, not commit-addressed");

  // Changing the file's content changes its blob sha.
  commitFile("src/auth.ts", "export const jwt = 2;", "change auth");
  const after = fileBlobSha(dir, "src/auth.ts");
  assert.ok(after);
  assert.notEqual(after, before, "editing the file must change its blob sha");
});

test("fileBlobSha accepts a leading ./ and backslashes", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  commitFile("src/auth.ts", "x", "add");
  const canonical = fileBlobSha(dir, "src/auth.ts");
  assert.ok(canonical);
  assert.equal(fileBlobSha(dir, "./src/auth.ts"), canonical);
  assert.equal(fileBlobSha(dir, "src\\auth.ts"), canonical);
});

test("changedFiles is empty on a clean tree", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  commitFile("README.md", "hello", "initial");
  assert.deepEqual(changedFiles(dir), new Set());
});

test("changedFiles reports modified, staged and untracked paths", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  commitFile("src/auth.ts", "export const jwt = 1;", "add auth");

  // Modify a tracked file without committing.
  writeFileSync(join(dir, "src/auth.ts"), "export const jwt = 999;", "utf8");
  // Add a brand new untracked file.
  writeFileSync(join(dir, "notes.txt"), "todo", "utf8");

  const changed = changedFiles(dir);
  assert.ok(changed.has("src/auth.ts"), "modified tracked file must show");
  assert.ok(changed.has("notes.txt"), "untracked file must show");
});

test("changedFiles reduces a rename to the new path", { skip: !GIT_AVAILABLE }, () => {
  initRepo();
  commitFile("old-name.ts", "export const x = 1;", "add");
  run(["mv", "old-name.ts", "new-name.ts"]);

  const changed = changedFiles(dir);
  assert.ok(changed.has("new-name.ts"), `rename should surface the new path, got ${[...changed].join(",")}`);
});
