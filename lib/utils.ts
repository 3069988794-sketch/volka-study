import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { SegmentSpec, SessionLength } from "@/lib/types";

/* -------------------------------------------------------------------------
 * Class names
 * ---------------------------------------------------------------------- */

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/* -------------------------------------------------------------------------
 * Formatting
 * ---------------------------------------------------------------------- */

const integerFormat = new Intl.NumberFormat("zh-CN");

export function formatInt(value: number): string {
  return integerFormat.format(Math.round(value));
}

export function percent(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

/* -------------------------------------------------------------------------
 * Curriculum constants (PLAN §2.1–§2.3, §6.3).
 * Presentation-only copies of the plan's numbers so the map / today / ability
 * pages can render before lib/planner.ts exists.
 * ---------------------------------------------------------------------- */

export const TOTAL_SENSES = 7223;
export const TOTAL_DAYS = 241;
export const DAILY_NEW_TARGET = 30;

export type CurriculumStage = {
  no: 1 | 2 | 3 | 4;
  name: string;
  levelLabel: string;
  senses: number;
  days: number;
  startDay: number;
  endDay: number;
  outcome: string;
  /** Chart token used as this stage's accent. */
  tone: string;
};

export const STAGES: readonly CurriculumStage[] = [
  {
    no: 1,
    name: "落地生存",
    levelLabel: "A1",
    senses: 1487,
    days: 50,
    startDay: 1,
    endDay: 50,
    outcome: "问路、点餐、购物、说清时间数字金钱、礼貌应对陌生人",
    tone: "var(--chart-4)"
  },
  {
    no: 2,
    name: "日常自理",
    levelLabel: "A2",
    senses: 1841,
    days: 61,
    startDay: 51,
    endDay: 111,
    outcome: "看病、租房、办手机卡、和邻居同事闲聊、描述感受和经历",
    tone: "var(--chart-5)"
  },
  {
    no: 3,
    name: "工作胜任",
    levelLabel: "B1",
    senses: 1981,
    days: 66,
    startDay: 112,
    endDay: 177,
    outcome: "开会发言、写邮件、解释方案、电话沟通、处理工作分歧",
    tone: "var(--chart-6)"
  },
  {
    no: 4,
    name: "自然交流",
    levelLabel: "B2+",
    senses: 1914,
    days: 64,
    startDay: 178,
    endDay: 241,
    outcome: "讨论抽象话题、表达细微态度、听懂玩笑和话外之意",
    tone: "var(--chart-7)"
  }
] as const;

/** PLAN §2.2 — the book's own level counts. C1/C2 are folded into stage 4. */
export const CEFR_SPLIT: readonly { level: string; senses: number; tone: string }[] = [
  { level: "A1", senses: 1487, tone: "var(--chart-4)" },
  { level: "A2", senses: 1841, tone: "var(--chart-5)" },
  { level: "B1", senses: 1981, tone: "var(--chart-6)" },
  { level: "B2", senses: 1903, tone: "var(--chart-7)" },
  { level: "C1", senses: 3, tone: "var(--chart-8)" },
  { level: "C2", senses: 8, tone: "var(--chart-1)" }
] as const;

export const SEGMENTS: readonly SegmentSpec[] = [
  { kind: "warmup", label: "热身跟读", minutes: 4, tone: "var(--amber)", hint: "昨天学的 10 句，不评分" },
  { kind: "review", label: "到期复习", minutes: 28, tone: "var(--accent)", hint: "FSRS 排期，题型按轮次轮换" },
  { kind: "new", label: "新学", minutes: 10, tone: "var(--blue)", hint: "30 个新义项" },
  { kind: "produce", label: "产出口述", minutes: 15, tone: "var(--rose)", hint: "看中文说英文 + 录音对比" },
  { kind: "chain", label: "场景连读", minutes: 3, tone: "var(--ink)", hint: "今日义项串成一段对话" }
] as const;

export type SessionLengthOption = {
  value: SessionLength;
  minutes: number;
  label: string;
  hint: string;
};

/** PLAN §6.3 — the escape hatches that keep a bad day from breaking the streak. */
export const SESSION_LENGTHS: readonly SessionLengthOption[] = [
  { value: "full", minutes: 60, label: "完整", hint: "标准五段流程" },
  { value: "short", minutes: 20, label: "精简", hint: "只做最紧急的到期复习" },
  { value: "minimal", minutes: 5, label: "保底", hint: "跟读 10 句，保住连续天数" }
] as const;

export function stageForDay(dayNo: number): CurriculumStage | null {
  if (!Number.isFinite(dayNo) || dayNo < 1) {
    return null;
  }

  return STAGES.find((stage) => dayNo >= stage.startDay && dayNo <= stage.endDay) ?? null;
}

export const TOPIC_TONES = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)"
] as const;

export function toneForIndex(index: number): string {
  return TOPIC_TONES[index % TOPIC_TONES.length] as string;
}
