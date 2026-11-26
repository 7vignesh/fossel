/**
 * Documentation snapshot.
 *
 *   node scripts/docs-snapshot.mjs          write site/data/tools.json and session.json
 *   node scripts/docs-snapshot.mjs --check  exit 1 if the committed files are stale
 *
 * The docs never hand-copy tool schemas or example output. This script starts
 * the real server (from src/, through tsx), reads `tools/list`, then runs a
 * fixed scripted session against a throwaway database and a throwaway git repo,
 * recording every response. The CLI is run the same way. The build renders the
 * parameter tables and examples from the two JSON files, and
 * tests/docs-snapshot.test.ts fails if a code change makes them stale, so a
 * renamed parameter or a reworded response cannot slip past the docs.
 *
 * Determinism: the clock is driven by scripts/freeze-time.mjs (one fixed
 * minute-step per call), FOSSEL_* variables are cleared, HOME points at a
 * scratch directory, and generated ids and temp paths are rewritten to stable
 * placeholders. Nothing here touches the network or a real Fossel database.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "site", "data");

/** 2026-06-15T12:00:00Z, a Monday. Each step advances the clock one minute. */
const CLOCK_START_MS = Date.UTC(2026, 5, 15, 12, 0, 0);
const STEP_MS = 60_000;

const SHOWN_HOME = "/home/dev";
const SHOWN_WORKSPACE = `${SHOWN_HOME}/storefront`;
const SHOWN_DB = `${SHOWN_HOME}/.fossel/memory.db`;

const NANOID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

