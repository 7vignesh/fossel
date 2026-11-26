import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error plain .mjs module, no type declarations
import { GROUPS } from "../site/nav.mjs";

const ROOT = join(import.meta.dirname, "..");
const PAGES_DIR = join(ROOT, "site", "pages");

function sourceText(dir: string): string {
  const parts: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) parts.push(sourceText(path));
    else if (entry.name.endsWith(".ts")) parts.push(readFileSync(path, "utf8"));
  }
  return parts.join("\n");
}

const SRC = sourceText(join(ROOT, "src"));
const pages = readdirSync(PAGES_DIR)
  .filter((name) => name.endsWith(".html"))
  .map((name) => ({ slug: name.slice(0, -5), html: readFileSync(join(PAGES_DIR, name), "utf8") }));

function codeBlocks(html: string): Array<{ lang: string; text: string }> {
  return [...html.matchAll(/<code-block(?:\s+lang="([^"]*)")?\s*>([\s\S]*?)<\/code-block>/g)].map((m) => ({
    lang: m[1] ?? "",
    text: m[2].trim(),
  }));
}

test("every json code block on every docs page parses", () => {
  let checked = 0;
  for (const page of pages) {
    for (const block of codeBlocks(page.html).filter((b) => b.lang === "json")) {
      assert.doesNotThrow(() => JSON.parse(block.text), `${page.slug}: invalid JSON block:\n${block.text}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 5, "expected the client pages to carry JSON snippets");
});

test("every FOSSEL_* variable the docs mention exists in the source", () => {
  const mentioned = new Set<string>();
  for (const page of pages) {
    for (const m of page.html.matchAll(/\bFOSSEL_[A-Z_]+\b/g)) mentioned.add(m[0]);
  }
  assert.ok(mentioned.size >= 3);
  for (const name of mentioned) {
    assert.ok(SRC.includes(`process.env.${name}`), `${name} is documented but never read in src/`);
  }
});

test("every MCP tool the docs name is registered by the server", () => {
  const registered = new Set([...SRC.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
  assert.ok(registered.size >= 17, "could not read the tool registrations");
  const mentioned = new Set<string>();
  for (const page of pages) {
    for (const m of page.html.matchAll(/<code>([a-z]+_[a-z_]+)<\/code>/g)) mentioned.add(m[1]);
  }
  // Parameter and field names look like tool names but are not tools.
  const snapshot = JSON.parse(readFileSync(join(ROOT, "site", "data", "tools.json"), "utf8")).tools as Array<{
    inputSchema: { properties?: Record<string, unknown> };
  }>;
  const params = new Set(snapshot.flatMap((tool) => Object.keys(tool.inputSchema.properties ?? {})));
  const otherFields = new Set(["valid_to", "valid_from", "legacy_id", "access_count", "memory_rowid", "relates_to", "bug_fix", "reviewer_pattern"]);
  // Database table names appear in prose and are not tools.
  const tables = new Set(["memories_fts", "memory_edges", "memory_embeddings", "memory_entities", "memory_file_refs", "repo_aliases"]);
  const toolLike = [...mentioned].filter(
    (name) => !name.startsWith("fossel_") && !params.has(name) && !otherFields.has(name) && !tables.has(name),
  );
  assert.ok(toolLike.includes("resolve_repo") && toolLike.includes("get_context"));
  for (const name of toolLike) {
    assert.ok(registered.has(name), `${name} is documented as a tool but is not registered in src/`);
  }
});

test("the launch command on the setup pages matches what fossel init prints", () => {
  assert.match(SRC, /command: "npx",\s*args: \["-y", "fossel"\]/);
  for (const slug of ["claude-code", "cursor", "gemini-cli", "opencode-windsurf"]) {
    const page = pages.find((p) => p.slug === slug)!;
    assert.ok(
      page.html.includes('"args": ["-y", "fossel"]') || page.html.includes('["npx", "-y", "fossel"]') || page.html.includes("npx -y fossel"),
      `${slug} does not launch fossel with npx -y`,
    );
  }
});

test("each client page says plainly whether it was tested", () => {
  for (const slug of ["claude-code", "cursor", "gemini-cli", "opencode-windsurf"]) {
    const page = pages.find((p) => p.slug === slug)!;
    assert.match(page.html, /class="note"[^>]*>[^<]*(Tested with|Not tested here)/, `${slug} lacks a tested / not tested note`);
  }
});

test("every page is listed in the nav and every internal docs link resolves", () => {
  const slugs = new Set<string>(GROUPS.flatMap((g: { pages: Array<{ slug: string }> }) => g.pages.map((p) => p.slug)));
  assert.deepEqual([...slugs].sort(), pages.map((p) => p.slug).sort());
  for (const page of pages) {
    for (const m of page.html.matchAll(/href="\/docs\/([a-z0-9-]*)\/?"/g)) {
      const target = m[1] === "" ? "index" : m[1];
      assert.ok(slugs.has(target), `${page.slug} links to /docs/${m[1]}/ which is not a page`);
    }
  }
});

test("tool pages reference only tools and steps that exist in the snapshot", () => {
  const tools = new Set<string>(
    (JSON.parse(readFileSync(join(ROOT, "site", "data", "tools.json"), "utf8")).tools as Array<{ name: string }>).map((t) => t.name),
  );
  const steps = new Set<string>(
    (JSON.parse(readFileSync(join(ROOT, "site", "data", "session.json"), "utf8")).steps as Array<{ id: string }>).map((s) => s.id),
  );
  const used = new Set<string>();
  for (const page of pages) {
    for (const m of page.html.matchAll(/<tool-reference names="([^"]*)"/g)) {
      for (const name of m[1].split(/\s+/).filter(Boolean)) {
        assert.ok(tools.has(name), `${page.slug}: <tool-reference> names unknown tool ${name}`);
        used.add(name);
      }
    }
    for (const m of page.html.matchAll(/<tool-example step="([^"]*)"/g)) {
      assert.ok(steps.has(m[1]), `${page.slug}: <tool-example> uses unknown step ${m[1]}`);
    }
  }
  assert.deepEqual([...used].sort(), [...tools].sort(), "the MCP Tools page must document every tool exactly once");
});
