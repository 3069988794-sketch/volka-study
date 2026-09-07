"use client";

import { useEffect, useState } from "react";
import { TopNav } from "@/components/top-nav";
import { getDayNo } from "@/lib/storage";

const stages = [
  {
    level: "A1",
    label: "落地生存",
    days: "第 1 – 50 天",
    range: [1, 50],
    words: 1500,
    desc: "基础高频词、打招呼、问路、点餐、数字时间。",
    tone: "var(--accent)",
  },
  {
    level: "A2",
    label: "日常交流",
    days: "第 51 – 111 天",
    range: [51, 111],
    words: 1800,
    desc: "购物、出行、家庭、工作入门。",
    tone: "var(--blue)",
  },
  {
    level: "B1",
    label: "职场衔接",
    days: "第 112 – 177 天",
    range: [112, 177],
    words: 2100,
    desc: "会议、报告、观点表达、新闻阅读。",
    tone: "var(--rose)",
  },
  {
    level: "B2",
    label: "流利表达",
    days: "第 178 – 241 天",
    range: [178, 241],
    words: 1823,
    desc: "抽象概念、学术、专业讨论、细腻情感。",
    tone: "var(--amber)",
  },
];

const segments = [
  { label: "热身", minutes: 4, tone: "var(--amber)" },
  { label: "复习", minutes: 28, tone: "var(--accent)" },
  { label: "新学", minutes: 10, tone: "var(--blue)" },
  { label: "产出", minutes: 15, tone: "var(--rose)" },
  { label: "连读", minutes: 3, tone: "var(--ink)" },
];

// TODO: replace with actual day from DB
const TOTAL_DAYS = 241;

export default function MapPage() {
  const [todayDay, setTodayDay] = useState(1);

  useEffect(() => {
    setTodayDay(getDayNo());
  }, []);

  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-7xl px-4 pb-10 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-normal">学习地图</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            241 天 · 7,223 义项 · CEFR A1 → B2
          </p>
        </div>

        {/* Overall progress */}
        <div className="mb-8 rounded-sm border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm text-[var(--muted)]">总进度</span>
              <p className="mt-1 text-3xl font-semibold">第 {todayDay} 天</p>
            </div>
            <div className="text-right">
              <span className="text-sm text-[var(--muted)]">{TOTAL_DAYS} 天目标</span>
              <p className="mt-1 text-lg font-medium text-[var(--muted)]">
                {Math.round((todayDay / TOTAL_DAYS) * 100)}% 完成
              </p>
            </div>
          </div>
          <div className="mt-4 h-3 rounded-sm bg-[color-mix(in_srgb,var(--line),transparent_35%)]">
            <div
              className="h-3 rounded-sm bg-[var(--accent)] transition-all"
              style={{ width: `${Math.max(0.5, (todayDay / TOTAL_DAYS) * 100)}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-xs text-[var(--muted)]">
            <span>第 1 天</span>
            <span>第 {TOTAL_DAYS} 天</span>
          </div>
        </div>

        {/* Stage timeline */}
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {stages.map((stage) => {
            const isActive = todayDay >= stage.range[0] && todayDay <= stage.range[1];
            const isDone = todayDay > stage.range[1];
            return (
              <div
                key={stage.level}
                className={`rounded-sm border p-5 shadow-[var(--shadow)] ${
                  isActive
                    ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent),var(--panel)_88%)]"
                    : isDone
                    ? "border-[var(--line)] bg-[var(--panel)] opacity-60"
                    : "border-[var(--line)] bg-[var(--panel)]"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span
                    className="rounded-sm px-2 py-0.5 text-sm font-semibold text-[var(--paper)]"
                    style={{ background: stage.tone }}
                  >
                    {stage.level}
                  </span>
                  {isActive && (
                    <span className="rounded-sm bg-[var(--accent)] px-2 py-0.5 text-xs font-medium text-[var(--paper)]">
                      当前
                    </span>
                  )}
                  {isDone && (
                    <span className="text-xs text-[var(--muted)]">已完成</span>
                  )}
                </div>
                <h2 className="mt-3 text-lg font-semibold">{stage.label}</h2>
                <p className="mt-0.5 text-xs text-[var(--muted)]">{stage.days}</p>
                <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{stage.desc}</p>
                <div className="mt-4 flex items-center justify-between text-sm">
                  <span className="font-medium">{stage.words.toLocaleString()} 词</span>
                  <span className="text-[var(--muted)]">
                    {stage.range[1] - stage.range[0] + 1} 天
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Daily session structure */}
        <div className="rounded-sm border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
          <h2 className="text-base font-semibold">每日 60 分钟流程</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            五段式结构，从热身到产出，每张卡片间隔递进。
          </p>
          <div className="mt-5 grid gap-3">
            {segments.map((seg) => (
              <div
                key={seg.label}
                className="grid grid-cols-[56px_1fr_48px] items-center gap-3 text-sm"
              >
                <span className="font-medium">{seg.label}</span>
                <span className="h-2.5 rounded-sm bg-[color-mix(in_srgb,var(--line),transparent_25%)]">
                  <span
                    className="block h-2.5 rounded-sm"
                    style={{ width: `${(seg.minutes / 60) * 100}%`, background: seg.tone }}
                  />
                </span>
                <span className="text-right text-[var(--muted)]">{seg.minutes} min</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2">
            <div className="h-px flex-1 bg-[var(--line)]" />
            <span className="text-xs text-[var(--muted)]">每日30义项·每段专注一个目标</span>
            <div className="h-px flex-1 bg-[var(--line)]" />
          </div>
        </div>
      </main>
    </>
  );
}
