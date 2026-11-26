/**
 * Clock control for the documentation snapshot.
 *
 * Preloaded with `node --import` by scripts/docs-snapshot.mjs. Fossel stamps
 * memories with `Date.now()` in whole seconds and orders "recent" memories by
 * that stamp, so a session that runs in real time produces ties and a different
 * order from run to run. This replaces the global Date so that "now" is read
 * from a file the snapshot script rewrites before every step: the time then
 * depends on the step, never on how many times the server happens to ask for
 * it, so unrelated code changes do not shift the recorded timestamps.
 *
 * Only for the snapshot. It refuses to load without FOSSEL_DOCS_CLOCK_FILE.
 */

import { readFileSync } from "node:fs";

const clockFile = process.env.FOSSEL_DOCS_CLOCK_FILE;
if (!clockFile) {
  throw new Error("FOSSEL_DOCS_CLOCK_FILE is required to freeze the clock");
}

const RealDate = Date;

function current() {
  return Number(readFileSync(clockFile, "utf8").trim());
}

globalThis.Date = new Proxy(RealDate, {
  construct(target, args) {
    return args.length === 0 ? new target(current()) : new target(...args);
  },
  apply(target) {
    return new target(current()).toString();
  },
  get(target, prop, receiver) {
    if (prop === "now") return current;
    return Reflect.get(target, prop, receiver);
  },
});
