//! A tiny line+area sparkline for the featured hero's spot-price context. No
//! axes, no beat line — just the asset's recent drift, coloured by the window's
//! net direction. (Open rounds have no price-to-beat, so this stays contextual.)

const W = 168;
const H = 46;
const P = 3;

export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => P + (i / (values.length - 1)) * (W - 2 * P);
  const y = (v: number) => P + (1 - (v - min) / span) * (H - 2 * P);
  const dir = values[values.length - 1] >= values[0] ? "up" : "down";
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(values.length - 1).toFixed(1)} ${H - P} L${x(0).toFixed(1)} ${H - P} Z`;
  return (
    <svg className={`spark ${dir}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="spark-area" d={area} />
      <path className="spark-line" d={line} />
    </svg>
  );
}
