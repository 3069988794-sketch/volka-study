/**
 * Client-side audio playback for study cards.
 *
 * Clips are addressed by `sha1(text.trim())[:16]` (see pipeline/4_tts.py) and
 * served by `app/api/audio/[hash]/route.ts`, because `data/audio/` is a few
 * hundred MB and must stay out of `public/`.
 *
 * Nothing here touches the DOM at module scope, so this module is safe to
 * import from a server component or a route handler (only `isAudioHash` /
 * `audioUrl` are useful there).
 */

/** The only shape a clip hash can have. Also the route handler's 400 boundary. */
export const AUDIO_HASH_PATTERN = /^[0-9a-f]{16}$/;

export type AudioFailureReason =
  /** Hash was absent or not 16 lowercase hex chars — never even requested. */
  | "invalid-hash"
  /** No `HTMLAudioElement` (SSR, or a browser without it). */
  | "unsupported"
  /** The route answered 404, or the browser could not decode the source. */
  | "missing"
  /** Autoplay blocked, decode error, or any other playback failure. */
  | "playback"
  /** `stopAudio()` or the caller's `AbortSignal` cancelled the play. */
  | "aborted";

export class AudioPlaybackError extends Error {
  readonly reason: AudioFailureReason;
  readonly hash: string | undefined;

  constructor(reason: AudioFailureReason, message: string, hash?: string) {
    super(message);
    this.name = "AudioPlaybackError";
    this.reason = reason;
    this.hash = hash;
  }
}

export function isAudioHash(value: unknown): value is string {
  return typeof value === "string" && AUDIO_HASH_PATTERN.test(value);
}

/** Route for a clip. Callers should gate on `canPlay` first. */
export function audioUrl(hash: string): string {
  return `/api/audio/${encodeURIComponent(hash)}`;
}

/** True when a hash *could* be played; the file may still be missing on disk. */
export function canPlay(hash: string | undefined): boolean {
  return isAudioHash(hash);
}

// ---------------------------------------------------------------------------
// Element pool — a 60-minute session plays hundreds of clips. One element per
// card would leak media handles, so 3 are created lazily and reused forever.
// ---------------------------------------------------------------------------

const POOL_SIZE = 3;

type PendingPlay = {
  cleanup: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
  settled: boolean;
};

let pool: HTMLAudioElement[] | null = null;
let cursor = 0;
let active: HTMLAudioElement | null = null;
const pending = new Map<HTMLAudioElement, PendingPlay>();

function ensurePool(): HTMLAudioElement[] | null {
  if (typeof window === "undefined" || typeof window.Audio === "undefined") {
    return null;
  }

  if (!pool) {
    pool = Array.from({ length: POOL_SIZE }, () => {
      const element = new window.Audio();
      element.preload = "auto";
      return element;
    });
  }

  return pool;
}

/** Prefer an idle element so a still-fading clip is not cut off mid-buffer. */
function acquire(elements: HTMLAudioElement[]): HTMLAudioElement {
  const idle = elements.find((element) => !pending.has(element));
  if (idle) {
    return idle;
  }

  const element = elements[cursor % elements.length];
  cursor = (cursor + 1) % elements.length;
  return element;
}

function settle(element: HTMLAudioElement, error?: unknown): void {
  const entry = pending.get(element);
  if (!entry || entry.settled) {
    return;
  }

  entry.settled = true;
  pending.delete(element);
  entry.cleanup();

  if (error) {
    entry.reject(error);
  } else {
    entry.resolve();
  }
}

export type PlayAudioOptions = {
  /** `playbackRate`; 0.7 is the "slow" setting. Clamped to 0.5–2. */
  rate?: number;
  signal?: AbortSignal;
};

function clampRate(rate: number | undefined): number {
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    return 1;
  }

  return Math.min(2, Math.max(0.5, rate));
}

function reasonFromMediaError(error: MediaError | null): AudioFailureReason {
  // 2 = NETWORK, 4 = SRC_NOT_SUPPORTED. A 404 from the route lands on 4.
  if (error && (error.code === 2 || error.code === 4)) {
    return "missing";
  }

  return "playback";
}

/**
 * Play a clip and resolve when it ends.
 *
 * Rejects with an `AudioPlaybackError` on failure so the caller can fall back
 * to `speak()`. `stopAudio()` resolves an in-flight play instead of rejecting
 * (a learner pressing Space twice is not an error); use `opts.signal` when you
 * need cancellation to be observable, e.g. inside an A/B sequence.
 */
