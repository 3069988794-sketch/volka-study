"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  enqueueFailedReview,
  saveStates,
  loadStates,
  ensureStudyStart,
  saveCursor,
  loadCursor,
  saveRated,
  loadRated,
  clearSessionProgress,
  drainReviewQueue,
} from "@/lib/storage";
import type { Rating, ReviewInput, ReviewResult, SenseState } from "@/lib/types";
import type { Sense } from "@/lib/types";
import { PlayButton } from "@/components/audio/play-button";
import { playOrSpeak } from "@/lib/audio";
import type { SenseAudio } from "@/lib/audio-index";
import { buildDueFirstDeck } from "@/lib/planner";

// ---- constants ----

const TOTAL_SECONDS = 60 * 60; // 60 minutes

const segments = [
  { label: "热身", minutes: 4,  tone: "var(--amber)", tip: "听单词发音，跟读 2-3 遍，感受节奏。不需要记，只是激活今天的状态。" },
  { label: "复习", minutes: 28, tone: "var(--accent)", tip: "回忆之前学过的词。看到词先在脑子里想，想不起来就听音频。诚实评分，'重来'不丢分。" },
  { label: "新学", minutes: 10, tone: "var(--blue)", tip: "今天的新词。仔细看例句，听发音，理解用法。第一次见是正常的，不强求记住。" },
  { label: "产出", minutes: 15, tone: "var(--rose)", tip: "用中文想象这个词的场景，试着说出英文例句。嘴上说出来比眼睛看强10倍。" },
  { label: "连读", minutes: 3,  tone: "var(--ink)", tip: "快速过今天所有词，跟读例句，感受连读节奏。收尾阶段，不评分，只感受。" },
];

// cumulative start seconds for each segment
const segmentStarts = segments.reduce<number[]>((acc, seg, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1]! + segments[i - 1]!.minutes * 60);
  return acc;
}, []);

function fmt(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Live session clock — ticks every second. Supports pause + scrub. */
function useSessionTimer() {
  const startRef = useRef<number>(Date.now());
  const pausedAtRef = useRef<number | null>(null);
  const offsetRef = useRef<number>(0); // accumulated paused seconds
  const [elapsed, setElapsed] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      if (pausedAtRef.current !== null) return;
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000) - offsetRef.current);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const pause = useCallback(() => {
    if (pausedAtRef.current === null) {
      pausedAtRef.current = Date.now();
      setIsPaused(true);
    }
  }, []);

  const resume = useCallback(() => {
    if (pausedAtRef.current !== null) {
      offsetRef.current += Math.floor((Date.now() - pausedAtRef.current) / 1000);
      pausedAtRef.current = null;
      setIsPaused(false);
    }
  }, []);

  const scrub = useCallback((secs: number) => {
    const clamped = Math.max(0, Math.min(secs, TOTAL_SECONDS));
    startRef.current = Date.now() - clamped * 1000;
    offsetRef.current = 0;
    pausedAtRef.current = null;
    setIsPaused(false);
    setElapsed(clamped);
  }, []);

  const clampedElapsed = Math.min(elapsed, TOTAL_SECONDS);
  const remaining = TOTAL_SECONDS - clampedElapsed;

  let activeIdx = segments.length - 1;
  for (let i = 0; i < segmentStarts.length; i++) {
    const next = segmentStarts[i + 1] ?? TOTAL_SECONDS;
    if (clampedElapsed < next) { activeIdx = i; break; }
  }

  const segElapsed = clampedElapsed - (segmentStarts[activeIdx] ?? 0);
  const segTotal = segments[activeIdx]!.minutes * 60;
  const segRemaining = segTotal - segElapsed;

  return { elapsed: clampedElapsed, remaining, activeIdx, segRemaining, segTotal, isPaused, pause, resume, scrub };
}

