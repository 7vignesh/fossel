import type Database from "better-sqlite3";
import type { MemoryRecord } from "../db/client.js";
import { similarity } from "./dedupe.js";

export interface ConsolidationCandidate {
  memory: MemoryRecord;
  issue: "stale" | "redundant" | "contradicted";
  details: string;
  relatedIds?: number[];
}

export interface ConsolidationReport {
  repo: string;
  totalMemories: number;
  candidates: ConsolidationCandidate[];
  summary: string;
}

/** Extended record shape when access tracking columns exist (migration 011). */
interface MemoryWithAccess extends MemoryRecord {
  last_accessed_at: number | null;
  access_count: number;
}

/** Cap the O(n²) similarity scan at this many memories to keep runtime bounded. */
const SIMILARITY_SCAN_LIMIT = 100;

/**
 * Analyze a repo's memories for maintenance candidates:
 * - stale: memories with access_count = 0 and old updated_at (>staleDays days)
 * - redundant: pairs with similarity >= 0.70 (near-duplicate territory)
 * - contradicted: pairs where one contains negation language about the other's subject
 *
 * Returns a structured report the client model can act on.
 */
export function analyzeRepo(
  db: Database.Database,
  repo: string,
  options: { maxCandidates?: number; staleDays?: number } = {},
): ConsolidationReport {
  const maxCandidates = options.maxCandidates ?? 20;
  const staleDays = options.staleDays ?? 90;
  const now = Math.floor(Date.now() / 1000);
  const staleThreshold = now - staleDays * 86400;

  // Try loading with access tracking columns; fall back if they don't exist yet
  // (migration 011 may not have run).
  let memories: MemoryWithAccess[];
  let hasAccessColumns = true;

  try {
    memories = db
      .prepare(
        `SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned,
                last_accessed_at, access_count
         FROM memories
         WHERE repo = ? AND valid_to IS NULL
         ORDER BY updated_at DESC`,
      )
      .all(repo) as MemoryWithAccess[];
  } catch {
    // access_count / last_accessed_at columns don't exist yet — fall back
    hasAccessColumns = false;
    const rows = db
      .prepare(
        `SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned
         FROM memories
         WHERE repo = ? AND valid_to IS NULL
         ORDER BY updated_at DESC`,
      )
      .all(repo) as MemoryRecord[];
    memories = rows.map((r) => ({
      ...r,
      last_accessed_at: null,
      access_count: 0,
    }));
  }

  const candidates: ConsolidationCandidate[] = [];

  // 1. Find stale memories: never accessed, old, not pinned.
  // Only meaningful when access tracking columns exist; otherwise skip this
  // category since we cannot distinguish accessed from unaccessed.
  if (hasAccessColumns) {
    for (const mem of memories) {
      if (candidates.length >= maxCandidates) break;
      if (
        !mem.pinned &&
        mem.access_count === 0 &&
        mem.updated_at < staleThreshold
      ) {
        candidates.push({
          memory: mem,
          issue: "stale",
          details: `Never retrieved since creation (${Math.floor((now - mem.updated_at) / 86400)} days old). May be outdated or irrelevant.`,
        });
      }
    }
  }

  // 2. Find redundant pairs (similarity >= 0.70).
  // Limit to the most recent SIMILARITY_SCAN_LIMIT memories for O(n²) bound.
  const scanSet = memories.slice(0, SIMILARITY_SCAN_LIMIT);
  const seenPairs = new Set<string>();
  for (let i = 0; i < scanSet.length && candidates.length < maxCandidates; i++) {
    for (let j = i + 1; j < scanSet.length && candidates.length < maxCandidates; j++) {
      const sim = similarity(scanSet[i].note, scanSet[j].note);
      if (sim >= 0.70) {
        const pairKey = `${scanSet[i].row_id}:${scanSet[j].row_id}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        candidates.push({
          memory: scanSet[j],
          issue: "redundant",
          details: `${Math.round(sim * 100)}% similar to memory #${scanSet[i].row_id}: "${scanSet[i].note.slice(0, 80)}..."`,
          relatedIds: [scanSet[i].row_id],
        });
      }
    }
  }

  // 3. Find potential contradictions (negation language about same entities).
  const NEGATION =
    /\b(?:no longer|stopped|removed|replaced|deprecated|don't|doesn't|shouldn't|never|disabled)\b/i;
  for (let i = 0; i < scanSet.length && candidates.length < maxCandidates; i++) {
    if (!NEGATION.test(scanSet[i].note)) continue;
    for (let j = 0; j < scanSet.length && candidates.length < maxCandidates; j++) {
      if (i === j) continue;
      if (NEGATION.test(scanSet[j].note)) continue; // skip if both negate
      const sim = similarity(scanSet[i].note, scanSet[j].note);
      if (sim >= 0.28 && sim < 0.70) {
        const pairKey = `contra:${scanSet[i].row_id}:${scanSet[j].row_id}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        candidates.push({
          memory: scanSet[j],
          issue: "contradicted",
          details: `May be contradicted by memory #${scanSet[i].row_id}: "${scanSet[i].note.slice(0, 80)}"`,
          relatedIds: [scanSet[i].row_id],
        });
      }
    }
  }

  // Build summary
  const staleCount = candidates.filter((c) => c.issue === "stale").length;
  const redundantCount = candidates.filter((c) => c.issue === "redundant").length;
  const contradictedCount = candidates.filter((c) => c.issue === "contradicted").length;

  let summary = `Analyzed ${memories.length} live memories for ${repo}.\n`;
  if (candidates.length === 0) {
    summary += "No maintenance candidates found. Memory is clean.";
  } else {
    summary += `Found ${candidates.length} candidates for review:\n`;
    if (staleCount > 0)
      summary += `- ${staleCount} stale (never accessed, >=${staleDays} days old)\n`;
    if (redundantCount > 0)
      summary += `- ${redundantCount} redundant (>=70% similar to another memory)\n`;
    if (contradictedCount > 0)
      summary += `- ${contradictedCount} potentially contradicted\n`;
    summary += "\nReview each candidate and decide: supersede, update, merge, or keep as-is.";
  }

  return { repo, totalMemories: memories.length, candidates, summary };
}

/**
 * Format the consolidation report as a prompt-ready text block.
 */
export function formatConsolidationReport(report: ConsolidationReport): string {
  const lines: string[] = [
    `# Memory Consolidation Report: ${report.repo}`,
    "",
    report.summary,
    "",
  ];

  if (report.candidates.length === 0) return lines.join("\n");

  lines.push("## Candidates for review", "");

  for (const candidate of report.candidates) {
    const badge =
      candidate.issue === "stale"
        ? "🕸️"
        : candidate.issue === "redundant"
          ? "🔁"
          : "⚠️";
    lines.push(
      `${badge} **#${candidate.memory.row_id}** [${candidate.issue}] ${candidate.memory.note.slice(0, 120)}`,
      `   ${candidate.details}`,
      "",
    );
  }

  lines.push(
    "## Suggested actions",
    "",
    "- For stale memories: call `supersede_memory` if outdated, or `delete_memory` if wrong.",
    "- For redundant pairs: call `update_memory` to merge the notes, then `delete_memory` on the duplicate.",
    "- For contradictions: read both, decide which is current, `supersede_memory` the old one.",
  );

  return lines.join("\n");
}
