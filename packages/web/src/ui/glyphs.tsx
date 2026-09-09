//! The wordmark's mark: the pot with a single division in it — the same object
//! every round card draws, at 28px. Cobalt on the left, clay on the right, and
//! the gap between them is the division.

export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect width="28" height="28" rx="8" fill="var(--sunk)" />
      <rect x="5" y="11" width="9.5" height="6" rx="3" fill="var(--up)" />
      <rect x="16" y="11" width="7" height="6" rx="3" fill="var(--down)" />
    </svg>
  );
}
