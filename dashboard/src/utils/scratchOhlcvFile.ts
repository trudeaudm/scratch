import { promises as fs } from "fs";
import path from "path";
import { dexPairs } from "@/config/addresses";

export type OhlcvCandle = {
  /** Unix seconds at candle open (UTC day). */
  t: number;
  /** USD close. */
  c: number;
};

export type ScratchOhlcvCache = {
  pool: string;
  network: string;
  fetchedAt: number;
  candles: OhlcvCandle[];
};

const NETWORK = "robinhood";
const MIN_GAP_MS = 2_100;
/** Refresh disk cache after 6h. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const GT_LIMIT = 1000;

let lastGtAt = 0;

export function scratchOhlcvPath(): string {
  return path.join(process.cwd(), ".data", "scratch-ohlcv-day.json");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function rateLimitedGet(url: string): Promise<Response> {
  const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastGtAt));
  if (wait > 0) await sleep(wait);
  lastGtAt = Date.now();
  return fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
}

function parseOhlcvList(raw: unknown): OhlcvCandle[] {
  if (!Array.isArray(raw)) return [];
  const out: OhlcvCandle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const t = Number(row[0]);
    const c = Number(row[4]);
    if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) continue;
    out.push({ t, c });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

async function fetchGtPage(beforeTimestamp?: number): Promise<OhlcvCandle[]> {
  const pool = dexPairs.scratch.pairAddress;
  const params = new URLSearchParams({
    currency: "usd",
    aggregate: "1",
    limit: String(GT_LIMIT),
    token: "base",
  });
  if (beforeTimestamp != null) {
    params.set("before_timestamp", String(beforeTimestamp));
  }
  const url =
    `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${pool}/ohlcv/day` +
    `?${params.toString()}`;
  const res = await rateLimitedGet(url);
  if (!res.ok) {
    throw new Error(`GeckoTerminal OHLCV HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    data?: { attributes?: { ohlcv_list?: unknown } };
  };
  return parseOhlcvList(data.data?.attributes?.ohlcv_list);
}

export async function readScratchOhlcvFile(): Promise<ScratchOhlcvCache | null> {
  try {
    const raw = await fs.readFile(scratchOhlcvPath(), "utf8");
    const parsed = JSON.parse(raw) as ScratchOhlcvCache;
    if (!parsed || !Array.isArray(parsed.candles)) return null;
    return parsed;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw e;
  }
}

export async function writeScratchOhlcvFile(cache: ScratchOhlcvCache): Promise<void> {
  const dir = path.dirname(scratchOhlcvPath());
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${scratchOhlcvPath()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(cache)}\n`, "utf8");
  await fs.rename(tmp, scratchOhlcvPath());
}

/**
 * Ensure daily SCRATCH/USD candles are loaded (disk cache or GeckoTerminal refresh).
 */
export async function loadScratchOhlcv(opts?: {
  force?: boolean;
}): Promise<ScratchOhlcvCache> {
  const pool = dexPairs.scratch.pairAddress;
  const existing = await readScratchOhlcvFile();
  if (
    !opts?.force &&
    existing &&
    existing.pool.toLowerCase() === pool.toLowerCase() &&
    Date.now() - existing.fetchedAt < CACHE_TTL_MS &&
    existing.candles.length > 0
  ) {
    return existing;
  }

  const byT = new Map<number, OhlcvCandle>();
  let before: number | undefined;
  // Paginate older history until a short page or hard cap.
  for (let page = 0; page < 20; page++) {
    const batch = await fetchGtPage(before);
    if (batch.length === 0) break;
    for (const c of batch) byT.set(c.t, c);
    const oldest = batch.reduce((m, c) => Math.min(m, c.t), Infinity);
    if (!Number.isFinite(oldest)) break;
    before = oldest;
    if (batch.length < GT_LIMIT) break;
  }

  const candles = [...byT.values()].sort((a, b) => a.t - b.t);
  if (candles.length === 0 && existing?.candles.length) {
    return existing;
  }
  if (candles.length === 0) {
    throw new Error("GeckoTerminal returned no SCRATCH/USD daily candles");
  }

  const cache: ScratchOhlcvCache = {
    pool,
    network: NETWORK,
    fetchedAt: Date.now(),
    candles,
  };
  await writeScratchOhlcvFile(cache);
  return cache;
}

/** Nearest prior (or same-day) daily close for unix timestamp seconds. */
export function scratchUsdAtFromCandles(
  candles: OhlcvCandle[],
  tsSec: number,
): number | null {
  if (!candles.length || !Number.isFinite(tsSec) || tsSec <= 0) return null;
  // Day bucket: candle.t is day open UTC.
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
  return best && best.c > 0 ? best.c : null;
}
