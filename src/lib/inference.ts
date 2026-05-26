import { type MemoryType } from "../db/client.js";

export interface InferredMemory {
  type: MemoryType;
  tags: string[];
}

interface TypeRule {
  type: MemoryType;
  // Regex patterns the rule will look for. Each rule also carries a weight so
  // that more specific signals (e.g. "decided not to") outrank generic ones
  // (e.g. "decision").
  patterns: Array<{ pattern: RegExp; weight: number }>;
}

const TYPE_RULES: TypeRule[] = [
  {
    type: "bug_fix",
    patterns: [
      { pattern: /\broot cause\b/i, weight: 4 },
      { pattern: /\bregression\b/i, weight: 4 },
      { pattern: /\bhotfix\b/i, weight: 4 },
      { pattern: /\bfix(?:ed|es|ing)?\b/i, weight: 3 },
      { pattern: /\bbugs?\b/i, weight: 2 },
      { pattern: /\bcrash(?:ed|es|ing)?\b/i, weight: 2 },
      { pattern: /\bbroken\b/i, weight: 2 },
      { pattern: /\bworkaround\b/i, weight: 2 },
    ],
  },
  {
    type: "issue",
    patterns: [
      { pattern: /\bissue\s*#\d+/i, weight: 5 },
      { pattern: /\bticket\s*#?\w+/i, weight: 4 },
      { pattern: /\bjira[-\s]?\w+/i, weight: 4 },
      { pattern: /\bgh[-\s]?\d+/i, weight: 3 },
      { pattern: /#\d{2,}/i, weight: 2 },
    ],
  },
  {
    type: "decision",
    patterns: [
      { pattern: /\bdecided not to\b/i, weight: 5 },
      { pattern: /\bdecided to\b/i, weight: 4 },
      { pattern: /\bwe chose\b/i, weight: 4 },
      { pattern: /\bchose\s+\w+\s+over\b/i, weight: 4 },
      { pattern: /\barchitecture\b/i, weight: 3 },
      { pattern: /\bdecision\b/i, weight: 3 },
      { pattern: /\btrade[- ]?off\b/i, weight: 2 },
      { pattern: /\brfc\b/i, weight: 2 },
      { pattern: /\b(?:adopted|migrated to)\b/i, weight: 2 },
    ],
  },
  {
    type: "reviewer_pattern",
    patterns: [
      { pattern: /\breviewer(?:s)?\s+(?:prefer|want|expect|require)/i, weight: 5 },
      { pattern: /\bpr\s+style\b/i, weight: 4 },
      { pattern: /\bcode review\b/i, weight: 3 },
      { pattern: /\bprefer(?:s|red)?\b/i, weight: 2 },
      { pattern: /\breview comment\b/i, weight: 2 },
    ],
  },
  {
    type: "convention",
    patterns: [
      { pattern: /\bconvention\b/i, weight: 4 },
      { pattern: /\balways\b/i, weight: 2 },
      { pattern: /\bnever\b/i, weight: 2 },
      { pattern: /\bstandard\b/i, weight: 2 },
      { pattern: /\bstyle guide\b/i, weight: 3 },
      { pattern: /\buse\b\s+\w+\s+\bfor\b/i, weight: 1 },
    ],
  },
];

// Auth-style notes are ambiguous: a statement of fact ("JWT lives in
// localStorage") reads more like a convention; a statement of choice
// ("we chose JWT over sessions") is a decision. We bias toward decision when
// choice-like language is present, otherwise convention.
const AUTH_KEYWORDS = /\b(?:auth|jwt|oauth|token|login|logout|session|sso|saml)\b/i;
const CHOICE_KEYWORDS =
  /\b(?:chose|choose|decided|prefer|switched|migrated|adopted|over|instead of)\b/i;

const TAG_KEYWORDS: Array<{ tag: string; pattern: RegExp }> = [
  { tag: "auth", pattern: /\b(?:auth|authentication|authorization)\b/i },
  { tag: "jwt", pattern: /\bjwt\b/i },
  { tag: "oauth", pattern: /\boauth\b/i },
  { tag: "session", pattern: /\bsession(?:s)?\b/i },
  { tag: "api", pattern: /\bapi\b/i },
  { tag: "rest", pattern: /\brest(?:ful)?\b/i },
  { tag: "graphql", pattern: /\bgraphql\b/i },
  { tag: "websocket", pattern: /\bweb[- ]?socket(?:s)?\b/i },
  { tag: "database", pattern: /\b(?:database|db|sqlite|postgres|mysql|mongo)\b/i },
  { tag: "migration", pattern: /\bmigration(?:s)?\b/i },
  { tag: "schema", pattern: /\bschema\b/i },
  { tag: "frontend", pattern: /\b(?:frontend|ui|react|vue|svelte|next\.js|nextjs)\b/i },
  { tag: "backend", pattern: /\b(?:backend|server|node\.js|nodejs|express|fastify)\b/i },
  { tag: "testing", pattern: /\b(?:test|tests|testing|jest|vitest|pytest|rspec)\b/i },
  { tag: "ci", pattern: /\b(?:ci|cd|pipeline|github actions|gitlab ci)\b/i },
  { tag: "deployment", pattern: /\b(?:deploy|deployment|release|rollout)\b/i },
  { tag: "performance", pattern: /\b(?:performance|perf|latency|throughput)\b/i },
  { tag: "security", pattern: /\b(?:security|vuln|cve|xss|csrf|injection)\b/i },
  { tag: "logging", pattern: /\b(?:log|logging|telemetry|tracing)\b/i },
  { tag: "config", pattern: /\b(?:config|configuration|env|environment)\b/i },
  { tag: "routing", pattern: /\b(?:route|routing|router|endpoint)\b/i },
  { tag: "build", pattern: /\b(?:build|webpack|vite|tsup|rollup|esbuild)\b/i },
  { tag: "docs", pattern: /\b(?:docs|documentation|readme)\b/i },
];

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","is","are","was","were","be","been","being",
  "to","of","in","on","for","with","by","at","from","as","that","this","it",
  "we","our","you","your","i","my","they","their","them","he","she","his","her",
  "if","then","than","so","do","does","did","done","not","no","yes","can","will",
  "would","should","could","may","might","must","have","has","had","just","also",
  "use","used","using","want","wants","wanted","need","needs","needed","like",
  "now","new","old","good","bad","make","makes","made","get","gets","got",
  "set","sets","go","going","into","over","under","through","because","when",
  "where","while","there","here","what","which","who","why","how",
  "live","lives","living","keep","kept","keeps","take","takes","took","taken",
  "say","says","said","tell","tells","told","know","knows","known","knew",
  "redirect","redirects","redirected","redirecting","user","users","page","pages",
]);

/**
 * Infer a memory_type from free-form text using the v1 heuristic rules.
 * Falls back to "convention" when nothing matches.
 */
export function inferMemoryType(text: string): MemoryType {
  const scores = new Map<MemoryType, number>();

  for (const rule of TYPE_RULES) {
    let score = 0;
    for (const { pattern, weight } of rule.patterns) {
      if (pattern.test(text)) {
        score += weight;
      }
    }
    if (score > 0) {
      scores.set(rule.type, (scores.get(rule.type) ?? 0) + score);
    }
  }

  if (AUTH_KEYWORDS.test(text)) {
    if (CHOICE_KEYWORDS.test(text)) {
      scores.set("decision", (scores.get("decision") ?? 0) + 3);
    } else {
      scores.set("convention", (scores.get("convention") ?? 0) + 2);
    }
  }

  if (scores.size === 0) {
    return "convention";
  }

  let bestType: MemoryType = "convention";
  let bestScore = -1;
  for (const [type, score] of scores) {
    if (score > bestScore) {
      bestType = type;
      bestScore = score;
    }
  }

  return bestType;
}

function extractKeywordTags(text: string): string[] {
  const found: string[] = [];
  for (const { tag, pattern } of TAG_KEYWORDS) {
    if (pattern.test(text)) {
      found.push(tag);
    }
  }
  return found;
}

function extractIdentifierTags(text: string): string[] {
  // Pull out short kebab/snake/camel identifiers and file-extension hints so
  // notes like "fix /api/auth bug" or "update vite.config.ts" surface useful
  // tags without manual entry.
  const tokens = new Set<string>();

  const pathLike = text.match(/\/(?:[a-z0-9_-]+\/?){1,4}/gi);
  if (pathLike) {
    for (const segment of pathLike) {
      for (const part of segment.split("/")) {
        if (part.length >= 3 && /^[a-z0-9_-]+$/i.test(part)) {
          tokens.add(part.toLowerCase());
        }
      }
    }
  }

  const fileLike = text.match(/\b[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rb|rs|java|kt|sql|md|json|yml|yaml)\b/gi);
  if (fileLike) {
    for (const file of fileLike) {
      const base = file.split(".").slice(0, -1).join(".");
      if (base.length >= 3) {
        tokens.add(base.toLowerCase());
      }
    }
  }

  return Array.from(tokens);
}

function extractSalientWords(text: string, limit: number): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s/_-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));

  const counts = new Map<string, number>();
  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

/**
 * Generate 2–5 lower-cased, deduplicated tags from free-form text.
 * Strategy: keyword tags first (highest signal), then identifier-like tokens,
 * then salient nouns, capped at 5.
 */
export function inferTags(text: string): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const push = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    ordered.push(normalized);
  };

  for (const tag of extractKeywordTags(text)) {
    push(tag);
  }
  for (const tag of extractIdentifierTags(text)) {
    push(tag);
  }

  if (ordered.length < 5) {
    for (const word of extractSalientWords(text, 8)) {
      push(word);
      if (ordered.length >= 5) {
        break;
      }
    }
  }

  return ordered.slice(0, 5);
}

/**
 * Convenience wrapper that returns both type and tags in a single pass.
 */
export function inferMemoryFromNote(text: string): InferredMemory {
  return {
    type: inferMemoryType(text),
    tags: inferTags(text),
  };
}
