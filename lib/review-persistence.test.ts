import { afterEach, describe, expect, it } from "vitest";
import { closeDb, loadSenseProgress, loadReviewHistory, loadPersistedSenseState, persistReview } from "./db";
import { createInitialProgress, recordRating } from "./srs";

describe("review persistence", () => {
  afterEach(() => closeDb());

  it("writes the latest FSRS state and review log to SQLite", () => {
    const previous = createInitialProgress("sense-1");
    const next = recordRating(previous, "good", 3);

    persistReview("sense-1", { sense_id: "sense-1", level: "A1", priority: "T0", topic: "daily" }, previous, next, "good");

    const progress = loadSenseProgress("default").get("sense-1");
    const history = loadReviewHistory("default");
    expect(progress?.state).toBe(next.state);
    expect(progress?.nextReview).toBe(next.due);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]?.rating).toBe("good");
  });

  it("stores single-user sense state independently of a session", () => {
    const previous = createInitialProgress("sense-independent");
    const next = recordRating(previous, "good", 3);

    persistReview("sense-independent", { sense_id: "sense-independent", level: "A2", priority: "T1", topic: "work" }, previous, next, "good", "session-a");

    expect(loadPersistedSenseState("sense-independent", "session-b")?.sense_id).toBe("sense-independent");
  });

  it("does not duplicate a review with the same idempotency key", () => {
    const senseId = `sense-idempotent-${Date.now()}`;
    const key = `review-${Date.now()}`;
    const previous = createInitialProgress(senseId);
    const next = recordRating(previous, "good", 3);
    const args = [senseId, { sense_id: senseId, level: "A1", priority: "T0", topic: "daily" }, previous, next, "good" as const, "default", key] as const;

    const before = loadReviewHistory("default").filter((row) => row.sense_id === senseId).length;
    persistReview(...args);
    persistReview(...args);

    expect(loadReviewHistory("default").filter((row) => row.sense_id === senseId)).toHaveLength(before + 1);
  });
});
