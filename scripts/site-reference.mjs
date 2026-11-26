/**
 * Reference elements for docs fragments, rendered from the snapshot in
 * site/data (see scripts/docs-snapshot.mjs):
 *
 *   <tool-reference names="remember store_context"></tool-reference>
 *       description, parameter table and recorded examples for each tool
 *   <tool-example step="remember-conflict"></tool-example>
 *       one recorded request and response, labelled with its tool
 *   <cli-example id="cli-stats"></cli-example>
 *       one recorded CLI run
 *   <resource-reference></resource-reference>
 *       the MCP resource Fossel exposes, with a recorded read
 *   <bench-results></bench-results>
 *       the three neural-compare tables, from bench/results/neural-compare.json
 *   <bench-value key="fts.latency.search.p50" digits="2"></bench-value>
 *       one number from that file, formatted. Keys: <fts|hybrid|neural>.
 *       coldStartMs | indexBuildMs | dbSizeKb | latency.<path>.<p50|p95> |
 *       recall.<symbol|paraphrase>.<top1|top3> | detail.<name> | modelMb |
 *       top10.<category> (queries whose target was in the top 10) |
 *       top1miss.<category>.<decoy|filler|target|none> (queries whose target
 *       was not first, by what was). Also method.<name> and dataset.<name>.
 *
 * Every name is looked up in the snapshot and a missing one fails the build, so
 * a page cannot describe a tool, step or command the code no longer has.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { escapeHtml, renderCodeBlock } from "./site-html.mjs";

export function loadSiteData(dataDir, benchFile) {
  const toolsPath = join(dataDir, "tools.json");
  const sessionPath = join(dataDir, "session.json");
  if (!existsSync(toolsPath) || !existsSync(sessionPath)) {
    throw new Error(`Docs snapshot not found in ${dataDir}. Run \`npm run docs:snapshot\`.`);
  }
  const tools = JSON.parse(readFileSync(toolsPath, "utf8"));
  const session = JSON.parse(readFileSync(sessionPath, "utf8"));
  const bench = benchFile && existsSync(benchFile) ? JSON.parse(readFileSync(benchFile, "utf8")) : null;
  return {
    bench,
    tools: new Map(tools.tools.map((tool) => [tool.name, tool])),
    steps: new Map(session.steps.map((step) => [step.id, step])),
    stepList: session.steps,
    cli: new Map(session.cli.map((entry) => [entry.id, entry])),
    resource: session.resource,
  };
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** "integer or string", "array of string", "boolean". */
export function typeLabel(schema) {
  if (schema.anyOf) return schema.anyOf.map(typeLabel).join(" or ");
  if (schema.type === "array") return `array of ${schema.items ? typeLabel(schema.items) : "any"}`;
  return schema.type ?? "any";
}

/** Human-readable constraints from a JSON Schema node. */
export function constraintList(schema) {
  const out = [];
  if (schema.enum) out.push(`one of ${schema.enum.join(", ")}`);
  if (schema.exclusiveMinimum !== undefined) out.push(`> ${schema.exclusiveMinimum}`);
  if (schema.minimum !== undefined) out.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined && schema.maximum !== MAX_SAFE) out.push(`max ${schema.maximum}`);
  if (schema.minLength !== undefined) {
    out.push(schema.minLength === 1 ? "non-empty" : `min length ${schema.minLength}`);
  }
  if (schema.type === "array" && schema.items) {
    const inner = constraintList(schema.items);
    if (inner.length > 0) out.push(`each item: ${inner.join(", ")}`);
  }
  if (schema.anyOf) {
    for (const branch of schema.anyOf) {
      const inner = constraintList(branch);
      if (inner.length > 0) out.push(`${typeLabel(branch)}: ${inner.join(", ")}`);
    }
  }
  return out;
}