export function gitAvailable() {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

/** Stable stand-ins for generated ids, numbered by first appearance. */
function makeNormalizer(replacements) {
  const idMap = new Map();

  function fakeId(index) {
    let state = (index + 1) * 2654435761;
    let out = "";
    for (let i = 0; i < 21; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out += NANOID_ALPHABET[(state >>> 24) % NANOID_ALPHABET.length];
    }
    return out;
  }

  return (text) => {
    let out = text;
    for (const [from, to] of replacements) {
      out = out.split(from).join(to);
    }
    // Path tails keep Windows separators after the root was swapped out.
    out = out.replace(/\/home\/dev[^\s"'`),;]*/g, (m) => m.replace(/\\\\/g, "/").replace(/\\/g, "/"));
    out = out.replace(
      /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{21}(?![A-Za-z0-9_-])/g,
      (id) => {
        if (!/[0-9A-Z_-]/.test(id)) return id;
        if (!idMap.has(id)) idMap.set(id, fakeId(idMap.size));
        return idMap.get(id);
      },
    );
    return out;
  };
}

function pathVariants(path) {
  const forward = path.replace(/\\/g, "/");
  const jsonEscaped = JSON.stringify(path).slice(1, -1);
  return Array.from(new Set([jsonEscaped, path, forward]));
}

function cleanEnv() {
  // TZ is pinned so date grounding ("last week") cannot depend on the machine.
  const env = { TZ: "UTC" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("FOSSEL_")) env[key] = value;
  }
  return env;
}

function nodeArgs(clockFile, script) {
  return [
    "--import",
    import.meta.resolve("tsx"),
    "--import",
    pathToFileURL(join(ROOT, "scripts", "freeze-time.mjs")).href,
    script,
  ];
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function writeFile(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function initRepo(dir, remote) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "docs@fossel.test");
  git(dir, "config", "user.name", "Fossel Docs");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "remote", "add", "origin", remote);
}

const REMOTE = "https://github.com/acme/storefront.git";

/**
 * The scripted MCP session. `before` runs on the host (file edits, commits)
 * before the call. `shownArgs` replaces the arguments in the docs when the real
 * ones are too long to print.
 */
const MCP_STEPS = [
  { id: "resolve-repo", title: "Which repo is Fossel using?", tool: "resolve_repo", args: {} },
  {
    id: "remember-basic",
    title: "Save a note. Fossel infers the type and tags.",
    tool: "remember",
    args: { note: "JWT lives in localStorage; 401 redirects to /login" },
  },
  {
    id: "remember-explicit",
    title: "Save a note with an explicit type and tags.",
    tool: "remember",
    args: {
      note: "Fixed the websocket reconnect race by awaiting the auth handshake",
      type: "bug_fix",
      tags: ["websocket"],
    },
  },
  {
    id: "remember-duplicate",
    title: "Saving a near-identical note merges into the existing memory.",
    tool: "remember",
    args: { note: "JWT lives in localStorage; 401 redirects to /login." },
  },
  {
    id: "remember-conflict",
    title: "A related note that may contradict an older one is flagged for review.",
    tool: "remember",
    args: {
      note: "JWT no longer lives in localStorage; it moved to httpOnly cookies and 401 still redirects to /login",
    },
  },
  {
    id: "remember-dates",
    title: "Relative dates are written out as absolute dates.",
    tool: "remember",
    args: { note: "Migrated the cron scheduler to a queue last week" },
  },
  {
    id: "remember-verbatim",
    title: "infer=false stores the note as given, with no type or tags inferred.",
    tool: "remember",
    args: { note: "Use Postgres advisory locks for migrations", infer: false },
  },
  {
    id: "store-context",
    title: "store_context writes exactly what you pass. No inference, no merging.",
    tool: "store_context",
    args: {
      type: "decision",
      note: "The auth middleware in src/auth.ts verifies the JWT before any route handler runs",
      tags: ["auth", "jwt"],
    },
  },
  {
    id: "get-context-query",
    title: "Retrieve context for a query.",
    tool: "get_context",
    args: { query: "auth" },
  },
  {
    id: "get-context-markdown",
    title: "The same retrieval as a markdown brief, capped at three memories.",
    tool: "get_context",
    args: { query: "auth", format: "markdown", limit: 3 },
  },
  {
    id: "get-context-tags",
    title: "Restrict retrieval to memories that carry every listed tag.",
    tool: "get_context",
    args: { query: "websocket", tags: ["websocket"], tagMatch: "and" },
  },
  {
    id: "search-memory",
    title: "Full-text search.",
    tool: "search_memory",
    args: { query: "websocket reconnect" },
  },
  {
    id: "search-memory-no-match",
    title: "With no repo argument, search_memory searches every repo and reports no match plainly.",
    tool: "search_memory",
    args: { query: "kubernetes" },
  },
  {
    id: "search-memory-fallback",
    title: "With a repo argument, a query with no match falls back to recent and pinned memories.",
    tool: "search_memory",
    args: { query: "kubernetes", repo: "acme/storefront", limit: 2 },
  },
  {
    id: "get-repo-context",
    title: "Recent memories grouped by type.",
    tool: "get_repo_context",
    args: { limit: 5 },
  },
  { id: "pin-memory", title: "Pin a memory.", tool: "pin_memory", args: { id: 2 } },
  { id: "unpin-memory", title: "Unpin it.", tool: "unpin_memory", args: { id: 2 } },
  {
    id: "update-memory",
    title: "Rewrite a memory's text.",
    tool: "update_memory",
    args: {
      id: 2,
      content: "Fixed the websocket reconnect race by awaiting the auth handshake before resubscribing",
    },
  },
  {
    id: "update-memory-empty",
    title: "update_memory needs at least one field.",
    tool: "update_memory",
    args: { id: 2 },
  },
  {
    id: "supersede-memory",
    title: "Retire an outdated memory and point at its replacement.",
    tool: "supersede_memory",
    args: { id: 1, superseded_by: 3, reason: "moved to httpOnly cookies" },
  },
  {
    id: "superseded-lookup",
    title: "A superseded memory is no longer addressable by id.",
    tool: "pin_memory",
    args: { id: 1 },
  },
  {
    id: "summarize-repo-context",
    title: "A summary of every live memory.",
    tool: "summarize_repo_context",
    args: {},
  },
  {
    id: "consolidate-memory",
    title: "A read-only maintenance report.",
    tool: "consolidate_memory",
    args: {},
  },
  {
    id: "store-duplicate-a",
    title: "Two memories with the same text, written with store_context (no merging).",
    tool: "store_context",
    args: { type: "convention", note: "Run the linter before every commit in this repository" },
  },
  {
    id: "store-duplicate-b",
    title: "The second copy.",
    tool: "store_context",
    args: { type: "convention", note: "Run the linter before every commit in this repository." },
  },
  { id: "dedupe-dry-run", title: "dedupe_repo reports a plan by default.", tool: "dedupe_repo", args: {} },
  {
    id: "dedupe-apply",
    title: "apply=true carries the plan out.",
    tool: "dedupe_repo",
    args: { apply: true },
  },
  {
    id: "delete-memory",
    title: "Delete a memory.",
    tool: "delete_memory",
    args: { id: 4 },
  },
  {
    id: "delete-memory-missing",
    title: "Deleting an id that does not exist is an error.",
    tool: "delete_memory",
    args: { id: 999 },
  },
  {
    id: "get-context-drift",
    title: "After src/auth.ts is edited and committed, memories that mention it are flagged.",
    tool: "get_context",
    args: { query: "auth middleware" },
    before: (ctx) => {
      writeFile(ctx.repo, "src/auth.ts", "export const verify = () => 2;\n");
      git(ctx.repo, "add", "-A");
      git(ctx.repo, "commit", "-qm", "change auth");
    },
  },
  {
    id: "get-context-drift-dirty",
    title: "Uncommitted edits are flagged too, and a path git cannot resolve is reported as unverified.",
    tool: "get_context",
    args: { query: "auth middleware", format: "markdown", limit: 4 },
    setup: [
      {
        tool: "remember",
        args: { note: "Notes about src/ghost.ts, a file that was never committed", infer: false },
      },
    ],
    before: (ctx) => {
      writeFile(ctx.repo, "src/auth.ts", "export const verify = () => 3;\n");
    },
  },
  {
    id: "remember-other-repo",
    title: "Memories for a second repo, used by the next two examples.",
    tool: "remember",
    args: { repo: "acme/docs-demo", note: "Docs build runs before the site deploys" },
  },
  { id: "list-repos", title: "Every repo that has memories.", tool: "list_repos", args: {} },
  {
    id: "export-memories",
    title: "Export one repo as a JSON envelope.",
    tool: "export_memories",
    args: { repo: "acme/docs-demo" },
  },
  {
    id: "export-memories-file",
    title: "Write the export to a file inside the workspace instead.",
    tool: "export_memories",
    args: { repo: "acme/docs-demo", path: "backup/fossel.json" },
    before: (ctx) => mkdirSync(join(ctx.repo, "backup"), { recursive: true }),
  },
  {
    id: "export-memories-outside",
    title: "Paths outside the workspace are refused.",
    tool: "export_memories",
    args: { path: "../fossel.json" },
  },
  {
    id: "import-memories",
    title: "Importing is additive and idempotent. Re-importing the same file changes nothing.",
    tool: "import_memories",
    args: (state) => ({ data: state.outputs["export-memories"] }),
    shownArgs: { data: "<the JSON text returned by export_memories>" },
  },
  {
    id: "import-memories-invalid",
    title: "Malformed input is rejected.",
    tool: "import_memories",
    args: { data: "not json" },
  },
];

const CLI_STEPS = [
  { id: "cli-help", title: "Usage.", argv: ["--help"] },
  {
    id: "cli-init",
    title: "Onboarding in a repo that already has an AGENTS.md.",
    argv: ["init"],
    setup: (ctx) => writeFile(ctx.repo, "AGENTS.md", "# Agent notes\n\nUse pnpm.\n"),
  },
  { id: "cli-init-again", title: "Running it again changes nothing.", argv: ["init"] },
  { id: "cli-stats", title: "A read-only summary.", argv: ["stats"] },
  { id: "cli-doctor", title: "A health check.", argv: ["doctor"] },
  {
    id: "cli-doctor-problem",
    title: "doctor exits 1 when it finds a problem.",
    argv: ["doctor"],
    // Memories saved before the git remote was set live under the bare folder
    // name. This is the situation `doctor` exists to find.
    setup: (ctx) =>
      ctx.db(
        "INSERT INTO memories (id, repo, type, note, tags, created_at, updated_at, pinned, metadata_json, note_normalized) VALUES ('docslegacy000000001', 'storefront', 'general', 'Legacy note saved under the folder name', '[]', 1, 1, 0, '{}', 'legacy note saved under the folder name')",
      ),
  },
  { id: "cli-doctor-fix", title: "doctor --fix applies the safe repairs.", argv: ["doctor", "--fix"] },
  { id: "cli-unknown", title: "An unknown command.", argv: ["frobnicate"] },
];

async function runMcpSession(base, normalize, setClock) {
  const repo = join(base, "storefront");
  initRepo(repo, REMOTE);
  writeFile(repo, "src/auth.ts", "export const verify = () => 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "initial");

  const env = {
    ...cleanEnv(),
    FOSSEL_DB_PATH: join(base, "mcp.db"),
    FOSSEL_WORKSPACE: repo,
    FOSSEL_DOCS_CLOCK_FILE: join(base, "clock"),
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: nodeArgs(env.FOSSEL_DOCS_CLOCK_FILE, "src/index.ts"),
    cwd: ROOT,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "fossel-docs-snapshot", version: "0.0.0" });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    const toolsSnapshot = tools
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const state = { outputs: {} };
    const steps = [];
    let tick = 0;

    const call = async (tool, args) => {
      setClock(CLOCK_START_MS + tick * STEP_MS);
      tick += 1;
      const result = await client.callTool({ name: tool, arguments: args });
      const text = result.content.map((part) => part.text ?? "").join("\n");
      return { isError: Boolean(result.isError), text };
    };

    for (const step of MCP_STEPS) {
      for (const pre of step.setup ?? []) {
        await call(pre.tool, pre.args);
      }
      step.before?.({ repo });
      const args = typeof step.args === "function" ? step.args(state) : step.args;
      let response;
      try {
        response = await call(step.tool, args);
      } catch (error) {
        // Schema validation failures arrive as protocol errors, not tool results.
        response = { isError: true, text: error instanceof Error ? error.message : String(error) };
      }
      state.outputs[step.id] = response.text;
      steps.push({
        id: step.id,
        title: step.title,
        tool: step.tool,
        args: step.shownArgs ?? args,
        isError: response.isError,
        output: normalize(response.text),
      });
    }

    setClock(CLOCK_START_MS + tick * STEP_MS);
    const resource = await client.readResource({ uri: "fossel://context/current-repo" });
    const listed = (await client.listResources()).resources[0];
    return {
      tools: toolsSnapshot,
      steps,
      resource: {
        uri: listed.uri,
        name: listed.name,
        mimeType: listed.mimeType,
        description: listed.description,
        text: normalize(resource.contents[0].text),
      },
    };
  } finally {
    await client.close();
  }
}

