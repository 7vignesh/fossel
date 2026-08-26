/**
 * LongMemEval-S adapter.
 *
 * LongMemEval (ICLR 2025) is a *conversational* long-term-memory benchmark: a
 * haystack of prior chat sessions plus a question whose answer lives in one or
 * more specific sessions. Fossel is repo memory, so the domain does not match —
 * but the retrieval mechanics under test (can the index surface the one relevant
 * item out of hundreds?) are exactly the same, and it is the number every
 * comparable project quotes. It is included for comparability, not because it
 * measures what Fossel is for. The repo-memory dataset is the domain-accurate
 * one.
 *
 * The dataset is NOT redistributed here. Download `longmemeval_s.json` from
 * https://huggingface.co/datasets/xiaowu0162/longmemeval and pass `--file`.
 *
 * Mapping decisions:
 *
 *  - **One namespace per question.** Each question ships its own haystack, so
 *    every question is ingested under `lme/<question_id>`. Pooling them into a
 *    single namespace would let sessions from unrelated questions act as
 *    distractors, which is a different (and harder) task than the published one.
 *
 *  - **Session granularity by default.** One memory per haystack session, turns
 *    joined into a single note. This matches the session-level recall numbers
 *    usually quoted and keeps ingest tractable. `granularity: "turn"` evaluates
 *    at turn level instead, which is stricter and much slower.
 *
 *  - **Relevance from `answer_session_ids`.** A retrieval is correct when it
 *    surfaces a session the dataset marks as containing the answer. At turn
 *    granularity, correctness requires a turn flagged `has_answer`.
 */

import { readFileSync } from "node:fs";
import type { BenchDataset, BenchMemory, BenchQuery } from "./harness.js";

interface LongMemEvalTurn {
  role?: string;
  content?: string;
  has_answer?: boolean;
}

interface LongMemEvalItem {
  question_id?: string;
  question_type?: string;
  question?: string;
  answer?: string;
  question_date?: string;
  haystack_session_ids?: string[];
  haystack_dates?: string[];
  haystack_sessions?: LongMemEvalTurn[][];
  answer_session_ids?: string[];
}

export interface LongMemEvalOptions {
  /** Cap the number of questions ingested. The full 500-question set at session
   * granularity is tens of thousands of rows; a sample is usually enough to see
   * a regression. */
  maxQuestions?: number;
  granularity?: "session" | "turn";
}

function turnText(turn: LongMemEvalTurn): string {
  const role = turn.role?.trim() || "user";
  const content = turn.content?.trim() ?? "";
  return content ? `${role}: ${content}` : "";
}

export function loadLongMemEval(
  path: string,
  options: LongMemEvalOptions = {},
): BenchDataset {
  const granularity = options.granularity ?? "session";
  // Strip a UTF-8 BOM if present. Editors and shells on Windows add one freely
  // and JSON.parse rejects it, which is a confusing failure for a downloaded
  // dataset file.
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is not valid JSON: ${message}`);
  }

  if (!Array.isArray(raw)) {
    throw new Error(
      `${path} is not a LongMemEval file: expected a top-level JSON array of questions.`,
    );
  }

  const items = raw as LongMemEvalItem[];
  const selected =
    options.maxQuestions && options.maxQuestions > 0
      ? items.slice(0, options.maxQuestions)
      : items;

  const memories: BenchMemory[] = [];
  const queries: BenchQuery[] = [];
  let skipped = 0;

  selected.forEach((item, questionIndex) => {
    const questionId = item.question_id ?? `q${questionIndex}`;
    const question = item.question?.trim();
    const sessions = item.haystack_sessions ?? [];
    const sessionIds = item.haystack_session_ids ?? [];
    const answerIds = new Set(item.answer_session_ids ?? []);

    if (!question || sessions.length === 0 || answerIds.size === 0) {
      skipped += 1;
      return;
    }

    const repo = `lme/${questionId}`;
    const relevant: string[] = [];

    sessions.forEach((session, sessionIndex) => {
      const sessionId = sessionIds[sessionIndex] ?? `s${sessionIndex}`;
      const isAnswerSession = answerIds.has(sessionId);

      if (granularity === "session") {
        const note = session.map(turnText).filter(Boolean).join("\n");
        if (!note) {
          return;
        }
        const key = `${questionId}::${sessionId}`;
        memories.push({ key, note, repo, type: "general" });
        if (isAnswerSession) {
          relevant.push(key);
        }
        return;
      }

      session.forEach((turn, turnIndex) => {
        const note = turnText(turn);
        if (!note) {
          return;
        }
        const key = `${questionId}::${sessionId}::${turnIndex}`;
        memories.push({ key, note, repo, type: "general" });
        // At turn granularity only the flagged turns carry the answer.
        if (isAnswerSession && turn.has_answer) {
          relevant.push(key);
        }
      });
    });

    if (relevant.length === 0) {
      // Nothing to score against — usually a turn-granularity item with no
      // has_answer flags. Drop it rather than count it as an automatic miss.
      skipped += 1;
      return;
    }

    queries.push({
      id: questionId,
      query: question,
      relevant,
      category: item.question_type ?? "unknown",
      repo,
    });
  });

  if (queries.length === 0) {
    throw new Error(
      `Parsed ${items.length} item(s) from ${path} but none were scorable. ` +
        "Expected fields: question, haystack_sessions, haystack_session_ids, answer_session_ids.",
    );
  }

  return {
    name: `longmemeval-s (${granularity}, ${queries.length} questions${skipped ? `, ${skipped} skipped` : ""})`,
    description:
      "LongMemEval-S mapped onto Fossel memories, one namespace per question. " +
      "Included for cross-project comparability; the repo-memory dataset is the domain-accurate eval.",
    repo: "lme/unused",
    memories,
    queries,
  };
}
