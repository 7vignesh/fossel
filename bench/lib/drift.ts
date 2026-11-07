/**
 * Git-drift benchmark harness (#31).
 *
 * The retrieval benchmark in `harness.ts` scores keyword/vector/hybrid ranking
 * on a static corpus. It cannot measure anything git-aware, because it never
 * builds a git repo and never records file references. This harness fills that
 * gap, and is the infrastructure #30 (drift-aware ranking) is blocked on.
 *
 * It is deterministic: given a drift dataset it builds a throwaway git repo from
 * the dataset's `files`, commits them, records a file reference for every
 * memory (exactly as `remember` does), then applies each memory's declared
 * drift state:
 *
 *   - `unchanged`         commit the file, touch nothing.
 *   - `committed-change`  rewrite the file and commit again.
 *   - `working-tree-dirty` rewrite the file, do not commit.
 *   - `deleted`           remove the file and commit the deletion.
 *
 * No live repo state leaks in — `git` config is pinned and the whole repo lives
 * in a temp dir that is deleted on cleanup. Two things are reported:
 *
 *  1. **Drift detection** — for each state, whether `findStaleFileRefs` makes
 *     the correct call (drifted vs not). This is the signal #30 will rank on, so
 *     its accuracy is what matters, not a ranking number.
 *  2. **Retrieval** — the standard FTS metrics per drift category, so a later
 *     ranking change can be compared against this pre-ranking baseline.
 */

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runMigrations } from "../../src/db/migrate.js";
import { fetchRepoContext } from "../../src/lib/context.js";
import { normalizeText } from "../../src/lib/dedupe.js";
import { recordFileRefs, findStaleFileRefs } from "../../src/lib/file-refs.js";
import { summarize, summarizeByCategory, type QueryOutcome } from "./metrics.js";

export type DriftState =
  | "unchanged"
  | "committed-change"
  | "working-tree-dirty"
  | "deleted";

export const DRIFT_STATES: DriftState[] = [
  "unchanged",
  "committed-change",
  "working-tree-dirty",
  "deleted",
];

/** A drifted state is one where the referenced file no longer matches what it
 * was when the memory was written, so findStaleFileRefs should flag it. */
const DRIFTED: ReadonlySet<DriftState> = new Set([
  "committed-change",
  "working-tree-dirty",
  "deleted",
]);

export interface DriftMemory {
  key: string;
  note: string;
  type?: string;
  tags?: string[];
  file: string;
  drift: DriftState;
}

export interface DriftQuery {
  id: string;
  query: string;
  relevant: string[];
  category: string;
  rationale?: string;
}

export interface DriftDataset {
  name: string;
  description?: string;
  repo: string;
  files: Record<string, string>;
  memories: DriftMemory[];
  queries: DriftQuery[];
}

const BASE_TIMESTAMP = 1_700_000_000;

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

export function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

