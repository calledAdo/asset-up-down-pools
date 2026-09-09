//! Loading / empty / error, so every screen handles the three async outcomes
//! the same way.

import type { ReactNode } from "react";

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-grid" aria-busy="true" aria-live="polite">
      <span className="sr">Loading</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton skeleton-card" />
      ))}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="card">
      <div className="empty">
        <h2>{title}</h2>
        {hint && <p>{hint}</p>}
        {action}
      </div>
    </div>
  );
}

export function ErrorState({ error, what }: { error: unknown; what: string }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="card">
      <div className="empty" role="alert">
        <h2>Couldn’t load {what}</h2>
        <p>{msg}</p>
        <button className="btn btn-secondary" onClick={() => location.reload()}>Try again</button>
      </div>
    </div>
  );
}
