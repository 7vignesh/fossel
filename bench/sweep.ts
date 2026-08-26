/**
 * Fusion tuning sweep.
 *
 *   npx tsx bench/sweep.ts                     # sweep the vector leg weight
 *   npx tsx bench/sweep.ts --sweep floor       # sweep the vector score floor
 *   npx tsx bench/sweep.ts --sweep vector --values 0,0.1,0.2,0.4
 *
 * Exists so the defaults in `src/lib/fusion.ts` are chosen from the benchmark
 * rather than guessed. The FTS leg weight is held at 1 throughout; only the
 * vector leg moves, because what matters is its relationship to the keyword leg.
 *
 * A vector weight of 0 is exactly FTS-only, which the `fts-only` row reports for
 * comparison in the same run.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_FUSION_WEIGHTS } from "../src/lib/fusion.js";
import {
  evaluateHybridTuned,
  type BenchDataset,
  type TuningOverrides,
} from "./lib/harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));

type Axis = "vector" | "floor";

const GRIDS: Record<Axis, number[]> = {
  vector: [0, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1, 1.5],
  floor: [0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4],
};

function parseArgs(argv: string[]): { axes: Axis[]; values?: number[] } {
  let axes: Axis[] = ["vector"];
  let values: number[] | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sweep") {
      const value = argv[i + 1] as Axis | undefined;
      if (value !== "vector" && value !== "floor") {
        throw new Error("--sweep must be 'vector' or 'floor'");
      }
      axes = [value];
      i += 1;
    } else if (argv[i] === "--values") {
      const raw = argv[i + 1];
      if (!raw) throw new Error("--values requires a comma-separated list");
      values = raw.split(",").map((v) => Number(v.trim()));
      if (values.some((v) => !Number.isFinite(v) || v < 0)) {
        throw new Error("--values must be non-negative numbers");
      }
      i += 1;
    } else {
      throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }

  return { axes, values };
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function pad(value: string, width: number, left = true): string {
  if (value.length >= width) return value;
  const fill = " ".repeat(width - value.length);
  return left ? value + fill : fill + value;
}

function tuningFor(axis: Axis, value: number): TuningOverrides {
  const base = { ...DEFAULT_FUSION_WEIGHTS, fts: 1 };
  if (axis === "floor") {
    return { weights: base, vectorScoreFloor: value };
  }
  return { weights: { ...base, vector: value } };
}

interface Row {
  label: string;
  hit1: number;
  hit3: number;
  hit5: number;
  hit10: number;
  recall5: number;
  mrr: number;
  ndcg: number;
}

function measure(
  dataset: BenchDataset,
  label: string,
  tuning: TuningOverrides,
): Row {
  const { search } = evaluateHybridTuned(dataset, tuning, 10);
  return {
    label,
    hit1: search.hitRate[1],
    hit3: search.hitRate[3],
    hit5: search.hitRate[5],
    hit10: search.hitRate[10],
    recall5: search.recall[5],
    mrr: search.mrr,
    ndcg: search.ndcg[10],
  };
}

function render(title: string, rows: Row[]): void {
  const headers = [title, "hit@1", "hit@3", "hit@5", "hit@10", "recall@5", "MRR", "nDCG@10"];
  const cells = rows.map((row) => [
    row.label,
    pct(row.hit1),
    pct(row.hit3),
    pct(row.hit5),
    pct(row.hit10),
    pct(row.recall5),
    row.mrr.toFixed(3),
    row.ndcg.toFixed(3),
  ]);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...cells.map((row) => row[i].length)),
  );
  console.log("");
  console.log(headers.map((h, i) => pad(h, widths[i])).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of cells) {
    console.log(row.map((cell, i) => pad(cell, widths[i], i === 0)).join("  "));
  }

  const best = (key: (r: Row) => number, label: string) => {
    const winner = rows.reduce((a, b) => (key(b) > key(a) ? b : a));
    console.log(`  best ${label.padEnd(9)} ${winner.label}  (${key(winner).toFixed(3)})`);
  };
  console.log("");
  best((r) => r.hit5, "hit@5");
  best((r) => r.hit10, "hit@10");
  best((r) => r.mrr, "MRR");
  best((r) => r.ndcg, "nDCG@10");
}

function main(): void {
  const { axes, values } = parseArgs(process.argv.slice(2));
  const dataset = JSON.parse(
    readFileSync(join(HERE, "datasets", "repo-memory.json"), "utf8"),
  ) as BenchDataset;

  console.log(`Sweeping on ${dataset.name}`);
  console.log(
    `${dataset.memories.length} memories, ${dataset.queries.length} queries, fts weight 1`,
  );
  console.log(
    `held constant: ${JSON.stringify({ ...DEFAULT_FUSION_WEIGHTS, fts: 1 })}`,
  );

  const baseline = measure(dataset, "fts-only", {
    weights: { fts: 1, vector: 0 },
  });

  for (const axis of axes) {
    const grid = values ?? GRIDS[axis];
    const rows = [baseline, ...grid.map((value) => measure(dataset, String(value), tuningFor(axis, value)))];
    render(axis, rows);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`sweep failed: ${message}`);
  process.exit(1);
}
