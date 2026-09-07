/**
 * Learner progress persistence — `node:sqlite` + versioned migrations + daily backup.
 *
 * The single source of truth for progress is `data/progress.db` on disk
 * (PLAN.md §3.4). Single user, single writer, synchronous API on purpose.
 *
 * Set `VOLKA_DB_PATH` to point at another file (tests do this).
 */
import "server-only";

import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CARD_TYPE_BY_ROUND,
  DEFAULT_SETTINGS,
  type CardType,
  type Rating,
  type ReviewLogEntry,
  type SegmentProgress,
  type SenseState,
  type SessionSummary,
  type Settings,
  type SrsState
} from "@/lib/types";

type Row = Record<string, unknown>;

/** A `session` row: server-side session data persisted to SQLite. */
export type SessionRecord = {
  id: string;
  startedAt: string;
  plannedMin: number;
  segmentsDone: SegmentProgress[];
  settings: Settings;
  summary: SessionSummary;
};

/** Denormalised sense fields, so stats stay one SQL query (see `syncSenseMeta`). */
export type SenseMetaInput = {
  sense_id: string;
  level: string;
  priority: string;
  topic: string;
};

const BACKUP_KEEP = 30;
const META_LAST_BACKUP = "_meta.lastBackupDate";
const RATINGS: readonly Rating[] = ["again", "hard", "good", "easy"];
const SRS_STATES: readonly SrsState[] = ["new", "learning", "review", "relearning"];
/** Keep IN (...) lists well under SQLite's bound-parameter ceiling. */
const CHUNK = 400;

// @@TAIL@@

const DB_PATH = process.env.VOLKA_DB_PATH ?? path.join(process.cwd(), "data", "progress.db");

let db: DatabaseSync | null = null;

