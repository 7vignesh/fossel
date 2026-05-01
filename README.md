# Fossel

Fossel is a local MCP (Model Context Protocol) memory server for open-source contributors. It stores project-specific context such as reviewer preferences, bug fixes, conventions, decisions, and issue notes in a local SQLite database with FTS5 search.

## Features

- Persistent local memory in SQLite (`~/.fossel/memory.db`)
- Full-text search with SQLite FTS5
- Repo-aware context retrieval grouped by memory type
- Pinned memories that stay at the top of repo context
- Structured markdown summaries for PR and planning context
- Simple delete workflow by memory id
- Partial memory updates by numeric id
- CLI onboarding with `fossel init`
- Local `stdio` MCP server for tools such as Cursor and Claude Desktop

## Memory Types

- `convention`
- `bug_fix`
- `reviewer_pattern`
- `decision`
- `issue`
- `general`

## Install

```bash
npm install
```

Or run without installation:

```bash
npx -y fossel
```

## Commands

```bash
npx -y fossel          # start MCP server over stdio
npx -y fossel init     # onboarding for current repository
```

## `fossel init`

`fossel init` detects your current repo, prints ready-to-copy MCP config snippets for Cursor and Claude Desktop, inserts a starter memory, and shows DB stats plus command references.

Starter memory inserted:

- Type: `convention`
- Content: `Fossel is active for this repo. Use store_context to save context.`

## MCP Tools

- `store_context`: Save a new memory for a repository.
- `get_repo_context`: Fetch recent memories for a repository, grouped by type. Pinned entries are always listed first and marked `📌 Pinned`.
- `search_memory`: Full-text search memories across all repos or a single repo.
- `delete_memory`: Delete a memory by id.
- `update_memory`: Update memory content and/or type by numeric id.
- `pin_memory`: Pin a memory by numeric id.
- `unpin_memory`: Unpin a memory by numeric id.
- `summarize_repo_context`: Return a structured markdown summary for a repo.

## Tool Examples

### `update_memory`

Input:

```json
{
  "id": 12,
  "content": "Use `pnpm` workspaces for all package scripts.",
  "memory_type": "convention"
}
```

### `pin_memory`

Input:

```json
{
  "id": 12
}
```

### `summarize_repo_context`

Input:

```json
{
  "repo": "RocketChat"
}
```

Output format:

```md
Fossel Context Summary: RocketChat

📌 Pinned
- (12) Always run test matrix before merge.

Conventions
- (3) Use feature flags for UI experiments.

Bug Fixes
- (5) Fixed webhook retries by making queue idempotent.
```

## Cursor MCP Config

Add this to your Cursor MCP configuration:

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

## Claude Desktop MCP Config

Add this to your Claude Desktop MCP config:

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

## Development

```bash
npm run dev
```

This starts the local MCP server over stdio.

## Build

```bash
npm run build
```

## Run Built Server

```bash
npm run start
```

## Notes

- Fossel is local-first: data remains on your machine.
- FTS5 is used for V1 search (no `sqlite-vec`).
- Optional: set `FOSSEL_DB_PATH` to override the default database path for testing.
- DB schema changes are managed via startup migrations in `src/db/migrate.ts`.
