"use client";

import { useEffect, useState } from "react";
import { getDayNo } from "@/lib/storage";
import type { Sense } from "@/lib/types";

const TOTAL_GOAL = 7223;

const levels = [
  { level: "A1", count: 1500, color: "var(--accent)" },
  { level: "A2", count: 1800, color: "var(--blue)" },
  { level: "B1", count: 2100, color: "var(--rose)" },
  { level: "B2", count: 1823, color: "var(--amber)" },
];

function StatCard({
  value,
  label,
  sub,
}: {
  value: string | number;
  label: string;
  sub?: string;
}) {
  return (
    <div className="rounded-sm border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
      <div className="text-3xl font-semibold">{value}</div>
      <div className="mt-1 text-sm font-medium">{label}</div>
      {sub && <div className="mt-0.5 text-xs text-[var(--muted)]">{sub}</div>}
    </div>
  );
}

type Props = { senses: Sense[] };

export function AbilityClient({ senses }: Props) {
  const [mounted, setMounted] = useState(false);
  const [stats, setStats] = useState({
    learned: 0,
    learning: 0,
    dueToday: 0,
  });
  const [levelCounts, setLevelCounts] = useState<Record<string, number>>({});
  const [dayNo, setDayNo] = useState(1);

  useEffect(() => {
    void fetch("/api/stats").then((res) => res.json()).then((data) => {
      setStats({ learned: data.learned ?? 0, learning: (data.learning ?? 0) + (data.relearning ?? 0), dueToday: data.dueToday ?? 0 });
      setLevelCounts(data.byLevel ?? {});
      setDayNo(getDayNo());
      setMounted(true);
    }).catch(() => setMounted(true));
  }, [senses]);

  if (!mounted) return null;

  const hasData = stats.learned > 0 || stats.learning > 0;

  return (
    <main className="mx-auto w-full max-w-7xl px-4 pb-10 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-normal">能力面板</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          义项掌握情况 · 目标 {TOTAL_GOAL.toLocaleString()} 词 · 第 {dayNo} 天
        </p>
      </div>

      {/* Summary cards */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard value={stats.learned} label="已掌握" sub="review 状态" />
        <StatCard value={stats.learning} label="学习中" sub="learning 状态" />
        <StatCard value={stats.dueToday} label="待复习" sub="今日到期" />
        <StatCard
          value={`${Math.round((stats.learned / TOTAL_GOAL) * 100)}%`}
          label="总完成率"
          sub={`${stats.learned} / ${TOTAL_GOAL.toLocaleString()}`}
        />
      </div>

      {/* Level breakdown */}
      <div className="mb-8 rounded-sm border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
        <h2 className="mb-4 text-base font-semibold">各等级进度</h2>
        <div className="grid gap-4">
          {levels.map((lv) => {
            const done = levelCounts[lv.level] ?? 0;
            const pct = Math.round((done / lv.count) * 100);
            return (
              <div key={lv.level}>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="font-medium">{lv.level}</span>
                  <span className="text-[var(--muted)]">
                    {done.toLocaleString()} / {lv.count.toLocaleString()}
                  </span>
                </div>
                <div className="h-2.5 rounded-sm bg-[color-mix(in_srgb,var(--line),transparent_25%)]">
                  <div
                    className="h-2.5 rounded-sm transition-all"
                    style={{
                      width: pct > 0 ? `${pct}%` : "0%",
                      background: lv.color,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Empty or progress state */}
      {!hasData ? (
        <div className="rounded-sm border border-[var(--line)] bg-[var(--panel-strong)] p-6 text-center">
          <p className="text-lg font-medium">尚无学习记录</p>
          <p className="mt-2 text-sm text-[var(--muted)] leading-6">
            完成第一轮学习后，这里会显示你的掌握义项、遗忘曲线和每日复习量。
            <br />
            目标是 241 天内覆盖 7,223 个英语义项，涵盖 CEFR A1–B2 全范围。
          </p>
          <a
            href="/"
            className="mt-4 inline-block rounded-sm bg-[var(--ink)] px-5 py-2.5 text-sm font-semibold text-[var(--paper)] transition hover:opacity-90"
          >
            开始今日学习
          </a>
        </div>
      ) : (
        <div className="rounded-sm border border-[var(--line)] bg-[var(--panel-strong)] p-5">
          <p className="text-sm text-[var(--muted)]">
            已学习 {stats.learned + stats.learning} 个义项 · 其中{" "}
            {stats.learned} 个进入复习阶段 · 今日有 {stats.dueToday} 个到期
          </p>
        </div>
      )}
    </main>
  );
}
