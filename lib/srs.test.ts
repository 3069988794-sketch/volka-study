import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createInitialProgress, recordRating, cardTypeForRound, getProgressPercent } from "./srs";

describe("SRS engine", () => {
  it("creates initial state for a new sense", () => {
    const s = createInitialProgress("s1");
    expect(s.sense_id).toBe("s1");
    expect(s.state).toBe("new");
    expect(s.reps).toBe(0);
    expect(s.round).toBe(0);
    expect(s.last_review).toBeNull();
  });

  it("advances state after a good rating", () => {
    const s = createInitialProgress("s1");
    const next = recordRating(s, "good", 5);
    expect(next.sense_id).toBe("s1");
    expect(next.reps).toBeGreaterThan(0);
    expect(next.round).toBe(1);
    expect(next.last_review).not.toBeNull();
  });

  it("does not increment round on 'again'", () => {
    const s = createInitialProgress("s1");
    const next = recordRating(s, "again", 2);
    expect(next.round).toBe(0);
  });

  it("increments lapses on 'again' in review state", () => {
    const s = { ...createInitialProgress("s1"), state: "review" as const, reps: 5 };
    const next = recordRating(s, "again", 2);
    expect(next.lapses).toBe(s.lapses + 1);
  });

  it("cardTypeForRound returns correct types", () => {
    expect(cardTypeForRound(0)).toBe("intro");
    expect(cardTypeForRound(1)).toBe("intro");
    expect(cardTypeForRound(2)).toBe("listen_choose");
  });

  it("getProgressPercent handles zero total", () => {
    expect(getProgressPercent(0, 0)).toBe(0);
    expect(getProgressPercent(10, 5)).toBe(50);
  });
});
