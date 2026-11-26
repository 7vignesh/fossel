import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain .mjs module, no type declarations
import { generateSnapshot, gitAvailable, maskVolatile, readCommitted, serialize } from "../scripts/docs-snapshot.mjs";

const GIT = gitAvailable();

test("maskVolatile hides only database sizes", () => {
  assert.equal(maskVolatile("DB: /x/memory.db (124.1 KB)"), "DB: /x/memory.db (<size>)");
  assert.equal(maskVolatile("Memories: 3 live (2 pinned)"), "Memories: 3 live (2 pinned)");
});

test(
  "site/data matches what the code produces now",
  { skip: GIT ? false : "git is required", timeout: 180_000 },
  async () => {
    const snapshot = await generateSnapshot();
    const fresh = {
      "tools.json": serialize(snapshot.tools),
      "session.json": serialize(snapshot.session),
    };
    for (const [name, text] of Object.entries(fresh)) {
      const committed = readCommitted(name);
      assert.notEqual(committed, null, `site/data/${name} is missing. Run npm run docs:snapshot.`);
      assert.equal(
        maskVolatile(committed as string),
        maskVolatile(text),
        `site/data/${name} is stale. Run npm run docs:snapshot and commit the result.`,
      );
    }
  },
);

test("the committed snapshot carries no machine-specific text", () => {
  for (const name of ["tools.json", "session.json"]) {
    const text = readCommitted(name) ?? "";
    assert.doesNotMatch(text, /[A-Za-z]:[\/](?!\/)|\/Users\/|\/tmp\/|AppData|fossel-docs-/, `${name} has a local path`);
  }
});

test("the snapshot covers every registered tool and the scripted session reaches each one", () => {
  const tools = JSON.parse(readCommitted("tools.json") ?? "{}").tools as Array<{ name: string }>;
  const session = JSON.parse(readCommitted("session.json") ?? "{}") as { steps: Array<{ tool: string }> };
  assert.equal(tools.length, 17);
  const exercised = new Set(session.steps.map((step) => step.tool));
  for (const tool of tools) {
    assert.ok(exercised.has(tool.name), `no scripted example calls ${tool.name}`);
  }
});
