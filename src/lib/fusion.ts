/**
 * Rank fusion.
 *
 * Reciprocal Rank Fusion combines several ranked lists without needing their
 * score scales to be comparable: each list contributes `weight / (k + rank)` to
 * every item it returns, and items ranked highly by more than one list rise.
 *
 * The weights exist because equal-weight fusion is only correct when the legs
 * are equally strong, and ours are not. Measured on the committed repo-memory
 * benchmark, BM25 keyword search reaches 81.8% hit@5 while the built-in
 * feature-hashed embedding reaches 75.8% with a much weaker MRR (0.52 vs 0.74).
 * Fusing those at equal weight let the weaker leg displace good keyword hits, so
 * hybrid scored *below* FTS-only at k=5. Down-weighting the vector leg keeps its
 * genuine contribution — extra reach at larger k, and multi-answer recall —
 * without letting it outvote the stronger signal near the top of the list.
 *
 * `DEFAULT_VECTOR_WEIGHT` was chosen by sweeping it against the benchmark
 * (`npx tsx bench/sweep.ts`), not picked by feel.
 */

/** RRF smoothing constant. 60 is the value from the original RRF paper and is
 * what most implementations use; it makes the curve flat enough that a rank-1
 * and a rank-3 hit are not wildly far apart. */
export const RRF_K = 60;

/** Weight for the BM25 keyword leg. */
export const DEFAULT_FTS_WEIGHT = 1;

/**
 * Weight for the vector leg, relative to the keyword leg.
 *
 * Chosen by sweeping it against the repo-memory benchmark
 * (`npx tsx bench/sweep.ts --sweep vector`), not by feel. The sweep has been run
 * twice, and the history matters:
 *
 *  - Against the original unweighted embedder the optimum was ~0.2. At equal
 *    weight (1.0) the weaker semantic leg displaced good BM25 hits.
 *  - After query-side IDF weighting made the vector leg substantially stronger
 *    (standalone MRR 0.519 -> 0.608), the optimum moved up to a 0.6-1.0 plateau.
 *    0.8 sits mid-plateau; 1.2 measurably degrades.
 *
 * The lesson worth keeping: this constant is coupled to the embedder's quality
 * and must be re-swept whenever the embedder changes.
 *
 * Tried and rejected: making this weight *adaptive* on whether FTS matched via
 * AND or fell back to OR, on the theory that semantics should carry the query
 * only when lexical matching failed. Measured to change nothing — the AND-match
 * weight had no effect at any value from 0 to 1, and the adaptive configuration
 * scored identically to a single fixed weight. Not kept, because inert
 * complexity is worse than none.
 */
export const DEFAULT_VECTOR_WEIGHT = 0.8;

/**
 * Minimum cosine similarity a vector hit must reach before it enters the
 * fusion. Defaults to 0 — no gating.
 *
 * Kept as a knob because it is the natural place to filter noise, but measured
 * *not* to help with the built-in hashed embedder: on the repo-memory benchmark,
 * relevant vector hits have a median cosine of 0.291 (p25 0.204) while
 * irrelevant ones sit at 0.143 (p75 0.211). The distributions overlap so much
 * that any floor tight enough to remove noise also removes real hits — sweeping
 * it showed every value either changed nothing or suppressed the vector leg back
 * to FTS-only behaviour. A stronger embedder with cleaner score separation would
 * likely benefit from a floor, which is why the parameter stays.
 */
export const DEFAULT_VECTOR_SCORE_FLOOR = 0;

/**
 * Half-life, in days, for an optional recency decay applied to fused scores.
 * Defaults to 0, which disables decay entirely (every memory keeps its raw
 * fused score). A positive value multiplies each score by 0.5 ^ (ageDays /
 * halfLife), so a memory one half-life old is worth half as much as the newest.
 *
 * Age is measured corpus-relative: against the newest memory in the fused set,
 * not the wall clock. This keeps the signal meaningful regardless of how old
 * the whole corpus is, and keeps retrieval a pure function of the stored data
 * rather than of the current time.
 *
 * Tried and rejected (#61): a recency decay term was added here behind this
 * tunable and swept with `npx tsx bench/sweep.ts --sweep recency`. On the
 * committed repo-memory benchmark every half-life from 1 to 365 days scored
 * identically to decay-off: the dataset's memories are seconds apart in age, so
 * any day-scale half-life leaves the decay factor at ~1 for all of them, and
 * the ranking never moves. The dataset is also topical, not temporal - its only
 * recency-sensitive queries are the two `superseded` cases, which supersession
 * tombstones (migration 009) already resolve by filtering `valid_to`. Kept the
 * plumbing (default 0 = inert) but did not change the default, per the working
 * agreement: a retrieval knob only ships turned on when the numbers support it.
 * Measuring this for real needs a temporally-labelled dataset ("which dated
 * instance is current") with day/week-scale age gaps, which the repo-memory set
 * is not.
 */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 0;

