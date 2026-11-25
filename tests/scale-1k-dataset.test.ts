import assert from "node:assert/strict";
import { test } from "node:test";
import { buildScale1k, scale1k } from "../bench/datasets/scale-1k.js";
import { lightStem, tokenizeQuery } from "../src/lib/fts.js";

const STOPWORDS = new Set(
  "a an the and or of to in on at for from with without by is are was were be been do does did how what when where why who we us our you they it its this that these those can cant just so as if then than too very not no one two all any each into out up down over under again once keep keeps stay stays someone something single instead".split(
    " ",
  ),
);

function contentStems(text: string): Set<string> {
  return new Set(
    tokenizeQuery(text)
      .filter((token) => !STOPWORDS.has(token) && token.length >= 3)
      .map((token) => lightStem(token)),
  );
}

test("scale-1k has 1,000 unique documents and 30 queries split 15/15", () => {
  assert.equal(scale1k.memories.length, 1000);
  assert.equal(new Set(scale1k.memories.map((m) => m.key)).size, 1000);
  assert.equal(new Set(scale1k.memories.map((m) => m.note)).size, 1000);
  assert.equal(scale1k.queries.length, 30);
  assert.equal(scale1k.queries.filter((q) => q.category === "symbol").length, 15);
  assert.equal(scale1k.queries.filter((q) => q.category === "paraphrase").length, 15);
});

test("scale-1k is deterministic for a seed and differs across seeds", () => {
  assert.deepEqual(buildScale1k(), buildScale1k());
  assert.notDeepEqual(
    buildScale1k().memories.map((m) => m.key),
    buildScale1k(1).memories.map((m) => m.key),
  );
});

test("scale-1k labels point at existing memories, one target per query", () => {
  const keys = new Set(scale1k.memories.map((m) => m.key));
  for (const query of scale1k.queries) {
    assert.equal(query.relevant.length, 1, `${query.id} should have one target`);
    assert.ok(keys.has(query.relevant[0]), `${query.id} targets unknown ${query.relevant[0]}`);
  }
});

test("each exact-symbol query appears verbatim in its target and nowhere else", () => {
  for (const query of scale1k.queries.filter((q) => q.category === "symbol")) {
    const needle = query.query.toLowerCase();
    const hits = scale1k.memories.filter((m) => m.note.toLowerCase().includes(needle));
    assert.deepEqual(
      hits.map((m) => m.key),
      query.relevant,
      `${query.id} "${query.query}" must occur only in its target`,
    );
  }
});

test("paraphrase targets share no content words with their query", () => {
  const byKey = new Map(scale1k.memories.map((m) => [m.key, m]));
  for (const query of scale1k.queries.filter((q) => q.category === "paraphrase")) {
    const target = byKey.get(query.relevant[0])!;
    const queryStems = contentStems(query.query);
    const shared = Array.from(contentStems(target.note)).filter((stem) => queryStems.has(stem));
    assert.deepEqual(shared, [], `${query.id} target shares stems with its query`);
  }
});

test("paraphrase queries are not answered by any generated filler", () => {
  // A filler sharing a rare query stem could make a paraphrase query ambiguous.
  const fillers = scale1k.memories.filter((m) => m.key.startsWith("f-"));
  assert.equal(fillers.length, 940);
  for (const query of scale1k.queries.filter((q) => q.category === "paraphrase")) {
    const queryStems = contentStems(query.query);
    for (const filler of fillers) {
      const overlap = Array.from(contentStems(filler.note)).filter((s) => queryStems.has(s));
      assert.ok(overlap.length < 3, `${query.id} overlaps filler ${filler.key}: ${overlap.join(",")}`);
    }
  }
});
