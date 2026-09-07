import type { Sense, SenseState, SessionCard } from "./types";
import { cardTypeForRound, createInitialProgress } from "./srs";

export function buildDueFirstDeck(
  senses: readonly Sense[],
  states: Record<string, SenseState>,
  limit = 30,
  now = new Date()
): Sense[] {
  return [...senses]
    .filter((sense) => {
      const state = states[sense.sense_id];
      return !state || new Date(state.due).getTime() <= now.getTime();
    })
    .sort((a, b) => {
      const sa = states[a.sense_id];
      const sb = states[b.sense_id];
      const dueA = sa ? new Date(sa.due).getTime() : Number.POSITIVE_INFINITY;
      const dueB = sb ? new Date(sb.due).getTime() : Number.POSITIVE_INFINITY;
      if (dueA !== dueB) return dueA - dueB;
      if (!sa && sb) return 1;
      if (sa && !sb) return -1;
      return a.sense_id.localeCompare(b.sense_id);
    })
    .slice(0, Math.max(0, limit));
}

export function cardsForDeck(senses: readonly Sense[], states: Record<string, SenseState>): SessionCard[] {
  return senses.map((sense) => {
    const state = states[sense.sense_id] ?? createInitialProgress(sense.sense_id);
    return { senseId: sense.sense_id, cardType: cardTypeForRound(state.round), segment: state.state === "new" ? "new" : "review", round: state.round + 1 };
  });
}

export function dailySessionId(date = new Date()): string {
  return `daily:${date.toISOString().slice(0, 10)}`;
}
