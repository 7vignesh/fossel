import type Database from "better-sqlite3";
import type { MemoryRecord } from "../db/client.js";

export interface DuplicateMatch {
  memory: MemoryRecord;
  similarity: number;
}

export interface DedupeOptions {
  /** Minimum Jaccard score to consider two notes near-duplicates. */
  threshold?: number;
  /** Cap candidate scan size. Larger values raise recall but cost CPU. */
  candidateLimit?: number;
}

const DEFAULT_THRESHOLD = 0.82;
const DEFAULT_CANDIDATE_LIMIT = 200;

/**
 * Lower-case, strip punctuation, collapse whitespace. Used both for storage
 * (`memories.note_normalized`) and for live similarity comparisons so the two
 * code paths stay in lockstep.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokenize on whitespace and keep tokens of length >= 2 to avoid noise from
 * single-character fragments.
 */
function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length >= 2);
}

/**
 * Generate character trigrams from a normalized string. Used as a backup
 * similarity signal for short notes where word-level overlap is too coarse.
 */
function trigrams(text: string): Set<string> {
  const padded = ` ${text} `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Combined similarity score in [0, 1]. We blend word-level Jaccard with
 * trigram Jaccard so that short and long notes are both handled gracefully:
 *  - long notes lean on word overlap (tokens dominate)
 *  - short notes lean on trigram overlap (characters dominate)
 */
export function similarity(a: string, b: string): number {
  const normalizedA = normalizeText(a);
  const normalizedB = normalizeText(b);
  if (!normalizedA && !normalizedB) {
    return 1;
  }
  if (!normalizedA || !normalizedB) {
    return 0;
  }
  if (normalizedA === normalizedB) {
    return 1;
  }

  const wordScore = jaccard(new Set(tokenize(normalizedA)), new Set(tokenize(normalizedB)));
  const triScore = jaccard(trigrams(normalizedA), trigrams(normalizedB));

  // Weight slightly toward trigrams so that minor wording changes still merge.
  return wordScore * 0.55 + triScore * 0.45;
}

/**
 * Look for an existing memory in `repo` whose note is similar enough to be
 * considered the same idea. Returns the best match above the threshold or
 * `null` when no match qualifies.
 */
export function findDuplicate(
  db: Database.Database,
  repo: string,
  note: string,
  options: DedupeOptions = {},
): DuplicateMatch | null {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const limit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const normalized = normalizeText(note);

  if (!normalized) {
    return null;
  }

  // Fast path: exact normalized match. Avoids similarity work entirely for the
  // common "user pasted the same note again" case.
  const exact = db
    .prepare(
      `
        SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned
        FROM memories
        WHERE repo = ? AND note_normalized = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(repo, normalized) as MemoryRecord | undefined;

  if (exact) {
    return { memory: exact, similarity: 1 };
  }

  const candidates = db
    .prepare(
      `
        SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned
        FROM memories
        WHERE repo = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(repo, limit) as MemoryRecord[];

  let best: DuplicateMatch | null = null;
  for (const candidate of candidates) {
    const score = similarity(note, candidate.note);
    if (score >= threshold && (!best || score > best.similarity)) {
      best = { memory: candidate, similarity: score };
    }
  }

  return best;
}
