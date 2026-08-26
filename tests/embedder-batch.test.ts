import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDING_DIM,
  embedBatchExternal,
  embedTextExternal,
} from "../src/lib/embeddings.js";
import { backfillRepoEmbeddings } from "../src/lib/vector-index.js";
import { createTestDb, insertMemory, type TestDb } from "./helpers.js";

const REPO = "acme/storefront";

let ctx: TestDb;
let dir: string;
let counterPath: string;
const originalCmd = process.env.FOSSEL_EMBEDDER_CMD;

/**
 * A batch-capable stub embedder: reads JSONL strings on stdin and writes one
 * JSON vector per line. Also appends a byte to a counter file on every
 * invocation, so tests can assert how many times the process was spawned — which
 * is the whole point of the batch protocol.
 */
function batchEmbedderScript(counter: string): string {
  return `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(counter)}, "x");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const lines = raw.split("\\n").map((l) => l.trim()).filter(Boolean);
  const out = lines.map((line) => {
    const text = JSON.parse(line);
    const v = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < text.length; i++) v[i % 8] += (text.charCodeAt(i) % 7) + 1;
    return JSON.stringify(v);
  });
  process.stdout.write(out.join("\\n") + "\\n");
});
`;
}

/** A legacy single-text embedder: reads all of stdin as one text, prints one
 * vector. Must keep working, and must not silently misalign a batch. */
function legacyEmbedderScript(counter: string): string {
  return `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(counter)}, "x");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const v = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < raw.length; i++) v[i % 8] += (raw.charCodeAt(i) % 7) + 1;
  process.stdout.write(JSON.stringify(v));
});
`;
}

function useEmbedder(name: string, source: string): void {
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, source, "utf8");
  process.env.FOSSEL_EMBEDDER_CMD = `node "${scriptPath}"`;
}

function spawnCount(): number {
  if (!existsSync(counterPath)) {
    return 0;
  }
  return readFileSync(counterPath, "utf8").length;
}

beforeEach(() => {
  ctx = createTestDb();
  dir = mkdtempSync(join(tmpdir(), "fossel-embedder-"));
  counterPath = join(dir, "spawns.txt");
  writeFileSync(counterPath, "", "utf8");
  process.env.FOSSEL_EMBEDDINGS = "1";
  delete process.env.FOSSEL_EMBEDDER_CMD;
});

