"use client";

import { useEffect, useState } from "react";
import { TopNav } from "@/components/top-nav";
import type { Settings } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";

const STORAGE_KEY = "volka:settings";

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable
  }
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-base font-semibold">{children}</h2>
  );
}

function OptionGroup<T extends string | number | boolean>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded-sm border px-4 py-2 text-sm font-medium transition ${
            value === opt.value
              ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent),var(--panel)_85%)] text-[var(--ink)]"
              : "border-[var(--line)] bg-[var(--panel-strong)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--ink)]"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-sm border border-[var(--line)] bg-[var(--panel-strong)] p-4">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs text-[var(--muted)]">{description}</div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 rounded-full transition-colors ${
          checked ? "bg-[var(--accent)]" : "bg-[var(--line)]"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-[var(--paper)] shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </label>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const local = loadSettings();
    setSettings(local);
    void fetch("/api/settings")
      .then((res) => res.ok ? res.json() as Promise<Settings> : null)
      .then((remote) => { if (remote) { setSettings(remote); saveSettings(remote); } })
      .catch(() => undefined);
    setMounted(true);
  }, []);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      saveSettings(next);
      void fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => undefined);
      // Apply theme immediately without waiting for a page reload
      if (key === "theme") {
        const isDark =
          value === "dark" ||
          (value === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
        document.documentElement.classList.toggle("dark", isDark);
      }
      return next;
    });
  }

  if (!mounted) return null;

  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-2xl px-4 pb-10 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-normal">设置</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">偏好保存到本地浏览器</p>
        </div>

        <div className="grid gap-6">
          {/* Theme */}
          <section className="rounded-sm border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
            <SectionTitle>主题</SectionTitle>
            <OptionGroup
              options={[
                { value: "system" as const, label: "跟随系统" },
                { value: "light" as const, label: "浅色" },
                { value: "dark" as const, label: "深色" },
              ]}
              value={settings.theme}
              onChange={(v) => update("theme", v)}
            />
          </section>

          {/* Session length */}
          <section className="rounded-sm border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
            <SectionTitle>每日时长</SectionTitle>
            <OptionGroup
              options={[
                { value: "minimal" as const, label: "5 分钟" },
                { value: "short" as const, label: "20 分钟" },
                { value: "full" as const, label: "60 分钟" },
              ]}
              value={settings.sessionLength}
              onChange={(v) => update("sessionLength", v)}
            />
            <p className="mt-2 text-xs text-[var(--muted)]">
              每天坚持比时长更重要。状态不好就选最短的。
            </p>
          </section>

          {/* Daily targets */}
          <section className="rounded-sm border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
            <SectionTitle>每日目标</SectionTitle>
            <div className="grid gap-4">
              <div>
                <div className="mb-2 text-sm text-[var(--muted)]">新词上限</div>
                <OptionGroup
                  options={[
                    { value: 10, label: "10" },
                    { value: 20, label: "20" },
                    { value: 30, label: "30" },
                    { value: 40, label: "40" },
                    { value: 50, label: "50" },
                  ]}
                  value={settings.dailyNewLimit}
                  onChange={(v) => update("dailyNewLimit", v)}
                />
              </div>
              <div>
                <div className="mb-2 text-sm text-[var(--muted)]">复习上限</div>
                <OptionGroup
                  options={[
                    { value: 60, label: "60" },
                    { value: 120, label: "120" },
                    { value: 180, label: "180" },
                  ]}
                  value={settings.dailyReviewLimit}
                  onChange={(v) => update("dailyReviewLimit", v)}
                />
              </div>
            </div>
          </section>

          {/* Audio */}
          <section className="rounded-sm border border-[var(--line)] bg-[var(--panel)] p-5 shadow-[var(--shadow)]">
            <SectionTitle>音频</SectionTitle>
            <div className="grid gap-3">
              <div>
                <div className="mb-2 text-sm text-[var(--muted)]">正常语速</div>
                <OptionGroup
                  options={[
                    { value: 0.7, label: "0.7×" },
                    { value: 1, label: "1×" },
                    { value: 1.2, label: "1.2×" },
                    { value: 1.5, label: "1.5×" },
                  ]}
                  value={settings.playbackRate}
                  onChange={(v) => update("playbackRate", v)}
                />
              </div>
              <Toggle
                checked={settings.autoPlayAudio}
                onChange={(v) => update("autoPlayAudio", v)}
                label="自动播放"
                description="换卡时自动播放例句音频"
              />
              <Toggle
                checked={settings.keepRecordings}
                onChange={(v) => update("keepRecordings", v)}
                label="保留录音"
                description="跟读卡片结束后保存录音文件"
              />
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
