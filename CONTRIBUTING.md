# Contributing to Fossel

Thanks for helping improve Fossel. This guide covers how to report issues, set
up your environment, and open a pull request that lands cleanly.

Fossel is a **local-first MCP memory server** for coding assistants. The guiding
constraint behind almost every decision: **no LLM, no model download, no network
at runtime.** Where a general memory tool would call an LLM, Fossel uses a
heuristic or hands the judgment back to the client's own model. Please keep this
constraint in mind for any contribution.

## Table of contents

- [Reporting issues](#reporting-issues)
- [Development setup](#development-setup)
- [Making changes](#making-changes)
- [Working with retrieval / search](#working-with-retrieval--search)
- [Opening a pull request](#opening-a-pull-request)
- [Project layout](#project-layout)
- [Releases](#releases-maintainers)

## Reporting issues

Before opening an issue, please [search existing issues](https://github.com/7vignesh/fossel/issues)
to avoid duplicates.

- **Found a bug?** Open a [bug report](https://github.com/7vignesh/fossel/issues/new?template=bug_report.yml).
  Include the exact tool call or CLI command, what you expected, what happened,
  and your Fossel / Node / OS versions. A minimal reproduction is worth more than
  a long description.
- **Have an idea?** Open a [feature request](https://github.com/7vignesh/fossel/issues/new?template=feature_request.yml).
  Describe the problem you are solving, not just the solution, and explain how it
  fits Fossel's local-first, no-network constraint.
- **Security concern?** Do not open a public issue for anything exploitable.
  Email the maintainer or use GitHub's private vulnerability reporting instead.

Issues labeled [`good first issue`](https://github.com/7vignesh/fossel/labels/good%20first%20issue)
are a good place to start.

## Development setup

Fossel targets **Node 20+** (CI runs on Node 20; the Docker image pins Node 22).

```bash
git clone https://github.com/7vignesh/fossel.git
cd fossel
npm install
npm run ci        # the full gate: typecheck + typecheck:bench + test + build + smoke
```

Useful scripts:

| Command | What it does |
|---------|--------------|
| `npm run dev` | Run the MCP server over stdio from source |
| `npm run typecheck` | TypeScript type check (`tsc --noEmit`) |
| `npm test` | Unit tests (`node:test` via `tsx`) |
| `npm run smoke` | End-to-end MCP roundtrip against a temp DB |
| `npm run build` | Production build (`tsup`) |
| `npm run bench` | Score fts/vector/hybrid retrieval on the committed eval set |
| `npm run bench:check` | Fail on retrieval-quality drift |
| `npm run ci` | Everything above that CI runs |

The database lives at `~/.fossel/memory.db`. Override it with `FOSSEL_DB_PATH`
for local experiments so you never touch your real memories.

## Making changes

A few principles the codebase follows. Matching them makes review faster:

- **Keep tools thin.** MCP tool files in `src/tools/` should resolve the repo,
  call a `src/lib/` function, and return `{ content: [{ type: "text" }] }`,
  catching errors into `isError: true` rather than throwing. Put logic in `lib`.
- **Surgical changes.** Every changed line should trace to the issue or feature
  you are addressing. Avoid drive-by refactors, reformatting, or unrelated
  cleanups in the same PR.
- **Write tests.** New features and bug fixes need tests. For bug fixes, add a
  test that reproduces the bug first, then make it pass. Tests use `node:test`
  and live in `tests/`.
- **Migrations are append-only.** Schema changes go in `src/db/migrate.ts` as a
  new sequentially named migration. Never edit an already-shipped migration;
  existing databases have already run it. Keep `src/db/schema.sql` (the
  hand-maintained reference of the final shape) in sync.
- **Stay dependency-light.** Do not add heavy dependencies. Anything that would
  require a network call, model download, or LLM at runtime is out of scope by
  design.

## Working with retrieval / search

Anything that touches search (`src/lib/fts.ts`, `fusion.ts`, `embeddings.ts`,
`idf.ts`, `vector-index.ts`, `context.ts`) **must be measured**:

1. Run `npm run bench` before and after your change.
2. Keep the change only if the numbers support it. Commit the updated results
   snapshot.
3. `npm run bench:check` must not report drift.

Several ideas have been implemented, measured, and removed because the numbers
did not hold up (see the "tried and rejected" notes in `fusion.ts` and
`fts.ts`). Please do not re-try those without new evidence.

Note: stored embedding vectors must stay a pure function of their own text.
Corpus-derived weighting (IDF) is applied to the **query** side only, otherwise
every vector goes stale on any corpus change.

## Opening a pull request

1. **Fork** the repo and create a branch from `main`:
   ```bash
   git checkout -b fix/import-rollback
   ```
   Use a short, descriptive branch name (`fix/...`, `feat/...`, `docs/...`).
2. **Make your change** with tests. Keep the PR focused on one concern.
3. **Run the full gate locally** and make sure it is green:
   ```bash
   npm run ci
   ```
4. **Commit** with a clear message. We loosely follow
   [Conventional Commits](https://www.conventionalcommits.org/): `fix:`, `feat:`,
   `docs:`, `chore:`, `refactor:`, `test:`. One logical change per commit where
   practical.
5. **Push** and open a PR against `main`. In the description, include:
   - **What** changed and **why**.
   - The issue it closes (`Closes #123`), if any.
   - **How you tested it** (which commands you ran, new tests added).
   - For retrieval changes, the before/after `npm run bench` numbers.
6. **CI must pass.** Every push and PR runs `npm run ci` on GitHub Actions. PRs
   with a red build will not be merged.

Keep the PR reviewable: small and focused merges faster than large and sprawling.
If a change grows, consider splitting it.

## Project layout

- `src/db/` — `client.ts` (singleton WAL connection), `migrate.ts` (sequential
  named migrations, the runtime source of truth), `schema.sql` (reference shape).
- `src/lib/` — domain logic: repo resolution, context assembly, FTS, fusion,
  embeddings, dedupe, inference, temporal grounding, git-aware file refs,
  portability.
- `src/tools/` — thin MCP tool registrations (keep logic in `lib`).
- `bench/` — the retrieval benchmark and its committed eval set.
- `tests/` — `node:test` unit tests.

## Releases (maintainers)

Releases use git tags `v*`; CI publishes to npm (see
`.github/workflows/publish.yml`). Bump the `package.json` version before tagging.

---

By contributing, you agree that your contributions are licensed under the
project's [LICENSE](./LICENSE).
