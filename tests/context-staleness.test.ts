import assert from "node:assert/strict";
import { test } from "node:test";
import { formatContext, type ContextRow } from "../src/lib/context.js";
import type { StaleFileRef } from "../src/lib/file-refs.js";

function row(rowId: number, note: string): ContextRow {
  return {
    row_id: rowId,
    id: `m-${rowId}`,
    repo: "acme/app",
    type: "convention",
    note,
    tags: "[]",
    created_at: 1,
    updated_at: 1,
    pinned: 0,
    source: "recent",
  };
}

test("formatContext appends a staleness marker in text format", () => {
  const rows = [row(1, "auth lives in src/auth.ts"), row(2, "use pnpm")];
  const staleRefs = new Map<number, StaleFileRef[]>([
    [1, [{ path: "src/auth.ts", changedInWorkingTree: false }]],
  ]);

  const out = formatContext(rows, { repo: "acme/app", staleRefs });
  assert.match(out, /may be stale: src\/auth\.ts changed since this was written/);
  // The unaffected memory must not be marked.
  const lines = out.split("\n").filter((l) => l.includes("use pnpm"));
  assert.ok(lines.length === 1 && !/stale/.test(lines[0]));
});

test("formatContext marks an uncommitted change distinctly", () => {
  const rows = [row(1, "auth lives in src/auth.ts")];
  const staleRefs = new Map<number, StaleFileRef[]>([
    [1, [{ path: "src/auth.ts", changedInWorkingTree: true }]],
  ]);
  const out = formatContext(rows, { repo: "acme/app", staleRefs });
  assert.match(out, /has uncommitted changes since this was written/);
});

test("formatContext renders the marker in markdown format too", () => {
  const rows = [row(7, "middleware in middleware.ts")];
  const staleRefs = new Map<number, StaleFileRef[]>([
    [7, [{ path: "middleware.ts", changedInWorkingTree: false }]],
  ]);
  const out = formatContext(rows, {
    repo: "acme/app",
    format: "markdown",
    staleRefs,
  });
  assert.match(out, /⚠ may be stale: middleware\.ts/);
});

test("formatContext without staleRefs produces no markers", () => {
  const rows = [row(1, "auth lives in src/auth.ts")];
  const out = formatContext(rows, { repo: "acme/app" });
  assert.doesNotMatch(out, /stale/);
});

test("formatContext lists multiple changed files in one marker", () => {
  const rows = [row(1, "auth spans src/auth.ts and middleware.ts")];
  const staleRefs = new Map<number, StaleFileRef[]>([
    [
      1,
      [
        { path: "src/auth.ts", changedInWorkingTree: false },
        { path: "middleware.ts", changedInWorkingTree: false },
      ],
    ],
  ]);
  const out = formatContext(rows, { repo: "acme/app", staleRefs });
  assert.match(out, /src\/auth\.ts, middleware\.ts/);
});
