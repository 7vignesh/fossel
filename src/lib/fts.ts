/**
 * Shared FTS5 query construction and execution.
 *
 * Both retrieval paths — `get_context` (via `fetchRepoContext`) and
 * `search_memory` — need the same three things: tokenize a free-form query into
 * FTS-safe terms, build a MATCH expression, and fall back from a narrow AND to
 * a broad OR when AND finds nothing. They previously had separate, unequal
 * implementations: `search_memory` had the OR fallback and the path/identifier
 * aware tokenizer, `get_context` had neither. The benchmark made the cost
 * visible — AND-only meant `get_context` returned nothing at all for any
 * multi-word natural-language question, which is the most common way an agent
 * queries it.
 *
 * Keeping one implementation here means the two tools cannot drift apart again.
 */

import type Database from "better-sqlite3";
import type { MemoryRecord } from "../db/client.js";

export interface FtsRow extends MemoryRecord {
  rank: number;
}

/**
 * Conservative English suffix stripping, longest suffix first.
 *
 * Not a real stemmer — deliberately. Porter-style stemming is aggressive and
 * would need either a dependency or several hundred lines of rules, and the
 * failures it needs to fix here are almost entirely simple inflection:
 * `alerts` vs `alert`, `files` vs `file`, `deployment` vs `deploys`. A short
 * suffix table plus FTS5's native prefix matching covers those without pulling
 * in a linguistics library.
 *
 * The `MIN_STEM_LENGTH` guard is what keeps this safe: refusing to produce a
 * stem shorter than 4 characters stops it turning short words into
 * near-universal prefixes that would match most of the corpus.
 *
 * **Invariant: the result is always a prefix of the input.** That is what makes
 * it correct to use with FTS5 prefix matching — `stem*` is then guaranteed to
 * match the original token as well as its variants. A classic stemmer would map
 * "policies" to "policy", which is *not* a prefix and so would fail to match
 * "policies"; stripping to "polic" matches both forms. Precision of the stem
 * matters less than the prefix property here, and imprecise stems are harmless
 * because the prefix tier only ever appends rows.
 */
const SUFFIXES = ["ments", "ment", "ings", "ing", "ies", "ers", "er", "es", "ed", "s"];
const MIN_STEM_LENGTH = 4;

