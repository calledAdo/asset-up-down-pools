//! A lightweight candlestick chart — the pool-detail hero, like Polymarket's
//! event page. Hand-rolled SVG (no charting dependency): OHLC candles coloured
//! up/down, a dashed "price to beat" line (the round's open), and a marker on the
//! latest price. Colours come from theme tokens via CSS classes.

import type { Candle } from "../api/types.js";

const W = 620;
const H = 250;
const PAD_T = 12;
const PAD_B = 16;
const PAD_R = 64; // room for the price axis labels

export function PriceChart({ candles, priceToBeat }: { candles: Candle[]; priceToBeat: number }) {
  if (!candles.length) return null;

  const c = candles.map((k) => ({ t: Number(k.t), o: +k.o, h: +k.h, l: +k.l, c: +k.c }));
  // No price-to-beat for OPEN rounds (it's set at lock) — omit the line then, and
  // colour the latest marker by the window's net direction instead.
  const hasBeat = priceToBeat > 0;
  const lows = c.map((k) => k.l);
  const highs = c.map((k) => k.h);
  let min = Math.min(...lows, ...(hasBeat ? [priceToBeat] : []));
  let max = Math.max(...highs, ...(hasBeat ? [priceToBeat] : []));
  const pad = (max - min) * 0.12 || 1;
  min -= pad; max += pad;

  const plotW = W - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const xStep = plotW / c.length;
  const bodyW = Math.max(2, xStep * 0.6);
  const yOf = (v: number) => PAD_T + (1 - (v - min) / (max - min)) * plotH;

  const last = c[c.length - 1];
  const lastDir = (hasBeat ? last.c >= priceToBeat : last.c >= c[0].o) ? "up" : "down";
  const lastX = xStep * (c.length - 0.5);
  const lastY = yOf(last.c);

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Price chart">
      {/* price-to-beat reference line (locked/settled only) */}
      {hasBeat && <line className="ptb-line" x1={0} y1={yOf(priceToBeat)} x2={plotW} y2={yOf(priceToBeat)} />}
      {hasBeat && <text className="axis-label" x={plotW + 6} y={yOf(priceToBeat) + 3}>{fmt(priceToBeat)}</text>}

      {/* candles */}
      {c.map((k, i) => {
        const x = xStep * (i + 0.5);
        const dir = k.c >= k.o ? "up" : "down";
        const top = yOf(Math.max(k.o, k.c));
        const bot = yOf(Math.min(k.o, k.c));
        return (
          <g key={k.t} className={`candle ${dir}`}>
            <line className="wick" x1={x} y1={yOf(k.h)} x2={x} y2={yOf(k.l)} />
            <rect className="body" x={x - bodyW / 2} y={top} width={bodyW} height={Math.max(1, bot - top)} rx={1} />
          </g>
        );
      })}

      {/* latest price marker */}
      <line className={`now-line ${lastDir}`} x1={lastX} y1={lastY} x2={plotW} y2={lastY} />
      <circle className={`now-dot ${lastDir}`} cx={lastX} cy={lastY} r={3.5} />
      <text className={`now-label ${lastDir}`} x={plotW + 6} y={lastY + 3}>{fmt(last.c)}</text>
    </svg>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: 2 });
}
