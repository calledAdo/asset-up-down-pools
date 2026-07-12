//! Shared loading / empty / error primitives so every page handles the three
//! async outcomes consistently instead of bare "Loading…" text.

import type { ReactNode } from "react";

/** A row of shimmer skeleton cards (markets grid) or bars (tables). */
export function Skeleton({ rows = 3, variant = "card" }: { rows?: number; variant?: "card" | "row" }) {
  return (
    <div className={variant === "card" ? "grid" : "skeleton-rows"} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={`skeleton ${variant}`} />
      ))}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {hint && <p className="muted">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, what }: { error: unknown; what: string }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="empty">
      <p className="empty-title error">Couldn’t load {what}</p>
      <p className="muted small">{msg}</p>
    </div>
  );
}
