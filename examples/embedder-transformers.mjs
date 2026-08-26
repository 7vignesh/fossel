#!/usr/bin/env node
/**
 * Reference external embedder for Fossel, using transformers.js.
 *
 * Fossel itself stays dependency-free: this script lives outside the package's
 * dependency tree and you install the model runtime yourself. That is the whole
 * point of the FOSSEL_EMBEDDER_CMD hook — you own the model, Fossel owns the
 * memory.
 *
 * ## Install
 *
 *   npm i @huggingface/transformers
 *
 * ## Configure
 *
 *   {
 *     "mcpServers": {
 *       "fossel": {
 *         "command": "npx",
 *         "args": ["-y", "fossel"],
 *         "env": {
 *           "FOSSEL_WORKSPACE": "${workspaceFolder}",
 *           "FOSSEL_EMBEDDINGS": "1",
 *           "FOSSEL_EMBEDDER_CMD": "node /absolute/path/to/embedder-transformers.mjs"
 *         }
 *       }
 *     }
 *   }
 *
 * The model downloads once on first use (~30 MB quantized for the default) and is
 * cached on disk; every run after that is offline. Override with
 * FOSSEL_EMBED_MODEL, and the cache location with FOSSEL_EMBED_CACHE.
 *
 * ## Protocol
 *
 * Fossel speaks two shapes on stdin, and this script handles both:
 *
 *   - **Batch** (used whenever more than one text is embedded): one JSON-encoded
 *     string per line. Respond with one JSON array of numbers per line, in the
 *     same order.
 *   - **Single**: the raw text, unencoded. Respond with one JSON array.
 *
 * Batching matters: without it Fossel would spawn this process — and reload the
 * model — once per memory, which makes indexing a real repo impractical.
 *
 * Any failure should exit non-zero. Fossel falls back to its built-in embedder,
 * so a broken embedder degrades retrieval quality but never loses a write.
 */

const MODEL = process.env.FOSSEL_EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/**
 * Decide which protocol shape the input uses.
 *
 * Batch input is JSONL where every line is a JSON string. Requiring *every* line
 * to parse as a string is what makes this unambiguous: a raw single text would
 * have to be a valid JSON string literal on every line to be misread, which
 * plain prose never is.
 */
function parseInput(raw) {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { batch: false, texts: [] };
  }

  const decoded = [];
  for (const line of lines) {
    if (!line.startsWith('"')) {
      return { batch: false, texts: [raw] };
    }
    try {
      const value = JSON.parse(line);
      if (typeof value !== "string") {
        return { batch: false, texts: [raw] };
      }
      decoded.push(value);
    } catch {
      return { batch: false, texts: [raw] };
    }
  }
  return { batch: true, texts: decoded };
}

async function main() {
  const raw = await readStdin();
  const { batch, texts } = parseInput(raw);

  if (texts.length === 0) {
    return;
  }

  let pipeline;
  try {
    ({ pipeline } = await import("@huggingface/transformers"));
  } catch {
    process.stderr.write(
      "fossel embedder: @huggingface/transformers is not installed.\n" +
        "Run: npm i @huggingface/transformers\n",
    );
    process.exit(1);
  }

  if (process.env.FOSSEL_EMBED_CACHE) {
    const { env } = await import("@huggingface/transformers");
    env.cacheDir = process.env.FOSSEL_EMBED_CACHE;
  }

  const extract = await pipeline("feature-extraction", MODEL, {
    dtype: "q8",
  });

  // Mean pooling plus L2 normalization is the standard sentence-embedding recipe
  // for these models. Fossel re-normalizes anyway, but doing it here keeps the
  // script correct on its own terms.
  const output = await extract(texts, { pooling: "mean", normalize: true });
  const rows = output.tolist();

  if (batch) {
    process.stdout.write(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  } else {
    process.stdout.write(JSON.stringify(rows[0]));
  }
}

main().catch((error) => {
  process.stderr.write(`fossel embedder failed: ${error?.message ?? error}\n`);
  process.exit(1);
});
