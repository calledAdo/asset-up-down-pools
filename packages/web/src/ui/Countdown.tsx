//! A once-a-second countdown to a unix-seconds target. Renders mm:ss inside the
//! hour, then h/d, and flips to a settled label once the moment passes. The
//! `urgent` flag lets callers pulse it under 30s.

import { useEffect, useState } from "react";

export function Countdown({ to, done = "locked" }: { to: string; done?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const target = Number(to) * 1000;
  const left = Math.floor((target - now) / 1000);

  if (!target || left <= 0) return <span className="cd cd-done">{done}</span>;

  const urgent = left <= 30;
  return <span className={`cd${urgent ? " cd-urgent" : ""}`}>{render(left)}</span>;
}

function render(secs: number): string {
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${pad(m)}:${pad(s)}`;
  }
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${pad(m)}m`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return `${d}d ${h}h`;
}

const pad = (n: number) => n.toString().padStart(2, "0");
