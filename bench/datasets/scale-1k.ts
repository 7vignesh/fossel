/**
 * scale-1k: a deterministic, seeded 1,000-document developer-memory corpus with
 * 30 labelled queries (15 exact-symbol, 15 paraphrase).
 *
 * SYNTHETIC BY DESIGN. The corpus is generated from templates and hand-written
 * needles, and the query split is chosen to probe two different retrieval
 * behaviours (literal identifier lookup vs. meaning without shared vocabulary).
 * Scores on it describe those two behaviours; they are not a prediction of
 * accuracy on a real repo's memories.
 *
 * Composition (1,000 documents):
 *   -  30 needles   one hand-written target per query
 *   -  15 decoys    hand-written near-misses for the symbol queries only
 *   - 955 fillers   generated: 191 each of TypeScript signatures, PostgreSQL
 *                   schemas/errors, stack traces, CLI flags, architecture notes
 *
 * Symbol decoys are deliberate and disclosed: a sibling identifier sits next to
 * each target (PGRST302 beside PGRST301), which is the realistic way identifier
 * lookup goes wrong. Paraphrase queries have no decoys. An earlier revision
 * gave them lexical-trap decoys that reused each query's own words; the first
 * benchmark run showed every system, the dense model included, ranking those
 * decoys first, which made paraphrase top-1 uninformative. Paraphrase targets
 * share no stemmed content words with their query (checked in
 * tests/scale-1k-dataset.test.ts).
 *
 * Label invariants (also checked in the test):
 *   - every exact query string appears, case-insensitively, in exactly one
 *     document: its target;
 *   - fillers never contain the concepts the paraphrase queries ask about, so
 *     each paraphrase query has exactly one correct document.
 *
 * Array order is recency order (first is newest), matching the harness. The
 * order is a seeded shuffle so targets are not clustered.
 */

import type { BenchDataset, BenchMemory, BenchQuery, MemoryType } from "../lib/harness.js";

export const SCALE_1K_SEED = 20240601;
const FILLERS_PER_CATEGORY = 191;

type Rng = () => number;

