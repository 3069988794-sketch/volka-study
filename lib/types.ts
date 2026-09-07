/**
 * Shared type contract for the whole app.
 *
 * This file is the integration boundary between the workstreams (storage/SRS,
 * session engine, audio + click-to-word, theme/pages). Treat it as frozen:
 * if you need a change here, say so in your report rather than editing it,
 * because several agents compile against it at the same time.
 */

// ---------------------------------------------------------------------------
// Vocabulary data (produced by the Python pipeline)
// ---------------------------------------------------------------------------

export type CefrLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

/** Urgency band *within* a level — never used to reorder across levels. */
export type Priority = "T0" | "T1" | "T2" | "T3" | "T4";

export type Sense = {
  sense_id: string;
  headword: string;
  pos: string;
  level: string;
  gloss_en: string;
  gloss_cn: string;
  example_en: string;
  example_cn: string;
  ipa: string;
  chunk: string;
  priority: string;
  topic?: string;
  sub_name?: string;
};

export type SenseData = {
  senses: Sense[];
  isFallback: boolean;
  notice: string | null;
  counts: {
    total: number;
    completeCn: number;
  };
};

// ---------------------------------------------------------------------------
// Audio — addressed by hash of the *text*, never by sense_id, so editing a
// sense's metadata cannot invalidate its audio.
// hash = sha1(text.trim(), utf-8).hex[:16]
// ---------------------------------------------------------------------------

export type AudioKind = "word" | "example";

export type AudioFileMeta = {
  text: string;
  voice: string;
  kind: AudioKind;
  bytes: number;
};

export type AudioIndex = {
  version: number;
  hash: string;
  by_sense: Record<string, { word?: string; example?: string }>;
  files: Record<string, AudioFileMeta>;
};

// ---------------------------------------------------------------------------
// Word-level sense annotation — powers click-a-word-to-see-its-meaning.
// Sentences are keyed by the same sha1[:16] convention as audio.
// Tokens carry no gloss: resolve sense_id against `senses.json` at runtime.
// ---------------------------------------------------------------------------

export type TokenConfidence = "high" | "low";

export type AnnotatedToken = {
  surface: string;
  lemma: string;
  /** Character offsets into the original sentence. */
  start: number;
  end: number;
  sense_id: string;
  confidence: TokenConfidence;
};

export type AnnotatedSentence = {
  text: string;
  tokens: AnnotatedToken[];
};

export type WordSenseIndex = {
  version: number;
  by_sentence: Record<string, AnnotatedSentence>;
  unresolved?: Record<string, number>;
};

/** What the click-to-word popup renders. */
export type WordLookup = {
  surface: string;
  lemma: string;
  sense: Sense;
  confidence: TokenConfidence;
  /** Other senses of the same lemma, so the learner can correct a bad guess. */
  alternatives: Sense[];
};

// ---------------------------------------------------------------------------
// Grading and FSRS
// ---------------------------------------------------------------------------

export type Rating = "again" | "hard" | "good" | "easy";

/** ts-fsrs card states, mirrored so nothing outside lib/srs.ts imports ts-fsrs. */
export type SrsState = "new" | "learning" | "review" | "relearning";

export type SenseState = {
  sense_id: string;
  stability: number;
  difficulty: number;
  /** ISO 8601 UTC. */
  due: string;
  reps: number;
  lapses: number;
  /** ISO 8601 UTC, null before the first review. */
  last_review: string | null;
  state: SrsState;
  /** How many times this sense has been reviewed — drives card-type rotation. */
  round: number;
};

export type ReviewLogEntry = {
  id?: number;
  sense_id: string;
  rating: Rating;
  card_type: CardType;
  elapsed_ms: number;
  /** ISO 8601 UTC. */
  ts: string;
};

// ---------------------------------------------------------------------------
// Card types — one per review round, difficulty increasing from recognition
// to production (PLAN.md §2.6). Rounds 8+ all use "speak_free".
// ---------------------------------------------------------------------------

