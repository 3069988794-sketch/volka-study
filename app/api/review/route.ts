import "server-only";
import { createInitialProgress, recordRating } from "@/lib/srs";
import { applyReviewTransaction, loadPersistedSenseStates } from "@/lib/db";
import { loadSenseData } from "@/lib/data";
import type { CardType, Rating, ReviewInput, ReviewResult } from "@/lib/types";

const RATINGS: readonly Rating[] = ["again", "hard", "good", "easy"];
const CARD_TYPES: readonly CardType[] = ["intro", "listen_choose", "shadow_ab", "blind_listen", "cloze", "reorder", "speak_hinted", "speak_free"];

export async function GET(): Promise<Response> {
  return Response.json({ states: loadPersistedSenseStates() });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as Partial<ReviewInput>;
    if (typeof body.reviewId !== "string" || !body.reviewId.trim()) return Response.json({ ok: false, state: null, persisted: false }, { status: 400 });
    if (typeof body.senseId !== "string" || !body.senseId.trim() || !RATINGS.includes(body.rating as Rating) || !CARD_TYPES.includes(body.cardType as CardType) || !Number.isFinite(body.elapsedMs) || Number(body.elapsedMs) < 0) {
      return Response.json({ ok: false, state: null, persisted: false }, { status: 400 });
    }
    const data = await loadSenseData();
    const sense = data.senses.find((item) => item.sense_id === body.senseId);
    if (!sense) return Response.json({ ok: false, state: null, persisted: false }, { status: 404 });
    const input = body as ReviewInput;
    const next = applyReviewTransaction(
      input.senseId,
      { sense_id: sense.sense_id, level: sense.level, priority: sense.priority, topic: sense.topic ?? "" },
      input.rating,
      (current) => recordRating(current, input.rating, input.elapsedMs / 1000),
      "default",
      input.reviewId,
      createInitialProgress
    );
    const result: ReviewResult = { ok: true, state: next, persisted: true };
    return Response.json(result);
  } catch (err) {
    return Response.json({ ok: false, state: null, persisted: false }, { status: 500 });
  }
}
