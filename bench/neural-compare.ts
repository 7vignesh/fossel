/**
 * Three-way retrieval and latency comparison on the scale-1k dataset.
 *
 *   npm run bench:neural
 *
 * Systems, all loaded with the identical 1,000 documents into their own SQLite
 * file:
 *
 *   fossel-fts     searchFts() from src/lib/fts.ts: the real three-tier search
 *                  (AND, then OR, then stemmed prefix), not a bare bm25() query.
 *   fossel-hybrid  fetchRepoContext() with FOSSEL_EMBEDDINGS=1: FTS plus the
 *                  built-in feature-hashing vector leg, fused with weighted RRF.
 *   sqlite-vec     vec0 cosine KNN over Xenova/all-MiniLM-L6-v2 embeddings
 *                  (pooling: mean, normalize: true), computed with
 *                  @huggingface/transformers. This is an external baseline, not
 *                  something Fossel ships.
 *
 * Unlike `npm run bench`, the output is wall-clock timing and varies from run
 * to run, so it is written to bench/results/neural-compare.json for reading,
 * not as a snapshot for `--check`. It is also not part of `npm run ci`: the
 * first run downloads the ~90 MB model from the network.
 *
 * Definitions worth knowing before reading the numbers:
 *
 *  - Warmup is 5 untimed queries (the first five of the query set) per system,
 *    then every one of the 30 queries is timed once. p95 over 30 samples is the
 *    29th-smallest value: a coarse tail estimate.
 *  - Each query has one relevant document, so top-k recall equals hit@k.
 *  - The hybrid path is the whole get_context retrieval function, so its time
 *    includes pinned/recent lookups, entity extraction and an access-count
 *    write, not just ranking. That is deliberate: it is what an agent pays.
 *  - Neural cold start = model load + one throwaway inference + opening the
 *    database and creating the vec0 table. Neural index build = embedding all
 *    documents (batches of 32) + inserting them.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { env, pipeline } from "@huggingface/transformers";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, platform, release, arch, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRepoContext } from "../src/lib/context.js";
import { searchFts } from "../src/lib/fts.js";
import { backfillRepoEmbeddings } from "../src/lib/vector-index.js";
import { scale1k } from "./datasets/scale-1k.js";
import { ingest, withEmbeddings, type BenchDataset, type BenchQuery } from "./lib/harness.js";
import { summarizeLatency, type LatencyStats } from "./lib/latency.js";
import { summarizeByCategory, type QueryOutcome } from "./lib/metrics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(HERE, "results", "neural-compare.json");
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const MODEL_DIM = 384;
const LIMIT = 10;
const WARMUP = 5;
const EMBED_BATCH = 32;
const POOLING = { pooling: "mean", normalize: true } as const;

env.cacheDir = join(HERE, ".cache");

interface Recall {
  top1: number;
  top3: number;
}

interface SystemResult {
  id: string;
  label: string;
  coldStartMs: number;
  indexBuildMs: number;
  dbSizeKb: number;
  /** Latency of each measured path, over the timed queries. */
  latencyMs: Record<string, LatencyStats>;
  /** Percent, by query category. */
  recall: Record<string, Recall>;
  /** 1-based rank of the relevant document in the top LIMIT (null if absent),
   * and the key of whatever ranked first. Keys starting `d-` are the planted
   * decoys, `f-` are generated fillers, `n-` are targets. */
  ranks: Array<{ id: string; category: string; rank: number | null; top1: string | null }>;
  /** Component timings behind coldStartMs / indexBuildMs. */
  detailMs: Record<string, number>;
  notes: string[];
}

function now(): number {
  return performance.now();
}

function round(value: number, places = 1): number {
  return Number(value.toFixed(places));
}

function fileSizeKb(db: Database.Database): number {
  // WAL mode keeps recent pages in the -wal file; fold them in first so the
  // main file is the whole database.
  db.pragma("wal_checkpoint(TRUNCATE)");
  return round(statSync(db.name).size / 1024, 1);
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(path) : statSync(path).size;
  }
  return total;
}

/** Run `run` for every query after WARMUP untimed calls. */
function timeSync<T>(
  queries: BenchQuery[],
  run: (query: string) => T,
): { ms: number[]; results: T[] } {
  for (const query of queries.slice(0, WARMUP)) {
    run(query.query);
  }
  const ms: number[] = [];
  const results: T[] = [];
  for (const query of queries) {
    const startedAt = now();
    const result = run(query.query);
    ms.push(now() - startedAt);
    results.push(result);
  }
  return { ms, results };
}

