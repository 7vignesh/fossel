/**
 * Static site build.
 *
 *   node scripts/build-site.mjs
 *
 * Writes `public/`:
 *   - index.html            the landing page, copied byte for byte
 *   - docs/index.html       the docs overview (slug "index")
 *   - docs/<slug>/index.html every other docs page
 *   - docs/docs.css         landing-page theme CSS + site/docs.css
 *   - docs/docs.js          site/docs.js
 *
 * No dependencies. The theme comes from index.html itself: the tokens, layout,
 * nav and footer sections of its <style> block are extracted and reused, so the
 * docs cannot drift from the landing page's colours, fonts and borders. The
 * build fails if one of those sections is missing, which is what would happen
 * if someone renamed a section comment in index.html.
 *
 * A page is a fragment in site/pages/<slug>.html, listed in site/nav.mjs. The
 * build fails on a listed page with no fragment and on a fragment that is not
 * listed. Fragments may use <code-block lang="...">raw text</code-block>, which
 * renders a labelled block with a copy button; its content is HTML-escaped.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS } from "../site/nav.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Sections of index.html's stylesheet that the docs reuse. */
const REUSED_SECTIONS = ["tokens", "layout", "nav", "footer"];

/** localStorage key the landing page uses for the theme. Shared on purpose, so
 * the choice carries between / and /docs. */
export const THEME_KEY = "fossel-theme";

export function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

/** Split the landing page's <style> block into named sections. */
export function extractSections(landingHtml) {
  const style = landingHtml.match(/<style>([\s\S]*?)<\/style>/);
  if (!style) throw new Error("index.html has no <style> block");
  const css = normalizeNewlines(style[1]);
  const marker = /\/\* ─+ ([a-z][a-z0-9 +/&-]*?) ─+ \*\//g;
  const found = [];
  for (let m = marker.exec(css); m; m = marker.exec(css)) {
    found.push({ name: m[1], start: m.index, end: m.index + m[0].length });
  }
  const sections = new Map();
  found.forEach((entry, i) => {
    const bodyEnd = i + 1 < found.length ? found[i + 1].start : css.length;
    sections.set(entry.name, css.slice(entry.start, bodyEnd).trim());
  });
  for (const name of REUSED_SECTIONS) {
    if (!sections.has(name)) {
      throw new Error(`index.html is missing the "${name}" CSS section the docs reuse`);
    }
  }
  return sections;
}

export function extractFontsHref(landingHtml) {
  const m = landingHtml.match(/<link href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)"/);
  if (!m) throw new Error("index.html has no Google Fonts stylesheet link");
  return m[1].replace(/&amp;/g, "&");
}

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const COPY_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function renderCodeBlock(lang, raw) {
  if (!/^[a-z0-9+#._-]*$/i.test(lang)) {
    throw new Error(`code-block lang "${lang}" has unexpected characters`);
  }
  const text = normalizeNewlines(raw).replace(/^\n+/, "").replace(/\s+$/, "");
  const label = lang || "text";
  return (
    `<div class="code">` +
    `<div class="code-head"><span class="code-lang">${escapeHtml(label)}</span>` +
    `<button type="button" class="code-copy" aria-label="Copy ${escapeHtml(label)} code to clipboard">` +
    `<span class="code-copy-icon">${COPY_ICON}</span><span class="code-copy-label" aria-live="polite">copy</span></button></div>` +
    `<pre><code>${escapeHtml(text)}</code></pre></div>`
  );
}

/** Expand <code-block> elements and give h2/h3 headings stable ids. */
export function renderFragment(fragment, slug) {
  if (/<h1[\s>]/i.test(fragment)) {
    throw new Error(`site/pages/${slug}.html contains an <h1>; the page title is the h1`);
  }
  let html = normalizeNewlines(fragment).replace(
    /<code-block(?:\s+lang="([^"]*)")?\s*>([\s\S]*?)<\/code-block>/g,
    (_all, lang, raw) => renderCodeBlock(lang ?? "", raw),
  );
  if (/<code-block/i.test(html)) {
    throw new Error(`site/pages/${slug}.html has a malformed <code-block>`);
  }
  const used = new Set();
  html = html.replace(/<(h[23])>([\s\S]*?)<\/\1>/g, (_all, tag, inner) => {
    let id = slugify(inner) || "section";
    const base = id;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    return `<${tag} id="${id}">${inner}</${tag}>`;
  });
  return html;
}

