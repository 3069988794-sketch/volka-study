"use client";

/**
 * Minimal popover — no Radix, no deps.
 *
 * Uses a portal + `position: fixed` so the tooltip isn't clipped by
 * ancestor overflow:hidden (common in card containers).
 */

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type PopoverCtx = {
  id: string;
  open: boolean;
  onToggle: () => void;
};

const PopoverContext = createContext<PopoverCtx>({
  id: "",
  open: false,
  onToggle: () => {},
});

function usePopoverContext(): PopoverCtx {
  return useContext(PopoverContext);
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

export function Popover({
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternal] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const idRef = useRef(`popover-${Math.random().toString(36).slice(2, 9)}`);

  return (
    <PopoverContext.Provider
      value={{
        id: idRef.current,
        open,
        onToggle: () => {
          if (controlledOpen === undefined) setInternal((p) => !p);
          onOpenChange?.(!open);
        },
      }}
    >
      {children}
    </PopoverContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Anchor
// ---------------------------------------------------------------------------

export function PopoverAnchor({
  asChild,
  children,
  ...props
}: React.HTMLProps<HTMLSpanElement> & {
  asChild?: boolean;
}) {
  const ctx = usePopoverContext();

  const childrenEl = React.isValidElement(children) ? children : <span>{children}</span>;
  const el = asChild ? childrenEl : childrenEl;

  type AnyProps = Record<string, unknown>;
  const elProps = el.props as AnyProps;
  return React.cloneElement(el as React.ReactElement<AnyProps>, {
    ...elProps,
    role: "button",
    tabIndex: 0,
    "aria-expanded": ctx.open,
    "aria-controls": ctx.id,
    onClick: (e: React.MouseEvent) => {
      if (typeof elProps.onClick === "function") elProps.onClick(e);
      ctx.onToggle();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (typeof elProps.onKeyDown === "function") elProps.onKeyDown(e);
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        ctx.onToggle();
      }
      if (e.key === "Escape") {
        ctx.onToggle();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export function PopoverContent({
  children,
  side = "bottom",
  align = "start",
  className,
  sideOffset = 4,
  alignOffset = 0,
}: {
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
  sideOffset?: number;
  alignOffset?: number;
}) {
  const ctx = usePopoverContext();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!ctx.open || !ref.current) return;
    const anchor = ref.current.closest("[aria-expanded]") ?? ref.current.previousElementSibling;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerHeight;
    const vh = window.innerWidth;
    const offset = sideOffset;
    const aOffset = alignOffset;

    let top: number, left: number;
    switch (side) {
      case "top": top = rect.top - offset; break;
      case "bottom": top = rect.bottom + offset; break;
      case "left": top = rect.top + rect.height / 2 - 20; break;
      case "right": top = rect.top + rect.height / 2 - 20; break;
      default: top = rect.bottom + offset;
    }
    switch (align) {
      case "start": left = rect.left + aOffset; break;
      case "center": left = rect.left + rect.width / 2 + aOffset; break;
      case "end": left = rect.right + aOffset; break;
      default: left = rect.left + aOffset;
    }

    setPos({ top, left });
  }, [ctx.open, side, align, sideOffset, alignOffset]);

  if (!ctx.open) return null;

  const arrow = {
    top: "bottom: 100%; left: 16px; border-top-color: var(--panel)",
    bottom: "top: 100%; left: 16px; border-bottom-color: var(--panel)",
    left: "right: 100%; top: 12px; border-left-color: var(--panel)",
    right: "left: 100%; top: 12px; border-right-color: var(--panel)",
  }[side];

  return createPortal(
    <div
      ref={ref}
      id={ctx.id}
      role="tooltip"
      className={cn(
        "fixed z-50 rounded-sm border border-[var(--line)] bg-[var(--panel)] shadow-lg",
        "after:absolute after:w-0 after:h-0 after:border-[6px] after:border-0",
        className
      )}
      style={{
        top: pos.top,
        left: pos.left,
        transform: "translate(-4px, 0)",
        maxWidth: 320,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <span
        className={cn("absolute", arrow)}
        style={{
          borderTopColor: undefined, borderBottomColor: undefined,
          borderLeftColor: undefined, borderRightColor: undefined,
        }}
      />
      <span className="absolute w-0 h-0" style={{
        ...(side === "top" ? { bottom: "100%", left: 16 } : {}),
        ...(side === "bottom" ? { top: "100%", left: 16 } : {}),
        ...(side === "left" ? { right: "100%", top: 12 } : {}),
        ...(side === "right" ? { left: "100%", top: 12 } : {}),
      }} />
      {children}
    </div>,
    document.body
  );
}
