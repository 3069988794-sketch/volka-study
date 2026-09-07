/**
 * Pure sense resolution for click-a-word.
 *
 * Lives here (not in `lib/word-senses.ts`, which imports `node:fs`) so the
 * popover can resolve a token on the client with zero network and zero
 * re-tokenizing. `lib/word-senses.ts` re-exports these for server callers.
 */

import type { AnnotatedSentence, AnnotatedToken, Sense, WordLookup } from "@/lib/types";

function lemmaKey(value: string): string {
  return value.trim().toLowerCase();
}

/** Group senses by lemma/headword so alternatives are one lookup away. */
export function indexSensesByLemma(senses: readonly Sense[]): Map<string, Sense[]> {
  const byLemma = new Map<string, Sense[]>();

  for (const sense of senses) {
    const key = lemmaKey(sense.headword);
    if (!key) {
      continue;
    }

    const bucket = byLemma.get(key);
    if (bucket) {
      bucket.push(sense);
    } else {
      byLemma.set(key, [sense]);
    }
  }

  return byLemma;
}

export function indexSensesById(senses: readonly Sense[]): Map<string, Sense> {
  return new Map(senses.map((sense) => [sense.sense_id, sense]));
}

/**
 * Resolve one annotated token against the sense list.
 *
 * Returns `null` when the annotated `sense_id` is not in `senses` — a dangling
 * reference must render as plain text, never as a broken popover.
 *
 * `alternatives` are the other senses of the same lemma, so a low-confidence
 * or plainly wrong annotation stays recoverable by the learner.
 */
export function buildWordLookup(
  token: AnnotatedToken,
  senses: readonly Sense[]
): WordLookup | null {
  return buildWordLookupWithIndexes(token, indexSensesById(senses), indexSensesByLemma(senses));
}

/** Same as `buildWordLookup`, but reuses prebuilt indexes across many tokens. */
export function buildWordLookupWithIndexes(
  token: AnnotatedToken,
  byId: Map<string, Sense>,
  byLemma: Map<string, Sense[]>
): WordLookup | null {
  const sense = byId.get(token.sense_id);
  if (!sense) {
    return null;
  }

  const keys = new Set([lemmaKey(token.lemma), lemmaKey(sense.headword)]);
  const alternatives: Sense[] = [];
  const seen = new Set<string>([sense.sense_id]);

  for (const key of keys) {
    for (const candidate of byLemma.get(key) ?? []) {
      if (!seen.has(candidate.sense_id)) {
        seen.add(candidate.sense_id);
        alternatives.push(candidate);
      }
    }
  }

  return {
    surface: token.surface,
    lemma: token.lemma,
    sense,
    confidence: token.confidence,
    alternatives
  };
}

/** Every resolvable token of a sentence, keyed by `start` offset. */
export function buildSentenceLookups(
  sentence: AnnotatedSentence | null,
  senses: readonly Sense[]
): Map<number, WordLookup> {
  const lookups = new Map<number, WordLookup>();
  if (!sentence) {
    return lookups;
  }

  const byId = indexSensesById(senses);
  const byLemma = indexSensesByLemma(senses);

  for (const token of sentence.tokens) {
    const lookup = buildWordLookupWithIndexes(token, byId, byLemma);
    if (lookup) {
      lookups.set(token.start, lookup);
    }
  }

  return lookups;
}

export type SentenceSegment =
  | { kind: "text"; text: string; key: string }
  | { kind: "token"; text: string; key: string; token: AnnotatedToken };

/**
 * Split `text` into plain runs and clickable tokens using the annotation's
 * character offsets. Never re-tokenizes and never `split(" ")`: punctuation and
 * multi-word chunks depend on the pipeline's offsets being used verbatim.
 *
 * Tokens that are out of range, zero-width, overlapping, or whose `surface`
 * does not match the text at that offset are dropped (rendered as plain text).
 */
export function segmentSentence(
  text: string,
  sentence: AnnotatedSentence | null
): SentenceSegment[] {
  if (!sentence || sentence.tokens.length === 0) {
    return text ? [{ kind: "text", text, key: "t0" }] : [];
  }

  const tokens = [...sentence.tokens].sort((a, b) => a.start - b.start);
  const segments: SentenceSegment[] = [];
  let cursor = 0;

  for (const token of tokens) {
    const { start, end } = token;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < cursor ||
      end <= start ||
      end > text.length
    ) {
      continue;
    }

    const slice = text.slice(start, end);
    if (token.surface && slice !== token.surface) {
      continue;
    }

    if (start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, start), key: `t${cursor}` });
    }

    segments.push({ kind: "token", text: slice, key: `w${start}`, token });
    cursor = end;
  }

  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor), key: `t${cursor}` });
  }

  return segments;
}
