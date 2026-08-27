/**
 * Entity extraction for memories.
 *
 * Extracts structured entities (file paths, packages, functions, identifiers,
 * services, tickets) from free-form note text using regex heuristics. Entities
 * are stored in a side table and used as a third retrieval leg in fusion,
 * boosting memories that share named entities with the query.
 *
 * Like all Fossel heuristics: no LLM, no network, no model download.
 */

import type Database from "better-sqlite3";
import type { MemoryRecord } from "../db/client.js";

export interface Entity {
  entity: string;
  kind: string;
}

/**
 * File path pattern — reuses the same shape as file-refs.ts extractFilePaths.
 * Matches dotted filenames with known code/config extensions, optionally
 * preceded by directory segments.
 */
const FILE_PATH_PATTERN =
  /(?:\.\/|\/)?(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|php|swift|scala|sql|sh|yml|yaml|toml|json|md|css|scss|html|vue|svelte)\b/gi;

/**
 * Scoped npm packages: @scope/name
 */
const SCOPED_PACKAGE_PATTERN = /@[a-z0-9-]+\/[a-z0-9._-]+/g;

/**
 * Known package/library names. Matched as whole words.
 */
const KNOWN_PACKAGES = new Set([
  "express", "react", "vue", "angular", "next", "nuxt", "svelte",
  "webpack", "vite", "rollup", "esbuild", "tsup", "parcel",
  "jest", "mocha", "vitest", "playwright", "cypress",
  "lodash", "underscore", "ramda", "rxjs",
  "axios", "fetch", "got", "superagent",
  "prisma", "sequelize", "typeorm", "knex", "drizzle",
  "tailwind", "bootstrap", "styled-components",
  "zod", "joi", "yup", "ajv",
  "fastify", "koa", "hapi", "nest", "nestjs",
  "mongoose", "mongodb", "redis", "ioredis",
  "typescript", "babel", "eslint", "prettier",
  "docker", "kubernetes", "terraform", "ansible",
  "graphql", "apollo", "trpc",
  "socket.io", "ws",
  "nanoid", "uuid",
  "better-sqlite3", "sqlite3",
  "pnpm", "npm", "yarn",
]);

/**
 * Function call pattern: camelCase or snake_case identifiers followed by ()
 */
const FUNCTION_CALL_PATTERN = /\b([a-z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)*)\s*\(\)/g;

/**
 * PascalCase identifier pattern: starts with uppercase, has at least 2
 * uppercase letters total (to distinguish from regular words).
 */
