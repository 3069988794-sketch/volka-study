"use client";

/**
 * The play control every card uses. Three visible states: idle / playing /
 * unavailable. Falls back to Web Speech when the clip is missing, so pressing
 * it always produces sound if the browser can make any.
 *
 * Deliberately no global key listener — `Space` / `S` belong to the session
 * engine, which should call `playAudio` / `playOrSpeak` directly or drive this
 * button through `autoPlay`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { AudioPlaybackError, canPlay, playOrSpeak, speechSupported, stopAudio } from "@/lib/audio";
import type { PlaybackSource } from "@/lib/audio";

export type PlayState = "idle" | "playing" | "unavailable";

export type PlayButtonProps = {
  /** Clip hash from `audio_index.json`; may be undefined before TTS lands. */
  hash?: string;
  /** Text spoken by the Web Speech fallback. Also the accessible label source. */
  text: string;
  /** Play at `slowRate` (default 0.7×) with pitch preserved. */
  slow?: boolean;
  /** Overrides the normal rate; ignored when `slow` is set. */
  rate?: number;
  slowRate?: number;
  /** Play once on mount / when `hash` changes. Autoplay blocks are swallowed. */
  autoPlay?: boolean;
  /** Visible text. Omit for an icon-only button (still gets an aria-label). */
  label?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  onStateChange?: (state: PlayState) => void;
  onPlayed?: (source: PlaybackSource) => void;
};

const sizeClasses: Record<NonNullable<PlayButtonProps["size"]>, string> = {
  sm: "h-8 min-w-8 gap-1.5 px-2 text-xs",
  md: "h-10 min-w-10 gap-2 px-3 text-sm",
  lg: "h-12 min-w-12 gap-2 px-4 text-base"
};

const iconSize: Record<NonNullable<PlayButtonProps["size"]>, number> = {
  sm: 14,
  md: 16,
  lg: 18
};

export function PlayButton({
  hash,
  text,
  slow = false,
  rate,
  slowRate = 0.7,
  autoPlay = false,
  label,
  size = "md",
  className,
  onStateChange,
  onPlayed
}: PlayButtonProps) {
  const [state, setState] = useState<PlayState>("idle");
  const abortRef = useRef<AbortController | null>(null);
  const autoPlayedRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  // Kept in refs so inline parent callbacks cannot invalidate the effects below.
  const onStateChangeRef = useRef(onStateChange);
  const onPlayedRef = useRef(onPlayed);
  onStateChangeRef.current = onStateChange;
  onPlayedRef.current = onPlayed;

  const effectiveRate = slow ? slowRate : (rate ?? 1);

  const apply = useCallback((next: PlayState) => {
    if (mountedRef.current) {
      setState(next);
      onStateChangeRef.current?.(next);
    }
  }, []);

  const play = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    apply("playing");
    try {
      const source = await playOrSpeak(hash, text, {
        rate: effectiveRate,
        signal: controller.signal
      });
      if (source === "none") {
        apply("unavailable");
        return;
      }
      onPlayedRef.current?.(source);
      apply("idle");
    } catch (error) {
      if (error instanceof AudioPlaybackError && error.reason === "aborted") {
        return;
      }
      apply("idle");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [apply, effectiveRate, hash, text]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    apply(!canPlay(hash) && !speechSupported() ? "unavailable" : "idle");
  }, [apply, hash]);

  useEffect(() => {
    const key = hash ?? text;
    if (!autoPlay || autoPlayedRef.current === key) {
      return;
    }

    autoPlayedRef.current = key;
    void play();
  }, [autoPlay, hash, play, text]);

  const unavailable = state === "unavailable";
  const playing = state === "playing";
  const accessibleLabel = label
    ? undefined
    : unavailable
      ? `暂无音频：${text}`
      : slow
        ? `慢速播放：${text}`
        : `播放：${text}`;

  return (
    <button
      type="button"
      onClick={() => {
        if (playing) {
          stopAudio();
          apply("idle");
          return;
        }
        void play();
      }}
      aria-label={accessibleLabel}
      aria-pressed={playing}
      aria-disabled={unavailable}
      title={unavailable ? "该句音频尚未生成，将使用浏览器语音" : undefined}
      data-state={state}
      className={[
        "inline-flex items-center justify-center rounded-sm border transition",
        "border-[var(--line)] bg-[var(--panel-strong)] text-[var(--ink)]",
        "hover:border-[var(--accent)] focus-visible:border-[var(--accent)]",
        playing ? "border-[var(--accent)] text-[var(--accent)]" : "",
        unavailable ? "text-[var(--muted)] opacity-70" : "",
        sizeClasses[size],
        className ?? ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {unavailable ? (
        <VolumeX size={iconSize[size]} aria-hidden />
      ) : (
        <Volume2
          size={iconSize[size]}
          aria-hidden
          className={playing ? "motion-safe:animate-pulse" : undefined}
        />
      )}
      {slow ? <span aria-hidden>0.7×</span> : null}
      {label ? <span>{label}</span> : null}
    </button>
  );
}

export default PlayButton;
