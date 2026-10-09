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

test("writes into an existing .windsurfrules", () => {
  const path = join(dir, ".windsurfrules");
  writeFileSync(path, "windsurf rules\n", "utf8");

  const result = writeInvocationHint(dir);
  assert.ok(result?.includes(".windsurfrules"));

  const content = readFileSync(path, "utf8");
  assert.match(content, /get_context/);
  assert.match(content, /windsurf rules/);
});

test("writes into an existing .clinerules", () => {
  const path = join(dir, ".clinerules");
  writeFileSync(path, "cline rules\n", "utf8");

  const result = writeInvocationHint(dir);
  assert.ok(result?.includes(".clinerules"));

  const content = readFileSync(path, "utf8");
  assert.match(content, /get_context/);
  assert.match(content, /cline rules/);
});

test("writes into Zed's .rules file", () => {
  const path = join(dir, ".rules");
  writeFileSync(path, "zed rules\n", "utf8");

  const result = writeInvocationHint(dir);
  assert.ok(result?.includes(".rules"));

  const content = readFileSync(path, "utf8");
  assert.match(content, /get_context/);
  assert.match(content, /zed rules/);
});

test("writes into the .windsurf/rules.md and .clinerules/rules.md directory forms", () => {
  mkdirSync(join(dir, ".windsurf"));
  writeFileSync(join(dir, ".windsurf", "rules.md"), "ws dir rules\n", "utf8");
  mkdirSync(join(dir, ".clinerules"));
  writeFileSync(join(dir, ".clinerules", "rules.md"), "cline dir rules\n", "utf8");

  const result = writeInvocationHint(dir);
  assert.ok(result?.includes("rules.md"));

  assert.match(readFileSync(join(dir, ".windsurf", "rules.md"), "utf8"), /get_context/);
  assert.match(readFileSync(join(dir, ".clinerules", "rules.md"), "utf8"), /get_context/);
});

test("the new rule files are idempotent too", () => {
  const path = join(dir, ".windsurfrules");
  writeFileSync(path, "rules\n", "utf8");

  writeInvocationHint(dir);
  const first = readFileSync(path, "utf8");
  writeInvocationHint(dir);
  const second = readFileSync(path, "utf8");

  assert.equal(first, second, "second call must not duplicate the hint");
});
