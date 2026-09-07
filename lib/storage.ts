export const PROGRESS_STORAGE_KEY = "volka-study:progress:v1";

const QUEUE_KEY = "volka-study:review-queue:v1";

// ---------------------------------------------------------------------------
// FSRS state persistence
// ---------------------------------------------------------------------------

const STATES_KEY = "volka:states";
const DAY_START_KEY = "volka:day_start";
const STUDY_DAYS_KEY = "volka:study_days:v1";
const CURSOR_KEY = "volka:cursor";
const RATED_KEY = "volka:rated";

/** Persist all FSRS card states to localStorage. */
export function saveStates(states: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STATES_KEY, JSON.stringify(states));
  } catch { /* storage full */ }
}

/** Load persisted FSRS card states from localStorage. */
export function loadStates<T>(): Record<string, T> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STATES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, T>) : {};
  } catch { return {}; }
}

/** Record the first study date if not already set. */
export function ensureStudyStart(): void {
  if (typeof window === "undefined") return;
  const today = new Date().toISOString().slice(0, 10);
  if (!localStorage.getItem(DAY_START_KEY)) localStorage.setItem(DAY_START_KEY, today);
  try {
    const raw = localStorage.getItem(STUDY_DAYS_KEY);
    const days = raw ? (JSON.parse(raw) as string[]) : [];
    if (!days.includes(today)) localStorage.setItem(STUDY_DAYS_KEY, JSON.stringify([...days, today]));
  } catch { /* ignore malformed local progress */ }
}

/** Return the current study day number (1-based, increments each calendar day). */
export function getDayNo(): number {
  if (typeof window === "undefined") return 1;
  try {
    const raw = localStorage.getItem(STUDY_DAYS_KEY);
    const days = raw ? (JSON.parse(raw) as string[]) : [];
    return Math.max(1, days.length);
  } catch { return 1; }
}

export function saveCursor(n: number): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(CURSOR_KEY, String(n)); } catch { /* ignore */ }
}

export function loadCursor(maxLen: number): number {
  if (typeof window === "undefined") return 0;
  try {
    return Math.min(parseInt(localStorage.getItem(CURSOR_KEY) ?? "0", 10), maxLen);
  } catch { return 0; }
}

export function saveRated(n: number): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(RATED_KEY, String(n)); } catch { /* ignore */ }
}

export function loadRated(): number {
  if (typeof window === "undefined") return 0;
  try {
    return parseInt(localStorage.getItem(RATED_KEY) ?? "0", 10);
  } catch { return 0; }
}

export function clearSessionProgress(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(CURSOR_KEY);
    localStorage.removeItem(RATED_KEY);
  } catch { /* ignore */ }
}

export type QueuedReview = {
  reviewId: string;
  senseId: string;
  rating: string;
  cardType: string;
  elapsedMs: number;
  clientTs: string;
};

export function enqueueFailedReview(item: QueuedReview): void {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const queue: QueuedReview[] = raw ? (JSON.parse(raw) as QueuedReview[]) : [];
    queue.push(item);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch { /* ignore */ }
}

export function drainReviewQueue(): QueuedReview[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    localStorage.removeItem(QUEUE_KEY);
    const queue = JSON.parse(raw) as Array<Partial<QueuedReview>>;
    return queue.filter((item) => typeof item.senseId === "string").map((item, index) => ({
      reviewId: item.reviewId ?? `queued:${item.senseId}:${item.clientTs ?? ""}:${index}`,
      senseId: item.senseId!, rating: item.rating ?? "again", cardType: item.cardType ?? "intro",
      elapsedMs: Number(item.elapsedMs) || 0, clientTs: item.clientTs ?? new Date().toISOString(),
    }));
  } catch { return []; }
}
