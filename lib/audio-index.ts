/**
 * Server-side reader for `data/audio_index.json` (produced by pipeline/4_tts.py).
 *
 * Server-only: it touches `node:fs`. The repo does not depend on the
 * `server-only` package (Next aliases it but Node/vitest cannot resolve it),
 * so the guard below is explicit instead.
 *
 * The index is a single multi-MB JSON for ~9600 clips, so it is read once per
 * process and shared — 200 cards must not each re-parse it.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { isAudioHash } from "./audio";
import type { AudioFileMeta, AudioIndex } from "./types";

if (typeof window !== "undefined") {
  throw new Error("lib/audio-index.ts is server-only");
}

export const AUDIO_DIR = path.join(process.cwd(), "data", "audio");
export const AUDIO_INDEX_PATH = path.join(process.cwd(), "data", "audio_index.json");

let indexPromise: Promise<AudioIndex | null> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept the file only if it actually looks like an `AudioIndex`. */
function normalize(payload: unknown): AudioIndex | null {
  if (!isRecord(payload) || !isRecord(payload.by_sense) || !isRecord(payload.files)) {
    return null;
  }

  return {
    version: typeof payload.version === "number" ? payload.version : 1,
    hash: typeof payload.hash === "string" ? payload.hash : "sha1_16",
    by_sense: payload.by_sense as AudioIndex["by_sense"],
    files: payload.files as AudioIndex["files"]
  };
}

async function readIndex(): Promise<AudioIndex | null> {
  try {
    const source = await fs.readFile(AUDIO_INDEX_PATH, "utf8");
    return normalize(JSON.parse(source));
  } catch {
    // Not generated yet, or unreadable: every caller degrades to Web Speech.
    return null;
  }
}

/** Cached in module scope; `null` while the TTS batch has not landed. */
export function getAudioIndex(): Promise<AudioIndex | null> {
  if (!indexPromise) {
    indexPromise = readIndex();
  }

  return indexPromise;
}

/** Drop the cache (dev/tests, or after a pipeline re-run). */
export function resetAudioIndexCache(): void {
  indexPromise = null;
}

export type SenseAudio = {
  /** Hash of the headword clip, if one exists. */
  word?: string;
  /** Hash of the example-sentence clip, if one exists. */
  example?: string;
};

/** Clip hashes for one sense; `{}` when the index or the sense is missing. */
export async function getSenseAudio(senseId: string): Promise<SenseAudio> {
  const index = await getAudioIndex();
  const entry = index?.by_sense[senseId];
  if (!entry) {
    return {};
  }

  return {
    word: isAudioHash(entry.word) ? entry.word : undefined,
    example: isAudioHash(entry.example) ? entry.example : undefined
  };
}

/** Batch form for a whole session plan — one index read, N lookups. */
export async function getSenseAudioMap(
  senseIds: readonly string[]
): Promise<Record<string, SenseAudio>> {
  const index = await getAudioIndex();
  const result: Record<string, SenseAudio> = {};

  for (const senseId of senseIds) {
    const entry = index?.by_sense[senseId];
    result[senseId] = entry
      ? {
          word: isAudioHash(entry.word) ? entry.word : undefined,
          example: isAudioHash(entry.example) ? entry.example : undefined
        }
      : {};
  }

  return result;
}

export async function getAudioMeta(hash: string): Promise<AudioFileMeta | null> {
  if (!isAudioHash(hash)) {
    return null;
  }

  const index = await getAudioIndex();
  return index?.files[hash] ?? null;
}

/**
 * Path-traversal boundary for the route handler: reject anything that is not a
 * 16-char lowercase hex hash, then join, then confirm the result is still
 * inside `data/audio/`. The raw param never reaches `path.join` unvalidated.
 */
export function resolveAudioFilePath(hash: string): string | null {
  if (!isAudioHash(hash)) {
    return null;
  }

  const filePath = path.join(AUDIO_DIR, `${hash}.mp3`);
  const relative = path.relative(AUDIO_DIR, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return filePath;
}