function runCliSession(base, normalize, setClock) {
  const repo = join(base, "cli", "storefront");
  const home = join(base, "home");
  initRepo(repo, REMOTE);
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(join(home, ".cursor", "mcp.json"), "{}\n", "utf8");

  const dbPath = join(base, "cli.db");
  const env = {
    ...cleanEnv(),
    HOME: home,
    USERPROFILE: home,
    FOSSEL_DB_PATH: dbPath,
    FOSSEL_DOCS_CLOCK_FILE: join(base, "clock"),
  };
  const script = join(ROOT, "src", "cli.ts");

  const ctx = {
    repo,
    db: (sql) => {
      const Database = ctx.Database;
      const db = new Database(dbPath);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    },
  };

  return import("better-sqlite3").then(({ default: Database }) => {
    ctx.Database = Database;
    const out = [];
    let tick = 0;
    for (const step of CLI_STEPS) {
      step.setup?.(ctx);
      setClock(CLOCK_START_MS + tick * STEP_MS);
      tick += 1;
      const result = spawnSync(process.execPath, [...nodeArgs(env.FOSSEL_DOCS_CLOCK_FILE, script), ...step.argv], {
        cwd: repo,
        env,
        encoding: "utf8",
      });
      const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\r\n/g, "\n").replace(/\n+$/, "");
      out.push({
        id: step.id,
        title: step.title,
        command: ["fossel", ...step.argv].join(" "),
        exitCode: result.status,
        output: normalize(text),
      });
    }
    return out;
  });
}