const PASCAL_CASE_PATTERN = /\b([A-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g;

/**
 * Known service patterns.
 */
const KNOWN_SERVICES = new Set([
  "redis", "postgres", "postgresql", "mysql", "mariadb", "mongodb", "mongo",
  "rabbitmq", "kafka", "nats", "pulsar",
  "elasticsearch", "opensearch", "solr",
  "s3", "dynamodb", "lambda", "sqs", "sns", "cloudfront",
  "nginx", "apache", "caddy", "traefik",
  "docker", "kubernetes", "k8s",
  "datadog", "grafana", "prometheus", "jaeger",
  "vault", "consul", "etcd",
  "memcached", "valkey",
  "supabase", "firebase", "planetscale", "neon",
  "vercel", "netlify", "cloudflare", "fly.io",
  "stripe", "twilio", "sendgrid",
]);

/**
 * Ticket/issue reference pattern: #123, JIRA-123, GH-123, PROJ-1234
 */
const TICKET_PATTERN = /\b([A-Z]{2,10}-\d+)\b|(?<!\w)(#\d+)\b/g;

/**
 * Extract structured entities from free-form text using regex heuristics.
 *
 * Entity normalization: lowercase everything except file paths (which keep
 * their original case for path matching).
 */
export function extractEntities(text: string): Entity[] {
  const entities: Entity[] = [];
  const seen = new Set<string>();

  const add = (entity: string, kind: string) => {
    const key = `${kind}:${entity}`;
    if (seen.has(key)) return;
    seen.add(key);
    entities.push({ entity, kind });
  };

  // File paths — keep original case
  const filePaths = text.match(FILE_PATH_PATTERN);
  if (filePaths) {
    for (const raw of filePaths) {
      const normalized = raw.replace(/\\/g, "/").replace(/^\.?\//, "");
      if (normalized && normalized.includes(".")) {
        add(normalized, "file");
      }
    }
  }

  // Scoped npm packages — lowercase
  const scopedPkgs = text.match(SCOPED_PACKAGE_PATTERN);
  if (scopedPkgs) {
    for (const pkg of scopedPkgs) {
      add(pkg.toLowerCase(), "package");
    }
  }

  // Known packages — match as whole words, lowercase
  const words = text.split(/[\s,;:'"()\[\]{}|]+/);
  for (const word of words) {
    const lower = word.toLowerCase().replace(/[^a-z0-9._@/-]/g, "");
    if (KNOWN_PACKAGES.has(lower)) {
      add(lower, "package");
    }
    if (KNOWN_SERVICES.has(lower)) {
      add(lower, "service");
    }
  }

  // Function calls — lowercase
  let match: RegExpExecArray | null;
  FUNCTION_CALL_PATTERN.lastIndex = 0;
  while ((match = FUNCTION_CALL_PATTERN.exec(text)) !== null) {
    const name = match[1];
    // Skip very short names (1-2 chars) — too noisy
    if (name.length > 2) {
      add(name.toLowerCase(), "function");
    }
  }

  // PascalCase identifiers — lowercase
  PASCAL_CASE_PATTERN.lastIndex = 0;
  while ((match = PASCAL_CASE_PATTERN.exec(text)) !== null) {
    const name = match[1];
    // Skip very short names
    if (name.length > 2) {
      add(name.toLowerCase(), "identifier");
    }
  }

  // Tickets — uppercase (natural form)
  TICKET_PATTERN.lastIndex = 0;
  while ((match = TICKET_PATTERN.exec(text)) !== null) {
    const ticket = match[1] ?? match[2];
    if (ticket) {
      add(ticket.toUpperCase(), "ticket");
    }
  }

  return entities;
}

/**
 * Record entities extracted from a memory note. Replaces any existing entities
 * for the memory (full replace pattern, same as file-refs). Returns the number
 * of entities recorded.
 */
export function recordEntities(
  db: Database.Database,
  memoryRowId: number,
  note: string,
): number {
  const entities = extractEntities(note);
  if (entities.length === 0) {
    // Still delete stale entries if the note was edited to remove all entities.
    db.prepare("DELETE FROM memory_entities WHERE memory_rowid = ?").run(
      memoryRowId,
    );
    return 0;
  }

  const del = db.prepare("DELETE FROM memory_entities WHERE memory_rowid = ?");
  const insert = db.prepare(
    `INSERT INTO memory_entities (memory_rowid, entity, kind)
     VALUES (?, ?, ?)
     ON CONFLICT DO NOTHING`,
  );

  let recorded = 0;
  const tx = db.transaction(() => {
    del.run(memoryRowId);
    for (const { entity, kind } of entities) {
      insert.run(memoryRowId, entity, kind);
      recorded += 1;
    }
  });
  tx();
  return recorded;
}

/**
 * Find memories that share entities with the given query entities. Returns
 * MemoryRecord rows ranked by number of shared entities (most shared first).
 */
export function findEntityMatches(
  db: Database.Database,
  repo: string,
  queryEntities: Entity[],
  limit: number,
): MemoryRecord[] {
  if (queryEntities.length === 0) {
    return [];
  }

  const entityValues = queryEntities.map((e) => e.entity);
  const placeholders = entityValues.map(() => "?").join(", ");

  const rows = db
    .prepare(
      `
        SELECT
          m.rowid AS row_id, m.id, m.repo, m.type, m.note, m.tags,
          m.created_at, m.updated_at, m.pinned,
          COUNT(DISTINCT me.entity) AS shared_count
        FROM memory_entities me
        JOIN memories m ON m.rowid = me.memory_rowid
        WHERE me.entity IN (${placeholders})
          AND m.repo = ?
          AND m.valid_to IS NULL
        GROUP BY m.rowid
        ORDER BY shared_count DESC, m.updated_at DESC
        LIMIT ?
      `,
    )
    .all(...entityValues, repo, limit) as Array<MemoryRecord & { shared_count: number }>;

  // Strip the extra shared_count field, return plain MemoryRecord[]
  return rows.map(({ shared_count, ...memory }) => memory);
}
