import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb, type MemoryRecord } from "../db/client.js";
import { normalizeText, similarity } from "../lib/dedupe.js";
import { resolveRepoArg } from "../lib/repo.js";

const dedupeRepoInputSchema = {
  repo: z.string().trim().min(1).optional(),
  threshold: z.number().min(0.5).max(1).default(0.85),
  apply: z.boolean().default(false),
};

interface MetadataChangelogEntry {
  at: number;
  action: "merged" | "created" | "deduped";
  similarity?: number;
  previous_note?: string;
  merged_from?: number;
}

interface StoredMetadata {
  changelog?: MetadataChangelogEntry[];
  [key: string]: unknown;
}

interface MemoryRowWithMetadata extends MemoryRecord {
  metadata_json: string;
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function parseMetadata(raw: string): StoredMetadata {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StoredMetadata;
    }
  } catch {
    /* fall through */
  }
  return {};
}

function mergeTagLists(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const value of list) {
      const trimmed = value.trim().toLowerCase();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

interface DedupePlanEntry {
  keep: number;
  drop: number;
  similarity: number;
}

export function registerDedupeRepoTool(server: McpServer): void {
  server.registerTool(
    "dedupe_repo",
    {
      description:
        "Scan a repository for near-duplicate memories. Returns a plan by default; pass apply=true to merge duplicates into the most recently updated row, appending a changelog entry to metadata_json.",
      inputSchema: dedupeRepoInputSchema,
    },
    async ({ repo, threshold, apply }) => {
      try {
        const db = getDb();
        const resolved = resolveRepoArg(repo, process.cwd(), db);
        const rows = db
          .prepare(
            `
              SELECT rowid AS row_id, id, repo, type, note, tags, created_at, updated_at, pinned, metadata_json
              FROM memories
              WHERE repo = ?
              ORDER BY updated_at DESC
            `,
          )
          .all(resolved.canonical) as MemoryRowWithMetadata[];

        if (rows.length < 2) {
          return {
            content: [
              {
                type: "text",
                text: `No duplicates possible: only ${rows.length} memory in ${resolved.canonical}.`,
              },
            ],
          };
        }

        // Greedy clustering: walk newest-first, fold older similar rows into
        // the newer "keep" row. Each row only ever participates in one merge.
        const consumed = new Set<number>();
        const plan: DedupePlanEntry[] = [];

        for (let i = 0; i < rows.length; i += 1) {
          const keep = rows[i];
          if (!keep || consumed.has(keep.row_id)) continue;

          for (let j = i + 1; j < rows.length; j += 1) {
            const other = rows[j];
            if (!other || consumed.has(other.row_id)) continue;
            // Only merge same memory_type so we never collapse a "decision"
            // into a "convention".
            if (other.type !== keep.type) continue;

            const score = similarity(keep.note, other.note);
            if (score >= threshold) {
              plan.push({ keep: keep.row_id, drop: other.row_id, similarity: score });
              consumed.add(other.row_id);
            }
          }
        }

        if (plan.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No duplicates ≥ ${threshold} found in ${resolved.canonical} (${rows.length} memories scanned).`,
              },
            ],
          };
        }

        if (!apply) {
          const lines = plan.map(
            (entry) =>
              `- keep ${entry.keep}, drop ${entry.drop} (similarity ${entry.similarity.toFixed(2)})`,
          );
          return {
            content: [
              {
                type: "text",
                text:
                  `Dry run for ${resolved.canonical}. Found ${plan.length} duplicate pair(s):\n` +
                  `${lines.join("\n")}\n\nRe-run with apply=true to merge.`,
              },
            ],
          };
        }

        const byId = new Map(rows.map((row) => [row.row_id, row]));
        const now = Math.floor(Date.now() / 1000);
        let merged = 0;

        const tx = db.transaction((entries: DedupePlanEntry[]) => {
          for (const entry of entries) {
            const keep = byId.get(entry.keep);
            const drop = byId.get(entry.drop);
            if (!keep || !drop) continue;

            const longerNote = keep.note.length >= drop.note.length ? keep.note : drop.note;
            const mergedTags = mergeTagLists(parseTags(keep.tags), parseTags(drop.tags));
            const metadata = parseMetadata(keep.metadata_json);
            const changelog = metadata.changelog ?? [];
            changelog.push({
              at: now,
              action: "deduped",
              similarity: Number(entry.similarity.toFixed(3)),
              merged_from: drop.row_id,
              previous_note: drop.note,
            });
            metadata.changelog = changelog;

            db.prepare(
              `
                UPDATE memories
                SET note = ?, note_normalized = ?, tags = ?, metadata_json = ?, updated_at = ?,
                    pinned = CASE WHEN pinned = 1 OR ? = 1 THEN 1 ELSE pinned END
                WHERE rowid = ?
              `,
            ).run(
              longerNote,
              normalizeText(longerNote),
              JSON.stringify(mergedTags),
              JSON.stringify(metadata),
              now,
              drop.pinned,
              keep.row_id,
            );

            db.prepare("DELETE FROM memories WHERE rowid = ?").run(drop.row_id);
            merged += 1;
          }
        });

        tx(plan);

        return {
          content: [
            {
              type: "text",
              text: `Merged ${merged} duplicate pair(s) in ${resolved.canonical}.`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while deduping repo.";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to dedupe repo: ${message}`,
            },
          ],
        };
      }
    },
  );
}