export function lightStem(token: string): string {
  for (const suffix of SUFFIXES) {
    if (token.length - suffix.length >= MIN_STEM_LENGTH && token.endsWith(suffix)) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

/**
 * Build a prefix MATCH expression from stemmed tokens, e.g. `"alert"* OR
 * "deploy"*`. Tokens that do not stem to something usefully shorter are dropped:
 * a prefix query identical to the plain token adds nothing the OR tier did not
 * already try.
 */
export function buildPrefixExpression(tokens: string[]): string | null {
  const stems = Array.from(
    new Set(
      tokens
        .map((token) => lightStem(token))
        .filter((stem) => stem.length >= MIN_STEM_LENGTH),
    ),
  );
  if (stems.length === 0) {
    return null;
  }
  return stems.map((stem) => `"${stem.replace(/"/g, '""')}"*`).join(" OR ");
}

/**
 * Tokenize a free-form query into FTS-safe terms. Punctuation is stripped and
 * `/`, `_`, `-`, `.` are treated as separators so paths like `/api/auth` and
 * filenames like `env.schema.ts` produce useful tokens. Tokens shorter than two
 * characters are dropped as FTS noise.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/["()]/g, " ")
    .split(/[\s/_\-.,;:!?]+/)
    .map((token) => token.replace(/[^a-z0-9*]/g, ""))
    .filter((token) => token.length >= 2);
}

/**
 * Build a MATCH expression from tokens. Every token is quoted so user input can
 * never be interpreted as FTS syntax.
 */
export function buildMatchExpression(
  tokens: string[],
  operator: "AND" | "OR",
): string | null {
  if (tokens.length === 0) {
    return null;
  }
  return tokens
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(` ${operator} `);
}

function runMatch(
  db: Database.Database,
  expression: string,
  repo: string | undefined,
  limit: number,
): FtsRow[] {
  try {
    if (repo) {
      return db
        .prepare(
          `
            SELECT m.rowid AS row_id, m.id, m.repo, m.type, m.note, m.tags,
                   m.created_at, m.updated_at, m.pinned, bm25(memories_fts) AS rank
            FROM memories_fts
            JOIN memories AS m ON m.rowid = memories_fts.rowid
            WHERE memories_fts MATCH ? AND m.repo = ?
            ORDER BY rank
            LIMIT ?
          `,
        )
        .all(expression, repo, limit) as FtsRow[];
    }
    return db
      .prepare(
        `
          SELECT m.rowid AS row_id, m.id, m.repo, m.type, m.note, m.tags,
                 m.created_at, m.updated_at, m.pinned, bm25(memories_fts) AS rank
          FROM memories_fts
          JOIN memories AS m ON m.rowid = memories_fts.rowid
          WHERE memories_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `,
      )
      .all(expression, limit) as FtsRow[];
  } catch {
    // FTS5 rejects some inputs (only-stop-character queries, a stray quote).
    // Failing soft keeps the surrounding fallbacks useful.
    return [];
  }
}

export interface FtsSearchResult {
  rows: FtsRow[];
  /** Which operator produced the leading rows. Null when nothing matched. */
  matched: "AND" | "OR" | null;
  /** True when the stemmed-prefix pass contributed rows the exact-token passes
   * missed. */
  usedPrefix: boolean;
}

export interface FtsSearchOptions {
  repo?: string;
  limit: number;
}

/**
 * Run an FTS search, narrowing first and broadening only as needed.
 *
 * Three tiers, in order:
 *
 *  1. **AND** — every term present. Highest precision, tried first.
 *  2. **OR** — any term present. Runs when AND matched nothing, so a question
 *     phrased in prose or carrying one unmatched qualifier still returns its
 *     relevant rows. BM25 handles the ordering, and because BM25 already
 *     discounts terms appearing in many documents, the common words that widen
 *     the query contribute little to the ranking.
 *  3. **Stemmed prefix** — `"alert"*`, `"deploy"*`. Fills remaining slots only,
 *     appending rows the exact-token tiers missed rather than reordering what
 *     they found, so it can only add recall, never displace an exact hit. It
 *     exists because FTS5 has no stemming, which made queries fail purely on
 *     inflection: "alerts" not matching "alert channel", "file" not matching
 *     ".env files", "deployment" not matching "Deploys go out". Measured worth:
 *     +9.1 points of hit@5 on the repo-memory benchmark, the single largest
 *     retrieval gain in the project.
 *
 * Tried and rejected: a fourth tier doing RM3-style pseudo-relevance feedback —
 * mine the top few results for terms the query lacked, then re-query with them
 * added. Measured inert: identical hit@k and miss count, with hybrid MRR
 * slightly *down* (0.832 -> 0.827). The reason is visible in the failure list —
 * the queries that still miss return no relevant row at all, so the feedback set
 * is entirely irrelevant documents and expansion just drifts the query. RM3
 * needs a decent first pass to bootstrap from; when the first pass fails
 * completely there is nothing to learn. Not kept.
 */
export function searchFts(
  db: Database.Database,
  query: string,
  options: FtsSearchOptions,
): FtsSearchResult {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return { rows: [], matched: null, usedPrefix: false };
  }

  let rows: FtsRow[] = [];
  let matched: "AND" | "OR" | null = null;

  const andExpression = buildMatchExpression(tokens, "AND");
  if (andExpression) {
    rows = runMatch(db, andExpression, options.repo, options.limit);
    if (rows.length > 0) {
      matched = "AND";
    }
  }

  if (rows.length === 0 && tokens.length > 1) {
    const orExpression = buildMatchExpression(tokens, "OR");
    if (orExpression) {
      rows = runMatch(db, orExpression, options.repo, options.limit);
      if (rows.length > 0) {
        matched = "OR";
      }
    }
  }

  // Tier 3 fills leftover slots only, so exact-token ranking is preserved.
  let usedPrefix = false;
  if (rows.length < options.limit) {
    const prefixExpression = buildPrefixExpression(tokens);
    if (prefixExpression) {
      const seen = new Set(rows.map((row) => row.row_id));
      const extra = runMatch(
        db,
        prefixExpression,
        options.repo,
        options.limit,
      ).filter((row) => !seen.has(row.row_id));
      if (extra.length > 0) {
        rows = [...rows, ...extra].slice(0, options.limit);
        usedPrefix = true;
        matched = matched ?? "OR";
      }
    }
  }

  return { rows, matched, usedPrefix };
}