export function pageUrl(slug) {
  return slug === "index" ? "/docs/" : `/docs/${slug}/`;
}

function pageOutPath(outDir, slug) {
  return slug === "index"
    ? join(outDir, "docs", "index.html")
    : join(outDir, "docs", slug, "index.html");
}

function validateNav(groups, pagesDir) {
  const seen = new Set();
  for (const group of groups) {
    for (const page of group.pages) {
      if (!/^[a-z0-9-]+$/.test(page.slug)) {
        throw new Error(`Invalid docs slug "${page.slug}" (use a-z, 0-9 and hyphens)`);
      }
      if (seen.has(page.slug)) throw new Error(`Duplicate docs slug "${page.slug}"`);
      seen.add(page.slug);
      if (!existsSync(join(pagesDir, `${page.slug}.html`))) {
        throw new Error(`Docs page "${page.slug}" is listed in site/nav.mjs but site/pages/${page.slug}.html does not exist`);
      }
    }
  }
  for (const file of readdirSync(pagesDir)) {
    if (file.endsWith(".html") && !seen.has(file.slice(0, -5))) {
      throw new Error(`site/pages/${file} is not listed in site/nav.mjs`);
    }
  }
}

function renderSidebar(groups, currentSlug) {
  const parts = [];
  for (const group of groups) {
    if (group.pages.length === 0) continue;
    const items = group.pages
      .map((page) => {
        const current = page.slug === currentSlug ? ' aria-current="page"' : "";
        return `<li><a href="${pageUrl(page.slug)}"${current}>${escapeHtml(page.title)}</a></li>`;
      })
      .join("");
    parts.push(
      `<details class="docs-group" open><summary>${escapeHtml(group.title)}</summary><ul>${items}</ul></details>`,
    );
  }
  return parts.join("\n");
}

function renderPager(prev, next) {
  const link = (page, dir) =>
    page
      ? `<a class="docs-pager-${dir}" href="${pageUrl(page.slug)}" rel="${dir}"><span class="docs-pager-label">${dir === "prev" ? "Previous" : "Next"}</span><span class="docs-pager-title">${escapeHtml(page.title)}</span></a>`
      : `<span></span>`;
  if (!prev && !next) return "";
  return `<div class="docs-pager" role="navigation" aria-label="Pagination">${link(prev, "prev")}${link(next, "next")}</div>`;
}

const THEME_SCRIPT = `(function(){var t;try{t=localStorage.getItem('${THEME_KEY}')}catch(e){}if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.setAttribute('data-theme',t)})()`;

const MOON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

function renderPage({ page, body, groups, prev, next, fontsHref }) {
  const title = page.slug === "index" ? "Documentation" : page.title;
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} - Fossel docs</title>
  <meta name="description" content="${escapeHtml(page.description)}" />
  <script>${THEME_SCRIPT}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="${escapeHtml(fontsHref)}" rel="stylesheet">
  <link rel="stylesheet" href="/docs/docs.css">
</head>
<body class="grid-bg">
<nav aria-label="Site">
  <div class="nav-inner">
    <div class="docs-brandrow">
      <button type="button" class="icon-btn docs-menu-btn" data-docs-menu aria-label="Toggle navigation" aria-expanded="false" aria-controls="docs-sidebar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
      <a href="/" class="brand" aria-label="Fossel home"><span class="brand-mark">Fo</span> Fossel</a>
      <span class="docs-crumb">Docs</span>
    </div>
    <div class="nav-actions">
      <button type="button" class="icon-btn" data-theme-toggle aria-label="Toggle theme" title="Toggle theme">${MOON}</button>
      <a href="https://github.com/7vignesh/fossel" target="_blank" rel="noopener noreferrer" class="btn btn-ghost">GitHub</a>
    </div>
  </div>
