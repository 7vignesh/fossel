/**
 * Local, dependency-free embeddings for hybrid retrieval.
 *
 * Fossel's identity is local-first, zero-cloud, zero-config, and lightweight.
 * A transformer embedding model would add tens of megabytes and a model
 * download, breaking that promise. Instead we use a deterministic
 * feature-hashing embedding: token unigrams and bigrams are hashed into a
 * fixed-dimension vector. This runs offline, instantly, with no native deps
 * and no download.
 *
 * The embedding is intentionally pluggable. `embedText` is the single entry
 * point used by the write path and retrieval, so a real model (transformers.js,
 * an ONNX runtime, or a remote embedder) can be swapped in later without
 * touching callers. The vectors are L2-normalized so cosine similarity reduces
 * to a dot product.
 *
 * Quality note: this captures lexical and n-gram overlap as dense vectors. It
 * is not a semantic transformer — it will not match pure synonyms with zero
 * shared subwords. It does, however, generalize better than exact keyword
 * matching (sub-token and bigram overlap), and it gives Fossel a real fused
 * vector-retrieval leg that a stronger embedder can later upgrade in place.
 */

import { spawnSync } from "node:child_process";

/** Embedding dimensionality. Kept small so brute-force cosine stays cheap. */
export const EMBEDDING_DIM = 256;

/** Bumped whenever the embedding algorithm changes so stale vectors can be
 * detected and re-indexed. Stored alongside each vector.
 *
 * v2 added character n-gram features, which changes every stored vector, so
 * existing indexes re-embed automatically on the next search via
 * `backfillRepoEmbeddings`. */
export const EMBEDDING_VERSION = 2;

/** Base version marker for externally-embedded vectors, kept well clear of the
 * built-in hashed version so the two never get compared against each other.
 * The effective version is this base plus a hash of the embedder command — see
 * `externalEmbeddingVersion`. */
export const EXTERNAL_EMBEDDING_VERSION = 1000;

/** Size of the version space reserved for external embedders. Every external
 * version lands in [EXTERNAL_EMBEDDING_VERSION, +EXTERNAL_VERSION_SPAN). */
const EXTERNAL_VERSION_SPAN = 1_000_000;

/**
 * Effective stored version for a given external embedder command.
 *
 * Tagging every external embedder with one shared constant was not enough:
 * swapping between two different models of the *same* dimension left the old
 * vectors in place, because the index layer only re-embeds on a version or dim
 * mismatch. Deriving the version from the command string means changing
 * `FOSSEL_EMBEDDER_CMD` changes the version, which makes the existing
 * stale-vector detection in `backfillRepoEmbeddings` re-index automatically —
 * the behaviour the docs already promise.
 *
 * The command string is a proxy for model identity, not a guarantee: editing
 * the model *inside* an unchanged script still needs a manual re-index. That is
 * the same trade-off as bumping `EMBEDDING_VERSION` by hand for the built-in
 * embedder.
 */
export function externalEmbeddingVersion(command: string): number {
  const key = command.trim();
  if (!key) {
    return EXTERNAL_EMBEDDING_VERSION;
  }
  return EXTERNAL_EMBEDDING_VERSION + (fnv1a(key) % EXTERNAL_VERSION_SPAN);
}

/**
 * Returns true when semantic/hybrid retrieval is enabled. Opt-in via env so
 * the zero-config default behaves exactly as before.
 */
export function embeddingsEnabled(): boolean {
  const value = process.env.FOSSEL_EMBEDDINGS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

/**
 * True when an external embedder command is configured via FOSSEL_EMBEDDER_CMD.
 * The command receives the text to embed on stdin and must print a JSON array
 * of numbers (the vector) on stdout. Lets users plug in a stronger model
 * (transformers.js script, an ONNX runner, a local server CLI) while keeping
 * Fossel itself dependency-free.
 */
export function externalEmbedderConfigured(): boolean {
  return Boolean(process.env.FOSSEL_EMBEDDER_CMD?.trim());
}

/** The active embedding dimension and version, accounting for an external
 * embedder. Used by the index layer so stored vectors are tagged and filtered
 * consistently with whichever embedder produced them. */
export function activeEmbeddingMeta(): { dim: number; version: number } {
  const cmd = process.env.FOSSEL_EMBEDDER_CMD?.trim();
  if (cmd) {
    return {
      dim: externalEmbeddingDim(cmd),
      version: externalEmbeddingVersion(cmd),
    };
  }
  return { dim: EMBEDDING_DIM, version: EMBEDDING_VERSION };
}

/** Probed dimensions, keyed by embedder command. Keying by command (rather
 * than a single slot) matters because the command can change within a process
 * — a shared cache would report the previous embedder's dimension. */
const cachedExternalDims = new Map<string, number>();

/** Dimension of the external embedder, determined by probing it once per
 * command with a fixed string and caching the result. Falls back to
 * EMBEDDING_DIM if probing fails (the external path will then also fail and we
 * degrade to hashed). */
function externalEmbeddingDim(command: string): number {
  const cached = cachedExternalDims.get(command);
  if (cached !== undefined) {
    return cached;
  }
  const probe = embedTextExternal("dimension probe");
  const dim = probe ? probe.length : EMBEDDING_DIM;
  cachedExternalDims.set(command, dim);
  return dim;
}

/**
 * Parse and L2-normalize one vector from already-parsed JSON. Returns null when
 * the value is not a usable numeric array.
 */
function normalizeParsedVector(parsed: unknown): Float32Array | null {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  const vector = new Float32Array(parsed.length);
  for (let i = 0; i < parsed.length; i += 1) {
    const value = Number(parsed[i]);
    if (!Number.isFinite(value)) {
      return null;
    }
    vector[i] = value;
  }
  // L2 normalize so cosine similarity reduces to a dot product, matching the
  // built-in embedder's contract.
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) {
      vector[i] /= norm;
    }
  }
  return vector;
}

