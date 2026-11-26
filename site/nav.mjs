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
        title: "Overview",
        description:
          "Fossel is a local-first MCP memory server that keeps repo conventions, bug fixes and decisions in SQLite on your machine.",
      },
    ],
  },
  { title: "MCP Client Setup", pages: [] },
  { title: "Core Concepts", pages: [] },
  { title: "Reference", pages: [] },
  { title: "Architecture & Benchmarks", pages: [] },
];