</nav>
<div class="docs-shell">
  <aside id="docs-sidebar" class="docs-sidebar">
    <div class="docs-nav" role="navigation" aria-label="Documentation">
${renderSidebar(groups, page.slug)}
    </div>
  </aside>
  <div class="docs-scrim"></div>
  <main class="docs-main">
    <article class="docs-article">
      <h1>${escapeHtml(page.title)}</h1>
${body}
${renderPager(prev, next)}
    </article>
  </main>
</div>
<footer>
  <div class="foot">
    <a href="/" class="brand" style="font-size: var(--text-base);"><span class="brand-mark">Fo</span> Fossel</a>
    <div class="links">
      <a href="https://github.com/7vignesh/fossel" target="_blank" rel="noopener noreferrer">GitHub</a>
      <a href="https://www.npmjs.com/package/fossel" target="_blank" rel="noopener noreferrer">npm</a>
      <a href="https://github.com/7vignesh/fossel/blob/main/CHANGELOG.md" target="_blank" rel="noopener noreferrer">Changelog</a>
      <a href="https://github.com/7vignesh/fossel/issues" target="_blank" rel="noopener noreferrer">Issues</a>
    </div>
    <span>MIT · © Fossel</span>
  </div>
</footer>
<script src="/docs/docs.js"></script>
</body>
</html>
`;
}

/**
 * @param {object} [options]
 * @param {string} [options.outDir]    default <repo>/public
 * @param {string} [options.landing]   default <repo>/index.html
 * @param {string} [options.pagesDir]  default <repo>/site/pages
 * @param {string} [options.docsCss]   default <repo>/site/docs.css
 * @param {string} [options.docsJs]    default <repo>/site/docs.js
 * @param {Array}  [options.groups]    default GROUPS from site/nav.mjs
 */
export function buildSite(options = {}) {
  const outDir = options.outDir ?? join(ROOT, "public");
  const landing = options.landing ?? join(ROOT, "index.html");
  const pagesDir = options.pagesDir ?? join(ROOT, "site", "pages");
  const docsCss = options.docsCss ?? join(ROOT, "site", "docs.css");
  const docsJs = options.docsJs ?? join(ROOT, "site", "docs.js");
  const groups = options.groups ?? GROUPS;

  validateNav(groups, pagesDir);

  const landingHtml = readFileSync(landing, "utf8");
  const sections = extractSections(landingHtml);
  const fontsHref = extractFontsHref(landingHtml);
  const reusedCss = REUSED_SECTIONS.map((name) => sections.get(name)).join("\n\n");

  const flat = groups.flatMap((group) => group.pages);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "docs"), { recursive: true });
  copyFileSync(landing, join(outDir, "index.html"));
  writeFileSync(
    join(outDir, "docs", "docs.css"),
    `${reusedCss}\n\n${normalizeNewlines(readFileSync(docsCss, "utf8"))}`,
    "utf8",
  );
  copyFileSync(docsJs, join(outDir, "docs", "docs.js"));

  flat.forEach((page, i) => {
    const body = renderFragment(readFileSync(join(pagesDir, `${page.slug}.html`), "utf8"), page.slug);
    const html = renderPage({
      page,
      body,
      groups,
      prev: flat[i - 1],
      next: flat[i + 1],
      fontsHref,
    });
    const target = pageOutPath(outDir, page.slug);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html, "utf8");
  });

  return { outDir, pages: flat.map((page) => page.slug) };
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    const { outDir, pages } = buildSite();
    console.log(`Built ${pages.length} docs page(s) into ${outDir}`);
  } catch (error) {
    console.error(`build-site failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
