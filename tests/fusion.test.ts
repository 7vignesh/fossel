import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_FUSION_WEIGHTS,
  DEFAULT_RECENCY_HALF_LIFE_DAYS,
  RRF_K,
  fuseRrf,
  recencyDecay,
} from "../src/lib/fusion.js";

interface Item {
  id: number;
}

const item = (id: number): Item => ({ id });
const idOf = (i: Item): number => i.id;

test("fuseRrf rewards items appearing in more than one list", () => {
  const fused = fuseRrf(
    [
      { items: [item(1), item(2)], weight: 1 },
      { items: [item(2), item(3)], weight: 1 },
    ],
    idOf,
  );

  assert.equal(fused[0].item.id, 2, "the item in both lists must rank first");
  assert.equal(fused.length, 3);
});

test("fuseRrf respects leg weights", () => {
  // Item 1 leads the light list, item 2 leads the heavy one. The heavy leg wins.
  const fused = fuseRrf(
    [
      { items: [item(1)], weight: 0.1 },
      { items: [item(2)], weight: 1 },
    ],
    idOf,
  );
  assert.equal(fused[0].item.id, 2);

  // Flip the weights and the outcome flips with them.
  const flipped = fuseRrf(
    [
      { items: [item(1)], weight: 1 },
      { items: [item(2)], weight: 0.1 },
    ],
    idOf,
  );
  assert.equal(flipped[0].item.id, 1);
});

test("fuseRrf skips zero-weighted lists entirely", () => {
  const fused = fuseRrf(
    [
      { items: [item(1)], weight: 1 },
      { items: [item(2), item(3)], weight: 0 },
    ],
    idOf,
  );
  assert.deepEqual(
    fused.map((entry) => entry.item.id),
    [1],
    "a zero-weight leg must contribute nothing, so hybrid collapses to one leg",
  );
});

test("fuseRrf records the position an item held in each contributing list", () => {
  const fused = fuseRrf(
    [
      { items: [item(9), item(1)], weight: 1 },
      { items: [item(1)], weight: 1 },
    ],
    idOf,
  );
  const entry = fused.find((e) => e.item.id === 1);
  assert.ok(entry);
  assert.equal(entry.positions.get(0), 1, "was second in the first list");
  assert.equal(entry.positions.get(1), 0, "was first in the second list");
});

test("fuseRrf uses a deterministic tie-break", () => {
  // Identical single-item lists at equal weight produce equal scores; ordering
  // must still be stable rather than dependent on Map iteration.
  const run = () =>
    fuseRrf(
      [
        { items: [item(5)], weight: 1 },
        { items: [item(7)], weight: 1 },
      ],
      idOf,
    ).map((e) => e.item.id);

  assert.deepEqual(run(), run());
});

test("fuseRrf scores match the RRF formula", () => {
  const fused = fuseRrf([{ items: [item(1)], weight: 1 }], idOf);
  assert.ok(Math.abs(fused[0].score - 1 / (RRF_K + 1)) < 1e-12);
});

test("default weights keep the keyword leg dominant", () => {
  assert.ok(
    DEFAULT_FUSION_WEIGHTS.fts > DEFAULT_FUSION_WEIGHTS.vector,
    "BM25 measures stronger than the hashed embedder, so it must outweigh it",
  );
});

const DAY = 86_400;

test("recency decay is inert by default", () => {
  assert.equal(
    DEFAULT_RECENCY_HALF_LIFE_DAYS,
    0,
    "the spike shipped off: decay must not move rankings unless opted in",
  );
});

test("recencyDecay returns 1 when disabled or for the newest item", () => {
  assert.equal(recencyDecay(10 * DAY, 0), 1, "half-life 0 disables decay");
  assert.equal(recencyDecay(10 * DAY, -5), 1, "negative half-life disables it");
  assert.equal(recencyDecay(0, 7), 1, "zero age (newest) keeps full score");
  assert.equal(recencyDecay(-100, 7), 1, "a future age never boosts above 1");
});

test("recencyDecay halves the score at one half-life", () => {
  assert.ok(Math.abs(recencyDecay(7 * DAY, 7) - 0.5) < 1e-12);
  assert.ok(Math.abs(recencyDecay(14 * DAY, 7) - 0.25) < 1e-12);
});

test("recencyDecay is monotonically non-increasing in age", () => {
  const halfLife = 30;
  let prev = 1;
  for (let days = 0; days <= 120; days += 10) {
    const factor = recencyDecay(days * DAY, halfLife);
    assert.ok(factor <= prev + 1e-12, `factor must not rise at ${days}d`);
    assert.ok(factor > 0, "decay stays strictly positive");
    prev = factor;
  }
});
