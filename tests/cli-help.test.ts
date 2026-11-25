import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [tsxCli, "src/cli.ts", ...args], {
    encoding: "utf8",
  });
}

test("--help and -h print usage on stdout and exit 0", () => {
  for (const flag of ["--help", "-h"]) {
    const result = runCli(flag);
    assert.equal(result.status, 0, `${flag} should exit 0`);
    assert.match(result.stdout, /^Usage: fossel \[init/);
    assert.equal(result.stderr, "");
  }
});

test("an unknown command still fails with usage on stderr", () => {
  const result = runCli("bogus");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: bogus/);
  assert.match(result.stderr, /Usage: fossel \[init/);
});
