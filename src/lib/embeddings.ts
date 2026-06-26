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
 * detected and re-indexed. Stored alongside each vector. */
export const EMBEDDING_VERSION = 1;

/** Version marker for externally-embedded vectors, kept distinct from the
 * built-in hashed version so the two never get compared against each other. */
export const EXTERNAL_EMBEDDING_VERSION = 1000;

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
  if (externalEmbedderConfigured()) {
    return {
      dim: externalEmbeddingDim(),
      version: EXTERNAL_EMBEDDING_VERSION,
    };
  }
  return { dim: EMBEDDING_DIM, version: EMBEDDING_VERSION };
}

let cachedExternalDim: number | null = null;

/** Dimension of the external embedder, determined by probing it once with a
 * fixed string and caching the result. Falls back to EMBEDDING_DIM if probing
 * fails (the external path will then also fail and we degrade to hashed). */
function externalEmbeddingDim(): number {
  if (cachedExternalDim !== null) {
    return cachedExternalDim;
  }
  const probe = embedTextExternal("dimension probe");
  cachedExternalDim = probe ? probe.length : EMBEDDING_DIM;
  return cachedExternalDim;
}

/**
 * Call the configured external embedder. Returns an L2-normalized vector, or
 * null when the embedder is unconfigured, errors, or returns invalid output
 * (so callers can fall back to the built-in embedder).
 */
export function embedTextExternal(text: string): Float32Array | null {
  const cmd = process.env.FOSSEL_EMBEDDER_CMD?.trim();
  if (!cmd) {
    return null;
  }
  try {
    // Run via the shell so users can configure a full command line. The text
    // is passed on stdin (not as an argument) to avoid shell-escaping issues
    // and command-injection surface from note content.
    const result = spawnSync(cmd, {
      input: text,
      encoding: "utf8",
      shell: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    const parsed = JSON.parse(result.stdout.trim());
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
  } catch {
    return null;
  }
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
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length >= 2);
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
export function embedTextHashed(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIM);
  const tokens = tokenize(text);

  if (tokens.length === 0) {
    return vector;
  }

  const addFeature = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    const index = h % EMBEDDING_DIM;
    // Second hash bit decides the sign to spread collisions across +/-.
    const sign = (fnv1a(`#${feature}`) & 1) === 0 ? 1 : -1;
    vector[index] += sign * weight;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    addFeature(tokens[i], 1);
    if (i + 1 < tokens.length) {
      // Bigrams capture local word order ("not allowed" vs "allowed").
      addFeature(`${tokens[i]} ${tokens[i + 1]}`, 0.6);
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
