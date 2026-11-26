import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error plain .mjs build script, no type declarations
import { buildSite, escapeHtml, pageUrl, renderFragment, slugify } from "../scripts/build-site.mjs";

const ROOT = join(import.meta.dirname, "..");
const LANDING = readFileSync(join(ROOT, "index.html"), "utf8");

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fossel-site-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function read(outDir: string, ...parts: string[]): string {
  return readFileSync(join(outDir, ...parts), "utf8");
}

test("real build: landing page is copied unchanged and docs overview exists", () => {
  const { dir, done } = scratch();
  try {
    buildSite({ outDir: dir });
    assert.equal(read(dir, "index.html"), LANDING);
    const overview = read(dir, "docs", "index.html");
    assert.match(overview, /<title>Documentation - Fossel docs<\/title>/);
    assert.match(overview, /<h1>Overview<\/h1>/);
    assert.ok(existsSync(join(dir, "docs", "docs.css")));
    assert.ok(existsSync(join(dir, "docs", "docs.js")));
  } finally {
    done();
  }
});

test("landing page links into /docs/ from the header and a Read the Docs button", () => {
  assert.match(LANDING, /<div class="nav-links">[\s\S]*?<a href="\/docs\/">Docs<\/a>[\s\S]*?<\/div>/);
  assert.match(LANDING, /<a href="\/docs\/" class="btn btn-ghost">[\s\S]*?Read the Docs\s*<\/a>/);
});

test("docs stylesheet carries every theme token the landing page defines", () => {
  const { dir, done } = scratch();
  try {
    buildSite({ outDir: dir });
    const css = read(dir, "docs", "docs.css");
    const style = LANDING.match(/<style>([\s\S]*?)<\/style>/)![1];
    const tokens = new Set(
      [...style.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => `${m[1]}:${m[2].trim()}`),
    );
    assert.ok(tokens.size > 40, "expected the landing page to define many tokens");
    const squash = (text: string): string => text.replace(/\s+/g, " ");
    const flatCss = squash(css);
    for (const token of tokens) {
      const [name, value] = token.split(/:(.+)/);
      assert.ok(flatCss.includes(squash(`${name}: ${value}`)), `docs.css is missing ${name}: ${value}`);
    }
  } finally {
    done();
  }
});

