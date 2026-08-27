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

export interface FusionWeights {
  fts: number;
  vector: number;
  entity?: number;
}

/** Default weight for the entity leg. Entity matches are a strong signal —
 * sharing a named identifier or file path is high-precision — but the leg is
 * narrower than FTS so it supplements rather than dominates. */
export const DEFAULT_ENTITY_WEIGHT = 0.6;

export const DEFAULT_FUSION_WEIGHTS: FusionWeights = {
  fts: DEFAULT_FTS_WEIGHT,
  vector: DEFAULT_VECTOR_WEIGHT,
  entity: DEFAULT_ENTITY_WEIGHT,
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
