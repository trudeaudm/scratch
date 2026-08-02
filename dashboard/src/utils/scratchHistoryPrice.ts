/**
 * Client helper: load daily SCRATCH/USD closes (via /api/scratch-ohlcv)
 * and look up historical prices for FIFO PnL.
 */
export type OhlcvCandle = {
  t: number;
  c: number;
};

let memCandles: OhlcvCandle[] | null = null;
let memFetchedAt = 0;

/**
 * Ensure candles are in memory (from localhost API → disk/GT).
 */
export async function ensureScratchHistoryPrices(opts?: {
  force?: boolean;
}): Promise<OhlcvCandle[]> {
  if (
    !opts?.force &&
    memCandles &&
    memCandles.length > 0 &&
    Date.now() - memFetchedAt < 30 * 60 * 1000
  ) {
    return memCandles;
  }
  const q = opts?.force ? "?force=1" : "";
  const base =
    typeof window === "undefined"
      ? process.env.SCRATCH_OHLCV_URL?.replace(/\/$/, "") ||
        "http://127.0.0.1:3000"
      : "";
  const res = await fetch(`${base}/api/scratch-ohlcv${q}`, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `scratch-ohlcv HTTP ${res.status}`);
  }
  const data = (await res.json()) as { candles?: OhlcvCandle[] };
  memCandles = Array.isArray(data.candles) ? data.candles : [];
  memFetchedAt = Date.now();
  return memCandles;
}

/** Nearest prior daily close for unix timestamp seconds. */
export function scratchUsdAt(tsSec: number): number | null {
  const candles = memCandles;
  if (!candles?.length || !Number.isFinite(tsSec) || tsSec <= 0) return null;
  let lo = 0;
  let hi = candles.length - 1;
  let best: OhlcvCandle | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = candles[mid];
    if (c.t <= tsSec) {
      best = c;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Before first candle: use earliest close (listing bootstrap).
  if (!best) best = candles[0];
  return best && best.c > 0 ? best.c : null;
}

export function clearScratchHistoryPriceCache(): void {
  memCandles = null;
  memFetchedAt = 0;
}