function renderParams(inputSchema) {
  const properties = inputSchema.properties ?? {};
  const names = Object.keys(properties);
  if (names.length === 0) return `<p class="no-params">This tool takes no parameters.</p>`;
  const required = new Set(inputSchema.required ?? []);
  const rows = names
    .map((name) => {
      const prop = properties[name];
      const description = prop.description
        ? `<span class="param-desc">${escapeHtml(prop.description)}</span>`
        : "";
      const def = prop.default === undefined ? "" : `<code>${escapeHtml(JSON.stringify(prop.default))}</code>`;
      return (
        `<tr><td><code>${escapeHtml(name)}</code>${description}</td>` +
        `<td>${escapeHtml(typeLabel(prop))}</td>` +
        `<td>${required.has(name) ? "yes" : "no"}</td>` +
        `<td>${def}</td>` +
        `<td>${escapeHtml(constraintList(prop).join("; "))}</td></tr>`
      );
    })
    .join("");
  return (
    `<table class="params"><thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Default</th><th>Constraints</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

function renderStep(step, { showTool }) {
  const heading = showTool
    ? `<code>${escapeHtml(step.tool)}</code>: ${escapeHtml(step.title)}`
    : escapeHtml(step.title);
  const args = JSON.stringify(step.args, null, 2);
  return (
    `<div class="example"><p class="example-title">${heading}</p>` +
    renderCodeBlock("json", args, "arguments") +
    renderCodeBlock("text", step.output, step.isError ? "error response" : "response") +
    `</div>`
  );
}

function attr(tag, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  if (!match) throw new Error(`${tag.trim()} is missing the ${name} attribute`);
  return match[1];
}

/** Expand the reference elements in a fragment. `getData` loads the snapshot
 * on first use, so fragments without these elements never need it. */
export function expandReferenceElements(html, getData, slug) {
  let out = html;

  out = out.replace(/<tool-reference\b[^>]*>\s*<\/tool-reference>/g, (tag) => {
    const data = getData();
    const names = attr(tag, "names").split(/\s+/).filter(Boolean);
    return names
      .map((name) => {
        const tool = data.tools.get(name);
        if (!tool) throw new Error(`site/pages/${slug}.html names tool "${name}", which is not in site/data/tools.json`);
        const steps = data.stepList.filter((step) => step.tool === name);
        const examples =
          steps.length === 0
            ? ""
            : `<details class="examples"><summary>Examples (${steps.length})</summary>` +
              steps.map((step) => renderStep(step, { showTool: false })).join("") +
              `</details>`;
        return (
          `<section class="tool"><h3 id="${escapeHtml(name)}"><code>${escapeHtml(name)}</code></h3>` +
          `<p class="tool-desc">${escapeHtml(tool.description)}</p>` +
          renderParams(tool.inputSchema) +
          examples +
          `</section>`
        );
      })
      .join("\n");
  });

  out = out.replace(/<tool-example\b[^>]*>\s*<\/tool-example>/g, (tag) => {
    const id = attr(tag, "step");
    const step = getData().steps.get(id);
    if (!step) throw new Error(`site/pages/${slug}.html uses step "${id}", which is not in site/data/session.json`);
    return renderStep(step, { showTool: true });
  });

  out = out.replace(/<cli-example\b[^>]*>\s*<\/cli-example>/g, (tag) => {
    const id = attr(tag, "id");
    const entry = getData().cli.get(id);
    if (!entry) throw new Error(`site/pages/${slug}.html uses CLI example "${id}", which is not in site/data/session.json`);
    const exit = entry.exitCode === 0 ? "" : ` (exit code ${entry.exitCode})`;
    return (
      `<div class="example"><p class="example-title">${escapeHtml(entry.title)}${escapeHtml(exit)}</p>` +
      renderCodeBlock("bash", `$ ${entry.command}\n${entry.output}`, "terminal") +
      `</div>`
    );
  });

  out = out.replace(/<resource-reference\b[^>]*>\s*<\/resource-reference>/g, () => {
    const { resource } = getData();
    return (
      `<table class="params"><tbody>` +
      `<tr><th>URI</th><td><code>${escapeHtml(resource.uri)}</code></td></tr>` +
      `<tr><th>Name</th><td><code>${escapeHtml(resource.name)}</code></td></tr>` +
      `<tr><th>MIME type</th><td><code>${escapeHtml(resource.mimeType)}</code></td></tr>` +
      `<tr><th>Description</th><td>${escapeHtml(resource.description)}</td></tr>` +
      `</tbody></table>` +
      `<div class="example"><p class="example-title">Reading the resource</p>` +
      renderCodeBlock("md", resource.text, "markdown") +
      `</div>`
    );
  });

  return expandBenchElements(out, getData, slug);
}

// ---------------------------------------------------------------------------
// Benchmark figures, read from bench/results/neural-compare.json
// ---------------------------------------------------------------------------

const BENCH_SYSTEMS = {
  fts: "fossel-fts",
  hybrid: "fossel-hybrid",
  neural: "sqlite-vec-minilm",
};

const LATENCY_LABELS = {
  search: "searchFts()",
  retrieval: "fetchRepoContext() with hashed vectors",
  knnOnly: "vec0 KNN, query vector precomputed",
  queryEmbeddingOnly: "query embedding only",
  embeddingPlusKnn: "query embedding + vec0 KNN",
};

function benchResult(bench, system, key) {
  const id = BENCH_SYSTEMS[system];
  if (!id) throw new Error(`benchmark key "${key}": unknown system "${system}"`);
  const result = bench.results.find((entry) => entry.id === id);
  if (!result) throw new Error(`benchmark key "${key}": no result for ${id} in neural-compare.json`);
  return result;
}

/** Look up one number by key, for example `neural.latency.embeddingPlusKnn.p50`. */
export function benchValue(bench, key) {
  const [system, head, ...tail] = key.split(".");
  if (system === "method" || system === "dataset") {
    const value = bench[system]?.[head];
    if (typeof value !== "number") {
      throw new Error(`benchmark key "${key}" does not resolve to a number in neural-compare.json`);
    }
    return value;
  }
  const result = benchResult(bench, system, key);
  let node;
  switch (head) {
    case "modelMb": {
      const note = (result.notes ?? []).find((text) => /([0-9.]+) MB on disk/.test(text));
      node = note ? Number(/([0-9.]+) MB on disk/.exec(note)[1]) : undefined;
      break;
    }
    case "top10":
      node = result.ranks.filter((r) => r.category === tail[0] && r.rank !== null).length;
      break;
    case "top1miss": {
      const prefix = { decoy: "d-", filler: "f-", target: "n-" }[tail[1]];
      node = result.ranks.filter((r) => {
        if (r.category !== tail[0] || r.rank === 1) return false;
        if (tail[1] === "none") return r.top1 === null;
        return prefix !== undefined && r.top1 !== null && r.top1.startsWith(prefix);
      }).length;
      break;
    }
    case "coldStartMs":
    case "indexBuildMs":
    case "dbSizeKb":
      node = tail.length === 0 ? result[head] : undefined;
      break;
    case "latency":
      node = result.latencyMs?.[tail[0]]?.[tail[1]];
      break;
    case "recall":
      node = result.recall?.[tail[0]]?.[tail[1]];
      break;
    case "detail":
      node = result.detailMs?.[tail[0]];
      break;
    default:
      node = undefined;
  }
  if (typeof node !== "number") {
    throw new Error(`benchmark key "${key}" does not resolve to a number in neural-compare.json`);
  }
  return node;
}

export function formatNumber(value, digits) {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function table(headers, rows) {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="params"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderBenchResults(bench) {
  const fmt1 = (n) => formatNumber(n, 1);
  const setup = table(
    ["System", "Cold start (ms)", "Index build, 1,000 docs (ms)", "DB size (KB)"],
    bench.results.map((r) => [r.label, fmt1(r.coldStartMs), fmt1(r.indexBuildMs), fmt1(r.dbSizeKb)]),
  );
  const latencyRows = [];
  for (const r of bench.results) {
    for (const [path, stats] of Object.entries(r.latencyMs)) {
      latencyRows.push([r.label, LATENCY_LABELS[path] ?? path, formatNumber(stats.p50, 3), formatNumber(stats.p95, 3)]);
    }
  }
  const latency = table(["System", "Measured path", "p50 (ms)", "p95 (ms)"], latencyRows);
  const cell = (r, category, k) => `${fmt1(r.recall[category]?.[k] ?? 0)}%`;
  const recall = table(
    ["System", "Symbol top-1", "Symbol top-3", "Paraphrase top-1", "Paraphrase top-3"],
    bench.results.map((r) => [
      r.label,
      cell(r, "symbol", "top1"),
      cell(r, "symbol", "top3"),
      cell(r, "paraphrase", "top1"),
      cell(r, "paraphrase", "top3"),
    ]),
  );
  const env = bench.environment;
  const when = String(bench.generatedAt).slice(0, 10);
  return (
    `<h3>Setup, index build and size</h3>${setup}` +
    `<h3>Query latency</h3><p>${bench.method.warmupQueries} untimed warmup queries, then ${bench.method.timedQueries} timed queries, each run once.</p>${latency}` +
    `<h3>Recall</h3><p>15 symbol queries and 15 paraphrase queries, one relevant document each, so top-k recall equals hit@k.</p>${recall}` +
    `<p class="note">Recorded ${escapeHtml(when)} on ${escapeHtml(env.cpu)} (${env.logicalCores} logical cores, ${env.memoryGb} GB RAM), ` +
    `${escapeHtml(env.os)}, Node ${escapeHtml(env.node)}, SQLite ${escapeHtml(env.sqlite)}, sqlite-vec ${escapeHtml(env.sqliteVec)}, ` +
    `transformers.js ${escapeHtml(env.transformersJs)}. This is one run. The raw file, with per-query ranks, is ` +
    `<a href="https://github.com/7vignesh/fossel/blob/main/bench/results/neural-compare.json" target="_blank" rel="noopener noreferrer">bench/results/neural-compare.json</a>.</p>`
  );
}

export function expandBenchElements(html, getData, slug) {
  const bench = () => {
    const data = getData();
    if (!data.bench) {
      throw new Error(`site/pages/${slug}.html uses a benchmark element but bench/results/neural-compare.json was not found`);
    }
    return data.bench;
  };
  return html
    .replace(/<bench-results\b[^>]*>\s*<\/bench-results>/g, () => renderBenchResults(bench()))
    .replace(/<bench-value\b[^>]*>\s*<\/bench-value>/g, (tag) => {
      const key = attr(tag, "key");
      const digits = Number(attr(tag, "digits"));
      if (!Number.isInteger(digits) || digits < 0 || digits > 3) {
        throw new Error(`site/pages/${slug}.html: bad digits in ${tag.trim()}`);
      }
      return formatNumber(benchValue(bench(), key), digits);
    });
}
