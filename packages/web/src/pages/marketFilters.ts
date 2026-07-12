import type { Lane } from "../api/types.js";

export interface LaneFilters {
  asset: string;
  durationSecs: string;
}

export function assetKey(label: string): string {
  return label.split("·")[0]?.trim() || label.trim();
}

export function buildAssetChips(lanes: Lane[]): string[] {
  const seen = new Set<string>();
  const assets: string[] = [];
  for (const lane of lanes) {
    const asset = assetKey(lane.label);
    if (seen.has(asset)) continue;
    seen.add(asset);
    assets.push(asset);
  }
  return assets;
}

export function filterLanes(lanes: Lane[], filters: LaneFilters): Lane[] {
  return lanes.filter((lane) => {
    const assetMatches = filters.asset === "all" || assetKey(lane.label) === filters.asset;
    const durationMatches = filters.durationSecs === "all" || lane.durationSecs === filters.durationSecs;
    return assetMatches && durationMatches;
  });
}

/** The asset (e.g. "BTC/USD") with the most summed open liquidity — the one to
 *  feature as the hero, holding all of its cadence rounds. */
export function featuredAsset(lanes: Lane[]): string | null {
  const liq = new Map<string, bigint>();
  for (const lane of lanes) {
    if (!lane.currentOpenPool) continue;
    const a = assetKey(lane.label);
    liq.set(a, (liq.get(a) ?? 0n) + BigInt(lane.currentOpenPool.odds.total));
  }
  let best: string | null = null;
  let bestV = -1n;
  for (const [a, v] of liq) if (v > bestV) { best = a; bestV = v; }
  return best;
}

export function featuredLane(lanes: Lane[]): Lane | null {
  let best: Lane | null = null;
  let bestTotal = -1n;

  for (const lane of lanes) {
    const total = BigInt(lane.currentOpenPool?.odds.total ?? "0");
    if (!lane.currentOpenPool || total <= bestTotal) continue;
    best = lane;
    bestTotal = total;
  }

  return best;
}
