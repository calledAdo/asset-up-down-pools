//! The clock. Every action in this product is a signature racing one, so the
//! countdown is in every header, every row and every transaction pane.
//!
//! Two rules, both of them about restraint. It clamps at zero, so a round
//! that has passed its lock never shows a negative number and never looks
//! open. And it only goes amber inside the last sixty seconds — the board can
//! have fourteen clocks on it at once, and if they all signal urgency then
//! none of them does.

import { useEffect, useState } from "react";

import { cd } from "../format.js";
import css from "./Clock.module.css";

/** One ticker for the whole app. Fourteen rows each holding their own
 *  interval drift apart within a minute, and a board whose clocks disagree
 *  with each other is a board nobody trusts. */
const listeners = new Set<(n: number) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function useSecond(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    listeners.add(setNow);
    timer ??= setInterval(() => {
      const t = Math.floor(Date.now() / 1000);
      for (const l of listeners) l(t);
    }, 1000);
    return () => {
      listeners.delete(setNow);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);
  return now;
}

export function Clock({
  to,
  size = "md",
  note,
  /** A countdown to settlement, not to lock: the money is already committed,
   *  so it never signals urgency however little time is left. */
  quiet = false,
  done = "—",
}: {
  to: string | number;
  size?: "sm" | "md" | "lg" | "xl" | "hero";
  note?: string;
  quiet?: boolean;
  done?: string;
}) {
  const now = useSecond();
  const target = Number(to);
  const left = target ? target - now : 0;

  const urgent = !quiet && left > 0 && left < 60;
  const cls = [
    css.clock,
    css[size],
    note ? "" : css.inline,
    urgent ? css.urgent : quiet ? css.past : "",
  ]
    .filter(Boolean)
    .join(" ");

  const face =
    target && left > 0 ? (
      <time className={cls} dateTime={new Date(target * 1000).toISOString()}>
        {cd(left)}
      </time>
    ) : (
      <span className={`${cls} ${css.past}`}>{done}</span>
    );

  // Without a note the clock is just a figure, so it stays inline and can sit
  // inside a sentence. Wrapping it in a block element puts a line break in the
  // middle of "your multiple is fixed at lock, in 4:07."
  if (!note) return face;

  return (
    <div>
      {face}
      <div className={css.note}>{note}</div>
    </div>
  );
}

/** The seconds remaining, for callers that need to branch on urgency rather
 *  than display it — a row's accent rail, a cell's background wash. */
export function useSecondsTo(to: string | number): number {
  const now = useSecond();
  const target = Number(to);
  return target ? target - now : 0;
}

/** Unix seconds, ticking on the shared interval. For anything drawn against
 *  the absolute grid rather than against one round's deadline. */
export function useNow(): number {
  return useSecond();
}

/** The wall clock in the top bar, in UTC. Rounds sit on an absolute grid, so
 *  the app's clock is the grid's clock and not the reader's. */
export function UtcClock() {
  const now = useSecond();
  return (
    <span className={`${css.clock} ${css.sm}`}>
      {new Date(now * 1000).toISOString().slice(11, 19)} UTC
    </span>
  );
}
