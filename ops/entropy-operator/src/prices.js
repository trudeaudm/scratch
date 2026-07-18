import { SCRATCH_PAIR } from "./token-map.js";

/** @type {Map<string, { price: number|null, at: number }>} */
const cache = new Map();
const TTL_MS = 60_000;

/**
 * USD price for an asset. USDG → 1. SCRATCH → Dex pair. Others → Dex by token.
 * Never throws; returns null on failure.
 */
export async function priceUsd(asset, priceKind) {
  try {
    if (priceKind === "none") return null;
    if (priceKind === "usdg") return 1;

    const key = (asset || "").toLowerCase();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.price;

    let price = null;
    if (priceKind === "scratch") {
      price = await fetchScratchPrice();
    } else {
      price = await fetchDexTokenPrice(key);
    }

    cache.set(key, { price, at: Date.now() });
    return price;
  } catch (e) {
    console.warn(`priceUsd: ${e?.message || e}`);
    return null;
  }
}

async function fetchScratchPrice() {
  const url = `https://api.dexscreener.com/latest/dex/pairs/${SCRATCH_PAIR.chainId}/${SCRATCH_PAIR.pairAddress}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return null;
  const data = await res.json();
  const p = Number(data?.pair?.priceUsd ?? data?.pairs?.[0]?.priceUsd);
  return Number.isFinite(p) && p > 0 ? p : null;
}

async function fetchDexTokenPrice(tokenAddress) {
  if (!tokenAddress || tokenAddress === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  const url = `https://api.dexscreener.com/tokens/v1/robinhood/${tokenAddress}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return null;
  const data = await res.json();
  const pairs = Array.isArray(data) ? data : data?.pairs || [];
  let best = null;
  for (const p of pairs) {
    const usd = Number(p?.priceUsd);
    const liq = Number(p?.liquidity?.usd ?? 0);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    if (!best || liq > best.liq) best = { usd, liq };
  }
  return best?.usd ?? null;
}
