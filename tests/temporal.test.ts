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

test("resolveRelativeDates clamps 'last month' from a month-end reference", () => {
  // Mar 31 - 1 month must land on the last valid day of February, not
  // overflow into March (the setUTCMonth bug produced 2026-03-03).
  const mar31 = new Date("2026-03-31T00:00:00Z");
  const r = resolveRelativeDates("shipped last month", mar31);
  assert.equal(r[0]?.date, "2026-02-28");

  // May 31 - 1 month -> April has 30 days, so clamp to Apr 30.
  const may31 = new Date("2026-05-31T00:00:00Z");
  const r2 = resolveRelativeDates("shipped last month", may31);
  assert.equal(r2[0]?.date, "2026-04-30");
});

test("resolveRelativeDates clamps 'last month' into a leap-year February", () => {
  // 2028 is a leap year: Mar 31 - 1 month -> Feb 29.
  const mar31 = new Date("2028-03-31T00:00:00Z");
  const r = resolveRelativeDates("shipped last month", mar31);
  assert.equal(r[0]?.date, "2028-02-29");
});

test("resolveRelativeDates clamps 'next month' and crosses a year boundary", () => {
  // Jan 31 + 1 month -> Feb has 28 days (2026 non-leap), clamp to Feb 28.
  const jan31 = new Date("2026-01-31T00:00:00Z");
  const r = resolveRelativeDates("freeze next month", jan31);
  assert.equal(r[0]?.date, "2026-02-28");

  // Dec 15 + 1 month -> Jan 15 of the next year (year rollover).
  const dec15 = new Date("2026-12-15T00:00:00Z");
  const r2 = resolveRelativeDates("freeze next month", dec15);
  assert.equal(r2[0]?.date, "2027-01-15");
});

test("resolveRelativeDates clamps 'N months ago' / 'in N months' from month-end", () => {
  // Mar 31 - 1 month ago -> Feb 28 (same overflow path via shiftByUnit).
  const mar31 = new Date("2026-03-31T00:00:00Z");
  const r = resolveRelativeDates("regression 1 months ago", mar31);
  assert.equal(r[0]?.date, "2026-02-28");

  // Aug 31 + 2 months -> Oct 31 (both have 31 days, no clamp needed).
  const aug31 = new Date("2026-08-31T00:00:00Z");
  const r2 = resolveRelativeDates("audit in 2 months", aug31);
  assert.equal(r2[0]?.date, "2026-10-31");

  // Aug 31 + 1 month -> Sep has 30 days, clamp to Sep 30.
  const r3 = resolveRelativeDates("audit in 1 months", aug31);
  assert.equal(r3[0]?.date, "2026-09-30");
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
