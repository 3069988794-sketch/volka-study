"use client";

import { useMemo, useState } from "react";
import type { Sense } from "@/lib/types";
import { PlayButton } from "@/components/audio/play-button";
import type { SenseAudio } from "@/lib/audio-index";

const PAGE_SIZE = 48;

type Props = { senses: Sense[]; audioMap?: Record<string, SenseAudio> };

type Filters = {
  search: string;
  level: string;
  priority: string;
};

function Badge({ text, color }: { text: string; color?: string }) {
  return (
    <span
      className="inline-block rounded-sm border border-[var(--line)] px-1.5 py-0.5 text-xs font-medium"
      style={color ? { color } : undefined}
    >
      {text}
    </span>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-sm border px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent),var(--panel)_85%)] text-[var(--ink)]"
          : "border-[var(--line)] bg-[var(--panel-strong)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--ink)]"
      }`}
    >
      {label}
    </button>
  );
}

const LEVEL_COLORS: Record<string, string> = {
  A1: "var(--accent)",
  A2: "var(--blue)",
  B1: "var(--rose)",
  B2: "var(--amber)",
};

export function LibraryClient({ senses, audioMap = {} }: Props) {
  const [filters, setFilters] = useState<Filters>({
    search: "",
    level: "",
    priority: "",
  });
  const [page, setPage] = useState(0);

  // Unique levels + priorities present in data
  const levels = useMemo(
    () => [...new Set(senses.map((s) => s.level).filter(Boolean))].sort(),
    [senses]
  );
  const priorities = useMemo(
    () => [...new Set(senses.map((s) => s.priority).filter(Boolean))].sort(),
    [senses]
  );

  const filtered = useMemo(() => {
    const q = filters.search.toLowerCase().trim();
    return senses.filter((s) => {
      if (filters.level && s.level !== filters.level) return false;
      if (filters.priority && s.priority !== filters.priority) return false;
      if (!q) return true;
      return (
        s.headword.toLowerCase().includes(q) ||
        s.gloss_en.toLowerCase().includes(q) ||
        s.gloss_cn.toLowerCase().includes(q)
      );
    });
  }, [senses, filters]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  function setFilter<K extends keyof Filters>(key: K, val: string) {
    setFilters((prev) => ({ ...prev, [key]: prev[key] === val ? "" : val }));
    setPage(0);
  }

  function setSearch(val: string) {
    setFilters((prev) => ({ ...prev, search: val }));
    setPage(0);
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 pb-10 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">词库</h1>
          <p className="mt-0.5 text-sm text-[var(--muted)]">
            共 {filtered.length.toLocaleString()} 条
            {filtered.length !== senses.length &&
              ` · 全库 ${senses.length.toLocaleString()}`}
          </p>
        </div>
        {/* Search */}
        <input
          type="search"
          value={filters.search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索单词 / 释义…"
          className="h-10 w-full max-w-xs rounded-sm border border-[var(--line)] bg-[var(--panel-strong)] px-3 text-sm outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)]"
        />
      </div>

      {/* Filters */}
      <div className="mb-5 flex flex-wrap gap-2">
        <span className="self-center text-xs text-[var(--muted)]">等级</span>
        {levels.map((lv) => (
          <FilterChip
            key={lv}
            label={lv}
            active={filters.level === lv}
            onClick={() => setFilter("level", lv)}
          />
        ))}
        <span className="self-center ml-3 text-xs text-[var(--muted)]">优先级</span>
        {priorities.map((p) => (
          <FilterChip
            key={p}
            label={p}
            active={filters.priority === p}
            onClick={() => setFilter("priority", p)}
          />
        ))}
      </div>

      {/* Grid */}
      {pageItems.length === 0 ? (
        <div className="py-16 text-center text-[var(--muted)]">没有匹配的词条</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pageItems.map((sense) => (
            <article
              key={sense.sense_id}
              className="rounded-sm border border-[var(--line)] bg-[var(--panel)] p-4 shadow-[var(--shadow)]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="text-xl font-semibold leading-tight">{sense.headword}</h2>
                  <PlayButton
                    size="sm"
                    hash={audioMap[sense.sense_id]?.word}
                    text={sense.headword}
                    label="读单词"
                  />
                </div>
                <div className="flex shrink-0 gap-1.5">
                  {sense.level && (
                    <Badge text={sense.level} color={LEVEL_COLORS[sense.level]} />
                  )}
                  {sense.priority && <Badge text={sense.priority} />}
                </div>
              </div>

              {sense.pos && (
                <p className="mt-0.5 text-xs text-[var(--muted)]">{sense.pos}</p>
              )}

              {sense.ipa || sense.chunk ? (
                <p className="mt-1 text-xs text-[var(--muted)]">
                  {[sense.ipa && `/${sense.ipa}/`, sense.chunk]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}

              <div className="mt-3 text-sm leading-6">
                <p>{sense.gloss_en || "—"}</p>
                {sense.gloss_cn && (
                  <p className="text-[var(--muted)]">{sense.gloss_cn}</p>
                )}
              </div>

              {sense.example_en && (
                <p className="mt-2 text-xs text-[var(--muted)] italic line-clamp-2">
                  {sense.example_en.length > 80
                    ? sense.example_en.slice(0, 80) + "…"
                    : sense.example_en}
                </p>
              )}
            </article>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-8 flex items-center justify-center gap-3">
          <button
            type="button"
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded-sm border border-[var(--line)] bg-[var(--panel-strong)] px-4 py-2 text-sm transition hover:border-[var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            上一页
          </button>
          <span className="text-sm text-[var(--muted)]">
            第 {safePage + 1} / {totalPages} 页
          </span>
          <button
            type="button"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="rounded-sm border border-[var(--line)] bg-[var(--panel-strong)] px-4 py-2 text-sm transition hover:border-[var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            下一页
          </button>
        </div>
      )}
    </main>
  );
}
