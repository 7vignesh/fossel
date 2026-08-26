import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_FUSION_WEIGHTS,
  RRF_K,
  fuseRrf,
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
