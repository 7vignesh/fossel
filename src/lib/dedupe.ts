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

/** Lower bound for "related" candidates surfaced for conflict review.
 * Calibrated against the blended word+trigram similarity metric: unrelated
 * notes score well below 0.2, while same-topic notes with different wording
 * land around 0.3. Below this floor, notes are too unrelated to flag. */
const DEFAULT_RELATED_FLOOR = 0.28;

/**
 * Lightweight negation/contradiction cue detection. We can't truly reason
 * about contradictions without an LLM, so we surface a hint when one note
 * carries negation/replacement language the other lacks, on top of a
 * meaningful similarity overlap. The client's model makes the final call.
 */
const CONTRADICTION_CUES =
  /\b(?:no longer|not|never|stop|stopped|deprecated|removed?|drop(?:ped)?|replace[ds]?|switch(?:ed)?|migrat(?:e|ed|ing)|instead|abandon(?:ed)?|don't|doesn't|won't|isn't|aren't)\b/i;

export interface RelatedCandidate {
  memory: MemoryRecord;
  similarity: number;
  /** True when negation/replacement language suggests the new note may
   * supersede or contradict this one. Advisory only. */
  possibleContradiction: boolean;
}

export interface RelatedOptions extends DedupeOptions {
  /** Inclusive lower similarity bound for "related". */
  floor?: number;
  /** Exclusive upper bound; matches at/above this are duplicates handled by
   * findDuplicate, so they are excluded here. Defaults to the dedup threshold. */
  ceiling?: number;
  /** Max number of related candidates to return. */
  max?: number;
}

/**
 * Find memories that are *related but not duplicates* of `note` — the mid-band
 * between "clearly the same idea" (handled by findDuplicate) and "unrelated".
 * These are candidates the calling agent may want to update or delete if the
 * new note supersedes or contradicts them.
 *
 * This is the dependency-free analogue of mem0's LLM ADD/UPDATE/DELETE step:
 * Fossel surfaces the candidates and lets the MCP client's own model decide.
 * Returns best-first, highest similarity first.
 */
export function findRelatedCandidates(
  db: Database.Database,
  repo: string,
  note: string,
  options: RelatedOptions = {},
): RelatedCandidate[] {
  const floor = options.floor ?? DEFAULT_RELATED_FLOOR;
  const ceiling = options.ceiling ?? DEFAULT_THRESHOLD;
  const limit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const max = options.max ?? 3;
  const normalized = normalizeText(note);

  if (!normalized || floor >= ceiling) {
    return [];
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

  const noteHasCue = CONTRADICTION_CUES.test(note);
  const related: RelatedCandidate[] = [];
  for (const candidate of candidates) {
    const score = similarity(note, candidate.note);
    if (score >= floor && score < ceiling) {
      // Flag a possible contradiction when negation/replacement language is
      // present in exactly one of the two notes (a likely supersede signal).
      const candidateHasCue = CONTRADICTION_CUES.test(candidate.note);
      related.push({
        memory: candidate,
        similarity: score,
        possibleContradiction: noteHasCue !== candidateHasCue,
      });
    }
  }

  related.sort((a, b) => b.similarity - a.similarity);
  return related.slice(0, max);
}
