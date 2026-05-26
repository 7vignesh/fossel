# Fossel

**Local-first MCP memory for every repo you work on.** Store conventions, bug fixes, reviewer patterns, and decisions in **SQLite on your machine** (with FTS5 search). Works with **Cursor**, **Claude Desktop**, and any **stdio MCP** client. **No accounts, no cloud.**

---

## Quick start (~2 minutes)

1. **Onboard** (prints copy-paste MCP config + creates a sample memory):

   ```bash
   npx -y fossel init
   ```

2. **Add the JSON** from the output to **Cursor** (`~/.cursor/mcp.json`) or **Claude Desktop** MCP settings, then restart the app.

3. **Run the server** (what the IDE launches; you can also run it manually for testing):

   ```bash
   npx -y fossel
   ```

4. In chat, just say *"remember this"* and Fossel handles the rest. See [Simple mode](#simple-mode-recommended) below.

**Database path:** `~/.fossel/memory.db` (override with `FOSSEL_DB_PATH`).

---

## Why Fossel?

| You get | Details |
|--------|---------|
| **Local data** | SQLite + migrations; nothing leaves your disk unless you share it. |
| **Repo-scoped memory** | One canonical key per repo; aliases collapse automatically. |
| **Find anything** | FTS5 search across notes; pin what matters; summarize for PRs. |
| **Ambient capture** | Natural-language `remember`; dedupes near-duplicates on save. |
| **Evolving schema** | Startup migrations keep upgrades safe for existing databases. |

---

## Simple mode (recommended)

Two tools cover the 80% case. Neither needs you to specify `type` or `tags`.

### `remember` — save a memory

Just send a sentence. Fossel infers the memory type, generates tags, resolves the repo, and merges near-duplicates into the existing row.

> **You:** Remember: JWT lives in localStorage and 401 redirects to /login.
>
> **Agent calls** `remember({ note: "JWT lives in localStorage and 401 redirects to /login." })`
>
> **Fossel:** Stored as `convention` with tags `jwt, auth, login` for `7vignesh/fossel`.

### `get_context` — pull repo context

Pinned first, then recent, then FTS matches if you pass a `query`. Default limit of 8 is tuned for LLM context injection.

> **You:** What does Fossel remember about auth here?
>
> **Agent calls** `get_context({ query: "auth" })`
>
> **Fossel:** returns a markdown block ready to drop into the system prompt.

That's it for daily use. The repo is detected from your `cwd` automatically.

### Zero-prompt usage in Cursor

Fossel exposes a static MCP resource at `fossel://context/current-repo`. Cursor and Claude Desktop list resources on session start, so Fossel's pinned + recent memories show up before you type anything. Clients that don't list resources can still call `get_context` from the agent's first turn — that's all the prompting needed.

---

## Advanced mode

Every original tool is still available for power users.

| Tool | Purpose |
|------|---------|
| `remember` | Natural-language save with auto-type/tags/dedupe (preferred). |
| `get_context` | Unified pinned + recent + FTS retrieval. |
| `resolve_repo` | Show canonical key, aliases, detected git remote. |
| `dedupe_repo` | Find or merge near-duplicate memories. |
| `store_context` | Explicit save with `type` and `tags`. |
| `get_repo_context` | Recent memories grouped by type (pinned first). |
| `search_memory` | FTS search, optional repo filter. |
| `summarize_repo_context` | Markdown brief for a repo. |
| `pin_memory` / `unpin_memory` | Pin important items. |
| `update_memory` | Partial update by numeric id. |
| `delete_memory` | Delete by legacy string id. |

### Memory types

`convention`, `bug_fix`, `reviewer_pattern`, `decision`, `issue`, `general`.

### Tool examples

`store_context` (explicit form):

```json
{
  "repo": "7vignesh/fossel",
  "type": "convention",
  "note": "Use pnpm workspaces for all package scripts.",
  "tags": ["pnpm", "workspaces"]
}
```

`pin_memory`:

```json
{ "id": 12 }
```

`summarize_repo_context`:

```json
{ "repo": "RocketChat/Rocket.Chat" }
```

```md
Fossel Context Summary: RocketChat/Rocket.Chat

📌 Pinned
- (12) Always run test matrix before merge.

Conventions
- (3) Use feature flags for UI experiments.

Bug Fixes
- (5) Fixed webhook retries by making queue idempotent.
```

`dedupe_repo` (dry run, then apply):

```json
{ "repo": "7vignesh/fossel", "apply": false }
{ "repo": "7vignesh/fossel", "apply": true, "threshold": 0.85 }
```

---

## Repo identity

Fossel resolves the canonical key for your workspace in this order:

1. `git remote get-url origin` → normalized to `owner/repo`
2. folder basename
3. anything you pass explicitly is recorded as an alias of the above

Memories saved under any alias are reachable from the canonical key, and `npx fossel init` automatically merges legacy alias rows (e.g. `studentmanager` → `7vignesh/student-manager`).

---

## Commands

```bash
npx -y fossel          # MCP server over stdio
npx -y fossel init     # onboarding + canonical key + safe alias merge
npx -y fossel doctor   # diagnose repo sprawl, duplicates, MCP config
```

### `fossel init`

Detects the canonical repo key, prints **Cursor** and **Claude Desktop** MCP snippets, merges legacy alias rows into the canonical key, and inserts a starter memory only when the database is empty.

### `fossel doctor`

Reports on:

- canonical repo key for the workspace
- sibling keys that look like the same repo (offers a fix)
- exact-duplicate memory clusters (suggest `dedupe_repo`)
- detected MCP config files

Exits non-zero when issues are found so it can run in CI.

---

## Cursor MCP config

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "fossel": {
      "command": "npx",
      "args": ["-y", "fossel"]
    }
  }
}
```

## Claude Desktop MCP config

```json
{
  "mcpServers": {
    "fossel": {
      "command": "npx",
      "args": ["-y", "fossel"]
    }
  }
}
```

---

## Development (from source)

```bash
npm install
npm run dev          # MCP server over stdio
npm run typecheck
npm test             # unit tests (node:test via tsx)
npm run smoke        # end-to-end MCP roundtrip
npm run build
npm run start        # node dist/index.js
npm run ci           # typecheck + tests + build + smoke
```

## Notes

- **Local-first:** data stays on your machine.
- **Search:** FTS5 (no `sqlite-vec` in v1).
- **`FOSSEL_DB_PATH`:** optional override for DB location (e.g. tests).
- **Schema:** migrations live in `src/db/migrate.ts`; reference shape in `src/db/schema.sql`.

## Community

If Fossel saves you time, **[star the repo](https://github.com/7vignesh/fossel)** and **[open an issue](https://github.com/7vignesh/fossel/issues)** for bugs or ideas — that helps others discover it too.