test("every internal link and asset in the built docs resolves to a file", () => {
  const { dir, done } = scratch();
  try {
    buildSite({ outDir: dir });
    const page = read(dir, "docs", "index.html");
    const targets = [...page.matchAll(/(?:href|src)="(\/[^"#]*)"/g)].map((m) => m[1]);
    assert.ok(targets.length >= 4);
    for (const target of targets) {
      const file = target.endsWith("/") ? join(dir, target, "index.html") : join(dir, target);
      assert.ok(existsSync(file), `${target} does not resolve to ${file}`);
    }
  } finally {
    done();
  }
});

function fixture(slugs: Record<string, string>) {
  const { dir, done } = scratch();
  const pagesDir = join(dir, "pages");
  mkdirSync(pagesDir);
  for (const [slug, body] of Object.entries(slugs)) writeFileSync(join(pagesDir, `${slug}.html`), body);
  return { dir, pagesDir, outDir: join(dir, "out"), done };
}

const page = (slug: string, title: string) => ({ slug, title, description: `${title} page` });

test("sidebar groups pages in order, marks the current page and hides empty groups", () => {
  const f = fixture({ index: "<p>a</p>", two: "<p>b</p>", three: "<p>c</p>" });
  try {
    const groups = [
      { title: "First", pages: [page("index", "One"), page("two", "Two")] },
      { title: "Empty", pages: [] },
      { title: "Last", pages: [page("three", "Three")] },
    ];
    buildSite({ outDir: f.outDir, pagesDir: f.pagesDir, groups });
    const two = read(f.outDir, "docs", "two", "index.html");
    assert.ok(two.indexOf(">First<") < two.indexOf(">Last<"));
    assert.ok(!two.includes(">Empty<"));
    assert.match(two, /<a href="\/docs\/two\/" aria-current="page">Two<\/a>/);
    assert.equal((two.match(/aria-current="page"/g) ?? []).length, 1);
  } finally {
    f.done();
  }
});

test("previous and next follow nav order across groups, with no dead ends", () => {
  const f = fixture({ index: "<p>a</p>", two: "<p>b</p>", three: "<p>c</p>" });
  try {
    const groups = [
      { title: "A", pages: [page("index", "One"), page("two", "Two")] },
      { title: "B", pages: [page("three", "Three")] },
    ];
    buildSite({ outDir: f.outDir, pagesDir: f.pagesDir, groups });
    const first = read(f.outDir, "docs", "index.html");
    const middle = read(f.outDir, "docs", "two", "index.html");
    const last = read(f.outDir, "docs", "three", "index.html");
    assert.ok(!first.includes('rel="prev"') && first.includes('href="/docs/two/" rel="next"'));
    assert.ok(middle.includes('href="/docs/" rel="prev"') && middle.includes('href="/docs/three/" rel="next"'));
    assert.ok(last.includes('href="/docs/two/" rel="prev"') && !last.includes('rel="next"'));
  } finally {
    f.done();
  }
});

test("the build fails on a listed page with no fragment and on an unlisted fragment", () => {
  const f = fixture({ index: "<p>a</p>", stray: "<p>b</p>" });
  try {
    assert.throws(
      () => buildSite({ outDir: f.outDir, pagesDir: f.pagesDir, groups: [{ title: "A", pages: [page("index", "One"), page("missing", "Gone")] }] }),
      /missing.*does not exist/,
    );
    assert.throws(
      () => buildSite({ outDir: f.outDir, pagesDir: f.pagesDir, groups: [{ title: "A", pages: [page("index", "One")] }] }),
      /stray\.html is not listed/,
    );
    assert.throws(
      () => buildSite({ outDir: f.outDir, pagesDir: f.pagesDir, groups: [{ title: "A", pages: [page("Bad_Slug", "x")] }] }),
      /Invalid docs slug/,
    );
  } finally {
    f.done();
  }
});

test("code-block renders a labelled, escaped block with a copy button", () => {
  const html = renderFragment(
    '<code-block lang="json">\n{ "a": "<b>&" }\n</code-block>',
    "t",
  );
  assert.match(html, /<span class="code-lang">json<\/span>/);
  assert.match(html, /<button type="button" class="code-copy" aria-label="Copy json code to clipboard">/);
  assert.match(html, /<pre><code>\{ &quot;a&quot;: &quot;&lt;b&gt;&amp;&quot; \}<\/code><\/pre>/);
  assert.ok(!html.includes("<b>"), "raw markup must not survive");
  assert.equal(escapeHtml("<&>"), "&lt;&amp;&gt;");
  assert.throws(() => renderFragment('<code-block lang="x y">a</code-block>', "t"), /unexpected characters/);
  assert.throws(() => renderFragment("<code-block>never closed", "t"), /malformed/);
});

test("headings get unique ids and a fragment may not carry its own h1", () => {
  const html = renderFragment("<h2>Set up</h2><h2>Set up</h2><h3>Set up!</h3>", "t");
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["set-up", "set-up-2", "set-up-3"]);
  assert.throws(() => renderFragment("<h1>Title</h1>", "t"), /contains an <h1>/);
});

test("pageUrl maps the index slug to /docs/ and others to /docs/<slug>/", () => {
  assert.equal(pageUrl("index"), "/docs/");
  assert.equal(pageUrl("quickstart"), "/docs/quickstart/");
});

test("slugify keeps readable ids for inline markup and never leaves a tag behind", () => {
  assert.equal(slugify("<code>remember</code> a fact"), "remember-a-fact");
  assert.equal(slugify("Tom &amp; Jerry"), "tom-jerry");
  // Nested or malformed markup must not survive into an id.
  for (const nasty of ["<scr<script>ipt>alert(1)", "<<b>script>x", "a<b", "<img src=x onerror=1>"]) {
    assert.match(slugify(nasty), /^[a-z0-9-]*$/, nasty);
  }
});
