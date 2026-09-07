/**
 * Server-side reader for `data/word_senses.json` (produced by the annotation
 * batch). Powers click-a-word-to-see-its-meaning: the sentence's tokens are
 * looked up here on the server and handed to `<ClickableSentence>`.
 *
 * Server-only: it touches `node:fs` and `node:crypto`. See the note in
 * lib/audio-index.ts about the `server-only` package not being installed.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AnnotatedSentence, AnnotatedToken, Sense, WordSenseIndex } from "./types";
import {
  buildSentenceLookups,
  buildWordLookup,
  buildWordLookupWithIndexes,
  indexSensesById,
  indexSensesByLemma
} from "@/components/word/sense-lookup";

if (typeof window !== "undefined") {
  throw new Error("lib/word-senses.ts is server-only");
}

export const WORD_SENSES_PATH = path.join(process.cwd(), "data", "word_senses.json");

/**
 * The pipeline's addressing convention, byte-for-byte: sha1 of the trimmed
 * UTF-8 text, first 16 hex chars. Audio uses the same function, so this is the
 * one place where the TS and Python sides must agree exactly.
 */
export function sentenceHash(text: string): string {
  return createHash("sha1").update(text.trim(), "utf8").digest("hex").slice(0, 16);
}

let indexPromise: Promise<WordSenseIndex | null> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(payload: unknown): WordSenseIndex | null {
  if (!isRecord(payload) || !isRecord(payload.by_sentence)) {
    return null;
  }

  return {
    version: typeof payload.version === "number" ? payload.version : 1,
    by_sentence: payload.by_sentence as WordSenseIndex["by_sentence"],
    unresolved: isRecord(payload.unresolved)
      ? (payload.unresolved as Record<string, number>)
      : undefined
  };
}

async function readIndex(): Promise<WordSenseIndex | null> {
  try {
    const source = await fs.readFile(WORD_SENSES_PATH, "utf8");
    return normalize(JSON.parse(source));
  } catch {
    // Annotation not generated yet: sentences render as plain text.
    return null;
  }
}

/** Cached in module scope; `null` until the annotation batch lands. */
export function getWordSenseIndex(): Promise<WordSenseIndex | null> {
  if (!indexPromise) {
    indexPromise = readIndex();
  }

  return indexPromise;
}

export function resetWordSenseCache(): void {
  indexPromise = null;
}

/**
 * Annotation for one sentence, or `null` when it has not been annotated.
 *
 * `text` is normalized to the sentence as stored by the pipeline, so token
 * offsets always line up with the string the component renders.
 */
export async function lookupSentence(text: string): Promise<AnnotatedSentence | null> {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const index = await getWordSenseIndex();
  const entry = index?.by_sentence[sentenceHash(trimmed)];
  if (!entry || !Array.isArray(entry.tokens)) {
    return null;
  }

  return { text: typeof entry.text === "string" ? entry.text : trimmed, tokens: entry.tokens };
}

/** Batch form for a session plan: one index read for many sentences. */
export async function lookupSentences(
  texts: readonly string[]
): Promise<Record<string, AnnotatedSentence | null>> {
  const index = await getWordSenseIndex();
  const result: Record<string, AnnotatedSentence | null> = {};

  for (const text of texts) {
    const trimmed = text.trim();
    const entry = trimmed ? index?.by_sentence[sentenceHash(trimmed)] : undefined;
    result[text] =
      entry && Array.isArray(entry.tokens)
        ? { text: typeof entry.text === "string" ? entry.text : trimmed, tokens: entry.tokens }
        : null;
  }

  return result;
}

/** How many annotated tokens a sentence has — useful for a data-coverage panel. */
export async function annotationCoverage(): Promise<{ sentences: number; unresolved: number }> {
  const index = await getWordSenseIndex();
  if (!index) {
    return { sentences: 0, unresolved: 0 };
  }

  return {
    sentences: Object.keys(index.by_sentence).length,
    unresolved: Object.keys(index.unresolved ?? {}).length
  };
}

export type { AnnotatedSentence, AnnotatedToken, Sense };
export {
  buildWordLookup,
  buildWordLookupWithIndexes,
  buildSentenceLookups,
  indexSensesById,
  indexSensesByLemma
};