/** Run the configured embedder once, with `input` on stdin. */
function runEmbedderProcess(input: string): string | null {
  const cmd = process.env.FOSSEL_EMBEDDER_CMD?.trim();
  if (!cmd) {
    return null;
  }
  try {
    // Run via the shell so users can configure a full command line. The text
    // is passed on stdin (not as an argument) to avoid shell-escaping issues
    // and command-injection surface from note content.
    const result = spawnSync(cmd, {
      input,
      encoding: "utf8",
      shell: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    return result.stdout;
  } catch {
    return null;
  }
}

/**
 * Call the configured external embedder. Returns an L2-normalized vector, or
 * null when the embedder is unconfigured, errors, or returns invalid output
 * (so callers can fall back to the built-in embedder).
 */
export function embedTextExternal(text: string): Float32Array | null {
  const stdout = runEmbedderProcess(text);
  if (!stdout) {
    return null;
  }
  try {
    return normalizeParsedVector(JSON.parse(stdout.trim()));
  } catch {
    return null;
  }
}

/**
 * Embed many texts with a **single** process spawn.
 *
 * The original contract was one text on stdin, one JSON array on stdout — which
 * meant embedding N memories cost N process spawns. For a real model that is a
 * model load per memory, so backfilling a few hundred memories was slow enough
 * to make the whole external-embedder escape hatch unusable in practice. That
 * defeated its purpose: it exists to be the way past the built-in embedder's
 * quality ceiling.
 *
 * The batch contract is JSONL both ways: N lines in, each a JSON-encoded string;
 * N lines out, each a JSON array of numbers, in the same order.
 *
 * Backwards compatibility is handled by validation rather than configuration.
 * A single-text embedder handed a batch will produce something that is not N
 * vectors — one concatenated vector, or a parse error — and we detect that and
 * return null so the caller falls back to per-text calls. So no new environment
 * variable, and existing embedders keep working unchanged.
 *
 * Returns null (not a partial result) if anything is wrong, so callers have one
 * simple failure path.
 */
export function embedBatchExternal(texts: string[]): Float32Array[] | null {
  if (texts.length === 0) {
    return [];
  }
  // A single text is indistinguishable from the legacy protocol, so use the
  // legacy path and keep old embedders on their well-tested route.
  if (texts.length === 1) {
    const single = embedTextExternal(texts[0]);
    return single ? [single] : null;
  }

  const stdout = runEmbedderProcess(
    `${texts.map((text) => JSON.stringify(text)).join("\n")}\n`,
  );
  if (!stdout) {
    return null;
  }

  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length !== texts.length) {
    // Almost certainly a legacy single-text embedder. Signal failure so the
    // caller falls back rather than storing misaligned vectors.
    return null;
  }

  const vectors: Float32Array[] = [];
  let dim = 0;
  for (const line of lines) {
    let vector: Float32Array | null;
    try {
      vector = normalizeParsedVector(JSON.parse(line));
    } catch {
      return null;
    }
    if (!vector) {
      return null;
    }
    // Every vector in a batch must share a dimension, or the index would end up
    // with rows that cannot be compared against each other.
    if (dim === 0) {
      dim = vector.length;
    } else if (vector.length !== dim) {
      return null;
    }
    vectors.push(vector);
  }

  return vectors;
}

/**
 * FNV-1a 32-bit hash. Deterministic across platforms and Node versions, which
 * matters because vectors are persisted and must stay comparable over time.
 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    // hash * 16777619, kept in 32-bit unsigned range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  // Force to unsigned 32-bit.
  return hash >>> 0;
}

/**
 * Tokenize text the same way the rest of the codebase normalizes notes: lower
 * case, strip punctuation, collapse whitespace. Keeps embeddings aligned with
 * the FTS/dedup token space.
 */
export function tokenizeForEmbedding(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length >= 2);
}

