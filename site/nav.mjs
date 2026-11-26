/**
 * Docs navigation: the single source for the sidebar, Previous/Next order and
 * the list of pages the build expects.
 *
 * Groups render in this order. A group with no pages is hidden, so the five
 * groups can be declared up front and fill in as pages land. Every page needs a
 * fragment at `site/pages/<slug>.html`; the build fails on a missing fragment
 * and on a fragment that is not listed here.
 *
 * The `index` slug is served at `/docs/`, every other slug at `/docs/<slug>/`.
 */

export const GROUPS = [
  {
    title: "Getting Started",
    pages: [
      {
        slug: "index",
        title: "Introduction & Quickstart",
        description:
          "What Fossel solves, why it runs fully local on SQLite, and how to start it with npx or a global install.",
      },
    ],
  },
  {
    title: "MCP Client Setup",
    pages: [
      {
        slug: "claude-code",
        title: "Claude Code",
        description: "Add Fossel to Claude Code with claude mcp add, and check that it connected.",
      },
      {
        slug: "cursor",
        title: "Cursor",
        description: "Add Fossel to Cursor's mcp.json, globally or per project.",
      },
      {
        slug: "gemini-cli",
        title: "Gemini CLI",
        description: "Add Fossel to Gemini CLI's settings.json and check it with /mcp.",
      },
      {
        slug: "opencode-windsurf",
        title: "OpenCode & Windsurf",
        description: "Add Fossel to OpenCode (tested) and Windsurf Cascade.",
      },
    ],
  },
  {
    title: "Core Concepts",
    pages: [
      {
        slug: "how-fossel-works",
        title: "How Fossel Works",
        description:
          "Where memories live, how a repo is identified, what happens on a write, and how retrieval combines FTS5, hashed vectors and entity matches.",
      },
      {
        slug: "memory-lifecycle",
        title: "Memory Lifecycle",
        description:
          "How memories are created, merged, flagged as conflicting, superseded, marked stale after code changes, exported and deleted.",
      },
    ],
  },
  {
    title: "Reference",
    pages: [
      {
        slug: "mcp-tools",
        title: "MCP Tools",
        description:
          "Every tool Fossel registers: parameters, constraints, and recorded request and response examples.",
      },
      {
        slug: "cli",
        title: "CLI & Configuration",
        description: "The fossel commands, flags, exit codes and environment variables, with recorded output.",
      },
    ],
  },
  {
    title: "Architecture & Benchmarks",
    pages: [
      {
        slug: "architecture-benchmarks",
        title: "Architecture & Benchmarks",
        description:
          "Why Fossel searches with local SQLite FTS5, and what a measured comparison against sqlite-vec with a MiniLM model does and does not show.",
      },
    ],
  },
];