const ratingLabels: { value: Rating; label: string; hint: string; key: string }[] = [
  { value: "again", label: "重来", hint: "没想起", key: "1" },
  { value: "hard", label: "吃力", hint: "勉强过", key: "2" },
  { value: "good", label: "顺手", hint: "能说出", key: "3" },
  { value: "easy", label: "轻松", hint: "很自动", key: "4" },
];

type SessionShellProps = {
  senses: Sense[];
  notice: string | null;
  totalCount: number;
  completeCn: number;
  audioMap?: Record<string, SenseAudio>;
};

// Pick today's deck: A1 + T0 priority, max 30 cards
// POST one review to the server
async function postReview(input: ReviewInput): Promise<ReviewResult | null> {
  try {
    const res = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as ReviewResult;
  } catch {
    return null;
  }
}

export function SessionShell({ senses, notice, totalCount, completeCn, audioMap = {} }: SessionShellProps) {
  // Per-card FSRS state, keyed by sense_id
  const [states, setStates] = useState<Record<string, SenseState>>({});
  const deck = useMemo(() => buildDueFirstDeck(senses, states, 30), [senses, states]);
  const timer = useSessionTimer();

  // Start at 0 (matches SSR), then restore from localStorage after mount
  const [cursor, setCursor] = useState(0);
  const [ratedCount, setRatedCount] = useState(0);
  useEffect(() => {
    const savedStates = loadStates<SenseState>();
    if (Object.keys(savedStates).length > 0) setStates(savedStates);
    void fetch("/api/review")
      .then((res) => res.ok ? res.json() as Promise<{ states?: Record<string, SenseState> }> : null)
      .then((payload) => {
        if (!payload?.states || Object.keys(payload.states).length === 0) return;
        setStates(payload.states);
        saveStates(payload.states);
      })
      .catch(() => undefined);
    const savedCursor = loadCursor(deck.length);
    const savedRated = loadRated();
    if (savedCursor > 0) setCursor(savedCursor);
    if (savedRated > 0) setRatedCount(savedRated);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [showCn, setShowCn] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const cardStartRef = useRef<number>(Date.now());

  const current = deck[cursor] ?? null;
  const percent = deck.length > 0 ? Math.round((ratedCount / deck.length) * 100) : 0;
  const completePercent = totalCount > 0 ? Math.round((completeCn / totalCount) * 100) : 0;

  // Reset timer when card changes
  useEffect(() => {
    cardStartRef.current = Date.now();
    setShowCn(false);
  }, [cursor]);

  // Persist progress to localStorage
  useEffect(() => { saveCursor(cursor); }, [cursor]);
  useEffect(() => { saveRated(ratedCount); }, [ratedCount]);

  const restart = useCallback(() => {
    // Only reset the cursor — ratedCount stays so today's progress is preserved
    setCursor(0);
    saveCursor(0);
  }, []);

  const rateCurrent = useCallback(
    async (rating: Rating) => {
      if (!current) return;
      setHasInteracted(true);
      const elapsedMs = Date.now() - cardStartRef.current;
      const input: ReviewInput = {
        reviewId: `${current.sense_id}:${cursor}:${Date.now()}`,
        senseId: current.sense_id,
        rating,
        cardType: "intro",
        elapsedMs,
        clientTs: new Date().toISOString(),
      };
      const result = await postReview(input);
      if (!result?.ok) {
        enqueueFailedReview({
          reviewId: input.reviewId,
          senseId: input.senseId,
          rating: rating as string,
          cardType: input.cardType as string,
          elapsedMs: input.elapsedMs,
          clientTs: input.clientTs ?? new Date().toISOString(),
        });
      } else if (result.state) {
        setStates((prev) => {
          const next = { ...prev, [current.sense_id]: result.state! };
          saveStates(next);
          return next;
        });
      }
      ensureStudyStart();
      setRatedCount((n) => n + 1);
      setCursor((n) => Math.min(n + 1, deck.length));
    },
    [current, deck.length]
  );

  // Retry reviews captured while the server was unavailable.
  useEffect(() => {
    const queued = drainReviewQueue();
    if (queued.length === 0) return;
    void Promise.all(queued.map(async (item) => {
      const result = await postReview({ ...item, rating: item.rating as Rating, cardType: item.cardType as ReviewInput["cardType"] });
      if (!result?.ok) enqueueFailedReview(item);
    }));
  }, []);

  const nextCard = useCallback(() => {
    setHasInteracted(true);
    setCursor((n) => Math.min(n + 1, deck.length));
  }, [deck.length]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case "1": void rateCurrent("again"); break;
        case "2": void rateCurrent("hard"); break;
        case "3": void rateCurrent("good"); break;
        case "4": void rateCurrent("easy"); break;
        case "t": case "T": setShowCn((v) => !v); break;
        case "Enter": nextCard(); break;
        case " ":
          e.preventDefault();
          if (current) {
            void playOrSpeak(audioMap[current.sense_id]?.example, current.example_en ?? "");
          }
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rateCurrent, nextCard, current, audioMap]);

  return (
    <main className="mx-auto grid w-full max-w-7xl gap-5 px-4 pb-10 sm:px-6 lg:grid-cols-[360px_1fr] lg:px-8">
      {/* Left panel */}
      <section className="grid gap-5">
        <div className="rounded-sm border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-normal">今日概览</h1>
              <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                第 1 天 · 落地生存 · 目标 30 张
              </p>
            </div>
            <div className="min-w-20 rounded-sm border border-[var(--line)] bg-[var(--panel-strong)] px-3 py-2 text-right">
              <div className="text-2xl font-semibold">{percent}%</div>
              <div className="text-xs text-[var(--muted)]">今日进度</div>
            </div>
          </div>
          <div className="mt-5 h-2 rounded-sm bg-[color-mix(in_srgb,var(--line),transparent_35%)]">
            <div
              className="h-2 rounded-sm bg-[var(--accent)] transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
            <div className="rounded-sm bg-[var(--panel-strong)] p-3">
              <div className="font-semibold">{ratedCount}</div>
              <div className="text-[var(--muted)]">已评分</div>
            </div>
            <div className="rounded-sm bg-[var(--panel-strong)] p-3">
              <div className="font-semibold">{deck.length}</div>
              <div className="text-[var(--muted)]">今日卡片</div>
            </div>
            <div className="rounded-sm bg-[var(--panel-strong)] p-3">
              <div className="font-semibold">{completePercent}%</div>
              <div className="text-[var(--muted)]">中文覆盖</div>
            </div>
          </div>
          {notice ? (
            <div className="mt-4 rounded-sm border border-[color-mix(in_srgb,var(--amber),transparent_40%)] bg-[color-mix(in_srgb,var(--amber),transparent_88%)] px-3 py-2 text-sm text-[var(--ink)]">
              {notice}
            </div>
          ) : null}
        </div>

        <div className="rounded-sm border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
          {/* Total countdown */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">60 分钟流程</h2>
              <button
                type="button"
                onClick={timer.isPaused ? timer.resume : timer.pause}
                className="rounded-sm border border-[var(--line)] bg-[var(--panel-strong)] px-2 py-0.5 text-xs transition hover:border-[var(--accent)]"
              >
                {timer.isPaused ? "▶ 继续" : "⏸ 暂停"}
              </button>
            </div>
            <div className="text-right">
              <div
                className="font-mono text-2xl font-semibold tabular-nums"
                style={{ color: timer.remaining < 300 ? "var(--rose)" : "var(--ink)" }}
              >
                {fmt(timer.remaining)}
              </div>
              <div className="text-xs text-[var(--muted)]">剩余</div>
            </div>
          </div>

          {/* Overall progress bar + scrub */}
          <div className="mt-3 h-1.5 rounded-sm bg-[color-mix(in_srgb,var(--line),transparent_25%)]">
            <div
              className="h-1.5 rounded-sm bg-[var(--accent)] transition-all duration-1000"
              style={{ width: `${(timer.elapsed / TOTAL_SECONDS) * 100}%` }}
            />
          </div>
          <input
            type="range"
            min={0}
            max={TOTAL_SECONDS}
            value={timer.elapsed}
            onChange={(e) => timer.scrub(Number(e.target.value))}
            className="mt-1 w-full cursor-pointer accent-[var(--accent)]"
          />

          {/* Segment rows */}
          <div className="mt-2 grid gap-1">
            {segments.map((seg, i) => {
              const isActive = i === timer.activeIdx;
              const isDone = i < timer.activeIdx;
              const segSecs = seg.minutes * 60;
              const fillPct = isActive
                ? ((segSecs - timer.segRemaining) / segSecs) * 100
                : isDone ? 100 : 0;

              return (
                <div key={seg.label}>
                  <div
                    className={`grid grid-cols-[52px_1fr_52px] items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors ${
                      isActive ? "bg-[var(--panel-strong)]" : ""
                    }`}
                  >
                    <span className={`font-medium ${isDone ? "text-[var(--muted)]" : ""}`}>
                      {seg.label}
                    </span>
                    <span className="h-2 rounded-sm bg-[color-mix(in_srgb,var(--line),transparent_25%)]">
                      <span
                        className="block h-2 rounded-sm transition-all duration-1000"
                        style={{ width: `${fillPct}%`, background: seg.tone, opacity: isDone ? 0.4 : 1 }}
                      />
                    </span>
                    <span className="text-right text-xs text-[var(--muted)]">
                      {isActive ? fmt(timer.segRemaining) : `${seg.minutes}m`}
                    </span>
                  </div>
                  {isActive && (
                    <p className="mb-1 px-2 text-xs leading-5 text-[var(--muted)]">{seg.tip}</p>
                  )}
                </div>
              );
            })}
          </div>

          <p className="mt-3 text-xs text-[var(--muted)]">
            快捷键：1-4 评分 · T 中文 · Space 播放 · Enter 下一张
          </p>
        </div>
      </section>

      {/* Card panel */}
      <section className="min-h-[620px] rounded-sm border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)] sm:p-6">
        {current ? (
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-4">
              <div>
                <p className="text-sm text-[var(--muted)]">
                  {cursor + 1} / {deck.length} · {current.level}
                </p>
                <div className="mt-1 flex items-center gap-3">
                  <h2 className="text-4xl font-semibold tracking-normal sm:text-5xl">
                    {current.headword}
                  </h2>
                  <PlayButton
                    key={cursor}
                    size="lg"
                    hash={audioMap[current.sense_id]?.word}
                    text={current.headword}
                    autoPlay={hasInteracted}
                  />
                </div>
              </div>
              <div className="flex gap-2 text-sm">
                <span className="rounded-sm border border-[var(--line)] px-3 py-2">{current.pos || "—"}</span>
                <span className="rounded-sm border border-[var(--line)] px-3 py-2">{current.level}</span>
              </div>
            </div>

            <div className="grid flex-1 gap-4 py-5 lg:grid-cols-2">
              <InfoBlock
                title="中文释义"
                value={showCn ? (current.gloss_cn || "释义待补齐") : "按 T 显示中文"}
                strong
              />
              <InfoBlock
                title="音标 / 语块"
                value={[current.ipa && `/${current.ipa}/`, current.chunk].filter(Boolean).join(" · ") || "—"}
              />
              <ExampleBlock
                exampleEn={current.example_en || "Example is being prepared."}
                exampleHash={audioMap[current.sense_id]?.example}
                senses={senses}
                wide
              />
              <InfoBlock
                title="中文例句"
                value={showCn ? (current.example_cn || "例句待补齐") : "按 T 显示中文"}
                wide
              />
            </div>

            <div className="grid gap-3 border-t border-[var(--line)] pt-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {ratingLabels.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => void rateCurrent(item.value)}
                    className="h-16 rounded-sm border border-[var(--line)] bg-[var(--panel-strong)] px-3 text-left transition hover:-translate-y-0.5 hover:border-[var(--accent)]"
                  >
                    <span className="block text-base font-semibold">
                      [{item.key}] {item.label}
                    </span>
                    <span className="block text-xs text-[var(--muted)]">{item.hint}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={nextCard}
                className="h-12 rounded-sm bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--paper)] transition hover:opacity-90"
              >
                [Enter] 下一张
              </button>
            </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center text-center">
            <div>
              <div className="text-5xl">🎉</div>
              <p className="mt-4 text-xl font-semibold">今日 {deck.length} 张完成！</p>
              <p className="mt-2 text-[var(--muted)]">明天见。</p>
              <button
                type="button"
                onClick={restart}
                className="mt-6 h-12 rounded-sm bg-[var(--ink)] px-8 text-sm font-semibold text-[var(--paper)] transition hover:opacity-90"
              >
                再来一轮
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function InfoBlock({
  title,
  value,
  strong,
  wide,
}: {
  title: string;
  value: string;
  strong?: boolean;
  wide?: boolean;
}) {
  return (
    <div
      className={`rounded-sm border border-[var(--line)] bg-[var(--panel-strong)] p-4 ${wide ? "lg:col-span-2" : ""}`}
    >
      <div className="text-sm text-[var(--muted)]">{title}</div>
      <div className={`mt-2 min-h-14 leading-7 ${strong ? "text-xl font-semibold" : "text-base"}`}>
        {value}
      </div>
    </div>
  );
}

function ExampleBlock({
  exampleEn,
  exampleHash,
  senses,
  wide,
}: {
  exampleEn: string;
  exampleHash: string | undefined;
  senses: readonly Sense[];
  wide?: boolean;
}) {
  return (
    <div
      className={`rounded-sm border border-[var(--line)] bg-[var(--panel-strong)] p-4 ${wide ? "lg:col-span-2" : ""}`}
    >
      <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
        <span>英文例句</span>
        <PlayButton size="sm" hash={exampleHash} text={exampleEn} />
      </div>
      <div className="mt-2 min-h-14 text-base leading-7">
        <ClickableWords text={exampleEn} senses={senses} />
      </div>
    </div>
  );
}

function ClickableWords({
  text,
  senses,
}: {
  text: string;
  senses: readonly Sense[];
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  // Tokenize into word and non-word chunks
  const tokens = useMemo(() => {
    const parts: Array<{ text: string; isWord: boolean }> = [];
    const re = /[a-zA-Z']+|[^a-zA-Z']+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const t = m[0]!;
      parts.push({ text: t, isWord: /^[a-zA-Z]/.test(t) });
    }
    return parts;
  }, [text]);

  // First match per lowercased headword
  const senseMap = useMemo(() => {
    const m = new Map<string, Sense>();
    for (const s of senses) {
      const key = s.headword.toLowerCase();
      if (!m.has(key)) m.set(key, s as Sense);
    }
    return m;
  }, [senses]);

  return (
    <span>
      {tokens.map((token, i) => {
        if (!token.isWord) return <span key={i}>{token.text}</span>;
        const sense = senseMap.get(token.text.toLowerCase());
        if (!sense) return <span key={i}>{token.text}</span>;
        const isOpen = openIdx === i;
        return (
          <span key={i} className="relative inline-block">
            <button
              type="button"
              onClick={() => setOpenIdx(isOpen ? null : i)}
              className="cursor-pointer rounded-sm underline decoration-dotted underline-offset-2 transition hover:text-[var(--accent)]"
            >
              {token.text}
            </button>
            {isOpen && (
              <span className="absolute bottom-full left-1/2 z-10 mb-1.5 w-52 -translate-x-1/2 rounded-sm border border-[var(--line)] bg-[var(--panel)] p-2.5 text-xs shadow-[var(--shadow)]">
                <span className="block font-semibold">{sense.headword}</span>
                {sense.gloss_cn && (
                  <span className="mt-0.5 block text-[var(--muted)]">{sense.gloss_cn}</span>
                )}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
