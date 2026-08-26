/**
 * Benchmark runner.
 *
 *   pnpm bench                        # repo-memory dataset, all modes
 *   npm run bench -- --mode hybrid    # one mode
 *   npm run bench -- --dataset longmemeval --file ./data/longmemeval_s.json
 *   npm run bench -- --check          # fail if results moved vs the snapshot
 *
 * Results are written to bench/results/<dataset>.json so a retrieval change
 * shows up as a reviewable diff instead of a claim.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_MODES,
  evaluate,
  type BenchDataset,
  type ModeResult,
  type RetrievalMode,
} from "./lib/harness.js";
import { loadLongMemEval } from "./lib/longmemeval.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");

interface Args {
  dataset: string;
  modes: RetrievalMode[];
  limit: number;
  file?: string;
  maxQuestions?: number;
  granularity: "session" | "turn";
  check: boolean;
  write: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dataset: "repo-memory",
    modes: ALL_MODES,
    limit: 10,
    granularity: "session",
    check: false,
    write: true,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--dataset":
        if (!value) throw new Error("--dataset requires a value");
        args.dataset = value;
        i += 1;
        break;
      case "--mode":
        if (!value) throw new Error("--mode requires a value");
        if (value === "all") {
          args.modes = ALL_MODES;
        } else {
          const modes = value.split(",").map((m) => m.trim());
          for (const mode of modes) {
            if (!ALL_MODES.includes(mode as RetrievalMode)) {
              throw new Error(
                `Unknown mode "${mode}". Expected one of: ${ALL_MODES.join(", ")}, all`,
              );
            }
          }
          args.modes = modes as RetrievalMode[];
        }
        i += 1;
        break;
      case "--limit":
        if (!value) throw new Error("--limit requires a value");
        args.limit = Number(value);
        if (!Number.isInteger(args.limit) || args.limit < 1) {
          throw new Error("--limit must be a positive integer");
        }
        i += 1;
        break;
      case "--file":
        if (!value) throw new Error("--file requires a value");
        args.file = resolve(value);
        i += 1;
        break;
      case "--max-questions":
        if (!value) throw new Error("--max-questions requires a value");
        args.maxQuestions = Number(value);
        if (!Number.isInteger(args.maxQuestions) || args.maxQuestions < 1) {
          throw new Error("--max-questions must be a positive integer");
        }
        i += 1;
        break;
      case "--granularity":
        if (value !== "session" && value !== "turn") {
          throw new Error("--granularity must be 'session' or 'turn'");
        }
        args.granularity = value;
        i += 1;
        break;
      case "--check":
        args.check = true;
        args.write = false;
        break;
      case "--no-write":
        args.write = false;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return args;
}

function printUsage(): void {
  console.log(
    [
      "Usage: npm run bench -- [options]",
      "",
      "  --dataset <name>   repo-memory (default) | longmemeval",
      "  --mode <modes>     fts | vector | hybrid | all (default) | comma-separated",
      "  --limit <n>        retrieval depth, default 10",
      "  --file <path>      dataset file, required for longmemeval",
      "  --max-questions n  cap questions (longmemeval only)",
      "  --granularity g    session (default) | turn (longmemeval only)",
      "  --check            compare against the committed snapshot and exit non-zero on drift",
      "  --no-write         do not update the snapshot",
      "  --verbose          list every failing query",
    ].join("\n"),
  );
}

function loadDataset(args: Args): BenchDataset {
  if (args.dataset === "longmemeval") {
    if (!args.file) {
      throw new Error(
        "The longmemeval dataset is not redistributed with Fossel. Download longmemeval_s.json " +
          "(ICLR 2025 LongMemEval, https://huggingface.co/datasets/xiaowu0162/longmemeval) and pass " +
          "--file <path>.",
      );
    }
    return loadLongMemEval(args.file, {
      maxQuestions: args.maxQuestions,
      granularity: args.granularity,
    });
  }

  const path = join(HERE, "datasets", `${args.dataset}.json`);
  if (!existsSync(path)) {
    throw new Error(`No dataset at ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as BenchDataset;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function renderTable(
  headers: string[],
  rows: string[][],
): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: string[], align: "l" | "r"): string =>
    cells
      .map((cell, index) =>
        index === 0 || align === "l"
          ? padRight(cell, widths[index])
          : padLeft(cell, widths[index]),
      )
      .join("  ");

  return [
    line(headers, "l"),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) => line(row, "r")),
  ].join("\n");
}

function reportModes(results: ModeResult[], verbose: boolean): void {
  console.log("\nSearch surface (pure ranked search contribution)");
  console.log(
    renderTable(
      ["mode", "hit@1", "hit@3", "hit@5", "hit@10", "recall@5", "MRR", "nDCG@10"],
      results.map((result) => [
        result.mode,
        pct(result.search.hitRate[1]),
        pct(result.search.hitRate[3]),
        pct(result.search.hitRate[5]),
        pct(result.search.hitRate[10]),
        pct(result.search.recall[5]),
        result.search.mrr.toFixed(3),
        result.search.ndcg[10].toFixed(3),
      ]),
    ),
  );

  console.log("\nContext surface (what get_context actually returns, backfill included)");
  console.log(
    renderTable(
      ["mode", "hit@1", "hit@5", "hit@10", "recall@10", "MRR"],
      results.map((result) => [
        result.mode,
        pct(result.context.hitRate[1]),
        pct(result.context.hitRate[5]),
        pct(result.context.hitRate[10]),
        pct(result.context.recall[10]),
        result.context.mrr.toFixed(3),
      ]),
    ),
  );

  const categories = Array.from(
    new Set(results.flatMap((result) => Object.keys(result.byCategory))),
  ).sort();

  console.log("\nhit@5 by category (search surface)");
  console.log(
    renderTable(
      ["category", ...results.map((r) => r.mode)],
      categories.map((category) => [
        category,
        ...results.map((result) =>
          result.byCategory[category]
            ? pct(result.byCategory[category].hitRate[5])
            : "-",
        ),
      ]),
    ),
  );

  for (const result of results) {
    if (result.failures.length === 0) {
      console.log(`\n${result.mode}: no misses at limit ${result.limit}.`);
      continue;
    }
    console.log(
      `\n${result.mode}: ${result.failures.length}/${result.search.queries} queries returned nothing relevant in the search surface`,
    );
    const shown = verbose ? result.failures : result.failures.slice(0, 5);
    for (const failure of shown) {
      console.log(
        `  [${failure.category}] "${failure.query}" -> expected ${failure.expected.join("|")}, got ${failure.got.join("|") || "(nothing)"}`,
      );
    }
    if (!verbose && result.failures.length > shown.length) {
      console.log(`  ... ${result.failures.length - shown.length} more (use --verbose)`);
    }
  }
}

interface Snapshot {
  dataset: string;
  generatedBy: string;
  limit: number;
  modes: Record<
    string,
    {
      search: ModeResult["search"];
      context: ModeResult["context"];
      byCategory: ModeResult["byCategory"];
      failures: number;
    }
  >;
}

function buildSnapshot(
  datasetName: string,
  limit: number,
  results: ModeResult[],
): Snapshot {
  const modes: Snapshot["modes"] = {};
  for (const result of results) {
    modes[result.mode] = {
      search: result.search,
      context: result.context,
      byCategory: result.byCategory,
      failures: result.failures.length,
    };
  }
  return {
    dataset: datasetName,
    generatedBy: "npm run bench",
    limit,
    modes,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataset = loadDataset(args);

  console.log(`Dataset: ${dataset.name}`);
  console.log(
    `  ${dataset.memories.length} memories, ${dataset.queries.length} queries, repo "${dataset.repo}", limit ${args.limit}`,
  );

  const results = args.modes.map((mode) => evaluate(dataset, mode, args.limit));
  reportModes(results, args.verbose);

  const snapshot = buildSnapshot(dataset.name, args.limit, results);
  const snapshotPath = join(RESULTS_DIR, `${args.dataset}.json`);

  if (args.check) {
    if (!existsSync(snapshotPath)) {
      console.error(`\nNo snapshot at ${snapshotPath}; run without --check first.`);
      process.exit(1);
    }
    const previous = readFileSync(snapshotPath, "utf8").trim();
    const current = `${JSON.stringify(snapshot, null, 2)}`.trim();
    if (previous !== current) {
      console.error(
        "\nResults differ from the committed snapshot. Re-run `npm run bench` and commit the diff if the change is intended.",
      );
      process.exit(1);
    }
    console.log("\nResults match the committed snapshot.");
    return;
  }

  if (args.write) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    console.log(`\nSnapshot written to ${snapshotPath}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`bench failed: ${message}`);
  process.exit(1);
}
