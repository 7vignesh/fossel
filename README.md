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

4. In chat, say:

   ```
   remember: [anything about this repo]
   ```

   Then ask:

   ```
   what does Fossel remember about [topic]?
   ```

5. **Verify it works** — paste this in your AI chat:

   ```
   remember: Fossel is working in this repo
   ```

   Then immediately ask:

   ```
   what does Fossel remember?
   ```

   You should see your memory returned.

**Database path:** `~/.fossel/memory.db` (override with `FOSSEL_DB_PATH`).

---

## Why Fossel?

| You get | Details |
|--------|---------|
| **Local data** | SQLite + migrations; nothing leaves your disk unless you share it. |
| **Repo-scoped memory** | One canonical key per repo; aliases collapse automatically. |
| **Find anything** | FTS5 search across notes; pin what matters; summarize for PRs. |
| **Ambient capture** | Natural-language `remember`; dedupes near-duplicates on save. |
| **Conflict review** | Flags related memories on save so the agent can reconcile contradictions. |
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

### Conflict review on save

When you save a note that *relates to but does not duplicate* an existing
memory, `remember` appends a short notice listing the related memories — and
flags ones that look like they may be contradicted or superseded (e.g. you say
you *no longer* use something). The new memory is always stored; the notice is
advisory so your AI assistant can decide whether to revise the old memory
(`update_memory`) or remove it (`delete_memory`).

> **You:** Remember: JWT no longer lives in localStorage; we moved it to httpOnly cookies.
>
> **Fossel:** Stored memory 3 …
> Related existing memories you may want to reconcile:
> - #2 (similarity 0.50) ⚠ may contradict/supersede: JWT lives in localStorage and 401 redirects to /login.

This keeps memory from silently accumulating contradictions over time. Fossel
stays dependency-free: it surfaces the candidates and lets the MCP client's own
model make the judgment, rather than embedding an LLM in the server.

### Zero-prompt usage in Cursor

Fossel exposes a static MCP resource at `fossel://context/current-repo`. Cursor and Claude Desktop list resources on session start, so Fossel's pinned + recent memories show up before you type anything. Clients that don't list resources can still call `get_context` from the agent's first turn — that's all the prompting needed.

---

## Advanced mode

Every original tool is still available for power users.

| Tool | Purpose |
|------|---------|
| `remember` | Save a memory in natural language — auto-infers type, tags, and repo |
| `get_context` | Retrieve relevant memories, pinned first then recent |
| `search_memory` | FTS search across notes, optional repo filter |
| `pin_memory` / `unpin_memory` | Pin important memories to always appear first |
| `delete_memory` | Delete by id |
| `update_memory` | Edit an existing memory by id |
| `dedupe_repo` | Merge near-duplicate memories |
| `summarize_repo_context` | Markdown summary — useful for PR descriptions |

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
- exact-duplicate memory clusters (suggests `fossel doctor --fix` or `dedupe_repo`)
- memory notes that still mention deprecated repo keys
- detected MCP config files

Pass `--fix` to apply safe automated cleanup in one go: merge sibling repo keys, rewrite stale alias mentions, and remove exact-text duplicates. Without `--fix` it's read-only and exits non-zero on issues so it can run in CI.

---

## Cursor MCP config

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "fossel": {
      "command": "npx",
      "args": ["-y", "fossel"],
      "env": {
        "FOSSEL_WORKSPACE": "${workspaceFolder}"
      }
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
      "args": ["-y", "fossel"],
      "env": {
        "FOSSEL_WORKSPACE": "/path/to/your/project"
      }
    }
  }
}
```

`FOSSEL_WORKSPACE` pins Fossel to your project root. Without it, the server falls back to `process.cwd()`, which is occasionally wrong — Cursor and Claude Desktop sometimes spawn MCP servers from your home directory, which would silently route memories to the wrong repo. Cursor expands `${workspaceFolder}` automatically; Claude Desktop needs an absolute path.

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
- **Search:** FTS5 keyword search by default. Optional **hybrid semantic search**
  via `FOSSEL_EMBEDDINGS=1` (see below).
- **`FOSSEL_DB_PATH`:** optional override for DB location (e.g. tests).
- **Schema:** migrations live in `src/db/migrate.ts`; reference shape in `src/db/schema.sql`.

## Hybrid semantic search (optional)

By default Fossel retrieves memories with FTS5 keyword search. Keyword search
misses paraphrases — a query like "how does authentication work?" won't match a
note that says "JWT lives in localStorage" because they share no words.

Set `FOSSEL_EMBEDDINGS=1` to enable **hybrid retrieval**: a local, dependency-free
embedding is computed for every memory and fused with the keyword results
(Reciprocal Rank Fusion). This adds semantic recall while keeping FTS5's exact-
match precision for identifiers, file paths, and ticket numbers.

```json
{
  "mcpServers": {
    "fossel": {
      "command": "npx",
      "args": ["-y", "fossel"],
      "env": {
        "FOSSEL_WORKSPACE": "${workspaceFolder}",
        "FOSSEL_EMBEDDINGS": "1"
      }
    }
  }
}
```

Properties:

- **Zero install weight / fully offline.** The embedding is a deterministic
  feature-hashing of token unigrams and bigrams — no model download, no native
  dependency, no network. It runs instantly and keeps the local-first promise.
- **Opt-in.** With the flag unset, Fossel behaves exactly as before: no vectors
  are written and retrieval is FTS-only.
- **Self-healing index.** Memories created before enabling the flag are embedded
  on demand the first time the repo is searched.
- **Pluggable.** `embedText` in `src/lib/embeddings.ts` is the single entry
  point, so a stronger embedder (transformers.js, ONNX, or a remote model) can
  be swapped in later without touching callers. Bump `EMBEDDING_VERSION` to
  trigger automatic re-indexing of stale vectors.

Vectors are stored in a `memory_embeddings` side table keyed by memory rowid and
cleaned up via trigger when a memory is deleted.

## Community

If Fossel saves you time, **[star the repo](https://github.com/7vignesh/fossel)** and **[open an issue](https://github.com/7vignesh/fossel/issues)** for bugs or ideas — that helps others discover it too.
