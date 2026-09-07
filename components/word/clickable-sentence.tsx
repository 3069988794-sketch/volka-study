"use client";

/**
 * ClickableSentence — renders an example sentence with per-word popovers.
 *
 * Uses the annotation's character offsets (never `split(" ")`) so punctuation
 * and multi-word chunks are placed correctly.  Taps/clicks toggle a popover
 * that shows the lemma, gloss, confidence badge, and sibling-sense
 * alternatives.
 *
 * This is the component that was missing when the user complained about
 * "no click-to-word".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import type { AnnotatedSentence, WordLookup } from "@/lib/types";
import { buildSentenceLookups, segmentSentence } from "@/components/word/sense-lookup";
import { cn } from "@/lib/utils";

type Props = {
  text: string;
  annotation: AnnotatedSentence | null;
  /** Preloaded sense list (from the session's data). */
  senses: readonly import("@/lib/types").Sense[];
};

export function ClickableSentence({ text, annotation, senses }: Props) {
  const segments = useMemo(
    () => segmentSentence(text, annotation),
    [text, annotation]
  );

  const lookups = useMemo(
    () => buildSentenceLookups(annotation, senses),
    [annotation, senses]
  );

  return (
    <span className="leading-relaxed">
      {segments.map((seg) =>
        seg.kind === "token" ? (
          <WordSpan key={seg.key} segment={seg} lookups={lookups} />
        ) : (
          <span key={seg.key}>{seg.text}</span>
        )
      )}
    </span>
  );
}

function WordSpan({
  segment,
  lookups,
}: {
  segment: import("@/components/word/sense-lookup").SentenceSegment & { kind: "token" };
  lookups: Map<number, WordLookup>;
}) {
  const lookup = lookups.get(segment.token.start);
  if (!lookup) return <span>{segment.text}</span>;

  return <PopoverWord lookup={lookup} />;
}

function PopoverWord({ lookup }: { lookup: WordLookup }) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openWithDelay = useCallback(() => {
    timerRef.current = setTimeout(() => setOpen(true), 300);
  }, []);

  const cancelOpen = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setOpen(false);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor
        asChild
        onMouseEnter={openWithDelay}
        onMouseLeave={cancelOpen}
        onTouchStart={(e) => {
          e.preventDefault();
          setOpen((prev) => !prev);
        }}
      >
        <span
          className={cn(
            "cursor-pointer rounded-sm px-0.5 underline decoration-dashed underline-offset-4",
            "hover:bg-[var(--accent)]/10",
            lookup.confidence === "low"
              ? "decoration-orange-400"
              : "decoration-blue-400"
          )}
        >
          {lookup.surface}
        </span>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        className="max-w-[320px] rounded-sm border border-[var(--line)] bg-[var(--panel)] p-3 shadow-lg"
        sideOffset={4}
      >
        <div className="space-y-2">
          <div>
            <span className="text-sm font-semibold">{lookup.surface}</span>
            <span className="ml-2 text-xs text-[var(--muted)]">/{lookup.lemma}/</span>
            {lookup.confidence === "low" && (
              <span className="ml-2 text-xs text-orange-400">(低置信度)</span>
            )}
          </div>
          <div>
            <div className="text-xs text-[var(--muted)]">释义</div>
            <div className="text-sm">{lookup.sense.gloss_cn || "—"}</div>
          </div>
          {lookup.alternatives.length > 0 && (
            <div>
              <div className="text-xs text-[var(--muted)]">同词其他义</div>
              <ul className="space-y-1">
                {lookup.alternatives.map((alt) => (
                  <li key={alt.sense_id} className="text-xs">
                    {alt.gloss_cn || alt.gloss_en}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
