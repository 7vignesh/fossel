/**
 * Git introspection helpers.
 *
 * These let Fossel tie a memory to the state of the code it describes: record
 * the blob sha of a file when a memory about it is written, then notice later
 * that the file has changed. This is the temporal-grounding idea (already
 * shipped for relative dates) applied to code.
 *
 * **Everything here fails safe.** Fossel runs in workspaces that are not git
 * repos, on machines where git is not installed, and against paths that do not
 * exist at HEAD. None of that is exceptional, so none of it throws — every
 * function returns null or an empty result and the caller carries on. A
 * non-git workspace simply records no file references and produces no staleness
 * advisories, exactly as if the feature were off.
 *
 * All git calls use `spawnSync` with a short timeout, mirroring `repo.ts`, so a
 * hung git process cannot stall an MCP request.
 */

import { spawnSync } from "node:child_process";

const GIT_TIMEOUT_MS = 3000;

interface GitResult {
  ok: boolean;
  stdout: string;
}

/** Run a git command in `cwd`, swallowing every failure mode into ok:false. */
function git(cwd: string, args: string[]): GitResult {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      // Silence git's stderr; we only care about status + stdout.
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || typeof result.stdout !== "string") {
      return { ok: false, stdout: "" };
    }
    return { ok: true, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * True when `cwd` is inside a git working tree. Cheap gate so callers can skip
 * the rest of the git work in a non-git workspace.
 */
export function isGitRepo(cwd: string): boolean {
  const result = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

/** Current HEAD commit sha, or null when there is no HEAD (empty repo, not a
 * repo, git absent). */
export function headSha(cwd: string): string | null {
  const result = git(cwd, ["rev-parse", "HEAD"]);
  if (!result.ok) {
    return null;
  }
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Blob sha of `path` at HEAD — the content hash of the committed file, which
 * changes exactly when the file's committed content changes. Returns null when
 * the path is untracked, absent at HEAD, or git is unavailable.
 *
 * `path` is repo-relative and forward-slashed; `git rev-parse HEAD:<path>`
 * expects that form on every platform, so callers must not pass a Windows
 * backslash path.
 */
export function fileBlobSha(cwd: string, path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!normalized) {
    return null;
  }
  const result = git(cwd, ["rev-parse", `HEAD:${normalized}`]);
  if (!result.ok) {
    return null;
  }
  const sha = result.stdout.trim();
  // rev-parse echoes the input back on failure in some git versions; a real
  // blob sha is 40 hex chars (or 64 under sha256 repos).
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * Files that differ from HEAD — staged, unstaged, or untracked — as
 * repo-relative forward-slashed paths. Empty when the tree is clean, not a repo,
 * or git is unavailable.
 *
 * Uses `git status --porcelain`, whose first two columns are the status code and
 * whose remainder is the path. Renames (`R  old -> new`) are reduced to the new
 * path. Quoted paths (those with unusual characters) are left as git emits them
 * rather than half-unquoted, since they are rare and only used for membership
 * checks.
 */
export function changedFiles(cwd: string): Set<string> {
  const result = git(cwd, ["status", "--porcelain"]);
  const changed = new Set<string>();
  if (!result.ok) {
    return changed;
  }
  for (const line of result.stdout.split("\n")) {
    if (line.length < 4) {
      continue;
    }
    // Columns 0-1 are the status, column 2 is a space, the path starts at 3.
    let path = line.slice(3).trim();
    const renameArrow = path.indexOf(" -> ");
    if (renameArrow !== -1) {
      path = path.slice(renameArrow + 4);
    }
    // Strip surrounding quotes git adds for paths with special characters.
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1);
    }
    if (path) {
      changed.add(path.replace(/\\/g, "/"));
    }
  }
  return changed;
}
