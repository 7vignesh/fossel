/**
 * Git-drift benchmark runner (#31).
 *
 *   npm run bench:drift            # run and refresh the snapshot
 *   npm run bench:drift -- --check # fail on drift vs the committed snapshot
 *
 * Reports two things for the committed git-drift fixtures:
 *
 *  1. Drift detection accuracy per state — does `findStaleFileRefs` correctly
 *     classify each memory's file as drifted or not.
 *  2. FTS retrieval metrics per drift category — the pre-ranking baseline that
 *     #30 (drift-aware ranking) will have to beat.
 *
 * Results go to bench/results/git-drift.json so a change shows up as a diff.
 * Skips cleanly when git is unavailable, so a git-less CI runner does not fail.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DRIFT_STATES,
  gitAvailable,
  ingestDrift,
  scoreDriftDetection,
  scoreDriftRetrieval,
  type DriftDataset,
} from "./lib/drift.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
const SNAPSHOT_PATH = join(RESULTS_DIR, "git-drift.json");

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

interface Snapshot {
  dataset: string;
  generatedBy: string;
  limit: number;
  detection: {
    accuracy: number;
    byState: Record<string, { total: number; correct: number }>;
  };
  retrieval: {
    search: ReturnType<typeof scoreDriftRetrieval>["search"];
    byCategory: ReturnType<typeof scoreDriftRetrieval>["byCategory"];
  };
}

function main(): void {
  const check = process.argv.includes("--check");

  if (!gitAvailable()) {
    console.log("git not available; skipping the git-drift benchmark.");
    return;
  }

  const dataset = JSON.parse(
    readFileSync(join(HERE, "datasets", "git-drift.json"), "utf8"),
  ) as DriftDataset;
  const limit = 10;

  console.log(`Dataset: ${dataset.name}`);
  console.log(
    `  ${dataset.memories.length} memories, ${dataset.queries.length} queries, ${Object.keys(dataset.files).length} files, repo "${dataset.repo}"`,
  );

  const ingest = ingestDrift(dataset);
  let snapshot: Snapshot;
  try {
    const detection = scoreDriftDetection(ingest, dataset);
    const retrieval = scoreDriftRetrieval(ingest, dataset, limit);

    console.log("\nDrift detection (findStaleFileRefs vs the declared state)");
    for (const state of DRIFT_STATES) {
      const row = detection.byState[state];
      if (row.total === 0) continue;
      console.log(`  ${state.padEnd(20)} ${row.correct}/${row.total} correct`);
    }
    console.log(`  overall accuracy: ${pct(detection.accuracy)}`);
    if (detection.misclassified.length > 0) {
      console.log("  misclassified:");
      for (const miss of detection.misclassified) {
        console.log(
          `    ${miss.key} (${miss.expected}) -> detected drift: ${miss.detectedDrift}`,
        );
      }
    }

    console.log("\nFTS retrieval by drift category (search surface, pre-ranking baseline)");
    const cats = Object.keys(retrieval.byCategory).sort();
    for (const cat of cats) {
      const m = retrieval.byCategory[cat];
      console.log(`  ${cat.padEnd(20)} hit@5 ${pct(m.hitRate[5])}  MRR ${m.mrr.toFixed(3)}  (${m.queries} q)`);
    }
    console.log(
      `  overall: hit@5 ${pct(retrieval.search.hitRate[5])}  MRR ${retrieval.search.mrr.toFixed(3)}`,
    );

    snapshot = {
      dataset: dataset.name,
      generatedBy: "npm run bench:drift",
      limit,
      detection: { accuracy: detection.accuracy, byState: detection.byState },
      retrieval: { search: retrieval.search, byCategory: retrieval.byCategory },
    };
  } finally {
    ingest.cleanup();
  }

  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

  if (check) {
    if (!existsSync(SNAPSHOT_PATH)) {
      console.error(`\nNo snapshot at ${SNAPSHOT_PATH}; run \`npm run bench:drift\` first.`);
      process.exit(1);
    }
    const previous = readFileSync(SNAPSHOT_PATH, "utf8").replace(/\r\n/g, "\n").trim();
    if (previous !== serialized.replace(/\r\n/g, "\n").trim()) {
      console.error(
        "\nDrift results differ from the committed snapshot. Re-run `npm run bench:drift` and commit the diff if intended.",
      );
      process.exit(1);
    }
    console.log("\nDrift results match the committed snapshot.");
    return;
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(SNAPSHOT_PATH, serialized, "utf8");
  console.log(`\nSnapshot written to ${SNAPSHOT_PATH}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`bench:drift failed: ${message}`);
  process.exit(1);
}
