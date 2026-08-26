/**
 * Retrieval metrics.
 *
 * Definitions are spelled out because "R@5" means different things in different
 * papers, and a headline number is worthless if the definition is ambiguous.
 * Everything here operates on a ranked list of retrieved ids plus the set of
 * ids considered relevant for that query.
 */

export interface QueryOutcome {
  /** Ranked ids, best first. */
  retrieved: string[];
  /** Ids that count as correct answers for this query. */
  relevant: string[];
}

export interface MetricSummary {
  queries: number;
  /** Fraction of queries with at least one relevant id in the top k.
   * This is the "R@k" quoted by most agent-memory leaderboards. */
  hitRate: Record<number, number>;
  /** Mean over queries of |relevant ∩ topK| / |relevant| — how much of the
   * full answer set was recovered, not just whether anything was. */
  recall: Record<number, number>;
  /** Mean reciprocal rank of the first relevant id (0 when none retrieved). */
  mrr: number;
  /** Normalized discounted cumulative gain at k, binary relevance. */
  ndcg: Record<number, number>;
}

const DEFAULT_KS = [1, 3, 5, 10];

function hitAtK(outcome: QueryOutcome, k: number): number {
  const relevant = new Set(outcome.relevant);
  return outcome.retrieved.slice(0, k).some((id) => relevant.has(id)) ? 1 : 0;
}

function recallAtK(outcome: QueryOutcome, k: number): number {
  if (outcome.relevant.length === 0) {
    return 0;
  }
  const relevant = new Set(outcome.relevant);
  let found = 0;
  for (const id of outcome.retrieved.slice(0, k)) {
    if (relevant.has(id)) {
      found += 1;
    }
  }
  return found / relevant.size;
}

function reciprocalRank(outcome: QueryOutcome): number {
  const relevant = new Set(outcome.relevant);
  for (let i = 0; i < outcome.retrieved.length; i += 1) {
    if (relevant.has(outcome.retrieved[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function ndcgAtK(outcome: QueryOutcome, k: number): number {
  const relevant = new Set(outcome.relevant);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, outcome.retrieved.length); i += 1) {
    if (relevant.has(outcome.retrieved[i])) {
      // Binary gain, log2(rank + 1) discount.
      dcg += 1 / Math.log2(i + 2);
    }
  }

  // Ideal DCG: every relevant item packed into the top positions.
  const ideal = Math.min(k, relevant.size);
  let idcg = 0;
  for (let i = 0; i < ideal; i += 1) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export function summarize(
  outcomes: QueryOutcome[],
  ks: number[] = DEFAULT_KS,
): MetricSummary {
  const hitRate: Record<number, number> = {};
  const recall: Record<number, number> = {};
  const ndcg: Record<number, number> = {};

  for (const k of ks) {
    hitRate[k] = round(mean(outcomes.map((o) => hitAtK(o, k))));
    recall[k] = round(mean(outcomes.map((o) => recallAtK(o, k))));
    ndcg[k] = round(mean(outcomes.map((o) => ndcgAtK(o, k))));
  }

  return {
    queries: outcomes.length,
    hitRate,
    recall,
    mrr: round(mean(outcomes.map(reciprocalRank))),
    ndcg,
  };
}

/** Group outcomes by an arbitrary label so per-category breakdowns are cheap. */
export function summarizeByCategory(
  labelled: Array<{ category: string; outcome: QueryOutcome }>,
  ks: number[] = DEFAULT_KS,
): Record<string, MetricSummary> {
  const groups = new Map<string, QueryOutcome[]>();
  for (const { category, outcome } of labelled) {
    const bucket = groups.get(category);
    if (bucket) {
      bucket.push(outcome);
    } else {
      groups.set(category, [outcome]);
    }
  }

  const out: Record<string, MetricSummary> = {};
  for (const [category, outcomes] of Array.from(groups.entries()).sort()) {
    out[category] = summarize(outcomes, ks);
  }
  return out;
}