/** mulberry32: tiny, fast, and identical on every platform. */
function mulberry32(seed: number): Rng {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Call `make` until `count` distinct strings exist. Insertion order is kept,
 * so the result is deterministic for a given rng stream. */
function unique(count: number, make: () => string): string[] {
  const seen = new Set<string>();
  let attempts = 0;
  while (seen.size < count) {
    attempts += 1;
    if (attempts > count * 100) {
      throw new Error("scale-1k: template space too small for requested count");
    }
    seen.add(make());
  }
  return Array.from(seen);
}

interface Seed {
  key: string;
  note: string;
  type: MemoryType;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Hand-written needles, decoys and queries
// ---------------------------------------------------------------------------

interface Case {
  id: string;
  category: "symbol" | "paraphrase";
  query: string;
  rationale: string;
  target: { note: string; type: MemoryType; tags: string[] };
  /** Symbol cases only. See the header for why paraphrase cases have none. */
  decoy?: { note: string; type: MemoryType; tags: string[] };
}

const CASES: Case[] = [
  // ----- exact symbol / identifier -----------------------------------------
  {
    id: "s01",
    category: "symbol",
    query: "PGRST301",
    rationale: "PostgREST error code; sibling code PGRST302 is the decoy.",
    target: {
      note: "PostgREST returns PGRST301 (HTTP 401) when the JWT is expired or its signature does not match the configured secret. Refresh the Supabase session and send the request once more.",
      type: "bug_fix",
      tags: ["postgrest", "auth"],
    },
    decoy: {
      note: "PGRST302 means anonymous access is disabled because db-anon-role is not set. Configure it or require a JWT on every route.",
      type: "issue",
      tags: ["postgrest", "auth"],
    },
  },
  {
    id: "s02",
    category: "symbol",
    query: "FOR UPDATE SKIP LOCKED",
    rationale: "SQL clause; the decoy describes the older plain FOR UPDATE claim.",
    target: {
      note: "claim_next_job() selects the oldest queued row with FOR UPDATE SKIP LOCKED inside the worker transaction, so concurrent workers never block on each other or take the same job.",
      type: "convention",
      tags: ["postgres", "queue"],
    },
    decoy: {
      note: "claim_next_job_v1 used a plain FOR UPDATE and serialised every worker behind the first row lock. It was replaced in release 2.4.",
      type: "decision",
      tags: ["postgres", "queue"],
    },
  },
  {
    id: "s03",
    category: "symbol",
    query: "ECONNRESET",
    rationale: "Node socket error code inside a stack trace; decoy is an ETIMEDOUT trace.",
    target: {
      note: "Error: read ECONNRESET\n    at TLSWrap.onStreamRead (node:internal/stream_base_commons:217:20)\n    at Connection.<anonymous> (node_modules/pg-pool/index.js:45:13)\nCause: PgBouncer closed an idle server connection after server_idle_timeout. Fix: set the pool idleTimeoutMillis below the bouncer timeout so the client drops connections first.",
      type: "bug_fix",
      tags: ["pg", "pgbouncer"],
    },
    decoy: {
      note: "Error: connect ETIMEDOUT 10.0.3.14:6432\n    at TCPConnectWrap.afterConnect (node:net:1595:16)\nCause: the PgBouncer security group does not allow the new subnet. Fix: add the subnet CIDR to the inbound rule.",
      type: "bug_fix",
      tags: ["pg", "pgbouncer"],
    },
  },
  {
    id: "s04",
    category: "symbol",
    query: "useOptimisticMutation",
    rationale: "TypeScript hook name; decoy is a sibling hook.",
    target: {
      note: "export function useOptimisticMutation<TData, TVars>(key: QueryKey, mutate: (vars: TVars) => Promise<TData>, opts?: OptimisticOptions<TData>): MutationHandle<TData, TVars>\n// Applies the patch to the query cache immediately and rolls it back if the mutation rejects.",
      type: "general",
      tags: ["react-query", "typescript"],
    },
    decoy: {
      note: "export function useOptimisticQuery<TData>(key: QueryKey): TData | undefined\n// Reads the pending patch layer without mutating it. Never call a mutation from inside this hook.",
      type: "general",
      tags: ["react-query", "typescript"],
    },
  },
  {
    id: "s05",
    category: "symbol",
    query: "idle_in_transaction_session_timeout",
    rationale: "PostgreSQL config key; decoy is statement_timeout.",
    target: {
      note: "Set idle_in_transaction_session_timeout = '30s' on the app role. Forgotten open transactions held row locks for hours and blocked autovacuum until this was added.",
      type: "convention",
      tags: ["postgres", "config"],
    },
    decoy: {
      note: "statement_timeout is 15s for the web role and 10min for the reporting role. Both are applied with ALTER ROLE in the bootstrap migration.",
      type: "convention",
      tags: ["postgres", "config"],
    },
  },
  {
    id: "s06",
    category: "symbol",
    query: "--max-old-space-size",
    rationale: "Node CLI flag; decoy is the sibling --max-semi-space-size.",
    target: {
      note: "CI builds of the web bundle run out of heap at the default limit. Run them with NODE_OPTIONS=--max-old-space-size=4096 on the 7GB runners; 8192 starves the runner itself.",
      type: "bug_fix",
      tags: ["ci", "node"],
    },
    decoy: {
      note: "--max-semi-space-size=64 shortened scavenge pauses in the SSR server but did not change the build's memory use.",
      type: "general",
      tags: ["ssr", "node"],
    },
  },
  {
    id: "s07",
    category: "symbol",
    query: "ERR_MODULE_NOT_FOUND",
    rationale: "Node error code; decoy is the sibling ERR_REQUIRE_ESM.",
    target: {
      note: "ERR_MODULE_NOT_FOUND: Cannot find module './util' imported from src/index.js. Under NodeNext every relative import needs an explicit .js extension, even inside .ts source files.",
      type: "bug_fix",
      tags: ["typescript", "esm"],
    },
    decoy: {
      note: "ERR_REQUIRE_ESM appears when a CommonJS script require()s our ESM-only package. Switch the caller to a dynamic import().",
      type: "bug_fix",
      tags: ["typescript", "esm"],
    },
  },
  {
    id: "s08",
    category: "symbol",
    query: "pg_advisory_xact_lock",
    rationale: "PostgreSQL function; decoy is the session-scoped pg_try_advisory_lock.",
    target: {
      note: "Deploys run migrations under pg_advisory_xact_lock(724001), so two pipelines starting together cannot apply the same migration twice. The lock is released automatically at commit.",
      type: "convention",
      tags: ["postgres", "deploy"],
    },
    decoy: {
      note: "pg_try_advisory_lock is session scoped and leaks through PgBouncer transaction pooling. Do not use it for migrations.",
      type: "issue",
      tags: ["postgres", "pgbouncer"],
    },
  },
  {
    id: "s09",
    category: "symbol",
    query: "tenant_isolation",
    rationale: "Row-level-security policy name; decoy is the admin_bypass policy.",
    target: {
      note: "CREATE POLICY tenant_isolation ON invoices USING (tenant_id = current_setting('app.tenant_id')::uuid); every request runs SET LOCAL app.tenant_id before its first query.",
      type: "convention",
      tags: ["postgres", "rls"],
    },
    decoy: {
      note: "CREATE POLICY admin_bypass ON invoices TO support_role USING (true) is audited weekly. It is the only policy that ignores tenant scoping.",
      type: "decision",
      tags: ["postgres", "rls"],
    },
  },
  {
    id: "s10",
    category: "symbol",
    query: "parseRetryAfter",
    rationale: "TypeScript function name; decoy is the sibling formatRetryDelay.",
    target: {
      note: "export function parseRetryAfter(header: string | null, now = Date.now()): number | null\n// Returns milliseconds to wait. Accepts delta-seconds or an HTTP-date, and null when the header is absent or unparseable.",
      type: "general",
      tags: ["http", "typescript"],
    },
    decoy: {
      note: "formatRetryDelay(ms: number): string renders 90000 as '1m 30s' for the UI toast.",
      type: "general",
      tags: ["ui", "typescript"],
    },
  },
  {
    id: "s11",
    category: "symbol",
    query: "WEBHOOK_SIGNING_SECRET",
    rationale: "Environment config key; decoy is SESSION_COOKIE_KEY.",
    target: {
      note: "The payments webhook handler verifies signatures with WEBHOOK_SIGNING_SECRET, read once at boot. Rotating it needs a rolling restart, otherwise the old value keeps verifying until pods recycle.",
      type: "issue",
      tags: ["payments", "config"],
    },
    decoy: {
      note: "SESSION_COOKIE_KEY signs session cookies. Rotating it signs every user out, so schedule it for a quiet hour.",
      type: "convention",
      tags: ["auth", "config"],
    },
  },
  {
    id: "s12",
    category: "symbol",
    query: "jsonb_path_ops",
    rationale: "PostgreSQL operator class; decoy covers the default jsonb_ops.",
    target: {
      note: "The GIN index on events.payload uses jsonb_path_ops. It is noticeably smaller than the default operator class, but supports only @> containment, not the ? key-exists operator.",
      type: "decision",
      tags: ["postgres", "index"],
    },
    decoy: {
      note: "A GIN index on payload with the default jsonb_ops supports ?, ?| and ?& key-existence lookups, which the admin filter relies on.",
      type: "general",
      tags: ["postgres", "index"],
    },
  },
  {
    id: "s13",
    category: "symbol",
    query: "TS2589",
    rationale: "TypeScript diagnostic code; decoy is TS2322.",
    target: {
      note: "TS2589: Type instantiation is excessively deep and possibly infinite. Triggered by chaining thirty .extend() calls on one zod object. Split the schema into smaller objects and annotate with z.ZodType.",
      type: "bug_fix",
      tags: ["typescript", "zod"],
    },
    decoy: {
      note: "TS2322 on the Drizzle insert helper: the inferred insert type marks defaultRandom() columns as required. Use $inferInsert instead.",
      type: "bug_fix",
      tags: ["typescript", "drizzle"],
    },
  },
  {
    id: "s14",
    category: "symbol",
    query: "--shard",
    rationale: "Test-runner CLI flag; decoy is --sequence.shuffle.",
    target: {
      note: "CI runs vitest with --shard=1/4 through 4/4 on a four-job matrix, then merges the coverage reports in a fifth job.",
      type: "convention",
      tags: ["ci", "vitest"],
    },
    decoy: {
      note: "--sequence.shuffle on the flaky-test branch exposed order dependence in the cart specs.",
      type: "issue",
      tags: ["ci", "vitest"],
    },
  },
  {
    id: "s15",
    category: "symbol",
    query: "40P01",
    rationale: "PostgreSQL SQLSTATE; decoy is 40001.",
    target: {
      note: "SQLSTATE 40P01 (deadlock detected) appeared when two checkout transactions updated inventory rows in opposite order. Always lock rows in ascending sku order.",
      type: "bug_fix",
      tags: ["postgres", "checkout"],
    },
    decoy: {
      note: "SQLSTATE 40001 serialization_failure under REPEATABLE READ is expected. The transaction helper re-runs the callback up to three times.",
      type: "convention",
      tags: ["postgres", "transactions"],
    },
  },

  // ----- paraphrase / conceptual -------------------------------------------
  {
    id: "p01",
    category: "paraphrase",
    query: "How do we make sure a customer still hears from us if the server dies right after saving their purchase?",
    rationale: "Transactional outbox, described without the words customer, hears, server, saving or purchase.",
    target: {
      note: "Order confirmation emails are written to an outbox table in the same transaction as the order, then a poller sends them. A crash between commit and send cannot lose the message, and rows are flagged as delivered only once the mail provider accepts them.",
      type: "decision",
      tags: ["email", "reliability"],
    },
  },
  {
    id: "p02",
    category: "paraphrase",
    query: "Why can't we just erase user accounts from the database for good?",
    rationale: "Soft deletion, described without erase, user, accounts, database or good.",
    target: {
      note: "The API never deletes customer rows. A deleted_at timestamp hides them from normal queries, so audits and the undo window keep working.",
      type: "convention",
      tags: ["data", "audit"],
    },
  },
  {
    id: "p03",
    category: "paraphrase",
    query: "What prevents someone from being billed two times when their phone resubmits the checkout call?",
    rationale: "Idempotency keys, described without billed, phone, resubmits, checkout or call.",
    target: {
      note: "Clients send an Idempotency-Key header. The server stores the first response for 24 hours and replays it for repeats, so a retried payment never charges twice.",
      type: "convention",
      tags: ["payments", "api"],
    },
  },
  {
    id: "p04",
    category: "paraphrase",
    query: "What happens to a call in progress if someone toggles a rollout switch?",
    rationale: "Per-request flag caching, described without call, progress, toggles, rollout or switch.",
    target: {
      note: "Feature flags are evaluated once per request and cached on the request context, so flipping a flag mid-request cannot change behaviour half-way through.",
      type: "decision",
      tags: ["flags", "api"],
    },
  },
  {
    id: "p05",
    category: "paraphrase",
    query: "What keeps a half-upgraded fleet from misreading objects that another generation of the app wrote into the shared store?",
    rationale: "Version-prefixed cache keys, described without fleet, upgraded, objects, generation or store.",
    target: {
      note: "Cache keys are prefixed with the build version, so a server running an earlier release never reads entries written by a later one during a rolling deploy.",
      type: "decision",
      tags: ["cache", "deploy"],
    },
  },
  {
    id: "p06",
    category: "paraphrase",
    query: "What happens to tasks that keep crashing so they don't hammer the system forever?",
    rationale: "Backoff plus dead-letter queue, described without tasks, crashing, hammer, system or forever.",
    target: {
      note: "Failed background jobs are retried with exponentially growing delays plus random jitter. After seven attempts they are parked in a dead-letter queue for a human to inspect.",
      type: "convention",
      tags: ["queue", "reliability"],
    },
  },
  {
    id: "p07",
    category: "paraphrase",
    query: "How do we represent prices so invoice sums come out exact?",
    rationale: "Integer minor units for money, described without represent, prices, invoice or sums.",
    target: {
      note: "Money is stored as integer minor units in a bigint column. Floating point is banned for currency because rounding drift makes totals disagree by a penny.",
      type: "convention",
      tags: ["money", "data"],
    },
  },
  {
    id: "p08",
    category: "paraphrase",
    query: "How does someone stay signed in all day without typing their password again?",
    rationale: "Short-lived access plus long-lived cookie credential, described without signed, typing or password.",
    target: {
      note: "Access tokens last fifteen minutes. A longer-lived opaque credential in an httpOnly cookie is exchanged for a fresh one in the background.",
      type: "decision",
      tags: ["auth", "session"],
    },
  },
  {
    id: "p09",
    category: "paraphrase",
    query: "How do people chatting in one channel all end up attached to a single backend instance?",
    rationale: "Room-keyed consistent hashing, described without chatting, channel, attached or instance.",
    target: {
      note: "The websocket gateway is partitioned by room id using consistent hashing, so every participant of a conversation lands on the same node.",
      type: "decision",
      tags: ["websocket", "scaling"],
    },
  },
  {
    id: "p10",
    category: "paraphrase",
    query: "How do we avoid exhausting RAM when someone downloads a gigantic spreadsheet?",
    rationale: "Streaming exports, described without exhausting, RAM, downloads, gigantic or spreadsheet.",
    target: {
      note: "Large CSV exports stream rows through a database cursor straight into the HTTP response instead of building the whole file in memory.",
      type: "convention",
      tags: ["export", "performance"],
    },
  },
  {
    id: "p11",
    category: "paraphrase",
    query: "How do we reshape a table's layout while older builds are still serving users?",
    rationale: "Expand/contract migrations, described without reshape, layout, older, builds or serving.",
    target: {
      note: "Schema changes ship in two releases: add the new column and backfill it, switch reads over, and only drop the old column in the following release.",
      type: "convention",
      tags: ["migrations", "deploy"],
    },
  },
  {
    id: "p12",
    category: "paraphrase",
    query: "How do we stop one client from flooding us with too many calls?",
    rationale: "Per-key token bucket, described without client, flooding or calls.",
    target: {
      note: "Each API key gets a token bucket in Redis that refills at a fixed pace, so short spikes pass but sustained abuse is throttled.",
      type: "decision",
      tags: ["api", "redis"],
    },
  },
  {
    id: "p13",
    category: "paraphrase",
    query: "When something breaks, how do we reconstruct the full path an incoming call took across our backend components?",
    rationale: "Correlation ids, described without reconstruct, path, incoming, call or components.",
    target: {
      note: "Every log line carries a correlation id minted at the edge and forwarded on each internal hop, so a single user action can be followed through every service.",
      type: "convention",
      tags: ["logging", "observability"],
    },
  },
  {
    id: "p14",
    category: "paraphrase",
    query: "Where should passwords and keys that the application needs be stored?",
    rationale: "Secret manager, described without passwords, keys, application or stored.",
    target: {
      note: "Credentials never live in the repository. They are injected at runtime from the cloud secrets manager and rotated every ninety days.",
      type: "convention",
      tags: ["security", "ops"],
    },
  },
  {
    id: "p15",
    category: "paraphrase",
    query: "Why do collection requests hand back a bookmark instead of letting us jump to arbitrary positions?",
    rationale: "Keyset pagination, described without collection, bookmark, jump, arbitrary or positions.",
    target: {
      note: "List endpoints return an opaque cursor built from the last row's sort key rather than page numbers, because deep offsets get slower and skip or repeat rows when data changes.",
      type: "decision",
      tags: ["api", "pagination"],
    },
  },
];

// ---------------------------------------------------------------------------
// Generated fillers
// ---------------------------------------------------------------------------

const TS_VERBS: ReadonlyArray<readonly [string, (noun: string) => string]> = [
  ["fetch", (n) => `Loads the ${n} from the primary store`],
  ["create", (n) => `Validates and inserts a new ${n}`],
  ["update", (n) => `Applies a partial patch to an existing ${n}`],
  ["validate", (n) => `Checks a ${n} against the business rules without writing`],
  ["normalize", (n) => `Canonicalises casing and whitespace on a ${n}`],
  ["resolve", (n) => `Looks up the ${n} behind an external reference`],
  ["serialize", (n) => `Converts a ${n} to its wire format`],
  ["hydrate", (n) => `Rebuilds a ${n} from a raw database row`],
  ["merge", (n) => `Combines two ${n} records, preferring the newer fields`],
  ["filter", (n) => `Narrows a list of ${n} records by the supplied predicates`],
  ["compute", (n) => `Derives the summary fields of a ${n}`],
  ["render", (n) => `Formats a ${n} for display in the dashboard`],
];
const TS_NOUNS = [
  "Invoice", "Cart", "Profile", "Workspace", "Subscription", "Coupon", "Shipment",
  "Address", "Catalog", "Review", "Warehouse", "Ledger", "Reservation", "Category",
] as const;
const TS_DIRS = ["domain", "services", "api", "lib"] as const;

function makeTypeScript(rng: Rng): string {
  const [verb, describe] = pick(rng, TS_VERBS);
  const noun = pick(rng, TS_NOUNS);
  const ret = pick(rng, [`Promise<${noun}>`, `Promise<${noun}[]>`, `Promise<${noun} | null>`]);
  const dir = pick(rng, TS_DIRS);
  return `export async function ${verb}${noun}(id: string, opts: ${noun}Options = {}): ${ret}\n// ${describe(noun.toLowerCase())}. Defined in src/${dir}/${noun.toLowerCase()}.ts.`;
}

const PG_TABLES = [
  "orders", "line_items", "customers", "inventory", "shipments", "coupons", "reviews",
  "addresses", "ledger_entries", "subscriptions", "warehouses", "carts",
] as const;
const PG_COLUMNS = [
  "sku text NOT NULL",
  "quantity integer NOT NULL CHECK (quantity >= 0)",
  "status text NOT NULL DEFAULT 'pending'",
  "metadata jsonb NOT NULL DEFAULT '{}'",
  "note text",
  "weight_grams integer",
  "region text NOT NULL",
  "email citext",
  "position integer NOT NULL DEFAULT 0",
  "published_at timestamptz",
  "external_ref text UNIQUE",
  "parent_id uuid",
] as const;
const PG_OPS = ["bulk import", "checkout", "nightly rollup", "admin edit", "webhook ingest", "report export"] as const;
const PG_ERRORS: ReadonlyArray<{ code: string; causes: readonly string[]; fixes: readonly string[] }> = [
  { code: "23505 (unique_violation)", causes: ["two writers inserted the same natural key", "a seed script ran twice"], fixes: ["use INSERT ... ON CONFLICT DO NOTHING", "add the key to the upsert target"] },
  { code: "23503 (foreign_key_violation)", causes: ["the parent row was removed before its children", "an import loaded children first"], fixes: ["load parents first", "defer the constraint until commit"] },
  { code: "23502 (not_null_violation)", causes: ["the client omitted a required field", "a migration added a NOT NULL column without a default"], fixes: ["validate the payload in the handler", "give the column a default"] },
  { code: "22P02 (invalid_text_representation)", causes: ["a non-uuid string was bound to a uuid column", "a numeric field arrived as text with a unit suffix"], fixes: ["parse and validate ids at the edge", "strip units before binding"] },
  { code: "57014 (query_canceled)", causes: ["the statement ran past the role timeout", "the client disconnected mid-query"], fixes: ["add the missing index", "narrow the date range"] },
  { code: "55P03 (lock_not_available)", causes: ["NOWAIT hit a row locked by another session", "a long admin session holds the table"], fixes: ["shorten the holding transaction", "schedule the change off-peak"] },
  { code: "42P01 (undefined_table)", causes: ["the search_path differs on the replica", "the migration has not run in this environment"], fixes: ["schema-qualify the table name", "run pending migrations first"] },
  { code: "42703 (undefined_column)", causes: ["a renamed column is still referenced by a view", "the ORM model is ahead of the database"], fixes: ["recreate the view", "apply the pending migration"] },
  { code: "40001 (serialization_failure)", causes: ["two serializable transactions touched the same predicate", "a long read-write transaction overlapped a batch update"], fixes: ["keep transactions short", "use a weaker isolation level where it is safe"] },
  { code: "PGRST100", causes: ["an unparseable filter in the query string", "a stray operator in the order parameter"], fixes: ["URL-encode the filter value", "check the operator spelling"] },
  { code: "PGRST102", causes: ["the request body was empty JSON", "the body had mismatched keys in a bulk insert"], fixes: ["send a non-empty object", "normalise keys across rows"] },
  { code: "PGRST116", causes: ["a .single() call matched zero or many rows", "the filter was missing a unique column"], fixes: ["use .maybeSingle()", "add the unique column to the filter"] },
  { code: "PGRST200", causes: ["no foreign key links the two tables in the schema cache", "the relationship name was misspelled"], fixes: ["add the foreign key and reload the schema cache", "use the hinted relationship name"] },
  { code: "PGRST204", causes: ["a column was missing from the schema cache after a migration", "the payload carried an unknown field"], fixes: ["reload the schema cache with NOTIFY pgrst", "drop the unknown field"] },
];

function makePostgres(rng: Rng, index: number): string {
  const table = pick(rng, PG_TABLES);
  if (index % 2 === 0) {
    const columns = shuffle(rng, PG_COLUMNS).slice(0, int(rng, 3, 5));
    const indexed = columns[0].split(" ")[0];
    return `CREATE TABLE ${table} (\n  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),\n  ${columns.join(",\n  ")},\n  created_at timestamptz NOT NULL DEFAULT now()\n);\nCREATE INDEX ${table}_${indexed}_idx ON ${table} (${indexed});`;
  }
  const error = pick(rng, PG_ERRORS);
  return `Error ${error.code} on ${table} during ${pick(rng, PG_OPS)}: ${pick(rng, error.causes)}. Fix: ${pick(rng, error.fixes)}.`;
}

const TRACE_FRAMES = ["handleCheckout", "loadCart", "applyCoupon", "buildInvoice", "syncInventory", "renderReceipt", "authorize", "resolveAddress", "mapShipment", "flushLedger"] as const;
const TRACE_FILES = ["src/api/checkout.ts", "src/domain/cart.ts", "src/services/coupons.ts", "src/lib/invoice.ts", "src/services/inventory.ts", "src/api/receipt.ts"] as const;
const TRACE_ERRORS: ReadonlyArray<{ head: (n: number, name: string) => string; cause: string; fix: string }> = [
  { head: (_n, name) => `TypeError: Cannot read properties of undefined (reading '${name}')`, cause: "a nullable relation was dereferenced before it loaded", fix: "guard the access or load the relation first" },
  { head: (n) => `Error: connect ECONNREFUSED 127.0.0.1:${n}`, cause: "the dependency was not listening yet", fix: "wait for the health check before starting the caller" },
  { head: (n) => `Error: connect ETIMEDOUT 10.0.${n % 250}.${(n * 7) % 250}:5432`, cause: "the network path to the database is blocked", fix: "check the security group and the connect timeout" },
  { head: () => "Error: write EPIPE", cause: "the peer closed the socket while a response was being written", fix: "stop writing once the request is aborted" },
  { head: (_n, name) => `Error: ENOENT: no such file or directory, open './data/${name}.json'`, cause: "the fixture is generated at build time and was not produced", fix: "run the generate step before the tests" },
  { head: (n) => `Error: listen EADDRINUSE: address already in use :::${n}`, cause: "a previous dev server is still running", fix: "stop the old process or pick another port" },
  { head: () => "SyntaxError: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON", cause: "an HTML error page was parsed as JSON", fix: "check the response status before calling json()" },
  { head: (_n, name) => `ZodError: Expected string, received number at path ["${name}"]`, cause: "the client sent a numeric id", fix: "coerce at the boundary or fix the caller" },
  { head: () => "RangeError: Maximum call stack size exceeded", cause: "two helpers call each other without a base case", fix: "add the missing termination condition" },
  { head: () => "TypeError [ERR_INVALID_ARG_TYPE]: The \"path\" argument must be of type string. Received undefined", cause: "an environment variable was unset", fix: "validate configuration at boot" },
];
const TRACE_PROPS = ["id", "items", "total", "address", "owner", "price", "status"] as const;

function makeTrace(rng: Rng): string {
  const error = pick(rng, TRACE_ERRORS);
  const frames = [0, 1, 2].map(() => `    at ${pick(rng, TRACE_FRAMES)} (${pick(rng, TRACE_FILES)}:${int(rng, 10, 400)}:${int(rng, 3, 40)})`);
  return `${error.head(int(rng, 3000, 9999), pick(rng, TRACE_PROPS))}\n${frames.join("\n")}\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)\nCause: ${error.cause}. Fix: ${error.fix}.`;
}

const CLI_FLAGS: ReadonlyArray<readonly [string, string, string]> = [
  ["git", "--no-verify", "skips the pre-commit and commit-msg hooks"],
  ["git", "--force-with-lease", "refuses to overwrite remote commits you have not fetched"],
  ["git", "--autostash", "stashes local edits around a rebase or pull"],
  ["git", "--ff-only", "aborts the pull instead of creating a merge commit"],
  ["docker", "--rm", "removes the container when it exits"],
  ["docker", "--platform linux/amd64", "forces the amd64 image on Apple silicon"],
  ["docker", "--no-cache", "ignores the layer cache for a clean build"],
  ["docker", "--build-arg", "passes a build-time variable"],
  ["npm", "--workspace", "runs the script in one workspace package"],
  ["npm", "--legacy-peer-deps", "skips peer dependency resolution"],
  ["npm", "--omit=dev", "installs production dependencies only"],
  ["npm", "--ignore-scripts", "skips lifecycle scripts during install"],
  ["kubectl", "--namespace", "scopes the command to one namespace"],
  ["kubectl", "--dry-run=client", "prints the object without sending it"],
  ["kubectl", "--context", "selects the cluster from kubeconfig"],
  ["psql", "--single-transaction", "wraps a script file in BEGIN and COMMIT"],
  ["psql", "--no-psqlrc", "ignores the personal startup file"],
  ["tsc", "--noEmit", "type checks without writing output"],
  ["tsc", "--incremental", "reuses the previous build info file"],
  ["tsc", "--skipLibCheck", "skips type checking of declaration files"],
  ["eslint", "--fix", "applies safe autofixes in place"],
  ["eslint", "--max-warnings 0", "fails the run on any warning"],
  ["eslint", "--cache", "stores results to skip unchanged files"],
  ["node", "--watch", "restarts the process when imported files change"],
  ["node", "--test", "runs the built-in test runner"],
  ["vitest", "--coverage", "collects coverage with the configured provider"],
  ["vitest", "--run", "runs once and exits instead of watching"],
  ["vitest", "--reporter=junit", "writes a JUnit XML report for CI"],
];
const CLI_WHEN = ["in CI", "before pushing", "in the pre-commit hook", "when debugging locally", "in the release workflow", "for one-off scripts", "inside the dev container", "on the build agent"] as const;

function makeCli(rng: Rng): string {
  const [tool, flag, meaning] = pick(rng, CLI_FLAGS);
  return `\`${tool} ${flag}\` ${meaning}. Typical use: ${pick(rng, CLI_WHEN)}.`;
}

const ARCH_SERVICES = ["catalog", "search", "inventory", "reporting", "admin console", "mobile BFF", "fulfilment", "recommendations", "media", "onboarding"] as const;
const ARCH_WHAT = [
  "renders PDF documents in a pool of headless browsers",
  "keeps product images in object storage behind a CDN",
  "indexes documents overnight into the search cluster",
  "runs in a single region with a warm standby",
  "feeds the analytics warehouse through logical replication",
  "ships as a container image built by CI",
  "exposes a GraphQL schema generated from Zod types",
  "validates its configuration at boot and refuses to start on missing values",
  "shares a monorepo package with the web client",
  "pins its runtime to the current Node LTS",
  "stores uploaded files under a content hash",
  "serves static assets from the edge network",
] as const;
const ARCH_WHY = [
  "it keeps the on-call surface small",
  "the team already knows the tooling",
  "it avoids a second datastore",
  "the latency budget is tight",
  "it simplifies local development",
  "compliance asked for a single audit point",
  "the alternative needed a new vendor contract",
  "it matches how the web client is built",
  "it keeps costs predictable",
  "an earlier spike showed it was enough",
  "it lets contractors work without production access",
  "the data volume does not justify more",
] as const;

function makeArchitecture(rng: Rng): string {
  return `The ${pick(rng, ARCH_SERVICES)} service ${pick(rng, ARCH_WHAT)}. Rationale: ${pick(rng, ARCH_WHY)}.`;
}

function makeFillers(rng: Rng): Seed[] {
  const out: Seed[] = [];
  const add = (prefix: string, type: MemoryType, tags: string[], notes: string[]): void => {
    notes.forEach((note, i) => {
      out.push({ key: `f-${prefix}-${String(i + 1).padStart(3, "0")}`, note, type, tags });
    });
  };
  add("ts", "general", ["typescript", "api"], unique(FILLERS_PER_CATEGORY, () => makeTypeScript(rng)));
  let pgIndex = 0;
  add("pg", "issue", ["postgres", "schema"], unique(FILLERS_PER_CATEGORY, () => makePostgres(rng, pgIndex++)));
  add("trace", "bug_fix", ["stack-trace", "node"], unique(FILLERS_PER_CATEGORY, () => makeTrace(rng)));
  add("cli", "convention", ["cli", "tooling"], unique(FILLERS_PER_CATEGORY, () => makeCli(rng)));
  add("arch", "decision", ["architecture"], unique(FILLERS_PER_CATEGORY, () => makeArchitecture(rng)));
  return out;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function buildScale1k(seed: number = SCALE_1K_SEED): BenchDataset {
  const rng = mulberry32(seed);

  const seeds: Seed[] = [];
  const queries: BenchQuery[] = [];
  for (const c of CASES) {
    seeds.push({ key: `n-${c.id}`, ...c.target });
    if (c.decoy) {
      seeds.push({ key: `d-${c.id}`, ...c.decoy });
    }
    queries.push({
      id: c.id,
      query: c.query,
      relevant: [`n-${c.id}`],
      category: c.category,
      rationale: c.rationale,
    });
  }
  seeds.push(...makeFillers(rng));

  const memories: BenchMemory[] = shuffle(rng, seeds).map((s) => ({
    key: s.key,
    note: s.note,
    type: s.type,
    tags: s.tags,
  }));

  return {
    name: "fossel-scale-1k-v1",
    description:
      "Synthetic 1,000-document developer-memory corpus (acme/platform) with 30 labelled queries: 15 exact-symbol and 15 paraphrase. 30 hand-written targets, 15 hand-written decoys (sibling identifiers, symbol queries only) and 955 template-generated fillers. Seeded and deterministic. Synthetic by design: the symbol/paraphrase split probes two retrieval behaviours and is not a prediction of accuracy on a real repo.",
    repo: "acme/platform",
    memories,
    queries,
  };
}

export const scale1k: BenchDataset = buildScale1k();
