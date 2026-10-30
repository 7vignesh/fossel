// Runs the test suite as `tsx --test <files>` with the file list built here.
//
// `tsx --test tests/*.test.ts` in package.json relied on the shell to expand the
// glob. cmd.exe (npm's script shell on Windows) does not, and Node 20's test
// runner does not expand globs itself (Node 22's does), so Windows + Node 20
// looked for a file literally named `*.test.ts`. Listing the files here works
// the same on every platform and Node version.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const files = readdirSync("tests")
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join("tests", name));

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const result = spawnSync(process.execPath, [tsxCli, "--test", ...files], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