export type CardType =
  /** 1 首学 — form + IPA + gloss + hear the example + shadow twice. */
  | "intro"
  /** 2 听音辨义 — hear the example, pick the Chinese gloss from 4. */
  | "listen_choose"
  /** 3 跟读评分 — hear it, record yourself, A/B compare. */
  | "shadow_ab"
  /** 4 盲听 — audio only, self-assess, then reveal the text. */
  | "blind_listen"
  /** 5 例句填空 — target word removed, fill from 4 options. */
  | "cloze"
  /** 6 乱序重组 — reorder the shuffled sentence (the one drag-and-drop card). */
  | "reorder"
  /** 7 中→英口述 — Chinese prompt + first-letter hints, say the English. */
  | "speak_hinted"
  /** 8+ 中→英无提示 — Chinese prompt only. */
  | "speak_free";

export const CARD_TYPE_BY_ROUND: readonly CardType[] = [
  "intro",
  "listen_choose",
  "shadow_ab",
  "blind_listen",
  "cloze",
  "reorder",
  "speak_hinted",
  "speak_free"
] as const;

/** Cards that grade themselves from a choice instead of a self-rating. */
export const OBJECTIVE_CARD_TYPES: readonly CardType[] = [
  "listen_choose",
  "cloze",
  "reorder"
] as const;

/** Cards that need the microphone. */
export const RECORDING_CARD_TYPES: readonly CardType[] = [
  "shadow_ab",
  "speak_hinted",
  "speak_free"
] as const;

// ---------------------------------------------------------------------------
// Session structure — 5 timed segments (PLAN.md §2.4)
// ---------------------------------------------------------------------------

export type SegmentKind = "warmup" | "review" | "new" | "produce" | "chain";

export type SegmentSpec = {
  kind: SegmentKind;
  label: string;
  minutes: number;
  /** CSS custom property used for this segment's accent. */
  tone: string;
  hint: string;
};

/** 60 / 20 / 5 minute variants, so a bad day still keeps the streak. */
export type SessionLength = "full" | "short" | "minimal";

export type SessionCard = {
  senseId: string;
  cardType: CardType;
  segment: SegmentKind;
  /** Review round this card represents; 1 for a brand-new sense. */
  round: number;
  /** Distractor sense_ids for listen_choose / cloze. */
  distractors?: string[];
};

export type SegmentProgress = {
  kind: SegmentKind;
  total: number;
  done: number;
  /** ISO 8601 UTC, null until the learner enters the segment. */
  startedAt: string | null;
  completedAt: string | null;
};

export type SessionPlan = {
  /** YYYY-MM-DD in the learner's local time. */
  date: string;
  dayNo: number;
  length: SessionLength;
  plannedMinutes: number;
  stage: string;
  cards: SessionCard[];
  segments: SegmentProgress[];
  newCount: number;
  reviewCount: number;
};

export type SessionRuntime = {
  plan: SessionPlan;
  cursor: number;
  /** Ratings applied this session, keyed by sense_id. */
  graded: Record<string, Rating>;
  startedAt: string;
  paused: boolean;
};

export type SessionSummary = {
  date: string;
  dayNo: number;
  actualMinutes: number;
  cardsDone: number;
  newLearned: number;
  reviewed: number;
  accuracy: number;
  ratingCounts: Record<Rating, number>;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export type ReviewInput = {
  reviewId: string;
  senseId: string;
  rating: Rating;
  cardType: CardType;
  elapsedMs: number;
  /** Client timestamp, ISO 8601 UTC. The server trusts its own clock for `ts`. */
  clientTs?: string;
};

export type ReviewResult = {
  ok: boolean;
  state: SenseState;
  /** True when the write landed on disk; false when it was queued client-side. */
  persisted: boolean;
};

export type Settings = {
  dailyNewLimit: number;
  dailyReviewLimit: number;
  sessionLength: SessionLength;
  theme: "light" | "dark" | "system";
  playbackRate: number;
  slowPlaybackRate: number;
  autoPlayAudio: boolean;
  keepRecordings: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  dailyNewLimit: 30,
  dailyReviewLimit: 180,
  sessionLength: "full",
  theme: "system",
  playbackRate: 1,
  slowPlaybackRate: 0.7,
  autoPlayAudio: true,
  keepRecordings: false
};

// ---------------------------------------------------------------------------
// Legacy localStorage-only progress. Kept so the old client keeps compiling
// during the migration to SQLite; delete once nothing imports it.
// ---------------------------------------------------------------------------

export type RatingRecord = {
  rating: Rating;
  attempts: number;
  lastAnsweredAt: string;
};

export type StudyProgress = {
  deckIds: string[];
  currentIndex: number;
  answeredCount: number;
  ratings: Record<string, RatingRecord>;
};
