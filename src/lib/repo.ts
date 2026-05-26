import type Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

export interface ResolvedRepo {
  canonical: string;
  cwd: string;
  gitRemote: string | null;
  source: "git-remote" | "folder" | "alias" | "input";
  aliases: string[];
}

interface AliasRow {
  alias: string;
  canonical: string;
}

const REMOTE_PATTERNS: Array<RegExp> = [
  // git@github.com:owner/repo.git, git@gitlab.com:group/sub/repo.git
  /^[^@\s]+@([^:]+):([^\s]+?)(?:\.git)?$/,
  // ssh://git@github.com/owner/repo.git
  /^ssh:\/\/[^@/]+@([^/]+)\/([^\s]+?)(?:\.git)?$/,
  // https://github.com/owner/repo.git, http://gitlab.com/group/sub/repo
  /^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^\s]+?)(?:\.git)?$/,
  // git://github.com/owner/repo.git
  /^git:\/\/([^/]+)\/([^\s]+?)(?:\.git)?$/,
];

/**
 * Normalize a git remote URL to "owner/repo" (or "group/sub/repo" for nested
 * GitLab paths). Returns null when the URL cannot be parsed.
 */
export function normalizeGitRemote(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (!match) {
      continue;
    }

    const path = match[2]
      ?.replace(/^\/+/, "")
      .replace(/\\/g, "/")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");

    if (!path) {
      continue;
    }

    return path;
  }

  return null;
}

function readGitRemote(cwd: string): string | null {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return null;
  }

  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function detectFolderName(cwd: string): string {
  const name = basename(cwd);
  return name.length > 0 ? name : cwd;
}

function fetchAliases(db: Database.Database, canonical: string): string[] {
  const rows = db
    .prepare("SELECT alias FROM repo_aliases WHERE canonical = ? ORDER BY alias")
    .all(canonical) as Array<{ alias: string }>;

  return rows.map((row) => row.alias);
}

/**
 * Insert an alias → canonical row when we have not seen it before.
 * Self-aliases (alias === canonical) are stored too so resolution is a single
 * indexed lookup regardless of which key the caller passes in.
 */
export function upsertAlias(
  db: Database.Database,
  alias: string,
  canonical: string,
): void {
  const trimmed = alias.trim();
  const target = canonical.trim();
  if (!trimmed || !target) {
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `
      INSERT INTO repo_aliases (alias, canonical, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical
    `,
  ).run(trimmed, target, now);
}

function lookupAlias(db: Database.Database, alias: string): AliasRow | null {
  const row = db
    .prepare("SELECT alias, canonical FROM repo_aliases WHERE alias = ?")
    .get(alias) as AliasRow | undefined;

  return row ?? null;
}

/**
 * Resolve the canonical repo key for a working directory.
 * Order of precedence:
 *   1. git remote → owner/repo (if mappable)
 *   2. folder basename
 *
 * The result is recorded as an alias entry so future lookups by either form
 * (folder name or owner/repo) collapse to the same canonical key.
 */
export function resolveRepo(cwd: string, db: Database.Database): ResolvedRepo {
  const gitRemote = readGitRemote(cwd);
  const fromRemote = gitRemote ? normalizeGitRemote(gitRemote) : null;
  const folder = detectFolderName(cwd);

  let canonical: string;
  let source: ResolvedRepo["source"];

  if (fromRemote) {
    canonical = fromRemote;
    source = "git-remote";
  } else {
    canonical = folder;
    source = "folder";
  }

  // Persist self-alias and folder-name alias so subsequent lookups by either
  // form resolve to the same canonical id without re-shelling to git.
  upsertAlias(db, canonical, canonical);
  if (folder && folder !== canonical) {
    const existing = lookupAlias(db, folder);
    // Avoid clobbering a folder alias that was already mapped elsewhere by the
    // user (defensive — same folder name across different canonicals is rare
    // but possible when working in monorepos).
    if (!existing) {
      upsertAlias(db, folder, canonical);
    }
  }

  return {
    canonical,
    cwd,
    gitRemote,
    source,
    aliases: fetchAliases(db, canonical),
  };
}

/**
 * Resolve a caller-supplied repo string to its canonical form. When the input
 * is empty or unknown, fall back to the workspace-derived canonical key.
 *
 * The first time we see an input string that does not yet have an alias entry,
 * we record it pointing to the resolved canonical so future lookups are O(1).
 */
export function resolveRepoArg(
  input: string | undefined,
  cwd: string,
  db: Database.Database,
): ResolvedRepo {
  const trimmed = input?.trim();

  if (!trimmed) {
    return resolveRepo(cwd, db);
  }

  const aliasRow = lookupAlias(db, trimmed);
  if (aliasRow) {
    return {
      canonical: aliasRow.canonical,
      cwd,
      gitRemote: null,
      source: "alias",
      aliases: fetchAliases(db, aliasRow.canonical),
    };
  }

  // No alias yet. If we can derive a canonical from the workspace, treat the
  // input as an alias of that canonical so memories stored under the input
  // key remain reachable from the workspace key.
  const workspace = resolveRepo(cwd, db);
  if (workspace.canonical && workspace.canonical !== trimmed) {
    // Only auto-link when the input clearly refers to the same repo: either
    // the canonical contains the input as its tail segment (e.g. "my-repo"
    // alias for "owner/my-repo") or vice versa.
    const tail = workspace.canonical.split("/").at(-1) ?? workspace.canonical;
    const inputTail = trimmed.split("/").at(-1) ?? trimmed;
    if (tail === inputTail || tail === trimmed || inputTail === workspace.canonical) {
      upsertAlias(db, trimmed, workspace.canonical);
      return {
        ...workspace,
        source: "alias",
        aliases: fetchAliases(db, workspace.canonical),
      };
    }
  }

  // Treat the input as its own canonical and record a self-alias.
  upsertAlias(db, trimmed, trimmed);
  return {
    canonical: trimmed,
    cwd,
    gitRemote: null,
    source: "input",
    aliases: fetchAliases(db, trimmed),
  };
}

/**
 * Re-point every alias currently mapping to `from` so it now resolves to `to`,
 * and migrate every memory row stored under `from` (or any of its aliases) to
 * `to`. Used by `fossel init` when it discovers that the canonical repo key
 * has shifted (e.g. user moved from a folder-name key to "owner/repo").
 */
export function mergeRepoKeys(
  db: Database.Database,
  from: string,
  to: string,
): { movedAliases: number; movedMemories: number } {
  if (from === to) {
    return { movedAliases: 0, movedMemories: 0 };
  }

  const tx = db.transaction(() => {
    const aliasResult = db
      .prepare("UPDATE repo_aliases SET canonical = ? WHERE canonical = ?")
      .run(to, from);

    const aliasesToReassign = db
      .prepare("SELECT alias FROM repo_aliases WHERE canonical = ?")
      .all(to) as Array<{ alias: string }>;

    let movedMemories = 0;
    const updateMemories = db.prepare(
      "UPDATE memories SET repo = ? WHERE repo = ?",
    );
    for (const { alias } of aliasesToReassign) {
      if (alias === to) {
        continue;
      }
      const result = updateMemories.run(to, alias);
      movedMemories += result.changes;
    }
    // Catch any memories still stored directly under `from`.
    movedMemories += updateMemories.run(to, from).changes;

    upsertAlias(db, from, to);
    upsertAlias(db, to, to);

    return {
      movedAliases: aliasResult.changes,
      movedMemories,
    };
  });

  return tx();
}
