import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  DRIFT_STATES,
  gitAvailable,
  ingestDrift,
  scoreDriftDetection,
  scoreDriftRetrieval,
  type DriftDataset,
} from "../bench/lib/drift.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET = JSON.parse(
  readFileSync(join(HERE, "..", "bench", "datasets", "git-drift.json"), "utf8"),
) as DriftDataset;

const GIT = gitAvailable();

test("git-drift dataset is internally consistent", () => {
  // Every memory points at a declared file and a known drift state; every
  // query points at a memory key. Guards against a typo silently making a case
  // untestable.
  const keys = new Set(DATASET.memories.map((m) => m.key));
  for (const memory of DATASET.memories) {
    assert.ok(DATASET.files[memory.file], `${memory.key} references undeclared file ${memory.file}`);
    assert.ok(DRIFT_STATES.includes(memory.drift), `${memory.key} has unknown drift ${memory.drift}`);
  }
  for (const query of DATASET.queries) {
    assert.ok(query.relevant.length > 0, `${query.id} has no relevant keys`);
    for (const key of query.relevant) {
      assert.ok(keys.has(key), `${query.id} references unknown memory ${key}`);
    }
  }
  // All four states must be represented, or the fixture does not exercise the
  // feature it exists for.
  const states = new Set(DATASET.memories.map((m) => m.drift));
  for (const state of DRIFT_STATES) {
    assert.ok(states.has(state), `no fixture memory in drift state "${state}"`);
  }
});

test("findStaleFileRefs classifies every drift state correctly", { skip: !GIT }, () => {
  const ingest = ingestDrift(DATASET);
  try {
    const result = scoreDriftDetection(ingest, DATASET);
    assert.equal(
      result.accuracy,
      1,
      `expected perfect drift classification, misclassified: ${result.misclassified
        .map((m) => `${m.key}(${m.expected})`)
        .join(", ")}`,
    );
    // The drifted states must each be detected as drifted; unchanged must not.
    for (const state of DRIFT_STATES) {
      const row = result.byState[state];
      assert.equal(row.correct, row.total, `state ${state} had a misclassification`);
    }
  } finally {
    ingest.cleanup();
  }
});

test("the harness is deterministic across repeated runs", { skip: !GIT }, () => {
  const run = () => {
    const ingest = ingestDrift(DATASET);
    try {
      return {
        detection: scoreDriftDetection(ingest, DATASET),
        retrieval: scoreDriftRetrieval(ingest, DATASET),
      };
    } finally {
      ingest.cleanup();
    }
  };
  const a = run();
  const b = run();
  assert.deepEqual(a.detection.byState, b.detection.byState);
  assert.deepEqual(a.retrieval.byCategory, b.retrieval.byCategory);
  assert.deepEqual(a.retrieval.search, b.retrieval.search);
});

test("every drift query retrieves its target memory (pre-ranking baseline)", { skip: !GIT }, () => {
  const ingest = ingestDrift(DATASET);
  try {
    const retrieval = scoreDriftRetrieval(ingest, DATASET);
    // The fixtures are written so plain FTS already finds every target; a
    // drift-aware ranking change (#30) must not regress this.
    assert.equal(retrieval.search.hitRate[5], 1, "every query should hit@5 before ranking changes");
  } finally {
    ingest.cleanup();
  }
});

test("a working-tree-dirty file reverts to clean when the edit is undone", { skip: !GIT }, () => {
  // Proves the dirty state is really an uncommitted edit, not a committed one:
  // restoring the file from HEAD must clear the drift for that memory.
  const ingest = ingestDrift(DATASET);
  try {
    const dirty = DATASET.memories.find((m) => m.drift === "working-tree-dirty")!;
    const before = scoreDriftDetection(ingest, DATASET);
    assert.ok(before.byState["working-tree-dirty"].correct > 0);

    // Restore the dirty file to its committed content.
    spawnSync("git", ["checkout", "--", dirty.file], { cwd: ingest.dir });
    const stale = scoreDriftDetection(ingest, DATASET);
    // After restoring, that one memory's file is no longer dirty, so the
    // detector must stop flagging it. It is now unchanged, and was expected to
    // be dirty, so it becomes a misclassification.
    assert.ok(
      stale.misclassified.some((m) => m.key === dirty.key && m.detectedDrift === false),
      "restoring the file should clear its working-tree drift",
    );
  } finally {
    ingest.cleanup();
  }
});
