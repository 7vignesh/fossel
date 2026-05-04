# Fossel

**Local-first MCP memory for every repo you work on.** Store conventions, bug fixes, reviewer patterns, and decisions in **SQLite on your machine** (with FTS5 search). Works with **Cursor**, **Claude Desktop**, and any **stdio MCP** client. **No accounts, no cloud.**

---

## Quick start (~2 minutes)

1. **Onboard** (prints copy-paste MCP config + creates a sample memory):

   ```bash
   npx -y fossel init
   ```

2. **Add the JSON** from the output to **Cursor** (`~/.cursor/mcp.json`) or **Claude Desktop** MCP settings, then restart the app.

3. **Run the server** (what the IDE launches, or for testing):

   ```bash
   npx -y fossel
   ```

4. In chat, use tools like `store_context` and `get_repo_context` with your **repo** name (e.g. `org/repo` or your folder name).

**Database path:** `~/.fossel/memory.db` (override with `FOSSEL_DB_PATH`).

---

## Why Fossel?

| You get | Details |
|--------|---------|
| **Local data** | SQLite + migrations; nothing leaves your disk unless you share it. |
| **Repo-scoped memory** | Same patterns across Cursor, Claude, or any MCP client over stdio. |
| **Find anything** | FTS5 search across notes; pin what matters; summarize for PRs. |
| **Evolving schema** | Startup migrations keep upgrades safe for existing databases. |

---

## Features

- Persistent memory in SQLite (`~/.fossel/memory.db`)
- Full-text search (FTS5)
- Repo-aware context, grouped by memory type
- Pinned memories at the top of `get_repo_context`
- `summarize_repo_context` for markdown briefs (PRs, planning)
- `update_memory`, `pin_memory`, `unpin_memory`
- CLI: `fossel init` for onboarding
- `stdio` MCP server for Cursor, Claude Desktop, and compatible tools

## Memory types

- `convention`, `bug_fix`, `reviewer_pattern`, `decision`, `issue`, `general`

## Commands

```bash
npx -y fossel          # MCP server over stdio
npx -y fossel init     # onboarding + config snippets + sample memory
```

## `fossel init`

Detects the current git repo (or folder name), prints **Cursor** and **Claude Desktop** MCP snippets, inserts a starter **convention** memory (`Fossel is active for this repo…`), and shows DB path + memory count.

## MCP tools

| Tool | Purpose |
|------|---------|
| `store_context` | Save memory for a repo |
| `get_repo_context` | Recent memories by type (pinned first) |
| `search_memory` | FTS search, optional repo filter |
| `delete_memory` | Delete by legacy string id |
| `update_memory` | Partial update by numeric id |
| `pin_memory` / `unpin_memory` | Pin important items |
| `summarize_repo_context` | Markdown summary for a repo |

## Tool examples

### `update_memory`

```json
{
  "id": 12,
  "content": "Use `pnpm` workspaces for all package scripts.",
  "memory_type": "convention"
}
```

### `pin_memory`

```json
{ "id": 12 }
```

### `summarize_repo_context`

```json
{ "repo": "RocketChat" }
```

Example output shape:

```md
Fossel Context Summary: RocketChat

📌 Pinned
- (12) Always run test matrix before merge.

Conventions
- (3) Use feature flags for UI experiments.

Bug Fixes
- (5) Fixed webhook retries by making queue idempotent.
```

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

## Development (from source)

```bash
npm install
npm run dev          # MCP server over stdio
npm run build
npm run start        # node dist/index.js
npm run ci           # typecheck + build + smoke
```

## Notes

- **Local-first:** data stays on your machine.
- **Search:** FTS5 (no `sqlite-vec` in v1).
- **`FOSSEL_DB_PATH`:** optional override for DB location (e.g. tests).
- **Schema:** migrations live in `src/db/migrate.ts`.

## Community

If Fossel saves you time, **[star the repo](https://github.com/7vignesh/fossel)** and **[open an issue](https://github.com/7vignesh/fossel/issues)** for bugs or ideas—that helps others discover it too.
