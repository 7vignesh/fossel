import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getDb, MEMORY_TYPES, type MemoryType } from "../db/client.js";
import {
  findDuplicate,
  findRelatedCandidates,
  normalizeText,
  type RelatedCandidate,
} from "../lib/dedupe.js";
import { inferMemoryFromNote } from "../lib/inference.js";
import { resolveRepoArg } from "../lib/repo.js";
import { groundTemporalReferences } from "../lib/temporal.js";
import { indexMemoryEmbedding } from "../lib/vector-index.js";
import { getWorkspaceRoot } from "../lib/workspace.js";

const rememberInputSchema = {
  note: z.string().trim().min(1, "note is required"),
  repo: z.string().trim().min(1).optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  // When true (default), Fossel infers memory_type and tags from the note. Set
  // false when the calling agent has already extracted a clean atomic fact and
  // supplied type/tags itself, so Fossel stores the note verbatim without
  // re-inferring. Mirrors mem0's `infer` escape hatch.
  infer: z.boolean().optional(),
};

interface MetadataChangelogEntry {
  at: number;
  action: "merged" | "created";
  similarity?: number;
  previous_note?: string;
}

interface StoredMetadata {
  changelog?: MetadataChangelogEntry[];
  [key: string]: unknown;
}

function mergeTagLists(...lists: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const raw of list) {
      const value = raw.trim().toLowerCase();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function parseStoredTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function parseStoredMetadata(raw: string): StoredMetadata {
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

export function registerRememberTool(server: McpServer): void {
  server.registerTool(
    "remember",
    {
      description:
        "Save a memory from a natural-language note. By default Fossel infers memory_type and generates tags. For best quality, extract a single clean, self-contained fact before calling (resolve pronouns and vague references), and you may pass an explicit type and tags. Set infer=false when you have already supplied type/tags and want the note stored verbatim. Relative dates in the note (\"last week\", \"3 days ago\") are grounded to absolute dates automatically. Fossel resolves the repo, merges near-duplicates, and lists related memories so you can reconcile contradictions — call update_memory to revise or delete_memory to remove a superseded memory. Prefer this tool over store_context for everyday use.",
      inputSchema: rememberInputSchema,
    },
    async ({ note: rawNote, repo, type, tags, infer }) => {
      try {
        const db = getDb();
        const resolved = resolveRepoArg(repo, getWorkspaceRoot(), db);
        // Ground relative dates so the memory stays meaningful over time.
        const note = groundTemporalReferences(rawNote);
        // Skip heuristic inference when the agent opted out (infer=false),
        // falling back to "general" type and the supplied tags only.
        const shouldInfer = infer !== false;
        const inferred = shouldInfer
          ? inferMemoryFromNote(note)
          : { type: "general" as MemoryType, tags: [] as string[] };

        const finalType: MemoryType = type ?? inferred.type;
        const finalTags = mergeTagLists(tags, inferred.tags).slice(0, 5);

        const now = Math.floor(Date.now() / 1000);
        const duplicate = findDuplicate(db, resolved.canonical, note);

        if (duplicate) {
          const existing = duplicate.memory;
          const existingTags = parseStoredTags(existing.tags);
          const mergedTags = mergeTagLists(existingTags, finalTags);
          const metadata = parseStoredMetadata(
            (existing as MemoryRowWithMetadata).metadata_json ?? "{}",
          );
          const changelog = metadata.changelog ?? [];
          changelog.push({
            at: now,
            action: "merged",
            similarity: Number(duplicate.similarity.toFixed(3)),
            previous_note: existing.note,
          });
          metadata.changelog = changelog;

          // Prefer the longer note (more information). Keep the existing type
          // unless the caller passed an explicit override.
          const longerNote = note.length > existing.note.length ? note : existing.note;
          const nextType: MemoryType = type ?? existing.type;

          db.prepare(
            `
              UPDATE memories
              SET note = ?, note_normalized = ?, tags = ?, type = ?, metadata_json = ?, updated_at = ?
              WHERE rowid = ?
            `,
          ).run(
            longerNote,
            normalizeText(longerNote),
            JSON.stringify(mergedTags),
            nextType,
            JSON.stringify(metadata),
            now,
            existing.row_id,
          );

          // Re-index: the merged note text changed, so its vector must too.
          indexMemoryEmbedding(db, existing.row_id, longerNote);

          return {
            content: [
              {
                type: "text",
                text:
                  `Merged into memory ${existing.row_id} for ${resolved.canonical} ` +
                  `(similarity ${duplicate.similarity.toFixed(2)}, type ${nextType}, tags: ${mergedTags.join(", ") || "none"}).`,
              },
            ],
          };
        }

        const id = nanoid();
        const metadata: StoredMetadata = {
          changelog: [
            {
              at: now,
              action: "created",
            },
          ],
          inferred: {
            type: inferred.type,
            tags: inferred.tags,
            type_overridden: type !== undefined,
          },
        };

        db.prepare(
          `
            INSERT INTO memories (id, repo, type, note, tags, created_at, updated_at, pinned, metadata_json, note_normalized)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          `,
        ).run(
          id,
          resolved.canonical,
          finalType,
          note,
          JSON.stringify(finalTags),
          now,
          now,
          JSON.stringify(metadata),
          normalizeText(note),
        );

        const inserted = db
          .prepare("SELECT rowid AS row_id FROM memories WHERE id = ?")
          .get(id) as { row_id: number } | undefined;

        if (inserted) {
          indexMemoryEmbedding(db, inserted.row_id, note);
        }

        // Conflict-review hint: surface related-but-not-duplicate memories so
        // the client's model can decide whether the new note supersedes or
        // contradicts them (calling update_memory / delete_memory). Fossel
        // stays dependency-free by delegating the judgment to the agent.
        const related = findRelatedCandidates(db, resolved.canonical, note);
        const conflictNotice = formatConflictNotice(related);

        return {
          content: [
            {
              type: "text",
              text:
                `Stored memory ${inserted?.row_id ?? "?"} for ${resolved.canonical} ` +
                `(type ${finalType}, tags: ${finalTags.join(", ") || "none"}).` +
                conflictNotice,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error while remembering note.";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to remember note: ${message}`,
            },
          ],
        };
      }
    },
  );
}

interface MemoryRowWithMetadata {
  metadata_json?: string;
}

/**
 * Build an advisory notice listing related-but-not-duplicate memories so the
 * MCP client's model can reconcile them. Returns an empty string when there
 * is nothing to flag, so the common case adds no noise.
 */
function formatConflictNotice(related: RelatedCandidate[]): string {
  if (related.length === 0) {
    return "";
  }

  const lines = related.map((candidate) => {
    const flag = candidate.possibleContradiction
      ? " ⚠ may contradict/supersede"
      : "";
    const snippet =
      candidate.memory.note.length > 100
        ? `${candidate.memory.note.slice(0, 97)}...`
        : candidate.memory.note;
    return `  - #${candidate.memory.row_id} (similarity ${candidate.similarity.toFixed(
      2,
    )})${flag}: ${snippet}`;
  });

  const anyContradiction = related.some((c) => c.possibleContradiction);
  const guidance = anyContradiction
    ? "If this new note replaces or contradicts any of them, call update_memory " +
      "to revise the existing memory or delete_memory to remove the stale one. " +
      "Otherwise no action is needed."
    : "If this new note updates any of them, consider update_memory; otherwise " +
      "keeping both is fine.";

  return (
    `\n\nRelated existing memories you may want to reconcile:\n` +
    `${lines.join("\n")}\n${guidance}`
  );
}