function score(
  queries: BenchQuery[],
  ranked: string[][],
): Pick<SystemResult, "recall" | "ranks"> {
  const labelled = queries.map((query, i) => ({
    category: query.category,
    outcome: { retrieved: ranked[i], relevant: query.relevant } as QueryOutcome,
  }));
  const byCategory = summarizeByCategory(labelled);
  const recall: Record<string, Recall> = {};
  for (const [category, summary] of Object.entries(byCategory)) {
    recall[category] = {
      top1: round(summary.hitRate[1] * 100),
      top3: round(summary.hitRate[3] * 100),
    };
  }
  const ranks = queries.map((query, i) => {
    const index = ranked[i].findIndex((key) => query.relevant.includes(key));
    return {
      id: query.id,
      category: query.category,
      rank: index === -1 ? null : index + 1,
      top1: ranked[i][0] ?? null,
    };
  });
  return { recall, ranks };
}

function runFossel(dataset: BenchDataset, mode: "fts" | "hybrid"): SystemResult {
  const ingested = ingest(dataset);
  try {
    const { db, rowIdToKey } = ingested;
    const toKeys = (rowIds: number[]): string[] =>
      rowIds.flatMap((rowId) => {
        const key = rowIdToKey.get(rowId);
        return key === undefined ? [] : [key];
      });

    let backfillMs = 0;
    if (mode === "hybrid") {
      const startedAt = now();
      withEmbeddings(true, () => backfillRepoEmbeddings(db, dataset.repo));
      backfillMs = now() - startedAt;
    }

    let ms: number[];
    let ranked: string[][];
    if (mode === "fts") {
      const timed = timeSync(dataset.queries, (query) =>
        searchFts(db, query, { repo: dataset.repo, limit: LIMIT }).rows,
      );
      ms = timed.ms;
      ranked = timed.results.map((rows) => toKeys(rows.map((row) => row.row_id)));
    } else {
      const timed = withEmbeddings(true, () =>
        timeSync(dataset.queries, (query) =>
          fetchRepoContext(db, dataset.repo, LIMIT, query),
        ),
      );
      ms = timed.ms;
      // The pure search surface, as in `npm run bench`: backfill rows excluded.
      ranked = timed.results.map((rows) =>
        toKeys(rows.filter((row) => row.source === "search").map((row) => row.row_id)),
      );
    }

    const { setupMs, insertMs } = ingested.timings;
    const isFts = mode === "fts";
    return {
      id: isFts ? "fossel-fts" : "fossel-hybrid",
      label: isFts ? "Fossel 3-tier FTS5" : "Fossel hybrid (FTS5 + hashed vectors)",
      coldStartMs: round(setupMs),
      indexBuildMs: round(insertMs + backfillMs),
      dbSizeKb: fileSizeKb(db),
      latencyMs: {
        [isFts ? "search" : "retrieval"]: summarizeLatency(ms),
      },
      ...score(dataset.queries, ranked),
      detailMs: isFts
        ? { openAndMigrate: round(setupMs), insertAndFtsTriggers: round(insertMs) }
        : {
            openAndMigrate: round(setupMs),
            insertAndFtsTriggers: round(insertMs),
            hashedEmbeddingBackfill: round(backfillMs),
          },
      notes: isFts
        ? ["Search function: searchFts() (AND, OR, stemmed-prefix tiers)."]
        : [
            "Timed path is fetchRepoContext(): FTS + hashed vector + RRF + entity lookup + backfill + access write.",
            "No model: embeddings are feature-hashed, 256 dimensions.",
          ],
    };
  } finally {
    ingested.cleanup();
  }
}

