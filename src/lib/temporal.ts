/**
 * Temporal grounding for memories.
 *
 * Relative time references rot: "fixed last week" is useless six months later.
 * mem0 solves this with an LLM that resolves relative dates against an
 * observation date. Fossel does it with a dependency-free heuristic: detect
 * common relative-date phrases in a note and append the resolved absolute date
 * so the memory stays meaningful over time.
 *
 * This is intentionally conservative \u2014 it only annotates phrases it can resolve
 * unambiguously, and never rewrites or removes the original wording. The note
 * gets a trailing "(<phrase> = YYYY-MM-DD)" annotation; the audit trail is the
 * note text itself.
 */

/** Format a Date as YYYY-MM-DD in UTC. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

interface ResolvedPhrase {
  /** The matched phrase, lower-cased. */
  phrase: string;
  /** Resolved absolute date (YYYY-MM-DD). */
  date: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a set of common relative-date phrases against a reference date
 * (defaults to now). Returns one entry per distinct phrase found, in order of
 * appearance. Only unambiguous phrases are resolved; vague ones ("recently",
 * "soon") are deliberately skipped because guessing a date would be misleading.
 */
export function resolveRelativeDates(
  text: string,
  reference: Date = new Date(),
): ResolvedPhrase[] {
  const found: ResolvedPhrase[] = [];
  const seen = new Set<string>();
  const lower = text.toLowerCase();

  const push = (phrase: string, date: Date) => {
    if (seen.has(phrase)) {
      return;
    }
    seen.add(phrase);
    found.push({ phrase, date: isoDate(date) });
  };

  // Single-word / fixed phrases.
  if (/\byesterday\b/.test(lower)) {
    push("yesterday", addDays(reference, -1));
  }
  if (/\btoday\b/.test(lower)) {
    push("today", reference);
  }
  if (/\btomorrow\b/.test(lower)) {
    push("tomorrow", addDays(reference, 1));
  }
  if (/\blast week\b/.test(lower)) {
    push("last week", addDays(reference, -7));
  }
  if (/\bnext week\b/.test(lower)) {
    push("next week", addDays(reference, 7));
  }
  if (/\blast month\b/.test(lower)) {
    const d = new Date(reference);
    d.setUTCMonth(d.getUTCMonth() - 1);
    push("last month", d);
  }
  if (/\bnext month\b/.test(lower)) {
    const d = new Date(reference);
    d.setUTCMonth(d.getUTCMonth() + 1);
    push("next month", d);
  }

  // "N days/weeks/months ago" and "in N days/weeks/months".
  const agoPattern = /\b(\d{1,3})\s+(day|days|week|weeks|month|months)\s+ago\b/g;
  for (const match of lower.matchAll(agoPattern)) {
    const amount = Number(match[1]);
    const unit = match[2];
    const date = shiftByUnit(reference, -amount, unit);
    push(`${amount} ${unit} ago`, date);
  }

  const inPattern = /\bin\s+(\d{1,3})\s+(day|days|week|weeks|month|months)\b/g;
  for (const match of lower.matchAll(inPattern)) {
    const amount = Number(match[1]);
    const unit = match[2];
    const date = shiftByUnit(reference, amount, unit);
    push(`in ${amount} ${unit}`, date);
  }

  return found;
}

function shiftByUnit(reference: Date, amount: number, unit: string): Date {
  if (unit.startsWith("day")) {
    return new Date(reference.getTime() + amount * DAY_MS);
  }
  if (unit.startsWith("week")) {
    return new Date(reference.getTime() + amount * 7 * DAY_MS);
  }
  // months
  const d = new Date(reference);
  d.setUTCMonth(d.getUTCMonth() + amount);
  return d;
}

/**
 * Annotate a note with resolved absolute dates for any relative phrases it
 * contains. Returns the note unchanged when nothing resolvable is found, so
 * the common case is a no-op. The original wording is preserved; resolved
 * dates are appended in a compact parenthetical so the note remains
 * meaningful after the relative reference would have gone stale.
 *
 * Example:
 *   "fixed the race condition last week"
 *   -> "fixed the race condition last week (last week = 2026-06-19)"
 */
export function groundTemporalReferences(
  note: string,
  reference: Date = new Date(),
): string {
  const resolved = resolveRelativeDates(note, reference);
  if (resolved.length === 0) {
    return note;
  }

  // Avoid double-annotating a note that already carries a resolved date for
  // the same phrase (e.g. an edited/re-saved note).
  const annotations = resolved
    .filter(({ phrase, date }) => !note.includes(`${phrase} = ${date}`))
    .map(({ phrase, date }) => `${phrase} = ${date}`);

  if (annotations.length === 0) {
    return note;
  }

  return `${note} (${annotations.join("; ")})`;
}