afterEach(() => {
  delete process.env.FOSSEL_EMBEDDINGS;
  if (originalCmd === undefined) {
    delete process.env.FOSSEL_EMBEDDER_CMD;
  } else {
    process.env.FOSSEL_EMBEDDER_CMD = originalCmd;
  }
  ctx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

test("embedBatchExternal returns one vector per input, in order", () => {
  useEmbedder("batch.js", batchEmbedderScript(counterPath));
  const vectors = embedBatchExternal(["alpha", "beta gamma", "delta"]);

  assert.ok(vectors);
  assert.equal(vectors.length, 3);
  for (const vector of vectors) {
    assert.equal(vector.length, 8);
  }
  // Distinct inputs must produce distinct vectors, proving alignment rather than
  // the same vector repeated.
  assert.notDeepEqual(Array.from(vectors[0]), Array.from(vectors[1]));
});

test("embedBatchExternal output is L2-normalized", () => {
  useEmbedder("batch.js", batchEmbedderScript(counterPath));
  const vectors = embedBatchExternal(["one text", "another text"]);
  assert.ok(vectors);
  for (const vector of vectors) {
    let norm = 0;
    for (const value of vector) norm += value * value;
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-6);
  }
});

test("embedBatchExternal uses a single process spawn for many texts", () => {
  useEmbedder("batch.js", batchEmbedderScript(counterPath));
  const texts = Array.from({ length: 12 }, (_, i) => `memory number ${i}`);

  const vectors = embedBatchExternal(texts);
  assert.ok(vectors);
  assert.equal(vectors.length, 12);
  assert.equal(
    spawnCount(),
    1,
    "twelve texts must cost exactly one spawn, not twelve",
  );
});

test("embedBatchExternal rejects a legacy embedder rather than misaligning", () => {
  // A single-text embedder handed a batch returns one vector for N inputs. That
  // must be detected, not stored against the wrong rows.
  useEmbedder("legacy.js", legacyEmbedderScript(counterPath));
  const vectors = embedBatchExternal(["alpha", "beta", "gamma"]);
  assert.equal(
    vectors,
    null,
    "a line-count mismatch must fail loudly so the caller falls back",
  );
});

test("a single text still uses the legacy protocol", () => {
  useEmbedder("legacy.js", legacyEmbedderScript(counterPath));
  const vectors = embedBatchExternal(["just one"]);
  assert.ok(vectors, "one text must work with a legacy embedder");
  assert.equal(vectors.length, 1);
  assert.equal(vectors[0].length, 8);
});

test("embedBatchExternal returns an empty array for no input without spawning", () => {
  useEmbedder("batch.js", batchEmbedderScript(counterPath));
  assert.deepEqual(embedBatchExternal([]), []);
  assert.equal(spawnCount(), 0);
});

test("embedBatchExternal returns null when the embedder fails", () => {
  process.env.FOSSEL_EMBEDDER_CMD = 'node -e "process.exit(1)"';
  assert.equal(embedBatchExternal(["a", "b"]), null);
});

test("embedBatchExternal rejects a batch with inconsistent dimensions", () => {
  // Vectors of differing length cannot be compared against each other, so the
  // whole batch must be refused rather than half-indexed.
  useEmbedder(
    "ragged.js",
    `
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  process.stdout.write("[1,2,3]\\n[1,2,3,4]\\n");
});
`,
  );
  assert.equal(embedBatchExternal(["a", "b"]), null);
});

test("backfillRepoEmbeddings batches instead of spawning per memory", () => {
  useEmbedder("batch.js", batchEmbedderScript(counterPath));
  for (let i = 0; i < 10; i += 1) {
    insertMemory(ctx.db, REPO, `convention number ${i} about builds and tests`);
  }

  const indexed = backfillRepoEmbeddings(ctx.db, REPO);
  assert.equal(indexed, 10);
  // One spawn for the batch, plus one for the one-time dimension probe that
  // activeEmbeddingMeta performs to learn the embedder's output size. The probe
  // is cached per command, so it does not recur.
  assert.ok(
    spawnCount() <= 2,
    `ten memories must cost at most two spawns, got ${spawnCount()}`,
  );

  const stored = ctx.db
    .prepare("SELECT COUNT(*) AS count FROM memory_embeddings")
    .get() as { count: number };
  assert.equal(stored.count, 10, "every memory must end up indexed");
});

test("backfill spawn count does not grow with the number of memories", () => {
  // The property that actually matters. Under the old one-spawn-per-text
  // protocol this ratio would be 3x; with batching it must be flat.
  useEmbedder("batch.js", batchEmbedderScript(counterPath));

  for (let i = 0; i < 10; i += 1) {
    insertMemory(ctx.db, REPO, `first wave memory ${i}`);
  }
  backfillRepoEmbeddings(ctx.db, REPO);
  const afterTen = spawnCount();

  for (let i = 0; i < 30; i += 1) {
    insertMemory(ctx.db, REPO, `second wave memory ${i}`);
  }
  backfillRepoEmbeddings(ctx.db, REPO);
  const afterForty = spawnCount();

  assert.equal(
    afterForty - afterTen,
    1,
    `indexing 30 more memories must cost exactly one further spawn, got ${afterForty - afterTen}`,
  );

  const stored = ctx.db
    .prepare("SELECT COUNT(*) AS count FROM memory_embeddings")
    .get() as { count: number };
  assert.equal(stored.count, 40);
});

test("backfill falls back to per-memory calls for a legacy embedder", () => {
  useEmbedder("legacy.js", legacyEmbedderScript(counterPath));
  for (let i = 0; i < 4; i += 1) {
    insertMemory(ctx.db, REPO, `legacy path memory ${i}`);
  }

  const indexed = backfillRepoEmbeddings(ctx.db, REPO);
  assert.equal(indexed, 4, "a legacy embedder must still index everything");

  const stored = ctx.db
    .prepare("SELECT COUNT(*) AS count FROM memory_embeddings")
    .get() as { count: number };
  assert.equal(stored.count, 4);
  // One rejected batch attempt plus one spawn per memory.
  assert.ok(spawnCount() >= 4, "fallback path embeds each memory individually");
});

test("backfill degrades to the built-in embedder when the command is broken", () => {
  process.env.FOSSEL_EMBEDDER_CMD = 'node -e "process.exit(1)"';
  insertMemory(ctx.db, REPO, "a note that must still be indexed");
  insertMemory(ctx.db, REPO, "and another one");

  assert.equal(backfillRepoEmbeddings(ctx.db, REPO), 2);
  const row = ctx.db
    .prepare("SELECT dim FROM memory_embeddings LIMIT 1")
    .get() as { dim: number };
  assert.equal(
    row.dim,
    EMBEDDING_DIM,
    "a broken embedder must fall back to the built-in one, never lose the write",
  );
});

test("embedTextExternal still honours the single-text contract", () => {
  useEmbedder("legacy.js", legacyEmbedderScript(counterPath));
  const vector = embedTextExternal("hello world");
  assert.ok(vector);
  assert.equal(vector.length, 8);
});
