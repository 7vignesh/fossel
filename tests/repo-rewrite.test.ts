import test from "node:test";
import assert from "node:assert/strict";
import {
  findMemoriesMentioningAlias,
  mergeRepoKeys,
} from "../src/lib/repo.js";
import { createTestDb, insertMemory } from "./helpers.js";

test("mergeRepoKeys rewrites note text mentioning the deprecated alias", () => {
  const ctx = createTestDb();
  try {
    insertMemory(
      ctx.db,
      "studentmanager",
      "Use repo key studentmanager when storing context here.",
    );
    insertMemory(ctx.db, "studentmanager", "Unrelated note about routes.");

    const result = mergeRepoKeys(
      ctx.db,
      "studentmanager",
      "7vignesh/student-manager",
    );

    assert.equal(result.movedMemories, 2);
    assert.equal(result.rewrittenNotes, 1);

    const rows = ctx.db
      .prepare("SELECT note FROM memories ORDER BY rowid")
      .all() as Array<{ note: string }>;
    assert.match(rows[0]?.note ?? "", /7vignesh\/student-manager/);
    assert.doesNotMatch(rows[0]?.note ?? "", /\bstudentmanager\b/);
  } finally {
    ctx.cleanup();
  }
});

test("mergeRepoKeys leaves substring matches alone", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "fossel", "fossel-cli is the binary name.");

    const result = mergeRepoKeys(ctx.db, "fossel", "7vignesh/fossel");
    // The substring "fossel" inside "fossel-cli" should not be rewritten;
    // only standalone tokens get replaced.
    assert.equal(result.rewrittenNotes, 0);

    const note = ctx.db
      .prepare("SELECT note FROM memories WHERE rowid = 1")
      .get() as { note: string };
    assert.equal(note.note, "fossel-cli is the binary name.");
  } finally {
    ctx.cleanup();
  }
});

test("findMemoriesMentioningAlias surfaces stale guidance", () => {
  const ctx = createTestDb();
  try {
    insertMemory(ctx.db, "owner/repo", "When in doubt, use studentmanager key.");
    insertMemory(ctx.db, "owner/repo", "Otherwise call get_context.");

    const stale = findMemoriesMentioningAlias(
      ctx.db,
      "studentmanager",
      "owner/repo",
    );

    assert.equal(stale.length, 1);
    assert.match(stale[0]?.note ?? "", /studentmanager/);
  } finally {
    ctx.cleanup();
  }
});
