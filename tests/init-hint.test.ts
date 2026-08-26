import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { writeInvocationHint } from "../src/cli.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fossel-hint-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("writes the hint into an existing AGENTS.md", () => {
  const agentsPath = join(dir, "AGENTS.md");
  writeFileSync(agentsPath, "# My Agents\n", "utf8");

  const result = writeInvocationHint(dir);
  assert.ok(result?.includes("AGENTS.md"));

  const content = readFileSync(agentsPath, "utf8");
  assert.match(content, /get_context/);
  assert.match(content, /fossel:get_context/);
  // Original content preserved.
  assert.match(content, /# My Agents/);
});

test("is idempotent — a second call does not duplicate the hint", () => {
  const agentsPath = join(dir, "AGENTS.md");
  writeFileSync(agentsPath, "# My Agents\n", "utf8");

  writeInvocationHint(dir);
  const firstContent = readFileSync(agentsPath, "utf8");
  writeInvocationHint(dir);
  const secondContent = readFileSync(agentsPath, "utf8");

  assert.equal(firstContent, secondContent, "second call must not change the file");
});

test("returns null when no rule files exist", () => {
  assert.equal(writeInvocationHint(dir), null);
});

test("writes into .cursor/rules if it exists", () => {
  const cursorDir = join(dir, ".cursor");
  mkdirSync(cursorDir);
  writeFileSync(join(cursorDir, "rules"), "existing rules\n", "utf8");

  const result = writeInvocationHint(dir);
  assert.ok(result?.includes("rules"));

  const content = readFileSync(join(cursorDir, "rules"), "utf8");
  assert.match(content, /get_context/);
  assert.match(content, /existing rules/);
});

test("writes into multiple files when several exist", () => {
  writeFileSync(join(dir, "AGENTS.md"), "# A\n", "utf8");
  writeFileSync(join(dir, "CLAUDE.md"), "# C\n", "utf8");

  const result = writeInvocationHint(dir);
  assert.ok(result?.includes("AGENTS.md"));
  assert.ok(result?.includes("CLAUDE.md"));
});
