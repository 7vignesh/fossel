import assert from "node:assert/strict";
import { test } from "node:test";
import { percentile, summarizeLatency } from "../bench/lib/latency.js";

test("percentile uses nearest rank and returns an observed value", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 50), 50);
  assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile(hundred, 100), 100);

  // 30 samples: p50 is the 15th smallest, p95 the 29th.
  const thirty = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.equal(percentile(thirty, 50), 15);
  assert.equal(percentile(thirty, 95), 29);
});

test("percentile does not mutate its input and handles tiny samples", () => {
  const input = [5, 1, 3];
  assert.equal(percentile(input, 50), 3);
  assert.deepEqual(input, [5, 1, 3]);
  assert.equal(percentile([7], 95), 7);
});

test("percentile rejects empty samples and out-of-range p", () => {
  assert.throws(() => percentile([], 50));
  assert.throws(() => percentile([1], 0));
  assert.throws(() => percentile([1], 101));
});

test("summarizeLatency reports n, percentiles, mean, min and max", () => {
  const stats = summarizeLatency([4, 1, 2, 3]);
  assert.deepEqual(stats, { n: 4, p50: 2, p95: 4, mean: 2.5, min: 1, max: 4 });
});
