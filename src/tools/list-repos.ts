import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db/client.js";
import { listRepos } from "../lib/repo.js";

export function registerListReposTool(server: McpServer): void {
  server.registerTool(
    "list_repos",
    {
      description:
        "List every repository that has stored memories, with per-repo counts " +
        "(live, superseded, pinned) and the last-updated time. Useful for " +
        "discovering which projects Fossel has memory for.",
      inputSchema: {},
    },
    async () => {
      try {
        const db = getDb();
        const repos = listRepos(db);

        if (repos.length === 0) {
          return {
            content: [{ type: "text", text: "No repositories have stored memories yet." }],
          };
        }

        const lines = repos.map((r) => {
          const parts = [`${r.repo}: ${r.live} live`];
          if (r.superseded > 0) parts.push(`${r.superseded} superseded`);
          if (r.pinned > 0) parts.push(`${r.pinned} pinned`);
          if (r.lastUpdated !== null) {
            parts.push(`updated ${new Date(r.lastUpdated * 1000).toISOString().slice(0, 10)}`);
          }
          return `- ${parts.join(", ")}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `${repos.length} repo(s) with memories:\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while listing repos.";
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to list repos: ${message}` }],
        };
      }
    },
  );
}