/** Run everything and return `{ tools, session }`. */
export async function generateSnapshot() {
  if (!gitAvailable()) throw new Error("git is required to generate the docs snapshot");

  // `.native` expands Windows 8.3 short names (RUNNER~1), which a child process
  // may report in long form; the path replacements below must match either.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "fossel-docs-")));
  const clockFile = join(base, "clock");
  const setClock = (ms) => writeFileSync(clockFile, String(ms), "utf8");
  setClock(CLOCK_START_MS);

  const replacements = [
    ...pathVariants(join(base, "storefront")).map((v) => [v, SHOWN_WORKSPACE]),
    ...pathVariants(join(base, "cli", "storefront")).map((v) => [v, SHOWN_WORKSPACE]),
    ...pathVariants(join(base, "cli.db")).map((v) => [v, SHOWN_DB]),
    ...pathVariants(join(base, "home")).map((v) => [v, SHOWN_HOME]),
    ...pathVariants(base).map((v) => [v, SHOWN_HOME]),
  ];
  const normalize = makeNormalizer(replacements);

  try {
    const mcp = await runMcpSession(base, normalize, setClock);
    const cli = await runCliSession(base, normalize, setClock);
    return {
      tools: { tools: mcp.tools },
      session: { steps: mcp.steps, resource: mcp.resource, cli },
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Database sizes in `fossel stats` depend on the SQLite build and platform, so
 * the staleness check compares with them masked. The committed files keep the
 * real recorded value.
 */
export function maskVolatile(text) {
  return text.replace(/\(\d+(?:\.\d+)? (?:B|KB|MB)\)/g, "(<size>)");
}

export function readCommitted(name) {
  try {
    return readFileSync(join(DATA_DIR, name), "utf8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    const snapshot = await generateSnapshot();
    const files = {
      "tools.json": serialize(snapshot.tools),
      "session.json": serialize(snapshot.session),
    };
    if (process.argv.includes("--check")) {
      const stale = Object.entries(files).filter(
        ([name, text]) => maskVolatile(readCommitted(name) ?? "") !== maskVolatile(text),
      );
      if (stale.length > 0) {
        console.error(`Stale: ${stale.map(([name]) => `site/data/${name}`).join(", ")}. Run \`npm run docs:snapshot\` and commit the result.`);
        process.exit(1);
      }
      console.log("site/data is up to date.");
    } else {
      mkdirSync(DATA_DIR, { recursive: true });
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(DATA_DIR, name), text, "utf8");
      }
      console.log(`Wrote ${Object.keys(files).map((n) => `site/data/${n}`).join(" and ")}`);
    }
  } catch (error) {
    console.error(`docs-snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
