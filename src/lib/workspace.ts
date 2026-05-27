/**
 * Resolve the workspace root that Fossel should use for repo detection.
 *
 * MCP servers are launched with a `cwd` that depends on the IDE — Cursor and
 * Claude Desktop sometimes spawn the server from the user's home directory
 * rather than the project root, which silently routes memories under the
 * wrong repo.
 *
 * Resolution order:
 *   1. `FOSSEL_WORKSPACE` environment variable (set this in the MCP config).
 *   2. `process.cwd()` as a fallback.
 *
 * Always call this instead of `process.cwd()` so behaviour stays consistent
 * across tools and the override remains a single place to change.
 */
export function getWorkspaceRoot(): string {
  const fromEnv = process.env.FOSSEL_WORKSPACE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return process.cwd();
}
