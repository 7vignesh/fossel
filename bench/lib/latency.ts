/**
 * Latency statistics for the neural-comparison benchmark.
 *
 * Percentiles use the nearest-rank method (the smallest sample such that at
 * least p% of samples are <= it), so every reported value is a latency that was
 * actually observed. With the benchmark's 30 timed queries, p95 is the 29th
 * smallest sample: it is a coarse tail estimate, not a stable one.
 */

export interface LatencyStats {
  n: number;
  p50: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
}

/** Nearest-rank percentile of an unsorted sample, 0 < p <= 100. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) {
    throw new Error("percentile of an empty sample");
  }
  if (!(p > 0 && p <= 100)) {
    throw new Error(`percentile p must be in (0, 100], got ${p}`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

export function summarizeLatency(samples: readonly number[]): LatencyStats {
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    n: samples.length,
    p50: round3(percentile(samples, 50)),
    p95: round3(percentile(samples, 95)),
    mean: round3(total / samples.length),
    min: round3(Math.min(...samples)),
    max: round3(Math.max(...samples)),
  };
}
