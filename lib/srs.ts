/**
 * SRS engine — thin wrapper around `ts-fsrs` (Free Spaced Repetition Scheduler).
 *
 * ts-fsrs exposes the FSRS v5 algorithm. We wrap it so that:
 * - `lib/srs.ts` is the only module that imports `ts-fsrs`
 * - the rest of the app talks through `SenseState` / `Rating` (defined in `types.ts`)
 *
 * The `FSRS` instance is thread-local (Node single-threaded).  A `fparams`
 * instance carries the default parameters; the learner can override them via
 * the settings API.
 */
import {
  FSRS,
  Rating as FsrsRating,
  State,
  type CardInput,
  type FSRSParameters,
  type Grade,
} from "ts-fsrs";

import type {
  CardType,
  Rating,
  SenseState,
  ReviewLogEntry,
  SrsState,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Mapping between our domain and ts-fsrs
// ---------------------------------------------------------------------------

/** Convert our `SrsState` to ts-fsrs `State`. */
function toFsrsState(state: SrsState): State {
  switch (state) {
    case "new": return State.New;
    case "learning": return State.Learning;
    case "review": return State.Review;
    case "relearning": return State.Relearning;
  }
}

/** Convert ts-fsrs `State` back to our `SrsState`. */
function fromFsrsState(state: State): SrsState {
  switch (state) {
    case State.New: return "new";
    case State.Learning: return "learning";
    case State.Review: return "review";
    case State.Relearning: return "relearning";
  }
}

/** Map our `Rating` to ts-fsrs `Grade` (excludes Manual). */
function toFsrsRating(rating: Rating): Grade {
  switch (rating) {
    case "again": return FsrsRating.Again as Grade;
    case "hard": return FsrsRating.Hard as Grade;
    case "good": return FsrsRating.Good as Grade;
    case "easy": return FsrsRating.Easy as Grade;
  }
}

// ---------------------------------------------------------------------------
// Card-type helpers
// ---------------------------------------------------------------------------

const CARD_TYPES: readonly CardType[] = [
  "intro",
  "listen_choose",
  "shadow_ab",
  "blind_listen",
  "cloze",
  "reorder",
  "speak_hinted",
  "speak_free",
];

/** Which card type to show next for a sense, based on its review round. */
export function cardTypeForRound(round: number): CardType {
  if (round <= 0) return "intro";
  const idx = (round - 1) % CARD_TYPES.length;
  return CARD_TYPES[idx]!;
}

// ---------------------------------------------------------------------------
// Core SRS operations
// ---------------------------------------------------------------------------

const fparams: Partial<FSRSParameters> = {
  request_retention: 0.9,
  maximum_interval: 36500,
};

let _fsrs: FSRS | null = null;

function getFsrs(): FSRS {
  if (!_fsrs) {
    _fsrs = new FSRS(fparams);
  }
  return _fsrs;
}

/**
 * Initialise a brand-new sense. Returns a `SenseState` ready for the first card.
 */
export function createInitialProgress(senseId: string): SenseState {
  return {
    sense_id: senseId,
    stability: 0,
    difficulty: 0,
    due: new Date().toISOString(),
    reps: 0,
    lapses: 0,
    last_review: null,
    state: "new",
    round: 0,
  };
}

/**
 * Apply a rating and return the updated `SenseState`.
 */
export function recordRating(
  state: SenseState,
  rating: Rating,
  elapsedSec: number,
  now: Date = new Date(),
): SenseState {
  const fsrsRating = toFsrsRating(rating);
  const f = getFsrs();

  const card: CardInput = {
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: state.last_review
      ? Math.max(0, (now.getTime() - new Date(state.last_review).getTime()) / 86400000)
      : 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: state.reps,
    lapses: state.lapses,
    state: toFsrsState(state.state),
    due: state.due,
    last_review: state.last_review ?? undefined,
  };

  const item = f.next(card, now, fsrsRating);
  const next = item.card;

  return {
    sense_id: state.sense_id,
    stability: next.stability,
    difficulty: next.difficulty,
    due: next.due.toISOString(),
    reps: next.reps,
    lapses: next.lapses,
    last_review: now.toISOString(),
    state: fromFsrsState(next.state),
    round: state.round + (rating !== "again" ? 1 : 0),
  };
}

/**
 * Advance the cursor to the next card.
 */
export function moveToNextCard(state: SenseState): SenseState {
  return {
    ...state,
    round: state.round + 1,
  };
}

/**
 * Compute study progress percentage.
 */
export function getProgressPercent(
  total: number,
  learned: number,
): number {
  if (total === 0) return 0;
  return Math.round((learned / total) * 100);
}

// ---------------------------------------------------------------------------
// Review log
// ---------------------------------------------------------------------------

export function createLogEntry(
  senseId: string,
  rating: Rating,
  cardType: CardType,
  elapsedMs: number,
): ReviewLogEntry {
  return {
    sense_id: senseId,
    rating,
    card_type: cardType,
    elapsed_ms: elapsedMs,
    ts: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Preview card types (for session planning)
// ---------------------------------------------------------------------------

export function previewCardTypes(count: number): CardType[] {
  return Array.from({ length: count }, (_, i) => cardTypeForRound(i + 1));
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

export function closeSrs(): void {
  _fsrs = null;
}

process.on("exit", closeSrs);