export function playAudio(hash: string, opts: PlayAudioOptions = {}): Promise<void> {
  if (!isAudioHash(hash)) {
    return Promise.reject(
      new AudioPlaybackError("invalid-hash", `Not an audio hash: ${String(hash)}`, hash)
    );
  }

  const elements = ensurePool();
  if (!elements) {
    return Promise.reject(
      new AudioPlaybackError("unsupported", "Audio playback is unavailable here", hash)
    );
  }

  if (opts.signal?.aborted) {
    return Promise.reject(new AudioPlaybackError("aborted", "Aborted before playback", hash));
  }

  stopAudio();

  const element = acquire(elements);
  active = element;

  if (element.dataset.hash !== hash) {
    element.dataset.hash = hash;
    element.src = audioUrl(hash);
  }

  element.preservesPitch = true;
  element.playbackRate = clampRate(opts.rate);

  return new Promise<void>((resolve, reject) => {
    const signal = opts.signal;

    const onEnded = () => settle(element);
    const onError = () =>
      settle(
        element,
        new AudioPlaybackError(
          reasonFromMediaError(element.error),
          `Could not play clip ${hash}`,
          hash
        )
      );
    const onAbort = () => {
      try {
        element.pause();
      } catch {
        // Pausing a never-started element can throw in older engines.
      }
      settle(element, new AudioPlaybackError("aborted", "Playback aborted", hash));
    };

    const cleanup = () => {
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (active === element) {
        active = null;
      }
    };

    pending.set(element, { cleanup, resolve, reject, settled: false });
    element.addEventListener("ended", onEnded);
    element.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      element.currentTime = 0;
    } catch {
      // Not seekable yet; the fresh src already starts at 0.
    }

    void element.play().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "play() rejected";
      settle(element, new AudioPlaybackError("playback", message, hash));
    });
  });
}

/** Stop every pooled element and any Web Speech utterance. */
export function stopAudio(): void {
  if (pool) {
    for (const element of pool) {
      try {
        element.pause();
      } catch {
        // Ignore — nothing was playing.
      }
      settle(element);
    }
  }

  active = null;
  stopSpeaking();
}

/** True while a pooled element is mid-clip. */
export function isPlaying(): boolean {
  return active !== null;
}

// ---------------------------------------------------------------------------
// Prefetch — warm the next 2–3 cards. Bounded queue: never 200 requests.
// ---------------------------------------------------------------------------

const PREFETCH_CONCURRENCY = 2;
const PREFETCH_PER_CALL = 4;
const PREFETCH_TIMEOUT_MS = 6000;
const PREFETCH_MEMORY = 400;

const prefetched = new Set<string>();
const prefetchQueue: string[] = [];
let prefetchInFlight = 0;

export function prefetchAudio(hashes: string[]): void {
  if (typeof window === "undefined" || typeof window.Audio === "undefined") {
    return;
  }

  let queued = 0;
  for (const hash of hashes) {
    if (queued >= PREFETCH_PER_CALL) {
      break;
    }
    if (!isAudioHash(hash) || prefetched.has(hash)) {
      continue;
    }

    if (prefetched.size >= PREFETCH_MEMORY) {
      prefetched.clear();
    }

    prefetched.add(hash);
    prefetchQueue.push(hash);
    queued += 1;
  }

  pumpPrefetch();
}

function pumpPrefetch(): void {
  while (prefetchInFlight < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
    const hash = prefetchQueue.shift();
    if (!hash) {
      return;
    }

    prefetchInFlight += 1;
    const element = new window.Audio();
    element.preload = "auto";

    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      window.clearTimeout(timer);
      element.removeEventListener("canplaythrough", release);
      element.removeEventListener("error", release);
      prefetchInFlight -= 1;
      pumpPrefetch();
    };

    const timer = window.setTimeout(release, PREFETCH_TIMEOUT_MS);
    element.addEventListener("canplaythrough", release, { once: true });
    element.addEventListener("error", release, { once: true });
    element.src = audioUrl(hash);
    element.load();
  }
}

// ---------------------------------------------------------------------------
// Web Speech fallback — the learner must always hear *something*, even before
// the TTS batch has produced a clip for this sentence.
// ---------------------------------------------------------------------------

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function pickEnglishVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return (
    voices.find((voice) => voice.lang.replace("_", "-").toLowerCase() === "en-us") ??
    voices.find((voice) => voice.lang.replace("_", "-").toLowerCase().startsWith("en")) ??
    null
  );
}

/**
 * Speak `text` with an en-US voice. Returns false when the browser has no
 * speech synthesis or no English voice at all, so the caller can show the
 * "unavailable" state instead of pretending it played.
 */
export function speak(text: string, rate = 1): boolean {
  if (!speechSupported() || !text.trim()) {
    return false;
  }

  const synth = window.speechSynthesis;
  const voices = synth.getVoices();
  const voice = pickEnglishVoice(voices);

  // Chrome returns [] until `voiceschanged`; attempting en-US is still right.
  if (voices.length > 0 && !voice) {
    return false;
  }

  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voice?.lang ?? "en-US";
  if (voice) {
    utterance.voice = voice;
  }
  utterance.rate = clampRate(rate);
  synth.speak(utterance);
  return true;
}

export function stopSpeaking(): void {
  if (speechSupported()) {
    window.speechSynthesis.cancel();
  }
}

export type PlaybackSource = "audio" | "speech" | "none";

/**
 * The one call a card component usually wants: real clip if we have one,
 * Web Speech if we do not, `"none"` if the browser can do neither.
 */
export async function playOrSpeak(
  hash: string | undefined,
  text: string,
  opts: PlayAudioOptions = {}
): Promise<PlaybackSource> {
  if (canPlay(hash)) {
    try {
      await playAudio(hash as string, opts);
      return "audio";
    } catch (error) {
      if (error instanceof AudioPlaybackError && error.reason === "aborted") {
        throw error;
      }
    }
  }

  return speak(text, opts.rate) ? "speech" : "none";
}