function writeFileAt(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

export interface DriftIngest {
  db: Database.Database;
  dir: string;
  /** dataset key -> memory rowid */
  keyToRowId: Map<string, number>;
  rowIdToKey: Map<number, string>;
  cleanup: () => void;
}

/**
 * Build the scratch repo, ingest the memories, record file refs, then apply the
 * declared drift state of each memory's file. The returned db is a real Fossel
 * database with file refs recorded, ready to query and to run findStaleFileRefs
 * against.
 */
export function ingestDrift(dataset: DriftDataset): DriftIngest {
  const dir = mkdtempSync(join(tmpdir(), "fossel-drift-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "bench@fossel.test"]);
  git(dir, ["config", "user.name", "Fossel Bench"]);
  git(dir, ["config", "commit.gpgsign", "false"]);

  // Commit every file at its original content first.
  for (const [path, content] of Object.entries(dataset.files)) {
    writeFileAt(dir, path, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);

  const db = new Database(join(dir, "memory.db"));
  db.pragma("journal_mode = WAL");
  runMigrations(db);

  const insert = db.prepare(
    `
      INSERT INTO memories (id, repo, type, note, tags, created_at, updated_at, pinned, metadata_json, note_normalized)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, '{}', ?)
    `,
  );

  const keyToRowId = new Map<string, number>();
  const rowIdToKey = new Map<number, string>();

  dataset.memories.forEach((memory, index) => {
    const timestamp = BASE_TIMESTAMP - index;
    const result = insert.run(
      `drift-${memory.key}`,
      dataset.repo,
      memory.type ?? "general",
      memory.note,
      JSON.stringify(memory.tags ?? []),
      timestamp,
      timestamp,
      normalizeText(memory.note),
    );
    const rowId = Number(result.lastInsertRowid);
    keyToRowId.set(memory.key, rowId);
    rowIdToKey.set(rowId, memory.key);
    // Record the file reference against the committed file, exactly as the
    // write path does. This captures the original blob sha.
    recordFileRefs(db, rowId, memory.note, dir);
  });

  // Now apply drift. Committed changes and deletions are batched into one
  // follow-up commit; working-tree edits are left uncommitted.
  let hasCommittedMutation = false;
  for (const memory of dataset.memories) {
    const full = join(dir, memory.file);
    switch (memory.drift) {
      case "unchanged":
        break;
      case "committed-change":
        writeFileSync(full, `// changed after the memory was written\n${dataset.files[memory.file]}`, "utf8");
        git(dir, ["add", memory.file]);
        hasCommittedMutation = true;
        break;
      case "deleted":
        rmSync(full, { force: true });
        git(dir, ["add", "-A", memory.file]);
        hasCommittedMutation = true;
        break;
      case "working-tree-dirty":
        // Applied after the commit below, so it stays uncommitted.
        break;
    }
  }
  if (hasCommittedMutation) {
    git(dir, ["commit", "-q", "-m", "drift"]);
  }
  for (const memory of dataset.memories) {
    if (memory.drift === "working-tree-dirty") {
      writeFileSync(
        join(dir, memory.file),
        `// uncommitted edit\n${dataset.files[memory.file]}`,
        "utf8",
      );
    }
  }

  return {
    db,
    dir,
    keyToRowId,
    rowIdToKey,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface DriftDetectionResult {
  /** Per drift state: how many memories were classified correctly. */
  byState: Record<DriftState, { total: number; correct: number }>;
  /** Overall fraction correct. */
  accuracy: number;
  /** Memories classified wrongly, for the miss list. */
  misclassified: Array<{ key: string; expected: DriftState; detectedDrift: boolean }>;
}

/**
 * Score findStaleFileRefs against every memory's declared drift state. A memory
 * is "detected as drifted" when findStaleFileRefs returns a ref for it; the
 * expected answer is whether its state is in DRIFTED.
 */
export function scoreDriftDetection(ingest: DriftIngest, dataset: DriftDataset): DriftDetectionResult {
  const rowIds = dataset.memories.map((m) => ingest.keyToRowId.get(m.key)!);
  const stale = findStaleFileRefs(ingest.db, rowIds, ingest.dir);

  const byState = Object.fromEntries(
    DRIFT_STATES.map((s) => [s, { total: 0, correct: 0 }]),
  ) as DriftDetectionResult["byState"];
  const misclassified: DriftDetectionResult["misclassified"] = [];
  let correct = 0;

  for (const memory of dataset.memories) {
    const rowId = ingest.keyToRowId.get(memory.key)!;
    const detectedDrift = stale.has(rowId);
    const expectedDrift = DRIFTED.has(memory.drift);
    byState[memory.drift].total += 1;
    if (detectedDrift === expectedDrift) {
      byState[memory.drift].correct += 1;
      correct += 1;
    } else {
      misclassified.push({ key: memory.key, expected: memory.drift, detectedDrift });
    }
  }

  return {
    byState,
    accuracy: dataset.memories.length === 0 ? 0 : correct / dataset.memories.length,
    misclassified,
  };
}

export interface DriftRetrievalResult {
  /** FTS search-surface metrics across every query. */
  search: ReturnType<typeof summarize>;
  /** Metrics grouped by drift category. */
  byCategory: ReturnType<typeof summarizeByCategory>;
}

/**
 * Score plain FTS retrieval on the drift dataset. This is the pre-ranking
 * baseline: drift is not yet a ranking input, so these numbers describe search
 * before #30. A drift-aware ranking change is kept only if it moves them in the
 * intended direction without regressing the `unchanged` category.
 */
export function scoreDriftRetrieval(ingest: DriftIngest, dataset: DriftDataset, limit = 10): DriftRetrievalResult {
  const toKeys = (rowIds: number[]): string[] =>
    rowIds
      .map((rowId) => ingest.rowIdToKey.get(rowId))
      .filter((key): key is string => key !== undefined);

  const outcomes: QueryOutcome[] = [];
  const labelled: Array<{ category: string; outcome: QueryOutcome }> = [];

  for (const query of dataset.queries) {
    const rows = fetchRepoContext(ingest.db, dataset.repo, limit, query.query);
    const retrieved = toKeys(
      rows.filter((row) => row.source === "search").map((row) => row.row_id),
    );
    const outcome: QueryOutcome = { retrieved, relevant: query.relevant };
    outcomes.push(outcome);
    labelled.push({ category: query.category, outcome });
  }

  return {
    search: summarize(outcomes),
    byCategory: summarizeByCategory(labelled),
  };
}
