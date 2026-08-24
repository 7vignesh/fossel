# Turing Repo Notes

## Suitability Assessment

Fossel is a strong candidate for AfterQuery Turing tasks:

- **Non-trivial domain logic** - MCP protocol, SQLite schema migrations, FTS5 search, embedding-based hybrid retrieval, deduplication scoring, repo identity resolution
- **Real architecture** - clean separation of tools/lib/db layers; meaningful interaction between modules (conflict detection, temporal grounding, inference heuristics)
- **Test coverage** - 12+ test files covering distinct subsystems; node:test runner with assertions
- **Realistic scope** - ~25 source files, not a toy; small enough to understand in one session, complex enough for multi-step tasks
- **No cloud dependencies** - fully local, deterministic, easy to validate

## Possible Task Areas

1. **Schema migration authoring** - add a new column or table with a forward migration, handle existing data gracefully
2. **Search quality improvement** - modify hybrid retrieval scoring (RRF weights, FTS5 tokenization, embedding similarity threshold)
3. **Deduplication logic** - adjust or extend the near-duplicate detection heuristic (e.g. handle partial overlap, soft merges)
4. **Tool implementation** - add a new MCP tool (e.g. bulk import, tag rename, memory archival) following established patterns
5. **Conflict detection edge cases** - improve or fix the contradiction-detection heuristic when notes are semantically related but not duplicates
6. **CLI subcommand** - extend the CLI (e.g. export/import, stats, prune stale repos) using the existing cli.ts dispatch pattern
7. **Bug reproduction and fix** - introduce a regression test for a reported edge case (e.g. alias resolution with unusual remote URLs, FTS tokenization of paths)
8. **Embedding system extension** - swap in or integrate a stronger embedding backend while preserving fallback behavior and version tagging