/** Relative weight of a bigram feature against a unigram feature. */
const BIGRAM_WEIGHT = 0.6;

/**
 * Character n-gram size and weight.
 *
 * Word-level features alone cannot relate `migrate`, `migration` and
 * `migrating` — they hash to three unrelated dimensions. Character n-grams give
 * those forms overlapping features, which is the same trick `lib/dedupe.ts`
 * already uses successfully with trigrams for near-duplicate detection. The
 * weight is low because n-grams are numerous: a 40-character note produces ~38
 * of them against a handful of words, so at equal weight they would drown out
 * the word-level signal entirely.
 */
const CHAR_NGRAM_SIZE = 4;
const CHAR_NGRAM_WEIGHT = 0.25;

/** Only n-gram tokens long enough for it to mean something. Below this the
 * n-grams just reproduce the token. */
const MIN_TOKEN_FOR_NGRAMS = 6;

export interface HashedEmbeddingOptions {
  /**
   * Per-feature multiplier, applied on top of the base unigram/bigram weights.
   * Used to apply inverse document frequency to a *query* vector so common words
   * stop dominating the direction.
   *
   * Deliberately not applied when embedding documents: stored vectors must stay
   * a pure function of their own text, or every vector in the database would go
   * stale the moment corpus statistics shifted, forcing a full re-index on every
   * write. Weighting only the query side is a standard asymmetric tf-idf variant
   * and costs nothing in storage correctness.
   */
  featureWeight?: (feature: string) => number;
}

/**
 * Build an L2-normalized feature-hashed embedding from free-form text.
 * Unigrams and adjacent bigrams are hashed into the vector; a sign bit derived
 * from a second hash reduces collisions (signed feature hashing).
 */
export function embedText(text: string): Float32Array {
  // When an external embedder is configured, delegate to it. It produces
  // vectors of its own dimension (see externalEmbedDim/Version), kept separate
  // from the built-in hashed vectors via the dim/version columns.
  if (externalEmbedderConfigured()) {
    const external = embedTextExternal(text);
    if (external) {
      return external;
    }
    // Fall through to the built-in embedder if the external call fails, so a
    // misconfigured embedder degrades gracefully rather than losing the write.
  }
  return embedTextHashed(text);
}

/** Built-in dependency-free feature-hashed embedding. */
export function embedTextHashed(
  text: string,
  options: HashedEmbeddingOptions = {},
): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIM);
  const tokens = tokenizeForEmbedding(text);

  if (tokens.length === 0) {
    return vector;
  }

  const featureWeight = options.featureWeight;

  const addFeature = (feature: string, weight: number) => {
    const scale = featureWeight ? featureWeight(feature) : 1;
    if (scale === 0) {
      return;
    }
    const h = fnv1a(feature);
    const index = h % EMBEDDING_DIM;
    // Second hash bit decides the sign to spread collisions across +/-.
    const sign = (fnv1a(`#${feature}`) & 1) === 0 ? 1 : -1;
    vector[index] += sign * weight * scale;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    addFeature(token, 1);
    if (i + 1 < tokens.length) {
      // Bigrams capture local word order ("not allowed" vs "allowed").
      addFeature(`${token} ${tokens[i + 1]}`, BIGRAM_WEIGHT);
    }
    // Character n-grams let morphological variants overlap. Padding with a
    // boundary marker keeps prefixes and suffixes distinguishable from the
    // middle of a word, so "migrat" at the start scores differently from the
    // same run of letters inside a longer token.
    if (token.length >= MIN_TOKEN_FOR_NGRAMS) {
      const padded = `^${token}$`;
      for (let j = 0; j + CHAR_NGRAM_SIZE <= padded.length; j += 1) {
        addFeature(padded.slice(j, j + CHAR_NGRAM_SIZE), CHAR_NGRAM_WEIGHT);
      }
    }
  }

  // L2 normalize so cosine similarity == dot product.
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i += 1) {
      vector[i] /= norm;
    }
  }

  return vector;
}

/**
 * Cosine similarity for two L2-normalized vectors (reduces to a dot product).
 * Returns a score in [-1, 1]; for our normalized non-negative-ish hashed
 * vectors it lands in roughly [0, 1].
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
}

/** Serialize a vector to a Buffer for BLOB storage. */
export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Deserialize a Buffer (from a BLOB) back into a Float32Array. */
export function bufferToVector(buffer: Buffer): Float32Array {
  // Copy into a fresh aligned buffer; SQLite blobs are not guaranteed to be
  // 4-byte aligned for a direct Float32Array view.
  const copy = Buffer.from(buffer);
  return new Float32Array(
    copy.buffer,
    copy.byteOffset,
    Math.floor(copy.byteLength / 4),
  );
}
