# Fossyl

Fossyl is a local MCP (Model Context Protocol) memory server for open-source contributors. It stores project-specific context such as reviewer preferences, bug fixes, conventions, decisions, and issue notes in a local SQLite database with FTS5 search.

## Features

- Persistent local memory in SQLite (`~/.fossyl/memory.db`)
- Full-text search with SQLite FTS5
- Repo-aware context retrieval grouped by memory type
- Simple delete workflow by memory id
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

## MCP Tools

- `store_context`: Save a new memory for a repository.
- `get_repo_context`: Fetch recent memories for a repository, grouped by type.
- `search_memory`: Full-text search memories across all repos or a single repo.
- `delete_memory`: Delete a memory by id.

## Cursor MCP Config

Add this to your Cursor MCP configuration:

```json
{
  "mcpServers": {
    "fossyl": {
      "command": "npx",
      "args": ["-y", "fossyl"]
    }
  }
}
```

## Notes

- Fossyl is local-first: data remains on your machine.
- FTS5 is used for V1 search (no `sqlite-vec`).
- Optional: set `FOSSYL_DB_PATH` to override the default database path for testing.
