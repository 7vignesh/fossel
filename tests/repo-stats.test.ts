import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { gatherStatsLines } from "../src/cli.js";
import { closeDb, getDb } from "../src/db/client.js";
import { recordFileRefs } from "../src/lib/file-refs.js";
import { resolveRepo } from "../src/lib/repo.js";
import { gatherRepoStats } from "../src/lib/stats.js";
import { createTestDb, insertMemory } from "./helpers.js";

const REPO = "acme/app";

const GIT_AVAILABLE = (() => {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();

test("gatherRepoStats counts live memories by type and pinned", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, REPO, "a", { type: "convention", pinned: true });
    insertMemory(ctx.db, REPO, "b", { type: "convention" });
    insertMemory(ctx.db, REPO, "c", { type: "bug_fix" });
    const gone = insertMemory(ctx.db, REPO, "d", { type: "decision", pinned: true });
    ctx.db.prepare("UPDATE memories SET valid_to = 1 WHERE rowid = ?").run(gone);
    insertMemory(ctx.db, "other/repo", "e", { type: "issue" });

    const stats = gatherRepoStats(ctx.db, REPO, ctx.dir);
    assert.equal(stats.byType.convention, 2);
    assert.equal(stats.byType.bug_fix, 1);
    assert.equal(stats.byType.decision, 0, "superseded memories are not counted");
    assert.equal(stats.byType.issue, 0, "other repos are not counted");
    assert.equal(stats.pinned, 1, "a superseded pinned memory is not counted");
  } finally {
    ctx.cleanup();
  }
});

test("gatherRepoStats ranks top tags and entities by frequency", () => {
  const ctx = createTestDb();
  try {
    const a = insertMemory(ctx.db, REPO, "a", { tags: ["auth", "jwt"] });
    const b = insertMemory(ctx.db, REPO, "b", { tags: ["auth"] });
    insertMemory(ctx.db, REPO, "c", { tags: ["ci"] });
    const addEntity = ctx.db.prepare(
      "INSERT INTO memory_entities (memory_rowid, entity, kind) VALUES (?, ?, ?)",
    );
    addEntity.run(a, "src/auth.ts", "file");
    addEntity.run(b, "src/auth.ts", "file");
    addEntity.run(b, "express", "package");

    const stats = gatherRepoStats(ctx.db, REPO, ctx.dir, 2);
    assert.deepEqual(stats.topTags, [
      { tag: "auth", count: 2 },
      { tag: "ci", count: 1 },
    ]);
    assert.deepEqual(stats.topEntities, [
      { entity: "src/auth.ts", kind: "file", count: 2 },
      { entity: "express", kind: "package", count: 1 },
    ]);
  } finally {
    ctx.cleanup();
  }
});

test("gatherRepoStats returns null top entities when the table is absent", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, REPO, "a");
    ctx.db.exec("DROP TABLE memory_entities");
    assert.equal(gatherRepoStats(ctx.db, REPO, ctx.dir).topEntities, null);
  } finally {
    ctx.cleanup();
  }
});

test("gatherRepoStats counts memories whose referenced file drifted", { skip: !GIT_AVAILABLE }, () => {
  const ctx = createTestDb();
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: ctx.dir, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "T"]);
    git(["config", "commit.gpgsign", "false"]);
    mkdirSync(join(ctx.dir, "src"), { recursive: true });
    writeFileSync(join(ctx.dir, "src", "auth.ts"), "v1\n");
    writeFileSync(join(ctx.dir, "src", "db.ts"), "v1\n");
    git(["add", "src"]);
    git(["commit", "-q", "-m", "init"]);

    const auth = insertMemory(ctx.db, REPO, "auth lives in src/auth.ts");
    const dbNote = insertMemory(ctx.db, REPO, "queries go through src/db.ts");
    recordFileRefs(ctx.db, auth, "auth lives in src/auth.ts", ctx.dir);
    recordFileRefs(ctx.db, dbNote, "queries go through src/db.ts", ctx.dir);
    assert.equal(gatherRepoStats(ctx.db, REPO, ctx.dir).drifted, 0);

    writeFileSync(join(ctx.dir, "src", "auth.ts"), "v2\n");
    git(["commit", "-q", "-am", "change auth"]);
    assert.equal(gatherRepoStats(ctx.db, REPO, ctx.dir).drifted, 1);
  } finally {
    ctx.cleanup();
  }
});

// --- gatherStatsLines: the `fossel stats` output, fresh and populated db ---

let dir: string;
let prevDbPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fossel-stats-cli-"));
  prevDbPath = process.env.FOSSEL_DB_PATH;
  process.env.FOSSEL_DB_PATH = join(dir, "memory.db");
});

afterEach(() => {
  closeDb();
  if (prevDbPath === undefined) {
    delete process.env.FOSSEL_DB_PATH;
  } else {
    process.env.FOSSEL_DB_PATH = prevDbPath;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("fossel stats runs against a fresh db", () => {
  const out = gatherStatsLines(dir).join("\n");
  assert.match(out, /Memories: 0 live, 0 superseded, 0 pinned/);
  assert.match(out, /Code drift .*: 0/);
  assert.doesNotMatch(out, /By type:/, "no type line when there are no memories");
  assert.doesNotMatch(out, /Top tags:/);
});

test("fossel stats reports a populated db", () => {
  // Seed rows under the same repo key the command resolves for this cwd.
  gatherStatsLines(dir);
  const db = getDb();
  const repo = resolveRepo(dir, db).canonical;
  insertMemory(db, repo, "Use pnpm.", { type: "convention", tags: ["deps"], pinned: true });
  insertMemory(db, repo, "Fixed the race.", { type: "bug_fix", tags: ["deps", "ws"] });

  const out = gatherStatsLines(dir).join("\n");
  assert.ok(out.includes(`Repo: ${repo}`));
  assert.match(out, /Memories: 2 live, 0 superseded, 1 pinned/);
  assert.match(out, /By type: convention 1, bug_fix 1/);
  assert.match(out, /Top tags: deps \(2\), ws \(1\)/);
  assert.match(out, /DB: .*memory\.db \(\d+(\.\d)? (B|KB|MB)\)/);
});
