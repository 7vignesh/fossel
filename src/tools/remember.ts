import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getDb, MEMORY_TYPES, type MemoryType } from "../db/client.js";
import { findDuplicate, normalizeText } from "../lib/dedupe.js";
import { inferMemoryFromNote } from "../lib/inference.js";
import { resolveRepoArg } from "../lib/repo.js";
import { indexMemoryEmbedding } from "../lib/vector-index.js";
import { getWorkspaceRoot } from "../lib/workspace.js";

const rememberInputSchema = {
  note: z.string().trim().min(1, "note is required"),
  repo: z.string().trim().min(1).optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
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
        "Save a memory using only a natural-language note. Fossel infers memory_type, generates tags, resolves the repo, and merges into an existing memory when the note is a near-duplicate. Prefer this tool over store_context for everyday use.",
      inputSchema: rememberInputSchema,
    },
    async ({ note, repo, type, tags }) => {
      try {
        const db = getDb();
        const resolved = resolveRepoArg(repo, getWorkspaceRoot(), db);
        const inferred = inferMemoryFromNote(note);

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

        return {
          content: [
            {
              type: "text",
              text:
                `Stored memory ${inserted?.row_id ?? "?"} for ${resolved.canonical} ` +
                `(type ${finalType}, tags: ${finalTags.join(", ") || "none"}).`,
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