/** Lazily open and migrate the database. */
function getDb(): DatabaseSync {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  // --- schema version 1 ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session (
      id            TEXT PRIMARY KEY,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      started_at    TEXT NOT NULL,
      segments_done INTEGER NOT NULL DEFAULT 0,
      planned_min   INTEGER NOT NULL,
      segments_json TEXT NOT NULL,
      summary_json  TEXT NOT NULL,
      settings_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sense_progress (
      session_id TEXT REFERENCES session(id),
      sense_id   TEXT NOT NULL,
      state      TEXT NOT NULL CHECK(state IN ('new','learning','review','relearning')),
      level      TEXT NOT NULL,
      priority   TEXT NOT NULL,
      topic      TEXT NOT NULL,
      next_review TEXT,
      ease       REAL NOT NULL DEFAULT 2.5,
      interval   INTEGER NOT NULL DEFAULT 0,
      repetitions INTEGER NOT NULL DEFAULT 0,
      elapsed    REAL NOT NULL DEFAULT 0,
      lapses     INTEGER NOT NULL DEFAULT 0,
      srs_json   TEXT,
      PRIMARY KEY(session_id, sense_id)
    );
    CREATE TABLE IF NOT EXISTS sense_state (
      sense_id    TEXT PRIMARY KEY,
      state       TEXT NOT NULL CHECK(state IN ('new','learning','review','relearning')),
      level       TEXT NOT NULL,
      priority    TEXT NOT NULL,
      topic       TEXT NOT NULL,
      next_review TEXT,
      ease        REAL NOT NULL DEFAULT 2.5,
      interval    INTEGER NOT NULL DEFAULT 0,
      repetitions INTEGER NOT NULL DEFAULT 0,
      elapsed     REAL NOT NULL DEFAULT 0,
      lapses      INTEGER NOT NULL DEFAULT 0,
      srs_json    TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES session(id),
      sense_id   TEXT NOT NULL,
      rating     TEXT NOT NULL CHECK(rating IN ('again','hard','good','easy')),
      prev_state TEXT NOT NULL,
      new_state  TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS ix_review_log_session ON review_log(session_id);
    CREATE INDEX IF NOT EXISTS ix_review_log_sense ON review_log(sense_id);
  `);
  try { db.exec("ALTER TABLE sense_progress ADD COLUMN srs_json TEXT"); } catch { /* already migrated */ }
  try { db.exec("ALTER TABLE review_log ADD COLUMN idempotency_key TEXT"); } catch { /* already migrated */ }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_review_log_idempotency ON review_log(idempotency_key) WHERE idempotency_key IS NOT NULL");

  // Keep a recoverable snapshot before the first write of each calendar day.
  rotateBackup();

  return db;
}

// --- helpers ---

function nowISO(): string {
  return new Date().toISOString();
}

function serialize(v: unknown): string {
  return JSON.stringify(v);
}

function deserialize<T>(raw: unknown, fallback: T): T {
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as T; } catch { /* fall through */ }
  }
  return fallback;
}

// --- public API ---

/** Save or update a session. */
export function saveSession(session: SessionRecord): void {
  const conn = getDb();
  conn.prepare(
    `INSERT INTO session (id, created_at, started_at, segments_done, planned_min, segments_json, summary_json, settings_json)
     VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       segments_done = excluded.segments_done,
       segments_json = excluded.segments_json,
       summary_json  = excluded.summary_json,
       settings_json = excluded.settings_json,
       started_at    = excluded.started_at
    `
  ).run(
    session.id,
    session.startedAt,
    session.segmentsDone.length,
    session.plannedMin,
    serialize(session.segmentsDone),
    serialize(session.summary),
    serialize(session.settings)
  );
}

/** Load a session by id, or undefined. */
export function loadSession(id: string): SessionRecord | undefined {
  const conn = getDb();
  const row = conn
    .prepare("SELECT * FROM session WHERE id = ?")
    .get(id) as Row | undefined;
  if (!row) return undefined;
  const emptySummary: SessionSummary = {
    date: "", dayNo: 0, actualMinutes: 0, cardsDone: 0,
    newLearned: 0, reviewed: 0, accuracy: 0,
    ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 },
  };
  return {
    id: row.id as string,
    startedAt: row.started_at as string,
    summary: deserialize<SessionSummary>(row.summary_json, emptySummary),
    settings: deserialize<Settings>(row.settings_json, DEFAULT_SETTINGS),
    plannedMin: Number(row.planned_min) || 60,
    segmentsDone: deserialize<SegmentProgress[]>(row.segments_json, []),
  };
}

/** Delete a session (used after session completion). */
export function deleteSession(id: string): void {
  const conn = getDb();
  conn.prepare("DELETE FROM session WHERE id = ?").run(id);
  conn.prepare("DELETE FROM sense_progress WHERE session_id = ?").run(id);
  conn.prepare("DELETE FROM review_log WHERE session_id = ?").run(id);
}

/** List recent session ids (most recent first). */
export function listSessions(limit = 50): string[] {
  const conn = getDb();
  const rows = conn
    .prepare("SELECT id FROM session ORDER BY created_at DESC LIMIT ?")
    .all(limit) as { id: string }[];
  return rows.map(r => r.id);
}

export function loadSettings(): Settings {
  const row = getDb().prepare("SELECT settings_json FROM session WHERE id = ?").get("default") as Row | undefined;
  return deserialize<Settings>(row?.settings_json, DEFAULT_SETTINGS);
}

export function saveSettings(settings: Settings): void {
  ensureDefaultSession();
  getDb().prepare("UPDATE session SET settings_json = ? WHERE id = 'default'").run(serialize(settings));
}

export function exportProgress(): { settings: Settings; states: Record<string, SenseState>; reviews: DbReviewRow[] } {
  return { settings: loadSettings(), states: loadPersistedSenseStates(), reviews: loadReviewHistory("default", 100000) };
}

// --- sense-level progress ---

export function upsertSenseProgress(
  sessionId: string,
  senseId: string,
  meta: SenseMetaInput,
  srs: SrsState,
  ease: number,
  interval: number,
  repetitions: number,
  elapsed: number,
  lapses: number,
  nextReview: string | null
): void {
  const conn = getDb();
  conn.prepare(
    `INSERT INTO sense_progress
     (session_id, sense_id, state, level, priority, topic, next_review, ease, interval, repetitions, elapsed, lapses)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, sense_id) DO UPDATE SET
       state       = excluded.state,
       level       = excluded.level,
       priority    = excluded.priority,
       topic       = excluded.topic,
       next_review = excluded.next_review,
       ease        = excluded.ease,
       interval    = excluded.interval,
       repetitions = excluded.repetitions,
       elapsed     = excluded.elapsed,
       lapses      = excluded.lapses
    `
  ).run(
    sessionId, senseId, srs, meta.level, meta.priority, meta.topic,
    nextReview, ease, interval, repetitions, elapsed, lapses
  );
}

/** Bulk upsert (batched for speed). */
export function bulkUpsertSenseProgress(
  sessionId: string,
  entries: Array<{
    senseId: string;
    meta: SenseMetaInput;
    srs: SrsState;
    ease: number;
    interval: number;
    repetitions: number;
    elapsed: number;
    lapses: number;
    nextReview: string | null;
  }>
): void {
  const conn = getDb();
  const stmt = conn.prepare(
    `INSERT INTO sense_progress
     (session_id, sense_id, state, level, priority, topic, next_review, ease, interval, repetitions, elapsed, lapses)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, sense_id) DO UPDATE SET
       state       = excluded.state,
       level       = excluded.level,
       priority    = excluded.priority,
       topic       = excluded.topic,
       next_review = excluded.next_review,
       ease        = excluded.ease,
       interval    = excluded.interval,
       repetitions = excluded.repetitions,
       elapsed     = excluded.elapsed,
       lapses      = excluded.lapses
    `
  );

  for (let i = 0; i < entries.length; i += CHUNK) {
    const batch = entries.slice(i, i + CHUNK);
    const values = batch.flatMap(e => [
      sessionId, e.senseId, e.srs, e.meta.level, e.meta.priority, e.meta.topic,
      e.nextReview, e.ease, e.interval, e.repetitions, e.elapsed, e.lapses
    ]);
    stmt.run(...values);
  }
}

/** Get all sense progress for a session. */
export function loadSenseProgress(sessionId: string): Map<string, {
  state: SrsState;
  level: string;
  priority: string;
  topic: string;
  ease: number;
  interval: number;
  repetitions: number;
  elapsed: number;
  lapses: number;
  nextReview: string | null;
}> {
  const conn = getDb();
  const rows = conn
    .prepare("SELECT * FROM sense_progress WHERE session_id = ?")
    .all(sessionId) as Row[];
  const map = new Map<string, {
    state: SrsState; level: string; priority: string; topic: string;
    ease: number; interval: number; repetitions: number; elapsed: number;
    lapses: number; nextReview: string | null;
  }>();
  for (const r of rows) {
    map.set(r.sense_id as string, {
      state: r.state as SrsState,
      level: r.level as string,
      priority: r.priority as string,
      topic: r.topic as string,
      ease: Number(r.ease),
      interval: Number(r.interval),
      repetitions: Number(r.repetitions),
      elapsed: Number(r.elapsed),
      lapses: Number(r.lapses),
      nextReview: r.next_review as string | null,
    });
  }
  return map;
}

function ensureDefaultSession(): void {
  const conn = getDb();
  conn.prepare(
    `INSERT INTO session (id, started_at, planned_min, segments_json, summary_json, settings_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(
    "default",
    nowISO(),
    60,
    "[]",
    serialize({ date: "", dayNo: 0, actualMinutes: 0, cardsDone: 0, newLearned: 0, reviewed: 0, accuracy: 0, ratingCounts: { again: 0, hard: 0, good: 0, easy: 0 } }),
    serialize(DEFAULT_SETTINGS)
  );
}