async function runNeural(dataset: BenchDataset): Promise<SystemResult> {
  const modelDir = join(env.cacheDir as string, MODEL_ID);
  const cacheWarm = existsSync(modelDir);

  const loadStartedAt = now();
  const extractor = await pipeline("feature-extraction", MODEL_ID, { dtype: "fp32" });
  const modelLoadMs = now() - loadStartedAt;

  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const output = await extractor(texts, POOLING);
    const data = output.data as Float32Array;
    if (output.dims[0] !== texts.length || output.dims[1] !== MODEL_DIM) {
      throw new Error(`Unexpected embedding shape ${output.dims.join("x")}`);
    }
    return texts.map((_, i) => data.slice(i * MODEL_DIM, (i + 1) * MODEL_DIM));
  };
  const toBlob = (vector: Float32Array): Buffer => Buffer.from(vector.buffer);

  const firstStartedAt = now();
  await embed(["warmup"]);
  const firstInferenceMs = now() - firstStartedAt;

  const dir = mkdtempSync(join(tmpdir(), "fossel-neural-"));
  let db: Database.Database | undefined;
  try {
    const dbStartedAt = now();
    db = new Database(join(dir, "neural.db"));
    db.pragma("journal_mode = WAL");
    sqliteVec.load(db);
    db.exec(`
      CREATE TABLE docs (id INTEGER PRIMARY KEY, key TEXT NOT NULL, note TEXT NOT NULL);
      CREATE VIRTUAL TABLE vec_docs USING vec0(embedding float[${MODEL_DIM}] distance_metric=cosine);
    `);
    const dbSetupMs = now() - dbStartedAt;

    // Index build: embed in batches, then insert docs and vectors.
    const memories = dataset.memories;
    const insertDoc = db.prepare("INSERT INTO docs (id, key, note) VALUES (?, ?, ?)");
    const insertVec = db.prepare("INSERT INTO vec_docs (rowid, embedding) VALUES (?, ?)");
    let embedMs = 0;
    let insertMs = 0;
    for (let start = 0; start < memories.length; start += EMBED_BATCH) {
      const batch = memories.slice(start, start + EMBED_BATCH);
      const embedStartedAt = now();
      const vectors = await embed(batch.map((memory) => memory.note));
      embedMs += now() - embedStartedAt;

      const insertStartedAt = now();
      db.transaction(() => {
        batch.forEach((memory, i) => {
          const id = BigInt(start + i + 1);
          insertDoc.run(id, memory.key, memory.note);
          insertVec.run(id, toBlob(vectors[i]));
        });
      })();
      insertMs += now() - insertStartedAt;
    }

    const knn = db.prepare(
      "SELECT rowid FROM vec_docs WHERE embedding MATCH ? AND k = ? ORDER BY distance",
    );
    const keyOf = (rowid: number | bigint): string => memories[Number(rowid) - 1].key;
    const search = (vector: Float32Array): number[] =>
      (knn.all(toBlob(vector), LIMIT) as Array<{ rowid: number | bigint }>).map((row) =>
        Number(row.rowid),
      );

    for (const query of dataset.queries.slice(0, WARMUP)) {
      search((await embed([query.query]))[0]);
    }

    const embedSamples: number[] = [];
    const searchSamples: number[] = [];
    const totalSamples: number[] = [];
    const ranked: string[][] = [];
    for (const query of dataset.queries) {
      const startedAt = now();
      const vector = (await embed([query.query]))[0];
      const embeddedAt = now();
      const rowIds = search(vector);
      const finishedAt = now();
      embedSamples.push(embeddedAt - startedAt);
      searchSamples.push(finishedAt - embeddedAt);
      totalSamples.push(finishedAt - startedAt);
      ranked.push(rowIds.map(keyOf));
    }

    const modelBytes = existsSync(modelDir) ? dirSizeBytes(modelDir) : 0;
    const notes = [
      `Model ${MODEL_ID}, dtype fp32, ${MODEL_DIM} dimensions, ${round(modelBytes / 1024 / 1024, 1)} MB on disk.`,
      "Database holds a docs table (key, note) plus the vec0 table; the model file is not in the database.",
    ];
    if (!cacheWarm) {
      notes.push(
        "Model cache was empty at start, so modelLoadMs includes the network download. Re-run for a warm-cache number.",
      );
    }

    return {
      id: "sqlite-vec-minilm",
      label: "sqlite-vec + all-MiniLM-L6-v2",
      coldStartMs: round(modelLoadMs + firstInferenceMs + dbSetupMs),
      indexBuildMs: round(embedMs + insertMs),
      dbSizeKb: fileSizeKb(db),
      latencyMs: {
        knnOnly: summarizeLatency(searchSamples),
        queryEmbeddingOnly: summarizeLatency(embedSamples),
        embeddingPlusKnn: summarizeLatency(totalSamples),
      },
      ...score(dataset.queries, ranked),
      detailMs: {
        modelLoad: round(modelLoadMs),
        firstInference: round(firstInferenceMs),
        openAndCreateVec0: round(dbSetupMs),
        embedDocuments: round(embedMs),
        insertDocuments: round(insertMs),
      },
      notes,
    };
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

const f1 = (value: number): string => value.toFixed(1);
const f3 = (value: number): string => value.toFixed(3);

function render(results: SystemResult[]): string {
  const setup = table(
    ["System", "Cold start (ms)", "Index build, 1,000 docs (ms)", "DB size (KB)"],
    results.map((r) => [r.label, f1(r.coldStartMs), f1(r.indexBuildMs), f1(r.dbSizeKb)]),
  );

  const pathLabels: Record<string, string> = {
    search: "searchFts()",
    retrieval: "fetchRepoContext() with hashed vectors",
    knnOnly: "vec0 KNN, query vector precomputed",
    queryEmbeddingOnly: "query embedding only",
    embeddingPlusKnn: "query embedding + vec0 KNN",
  };
  const latencyRows: string[][] = [];
  for (const r of results) {
    for (const [path, stats] of Object.entries(r.latencyMs)) {
      latencyRows.push([r.label, pathLabels[path] ?? path, f3(stats.p50), f3(stats.p95)]);
    }
  }
  const latency = table(["System", "Measured path", "p50 (ms)", "p95 (ms)"], latencyRows);

  const cell = (r: SystemResult, category: string, key: keyof Recall): string =>
    `${f1(r.recall[category]?.[key] ?? 0)}%`;
  const recall = table(
    ["System", "Symbol top-1", "Symbol top-3", "Paraphrase top-1", "Paraphrase top-3"],
    results.map((r) => [
      r.label,
      cell(r, "symbol", "top1"),
      cell(r, "symbol", "top3"),
      cell(r, "paraphrase", "top1"),
      cell(r, "paraphrase", "top3"),
    ]),
  );

  return [
    "### Setup, index build and size",
    setup,
    "",
    `### Query latency (${WARMUP} untimed warmup queries, then ${scale1k.queries.length} timed)`,
    latency,
    "",
    "### Recall (15 symbol queries, 15 paraphrase queries, one relevant document each)",
    recall,
  ].join("\n");
}

function environment(db: Database.Database): Record<string, string | number> {
  const cpu = cpus();
  return {
    node: process.version,
    os: `${platform()} ${release()} ${arch()}`,
    cpu: cpu[0]?.model.trim() ?? "unknown",
    logicalCores: cpu.length,
    memoryGb: round(totalmem() / 1024 ** 3, 1),
    sqlite: (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v,
    sqliteVec: (db.prepare("SELECT vec_version() AS v").get() as { v: string }).v,
    transformersJs: (env as { version?: string }).version ?? "unknown",
  };
}

async function main(): Promise<void> {
  if (process.env.FOSSEL_EMBEDDER_CMD?.trim()) {
    throw new Error(
      "FOSSEL_EMBEDDER_CMD is set, so the hybrid system would not use the built-in embedder. Unset it and re-run.",
    );
  }
  delete process.env.FOSSEL_EMBEDDINGS;

  const dataset = scale1k;
  console.log(`Dataset: ${dataset.name}`);
  console.log(
    `  ${dataset.memories.length} memories, ${dataset.queries.length} queries, repo "${dataset.repo}", limit ${LIMIT}\n`,
  );

  console.log("Running Fossel FTS...");
  const fts = runFossel(dataset, "fts");
  console.log("Running Fossel hybrid...");
  const hybrid = runFossel(dataset, "hybrid");
  console.log(`Running sqlite-vec + ${MODEL_ID} (model load may take a while)...`);
  const neural = await runNeural(dataset);

  const results = [fts, hybrid, neural];
  console.log(`\n${render(results)}\n`);
  for (const r of results) {
    for (const note of r.notes) {
      console.log(`- ${r.label}: ${note}`);
    }
  }

  const probe = new Database(":memory:");
  sqliteVec.load(probe);
  const env_ = environment(probe);
  probe.close();

  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(
    RESULTS_PATH,
    `${JSON.stringify(
      {
        generatedBy: "npm run bench:neural",
        generatedAt: new Date().toISOString(),
        dataset: {
          name: dataset.name,
          documents: dataset.memories.length,
          queries: dataset.queries.length,
          synthetic: true,
        },
        method: {
          limit: LIMIT,
          warmupQueries: WARMUP,
          timedQueries: dataset.queries.length,
          embedBatchSize: EMBED_BATCH,
          model: MODEL_ID,
          pooling: POOLING,
        },
        environment: env_,
        results,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`\nResults written to ${RESULTS_PATH}`);
}

main().catch((error) => {
  console.error(`bench:neural failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