const SECONDS_PER_DAY = 86_400;

/**
 * Exponential recency decay factor in (0, 1]. `ageSeconds` is how much older a
 * memory is than the newest in its set; `halfLifeDays <= 0` disables decay
 * (returns 1). A memory `halfLifeDays` old scores 0.5, two half-lives 0.25, etc.
 */
export function recencyDecay(ageSeconds: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0 || ageSeconds <= 0) {
    return 1;
  }
  const ageDays = ageSeconds / SECONDS_PER_DAY;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export interface FusionWeights {
  fts: number;
  vector: number;
  entity?: number;
  edge?: number;
}

/** Default weight for the entity leg. Entity matches are a strong signal —
 * sharing a named identifier or file path is high-precision — but the leg is
 * narrower than FTS so it supplements rather than dominates. */
export const DEFAULT_ENTITY_WEIGHT = 0.6;

/**
 * Weight for the one-hop edge-traversal leg (#65).
 *
 * Chosen by sweeping against the edges benchmark (`bench/datasets/edges.json`,
 * `npx tsx bench/sweep.ts --sweep edge`). Turning the leg on lifts recall@5 from
 * 62.5% to 100% and recall@10 from 75% to 100% there, because each query's
 * second relevant memory is one typed edge from its lexical hit and shares
 * almost no query terms. The gain is flat across 0.1-0.8; the weight only
 * starts costing MRR once it is high enough to float a neighbour above the
 * lexical anchor (MRR 1.000 -> 0.875 at 0.1, down to 0.833 at 1.0). 0.2 takes
 * the full recall gain at the smallest ranking cost.
 *
 * On datasets with no edges (repo-memory) the leg is inert, so this does not
 * move the committed repo-memory snapshot.
 */
export const DEFAULT_EDGE_WEIGHT = 0.2;

export const DEFAULT_FUSION_WEIGHTS: FusionWeights = {
  fts: DEFAULT_FTS_WEIGHT,
  vector: DEFAULT_VECTOR_WEIGHT,
  entity: DEFAULT_ENTITY_WEIGHT,
  edge: DEFAULT_EDGE_WEIGHT,
};

export interface WeightedList<T> {
  items: T[];
  weight: number;
}

export interface FusedEntry<T> {
  item: T;
  score: number;
  /** Zero-based position in each list that contributed, keyed by list index.
   * Lets callers recover a per-leg rank (e.g. the BM25 rank) after fusing. */
  positions: Map<number, number>;
}

/**
 * Fuse weighted ranked lists. `idOf` supplies the identity used to detect the
 * same item appearing in more than one list. Ties are broken by best position in
 * any contributing list, so fusion is deterministic rather than dependent on
 * Map iteration order.
 */
export function fuseRrf<T>(
  lists: Array<WeightedList<T>>,
  idOf: (item: T) => number | string,
  k: number = RRF_K,
): Array<FusedEntry<T>> {
  const fused = new Map<number | string, FusedEntry<T>>();

  lists.forEach((list, listIndex) => {
    if (list.weight <= 0) {
      return;
    }
    list.items.forEach((item, position) => {
      const id = idOf(item);
      const contribution = list.weight / (k + position + 1);
      const prior = fused.get(id);
      if (prior) {
        prior.score += contribution;
        prior.positions.set(listIndex, position);
      } else {
        fused.set(id, {
          item,
          score: contribution,
          positions: new Map([[listIndex, position]]),
        });
      }
    });
  });

  const bestPosition = (entry: FusedEntry<T>): number =>
    Math.min(...Array.from(entry.positions.values()));

  return Array.from(fused.values()).sort(
    (a, b) => b.score - a.score || bestPosition(a) - bestPosition(b),
  );
}