function ensureSession(sessionId: string): void {
  if (sessionId === "default") {
    ensureDefaultSession();
    return;
  }
  getDb().prepare(
    `INSERT INTO session (id, started_at, planned_min, segments_json, summary_json, settings_json)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
  ).run(sessionId, nowISO(), 60, "[]", serialize({}), serialize(DEFAULT_SETTINGS));
}

/** Persist one review and its resulting FSRS state for the single local learner. */
export function persistReview(
  senseId: string,
  meta: SenseMetaInput,
  previous: SenseState,
  next: SenseState,
  rating: Rating,
  sessionId = "default",
  idempotencyKey = `${senseId}:${next.last_review ?? next.due}:${rating}`
): void {
  ensureSession(sessionId);
  const conn = getDb();
  conn.exec("BEGIN IMMEDIATE");
  try {
    conn.prepare(
      `INSERT INTO sense_state
       (sense_id, state, level, priority, topic, next_review, ease, interval, repetitions, elapsed, lapses, srs_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sense_id) DO UPDATE SET
         state = excluded.state, level = excluded.level, priority = excluded.priority,
         topic = excluded.topic, next_review = excluded.next_review, ease = excluded.ease,
         interval = excluded.interval, repetitions = excluded.repetitions, elapsed = excluded.elapsed,
         lapses = excluded.lapses, srs_json = excluded.srs_json, updated_at = excluded.updated_at`
    ).run(
      senseId, next.state, meta.level, meta.priority, meta.topic, next.due,
      next.difficulty, Math.round(next.stability), next.reps, 0, next.lapses,
      serialize(next), nowISO()
    );
    conn.prepare(
      `INSERT INTO sense_progress
       (session_id, sense_id, state, level, priority, topic, next_review, ease, interval, repetitions, elapsed, lapses, srs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, sense_id) DO UPDATE SET
         state=excluded.state, level=excluded.level, priority=excluded.priority, topic=excluded.topic,
         next_review=excluded.next_review, ease=excluded.ease, interval=excluded.interval,
         repetitions=excluded.repetitions, elapsed=excluded.elapsed, lapses=excluded.lapses, srs_json=excluded.srs_json`
    ).run(sessionId, senseId, next.state, meta.level, meta.priority, meta.topic, next.due,
      next.difficulty, Math.round(next.stability), next.reps, 0, next.lapses, serialize(next));
    conn.prepare(
      `INSERT OR IGNORE INTO review_log (session_id, sense_id, rating, prev_state, new_state, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sessionId, senseId, rating, previous.state, next.state, idempotencyKey);
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Atomically read the current single-user state, compute its successor, and
 * persist both the state and review log. The callback runs while the write
 * transaction is open, so callers cannot accidentally compute from stale data.
 */
export function applyReviewTransaction(
  senseId: string,
  meta: SenseMetaInput,
  rating: Rating,
  computeNext: (current: SenseState) => SenseState,
  sessionId = "default",
  idempotencyKey = `${senseId}:${rating}:${Date.now()}`,
  createInitial: (senseId: string) => SenseState
): SenseState {
  ensureSession(sessionId);
  const conn = getDb();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const duplicate = conn.prepare("SELECT 1 FROM review_log WHERE idempotency_key = ?").get(idempotencyKey);
    if (duplicate) {
      const row = conn.prepare("SELECT srs_json FROM sense_state WHERE sense_id = ?").get(senseId) as Row | undefined;
      const state = row?.srs_json ? deserialize<SenseState>(row.srs_json, createInitial(senseId)) : createInitial(senseId);
      conn.exec("COMMIT");
      return state;
    }
    const existing = conn.prepare("SELECT srs_json FROM sense_state WHERE sense_id = ?").get(senseId) as Row | undefined;
    const current = existing?.srs_json
      ? deserialize<SenseState>(existing.srs_json, createInitial(senseId))
      : createInitial(senseId);
    const next = computeNext(current);
    conn.prepare(
      `INSERT INTO sense_state
       (sense_id, state, level, priority, topic, next_review, ease, interval, repetitions, elapsed, lapses, srs_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sense_id) DO UPDATE SET state=excluded.state, level=excluded.level,
       priority=excluded.priority, topic=excluded.topic, next_review=excluded.next_review,
       ease=excluded.ease, interval=excluded.interval, repetitions=excluded.repetitions,
       elapsed=excluded.elapsed, lapses=excluded.lapses, srs_json=excluded.srs_json,
       updated_at=excluded.updated_at`
    ).run(senseId, next.state, meta.level, meta.priority, meta.topic, next.due,
      next.difficulty, Math.round(next.stability), next.reps, 0, next.lapses, serialize(next), nowISO());
    conn.prepare(
      `INSERT INTO sense_progress
       (session_id, sense_id, state, level, priority, topic, next_review, ease, interval, repetitions, elapsed, lapses, srs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, sense_id) DO UPDATE SET state=excluded.state,
       level=excluded.level, priority=excluded.priority, topic=excluded.topic,
       next_review=excluded.next_review, ease=excluded.ease, interval=excluded.interval,
       repetitions=excluded.repetitions, elapsed=excluded.elapsed, lapses=excluded.lapses,
       srs_json=excluded.srs_json`
    ).run(sessionId, senseId, next.state, meta.level, meta.priority, meta.topic, next.due,
      next.difficulty, Math.round(next.stability), next.reps, 0, next.lapses, serialize(next));
    conn.prepare(`INSERT OR IGNORE INTO review_log (session_id, sense_id, rating, prev_state, new_state, idempotency_key) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, senseId, rating, current.state, next.state, idempotencyKey);
    conn.exec("COMMIT");
    return next;
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}

export function loadPersistedSenseState(senseId: string, sessionId = "default"): SenseState | undefined {
  ensureDefaultSession();
  const row = getDb().prepare("SELECT srs_json FROM sense_state WHERE sense_id = ?")
    .get(senseId) as Row | undefined;
  if (!row) {
    const legacy = getDb().prepare("SELECT srs_json FROM sense_progress WHERE session_id = ? AND sense_id = ?")
      .get(sessionId, senseId) as Row | undefined;
    return legacy?.srs_json ? deserialize<SenseState>(legacy.srs_json, undefined as unknown as SenseState) : undefined;
  }
  return row?.srs_json ? deserialize<SenseState>(row.srs_json, undefined as unknown as SenseState) : undefined;
}

export function loadPersistedSenseStates(sessionId = "default"): Record<string, SenseState> {
  ensureDefaultSession();
  const rows = getDb().prepare("SELECT sense_id, srs_json FROM sense_state WHERE srs_json IS NOT NULL")
    .all() as Row[];
  const states: Record<string, SenseState> = {};
  for (const row of rows) {
    if (typeof row.srs_json === "string") {
      states[String(row.sense_id)] = JSON.parse(row.srs_json) as SenseState;
    }
  }
  return states;
}

// --- review log ---

export function logRating(
  sessionId: string,
  senseId: string,
  rating: Rating,
  prevState: SrsState,
  newState: SrsState
): void {
  const conn = getDb();
  conn.prepare(
    "INSERT INTO review_log (session_id, sense_id, rating, prev_state, new_state) VALUES (?, ?, ?, ?, ?)"
  ).run(sessionId, senseId, rating, prevState, newState);
}

export type DbReviewRow = {
  sense_id: string;
  rating: Rating;
  prev_state: SrsState;
  new_state: SrsState;
  timestamp: string;
};

export function loadReviewHistory(sessionId: string, limit = 100): DbReviewRow[] {
  const conn = getDb();
  const rows = conn
    .prepare("SELECT * FROM review_log WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?")
    .all(sessionId, limit) as Row[];
  return rows.map(r => ({
    sense_id: r.sense_id as string,
    rating: r.rating as Rating,
    prev_state: r.prev_state as SrsState,
    new_state: r.new_state as SrsState,
    timestamp: r.timestamp as string,
  }));
}

// --- statistics ---

export function getStats(sessionId: string): {
  total: number;
  new: number;
  learning: number;
  review: number;
  relearning: number;
  learned: number;
} {
  const conn = getDb();
  const rows = conn
    .prepare("SELECT state, COUNT(*) as cnt FROM sense_progress WHERE session_id = ? GROUP BY state")
    .all(sessionId) as { state: string; cnt: number }[];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.state] = r.cnt;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    total,
    new: counts.new || 0,
    learning: counts.learning || 0,
    review: counts.review || 0,
    relearning: counts.relearning || 0,
    learned: counts.review || 0, // review state = learned
  };
}

export function getGlobalStats() {
  const conn = getDb();
  const rows = conn.prepare("SELECT state, COUNT(*) as cnt FROM sense_state GROUP BY state").all() as { state: string; cnt: number }[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.state] = Number(row.cnt);
  const due = conn.prepare("SELECT COUNT(*) as cnt FROM sense_state WHERE next_review IS NOT NULL AND next_review <= ?").get(nowISO()) as Row;
  const levelRows = conn.prepare("SELECT level, COUNT(*) as cnt FROM sense_state WHERE state = 'review' GROUP BY level").all() as { level: string; cnt: number }[];
  const byLevel: Record<string, number> = {};
  for (const row of levelRows) byLevel[row.level] = Number(row.cnt);
  return { total: Object.values(counts).reduce((a, b) => a + b, 0), new: counts.new ?? 0, learning: counts.learning ?? 0, review: counts.review ?? 0, relearning: counts.relearning ?? 0, learned: counts.review ?? 0, dueToday: Number(due.cnt) || 0, byLevel };
}

// --- backup ---

export function rotateBackup(): void {
  if (!existsSync(DB_PATH)) return;

  const metaDir = path.dirname(DB_PATH);
  const backupDir = path.join(metaDir, "backups");
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

  const now = new Date().toISOString().slice(0, 10);
  const last = getMeta(META_LAST_BACKUP);
  if (last === now) return; // already backed up today

  const backupName = `progress_${now}.db`;
  copyFileSync(DB_PATH, path.join(backupDir, backupName));
  setMeta(META_LAST_BACKUP, now);

  // Prune old backups
  const files = readdirSync(backupDir).sort().reverse();
  for (const f of files.slice(BACKUP_KEEP)) {
    unlinkSync(path.join(backupDir, f));
  }
}

// --- meta ---

function setMeta(key: string, value: string): void {
  const conn = getDb();
  conn.prepare("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function getMeta(key: string): string | undefined {
  const conn = getDb();
  const row = conn.prepare("SELECT value FROM _meta WHERE key = ?").get(key) as Row | undefined;
  return row?.value as string | undefined;
}

// --- shutdown ---

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Graceful shutdown on process exit
process.on("exit", closeDb);
process.on("SIGINT", () => { closeDb(); process.exit(0); });
process.on("SIGTERM", () => { closeDb(); process.exit(0); });
