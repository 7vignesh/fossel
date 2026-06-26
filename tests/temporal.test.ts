import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groundTemporalReferences,
  resolveRelativeDates,
} from "../src/lib/temporal.js";

// Fixed reference date for deterministic assertions: 2026-06-26 (a Friday).
const REF = new Date("2026-06-26T12:00:00Z");

test("resolveRelativeDates resolves yesterday/today/tomorrow", () => {
  const r = resolveRelativeDates("fixed it yesterday, deploying today, review tomorrow", REF);
  const map = Object.fromEntries(r.map((x) => [x.phrase, x.date]));
  assert.equal(map["yesterday"], "2026-06-25");
  assert.equal(map["today"], "2026-06-26");
  assert.equal(map["tomorrow"], "2026-06-27");
});

test("resolveRelativeDates resolves last/next week", () => {
  const r = resolveRelativeDates("shipped last week, freeze next week", REF);
  const map = Object.fromEntries(r.map((x) => [x.phrase, x.date]));
  assert.equal(map["last week"], "2026-06-19");
  assert.equal(map["next week"], "2026-07-03");
});

test("resolveRelativeDates resolves 'N days/weeks ago'", () => {
  const r = resolveRelativeDates("regression introduced 3 days ago and 2 weeks ago", REF);
  const map = Object.fromEntries(r.map((x) => [x.phrase, x.date]));
  assert.equal(map["3 days ago"], "2026-06-23");
  assert.equal(map["2 weeks ago"], "2026-06-12");
});

test("resolveRelativeDates resolves 'in N days/months'", () => {
  const r = resolveRelativeDates("launch in 10 days, audit in 2 months", REF);
  const map = Object.fromEntries(r.map((x) => [x.phrase, x.date]));
  assert.equal(map["in 10 days"], "2026-07-06");
  assert.equal(map["in 2 months"], "2026-08-26");
});

test("resolveRelativeDates skips vague phrases", () => {
  const r = resolveRelativeDates("we'll get to it soon, recently it broke", REF);
  assert.equal(r.length, 0);
});

test("resolveRelativeDates returns nothing for notes with no relative dates", () => {
  assert.deepEqual(
    resolveRelativeDates("use pnpm workspaces for all package scripts", REF),
    [],
  );
});

test("groundTemporalReferences appends resolved dates", () => {
  const out = groundTemporalReferences("fixed the race condition last week", REF);
  assert.equal(out, "fixed the race condition last week (last week = 2026-06-19)");
});

test("groundTemporalReferences is a no-op when nothing resolvable", () => {
  const note = "always run the test matrix before merge";
  assert.equal(groundTemporalReferences(note, REF), note);
});

test("groundTemporalReferences handles multiple phrases", () => {
  const out = groundTemporalReferences("broke yesterday, fix ships tomorrow", REF);
  assert.match(out, /yesterday = 2026-06-25/);
  assert.match(out, /tomorrow = 2026-06-27/);
});

test("groundTemporalReferences does not double-annotate an already-grounded note", () => {
  const once = groundTemporalReferences("shipped last week", REF);
  const twice = groundTemporalReferences(once, REF);
  assert.equal(once, twice, "re-grounding must be idempotent");
});
