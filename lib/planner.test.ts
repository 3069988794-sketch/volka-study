import { describe, expect, it } from "vitest";
import { buildDueFirstDeck, dailySessionId } from "./planner";
import { createInitialProgress } from "./srs";
import type { Sense } from "./types";

const sense = (id: string): Sense => ({ sense_id: id, headword: id, pos: "n", level: "A1", gloss_en: "", gloss_cn: "", example_en: "", example_cn: "", ipa: "", chunk: "", priority: "T0" });

describe("session planner", () => {
  it("puts due cards before unseen cards", () => {
    const due = { ...createInitialProgress("due"), due: "2020-01-01T00:00:00.000Z" };
    const deck = buildDueFirstDeck([sense("new"), sense("due")], { due });
    expect(deck.map((item) => item.sense_id)).toEqual(["due", "new"]);
  });

  it("derives a stable daily session id", () => {
    expect(dailySessionId(new Date("2026-09-07T12:00:00Z"))).toBe("daily:2026-09-07");
  });
});
