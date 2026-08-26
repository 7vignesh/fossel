import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  exportMemories,
  importMemories,
  type ExportEnvelope,
} from "../src/lib/portability.js";
import { createTestDb, insertMemory, type TestDb } from "./helpers.js";

const REPO = "acme/app";

let ctx: TestDb;

beforeEach(() => {
  ctx = createTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

// --- export ---

test("exportMemories returns the correct envelope shape", () => {
  insertMemory(ctx.db, REPO, "Use pnpm for all installs.", {
    type: "convention",
    tags: ["pnpm"],
  });

  const envelope = exportMemories(ctx.db);
  assert.equal(envelope.format, EXPORT_FORMAT);
  assert.equal(envelope.version, EXPORT_VERSION);
  assert.ok(envelope.exported_at);
  assert.equal(envelope.memories.length, 1);
  assert.equal(envelope.memories[0].repo, REPO);
  assert.equal(envelope.memories[0].note, "Use pnpm for all installs.");
  assert.deepEqual(envelope.memories[0].tags, ["pnpm"]);
});

test("exportMemories scoped to a repo excludes other repos", () => {
  insertMemory(ctx.db, REPO, "fact A");
  insertMemory(ctx.db, "other/repo", "fact B");

  const envelope = exportMemories(ctx.db, REPO);
  assert.equal(envelope.memories.length, 1);
  assert.equal(envelope.memories[0].note, "fact A");
});

test("exportMemories includes superseded memories", () => {
  const id = insertMemory(ctx.db, REPO, "old fact");
  // Tombstone it
  const now = Math.floor(Date.now() / 1000);
  ctx.db
    .prepare("UPDATE memories SET valid_to = ? WHERE rowid = ?")
    .run(now, id);

  insertMemory(ctx.db, REPO, "new fact");

  const envelope = exportMemories(ctx.db);
  assert.equal(envelope.memories.length, 2);
  const old = envelope.memories.find((m) => m.note === "old fact");
  assert.ok(old);
  assert.equal(old!.valid_to, now);
});

test("exportMemories includes repo aliases", () => {
  const now = Math.floor(Date.now() / 1000);
  ctx.db
    .prepare("INSERT INTO repo_aliases (alias, canonical, created_at) VALUES (?, ?, ?)")
    .run("app", REPO, now);

  const envelope = exportMemories(ctx.db);
  assert.equal(envelope.aliases.length, 1);
  assert.equal(envelope.aliases[0].alias, "app");
  assert.equal(envelope.aliases[0].canonical, REPO);
});

test("exportMemories with no data returns empty arrays", () => {
  const envelope = exportMemories(ctx.db);
  assert.equal(envelope.memories.length, 0);
  assert.equal(envelope.aliases.length, 0);
});

// --- import ---

test("importMemories inserts new memories", () => {
  const envelope = makeEnvelope([
    makeExportedMemory("id-1", REPO, "imported fact", ["tag1"]),
  ]);

  const result = importMemories(ctx.db, envelope, ctx.dir);
  assert.equal(result.memoriesImported, 1);
  assert.equal(result.memoriesSkipped, 0);

  const row = ctx.db
    .prepare("SELECT note, repo FROM memories WHERE id = ?")
    .get("id-1") as { note: string; repo: string };
  assert.equal(row.note, "imported fact");
  assert.equal(row.repo, REPO);
});

test("importMemories is idempotent - re-import skips existing", () => {
  const envelope = makeEnvelope([
    makeExportedMemory("id-1", REPO, "fact"),
  ]);

  importMemories(ctx.db, envelope, ctx.dir);
  const result = importMemories(ctx.db, envelope, ctx.dir);
  assert.equal(result.memoriesImported, 0);
  assert.equal(result.memoriesSkipped, 1);

  const count = (
    ctx.db.prepare("SELECT count(*) AS n FROM memories").get() as { n: number }
  ).n;
  assert.equal(count, 1);
});

test("importMemories does not clobber an existing memory with the same id", () => {
  const envelope = makeEnvelope([
    makeExportedMemory("id-1", REPO, "original note"),
  ]);
  importMemories(ctx.db, envelope, ctx.dir);

  // Try importing the same id with different content
  const envelope2 = makeEnvelope([
    makeExportedMemory("id-1", REPO, "modified note"),
  ]);
  importMemories(ctx.db, envelope2, ctx.dir);

  const row = ctx.db
    .prepare("SELECT note FROM memories WHERE id = ?")
    .get("id-1") as { note: string };
  assert.equal(row.note, "original note");
});

test("importMemories imports aliases", () => {
  const now = Math.floor(Date.now() / 1000);
  const envelope: ExportEnvelope = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    memories: [],
    aliases: [{ alias: "shortname", canonical: REPO, created_at: now }],
  };

  const result = importMemories(ctx.db, envelope, ctx.dir);
  assert.equal(result.aliasesImported, 1);
  assert.equal(result.aliasesSkipped, 0);

  const alias = ctx.db
    .prepare("SELECT canonical FROM repo_aliases WHERE alias = ?")
    .get("shortname") as { canonical: string };
  assert.equal(alias.canonical, REPO);
});

test("importMemories rejects invalid format", () => {
  const bad = {
    format: "wrong-format",
    version: 1,
    exported_at: new Date().toISOString(),
    memories: [],
    aliases: [],
  } as unknown as ExportEnvelope;

  assert.throws(
    () => importMemories(ctx.db, bad, ctx.dir),
    /Unsupported format/,
  );
});

test("importMemories rejects future version", () => {
  const bad = {
    format: EXPORT_FORMAT,
    version: 999,
    exported_at: new Date().toISOString(),
    memories: [],
    aliases: [],
  } as unknown as ExportEnvelope;

  assert.throws(
    () => importMemories(ctx.db, bad, ctx.dir),
    /Unsupported version/,
  );
});

test("importMemories preserves valid_to for superseded memories", () => {
  const now = Math.floor(Date.now() / 1000);
  const envelope = makeEnvelope([
    makeExportedMemory("id-old", REPO, "superseded fact", [], now),
  ]);

  importMemories(ctx.db, envelope, ctx.dir);

  const row = ctx.db
    .prepare("SELECT valid_to FROM memories WHERE id = ?")
    .get("id-old") as { valid_to: number | null };
  assert.equal(row.valid_to, now);
});

test("round-trip: export then import into a fresh db preserves all data", () => {
  insertMemory(ctx.db, REPO, "fact one", { type: "convention", tags: ["a"] });
  insertMemory(ctx.db, REPO, "fact two", { type: "bug_fix", tags: ["b", "c"] });

  const now = Math.floor(Date.now() / 1000);
  ctx.db
    .prepare("INSERT INTO repo_aliases (alias, canonical, created_at) VALUES (?, ?, ?)")
    .run("myapp", REPO, now);

  const envelope = exportMemories(ctx.db);

  // Import into a fresh database
  const fresh = createTestDb();
  try {
    const result = importMemories(fresh.db, envelope, fresh.dir);
    assert.equal(result.memoriesImported, 2);
    assert.equal(result.aliasesImported, 1);

    const memories = fresh.db
      .prepare("SELECT note FROM memories ORDER BY note")
      .all() as Array<{ note: string }>;
    assert.equal(memories.length, 2);
    assert.equal(memories[0].note, "fact one");
    assert.equal(memories[1].note, "fact two");
  } finally {
    fresh.cleanup();
  }
});

// --- helpers ---

function makeExportedMemory(
  id: string,
  repo: string,
  note: string,
  tags: string[] = [],
  validTo: number | null = null,
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    repo,
    type: "general",
    note,
    tags,
    created_at: now,
    updated_at: now,
    pinned: 0,
    metadata_json: "{}",
    valid_from: now,
    valid_to: validTo,
  };
}

function makeEnvelope(
  memories: ReturnType<typeof makeExportedMemory>[],
): ExportEnvelope {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    memories,
    aliases: [],
  };
}
