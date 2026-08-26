/**
 * Git-aware file references for memories.
 *
 * When a memory mentions a source file, we record the file's blob sha at write
 * time; on retrieval we can then notice the file has changed and flag the memory
 * as possibly stale. This module owns both halves: extracting file paths from a
 * note, recording their shas on write, and detecting drift on read.
 *
 * Like `git.ts`, everything here fails safe. A non-git workspace, an untracked
 * path, or an absent git binary simply means no references are recorded and no
 * staleness is reported — identical to the feature being off.
 */

import type Database from "better-sqlite3";
import { changedFiles, fileBlobSha, isGitRepo } from "./git.js";

/**
 * Extract file-path-like tokens from free-form note text.
 *
 * Distinct from the tag extraction in `inference.ts`, which keeps only
 * basenames for search tags. Here we need the *full relative path* git can
 * resolve, so `src/auth/rbac.ts` stays whole rather than collapsing to `rbac`.
 *
 * Matches two shapes:
 *   - dotted filenames with a known code/config extension (`env.schema.ts`),
 *     optionally with leading directories (`src/auth/rbac.ts`);
 *   - rooted or nested paths ending in such a file.
 *
 * A leading `./` or `/` is stripped so the result is repo-relative, which is
 * what `git rev-parse HEAD:<path>` expects.
 */
const FILE_PATH_PATTERN =
  /(?:\.\/|\/)?(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|php|swift|scala|sql|sh|yml|yaml|toml|json|md|css|scss|html|vue|svelte)\b/gi;

export function extractFilePaths(note: string): string[] {
  const matches = note.match(FILE_PATH_PATTERN);
  if (!matches) {
    return [];
  }
  const seen = new Set<string>();
  for (const raw of matches) {
    const normalized = raw.replace(/\\/g, "/").replace(/^\.?\//, "");
    // Ignore anything that is purely an extension fragment or empty.
    if (normalized && normalized.includes(".")) {
      seen.add(normalized);
    }
  }
  return Array.from(seen);
}

/**
 * Record the blob sha of every file a memory mentions that exists at HEAD.
 * No-op — recording nothing — when the workspace is not a git repo, so callers
 * can invoke this unconditionally. Replaces any existing refs for the memory so
 * an edited note does not accumulate stale rows.
 */
export function recordFileRefs(
  db: Database.Database,
  memoryRowId: number,
  note: string,
  cwd: string,
): number {
  if (!isGitRepo(cwd)) {
    return 0;
  }

  const paths = extractFilePaths(note);
  if (paths.length === 0) {
    return 0;
  }

  const now = Math.floor(Date.now() / 1000);
  const del = db.prepare("DELETE FROM memory_file_refs WHERE memory_rowid = ?");
  const insert = db.prepare(
    `
      INSERT INTO memory_file_refs (memory_rowid, path, blob_sha, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(memory_rowid, path) DO UPDATE SET
        blob_sha = excluded.blob_sha,
        created_at = excluded.created_at
    `,
  );

  let recorded = 0;
  const tx = db.transaction(() => {
    del.run(memoryRowId);
    for (const path of paths) {
      const sha = fileBlobSha(cwd, path);
      // Only record paths that actually resolve at HEAD. A note mentioning a
      // file that isn't tracked (or a made-up path) records nothing for it, so
      // we never emit a staleness advisory for a file git doesn't know.
      if (sha) {
        insert.run(memoryRowId, path, sha, now);
        recorded += 1;
      }
    }
  });
  tx();
  return recorded;
}

export interface StaleFileRef {
  path: string;
  /** True when the file also differs from HEAD right now (uncommitted change),
   * i.e. it is in `git status`. Lets the advisory distinguish "changed in a past
   * commit" from "being edited right now". */
  changedInWorkingTree: boolean;
}

/**
 * For a set of memory rowids, return which referenced files have drifted — their
 * current blob sha differs from the one recorded when the memory was written.
 *
 * Returns an empty map when the workspace is not a git repo, so retrieval in a
 * non-git workspace produces no advisories. Batches the `changedFiles` lookup
 * once for the whole set rather than per memory.
 */
export function findStaleFileRefs(
  db: Database.Database,
  memoryRowIds: number[],
  cwd: string,
): Map<number, StaleFileRef[]> {
  const result = new Map<number, StaleFileRef[]>();
  if (memoryRowIds.length === 0 || !isGitRepo(cwd)) {
    return result;
  }

  const placeholders = memoryRowIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT memory_rowid, path, blob_sha
        FROM memory_file_refs
        WHERE memory_rowid IN (${placeholders})
      `,
    )
    .all(...memoryRowIds) as Array<{
    memory_rowid: number;
    path: string;
    blob_sha: string;
  }>;

  if (rows.length === 0) {
    return result;
  }

  const working = changedFiles(cwd);
  // Cache blob lookups: several memories may reference the same file.
  const currentSha = new Map<string, string | null>();

  for (const row of rows) {
    let current = currentSha.get(row.path);
    if (current === undefined) {
      current = fileBlobSha(cwd, row.path);
      currentSha.set(row.path, current);
    }

    // Drift = the committed content changed since the memory was written, or the
    // file is dirty in the working tree right now. A file deleted since (current
    // is null) also counts as drift.
    const committedChanged = current !== row.blob_sha;
    const dirty = working.has(row.path);
    if (!committedChanged && !dirty) {
      continue;
    }

    const list = result.get(row.memory_rowid) ?? [];
    list.push({ path: row.path, changedInWorkingTree: dirty });
    result.set(row.memory_rowid, list);
  }

  return result;
}
