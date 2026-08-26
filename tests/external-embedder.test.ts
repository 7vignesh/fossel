import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  activeEmbeddingMeta,
  EMBEDDING_DIM,
  EMBEDDING_VERSION,
  EXTERNAL_EMBEDDING_VERSION,
  embedText,
  externalEmbedderConfigured,
  externalEmbeddingVersion,
} from "../src/lib/embeddings.js";

const originalCmd = process.env.FOSSEL_EMBEDDER_CMD;

// A trivial deterministic "embedder": reads text on stdin and prints a JSON
// 8-dim vector derived from char codes. Lets us exercise the external path
// without a real model. Module-cached state in embeddings.ts (cachedExternalDim)
// means the dim is probed once per process; these tests assert behavior that
// holds regardless of that cache.
const FAKE_EMBEDDER =
  `node -e "let d='';process.stdin.on('data',c=>d+=c);` +
  `process.stdin.on('end',()=>{const v=[0,0,0,0,0,0,0,0];` +
  `for(let i=0;i<d.length;i++){v[i%8]+=d.charCodeAt(i)%7;}` +
  `process.stdout.write(JSON.stringify(v));});"`;

beforeEach(() => {
  delete process.env.FOSSEL_EMBEDDER_CMD;
});

afterEach(() => {
  if (originalCmd === undefined) {
    delete process.env.FOSSEL_EMBEDDER_CMD;
  } else {
    process.env.FOSSEL_EMBEDDER_CMD = originalCmd;
  }
});

test("externalEmbedderConfigured reflects the env var", () => {
  assert.equal(externalEmbedderConfigured(), false);
  process.env.FOSSEL_EMBEDDER_CMD = "some-cmd";
  assert.equal(externalEmbedderConfigured(), true);
});

test("activeEmbeddingMeta returns built-in meta when no external embedder", () => {
  const meta = activeEmbeddingMeta();
  assert.equal(meta.dim, EMBEDDING_DIM);
  assert.equal(meta.version, EMBEDDING_VERSION);
});

test("embedText uses the built-in embedder by default (256-dim)", () => {
  const v = embedText("authentication uses jwt tokens");
  assert.equal(v.length, EMBEDDING_DIM);
});

test("embedText falls back to built-in when external embedder fails", () => {
  // A command that exits non-zero / prints nothing useful must not break writes.
  process.env.FOSSEL_EMBEDDER_CMD = "node -e \"process.exit(1)\"";
  const v = embedText("some note");
  // Falls back to the 256-dim hashed embedder.
  assert.equal(v.length, EMBEDDING_DIM);
});

test("embedText falls back when external embedder returns invalid JSON", () => {
  process.env.FOSSEL_EMBEDDER_CMD = "node -e \"process.stdout.write('not json')\"";
  const v = embedText("another note");
  assert.equal(v.length, EMBEDDING_DIM);
});

test("external embedder output is L2-normalized", () => {
  process.env.FOSSEL_EMBEDDER_CMD = FAKE_EMBEDDER;
  const v = embedText("hello world this is a test note");
  assert.equal(v.length, 8, "should use the external embedder's 8-dim output");
  let norm = 0;
  for (const x of v) norm += x * x;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-6, "external vector must be L2-normalized");

  const meta = activeEmbeddingMeta();
  assert.ok(
    meta.version >= EXTERNAL_EMBEDDING_VERSION,
    "external vectors must be tagged in the external version range",
  );
  assert.equal(
    meta.version,
    externalEmbeddingVersion(FAKE_EMBEDDER),
    "active version must be the one derived from the configured command",
  );
  assert.equal(meta.dim, 8);
});

test("externalEmbeddingVersion is stable for the same command", () => {
  assert.equal(
    externalEmbeddingVersion("node my-embedder.js"),
    externalEmbeddingVersion("node my-embedder.js"),
  );
  // Surrounding whitespace must not change identity, since the env var is
  // trimmed everywhere else too.
  assert.equal(
    externalEmbeddingVersion("  node my-embedder.js  "),
    externalEmbeddingVersion("node my-embedder.js"),
  );
});

test("swapping embedder commands changes the version so stale vectors re-index", () => {
  const first = externalEmbeddingVersion("node embedder-a.js");
  const second = externalEmbeddingVersion("node embedder-b.js");
  assert.notEqual(
    first,
    second,
    "two different embedders must not share a version, even at equal dimension",
  );
});

test("external versions never collide with the built-in hashed version", () => {
  for (const cmd of ["a", "node b.js", "python -m embed", "./e --dim 384"]) {
    const version = externalEmbeddingVersion(cmd);
    assert.ok(
      version >= EXTERNAL_EMBEDDING_VERSION,
      `${cmd} produced ${version}, which is outside the external range`,
    );
    assert.notEqual(version, EMBEDDING_VERSION);
  }
});

test("activeEmbeddingMeta reflects a command swap within one process", () => {
  process.env.FOSSEL_EMBEDDER_CMD = "node -e \"process.stdout.write('[1,2,3,4]')\"";
  const a = activeEmbeddingMeta();
  assert.equal(a.dim, 4);

  process.env.FOSSEL_EMBEDDER_CMD =
    "node -e \"process.stdout.write('[1,2,3,4,5,6]')\"";
  const b = activeEmbeddingMeta();
  assert.equal(b.dim, 6, "the probed dimension must not be cached across commands");
  assert.notEqual(a.version, b.version);
});
