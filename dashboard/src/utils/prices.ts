import { formatUnits, type Address, zeroAddress } from "viem";
import {
  DEX_MIN_LIQUIDITY_USD,
  dexPairs,
  findTokenConfig,
  tokens,
  type DexPair,
  type TokenConfig,
} from "../config/addresses";

export type PriceMap = {
  scratchUsd: number | null;
  ethUsd: number | null;
  /** Per-token USD unit price (discovered + config dex). Key = lowercase address. */
  byToken: Record<string, TokenUnitPrice>;
  fetchedAt: number | null;
  error: string | null;
};

export type TokenUnitPrice = {
  usd: number;
  /** Source tag for UI. */
  tag: "config" | "dex" | "peg";
  liquidityUsd?: number;
};

export type PriceTag = "config" | "dex" | "peg" | "none";

async function fetchPairUsd(chainId: string, pairAddress: `0x${string}`): Promise<number | null> {
  if (pairAddress === zeroAddress) return null;
  const url = `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const data = (await res.json()) as {
    pair?: { priceUsd?: string; liquidity?: { usd?: number } } | null;
    pairs?: { priceUsd?: string; liquidity?: { usd?: number } }[] | null;
  };
  const pair = data.pair ?? data.pairs?.[0];
  const priceStr = pair?.priceUsd;
  if (!priceStr) return null;
  const n = Number(priceStr);
  return Number.isFinite(n) ? n : null;
}

type DexPairHit = {
  priceUsd: number;
  liquidityUsd: number;
  pairAddress: string;
};

export type DexPairOption = {
  chainId: string;
  pairAddress: `0x${string}`;
  label: string;
  liquidityUsd: number;
  priceUsd: number | null;
  dexId: string;
};

type DexScreenerPairRow = {
  priceUsd?: string;
  liquidity?: { usd?: number };
  pairAddress?: string;
  chainId?: string;
  dexId?: string;
  baseToken?: { symbol?: string; address?: string };
  quoteToken?: { symbol?: string; address?: string };
};

/**
 * Top DexScreener pairs for a token (sorted by liquidity, highest first).
 */
export async function fetchTokenDexPairs(
  tokenAddress: Address,
  limit = 8,
): Promise<DexPairOption[]> {
  if (tokenAddress === zeroAddress) return [];
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  const data = (await res.json()) as { pairs?: DexScreenerPairRow[] | null };
  const rows = [...(data.pairs ?? [])]
    .map((p) => {
      const liq = Number(p.liquidity?.usd ?? 0);
      const price = Number(p.priceUsd);
      const pairAddress = (p.pairAddress ?? "") as `0x${string}`;
      const chainId = p.chainId ?? "";
      if (!pairAddress || !chainId || !Number.isFinite(liq)) return null;
      const base = p.baseToken?.symbol ?? "?";
      const quote = p.quoteToken?.symbol ?? "?";
      return {
        chainId,
        pairAddress,
        label: `${base}/${quote} · ${p.dexId ?? "dex"} · $${Math.round(liq).toLocaleString()} liq`,
        liquidityUsd: liq,
        priceUsd: Number.isFinite(price) && price > 0 ? price : null,
        dexId: p.dexId ?? "",
      } satisfies DexPairOption;
    })
    .filter((x): x is DexPairOption => x !== null)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);

  const seen = new Set<string>();
  const out: DexPairOption[] = [];
  for (const row of rows) {
    const key = `${row.chainId}:${row.pairAddress.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Best DexScreener pair for a token with liquidity above the dashboard floor.
 */
export async function fetchTokenDexPrice(tokenAddress: Address): Promise<DexPairHit | null> {
  const pairs = await fetchTokenDexPairs(tokenAddress, 12);
  for (const p of pairs) {
    if (p.liquidityUsd < DEX_MIN_LIQUIDITY_USD) continue;
    if (p.priceUsd == null || p.priceUsd <= 0) continue;
    return {
      priceUsd: p.priceUsd,
      liquidityUsd: p.liquidityUsd,
      pairAddress: p.pairAddress,
    };
  }
  return null;
}

async function fetchPinnedPair(pair: DexPair): Promise<TokenUnitPrice | null> {
  const usd = await fetchPairUsd(pair.chainId, pair.pairAddress);
  if (usd == null) return null;
  return { usd, tag: "config" };
}

export async function fetchPrices(extraTokenAddresses: Address[] = []): Promise<PriceMap> {
  const byToken: Record<string, TokenUnitPrice> = {};
  try {
    const [scratchUsd, ethUsd] = await Promise.all([
      fetchPairUsd(dexPairs.scratch.chainId, dexPairs.scratch.pairAddress),
      fetchPairUsd(dexPairs.weth.chainId, dexPairs.weth.pairAddress),
    ]);

    // Curated token pricing
    for (const t of tokens) {
      if (t.address === zeroAddress) continue;
      const key = t.address.toLowerCase();
      if (t.price === "usdg") {
        byToken[key] = { usd: 1, tag: "peg" };
      } else if (t.price === "scratch" && scratchUsd != null) {
        byToken[key] = { usd: scratchUsd, tag: "config" };
      } else if (t.price === "eth" && ethUsd != null) {
        byToken[key] = { usd: ethUsd, tag: "config" };
      } else if (t.price === "dex") {
        if (t.preferredPair) {
          const pinned = await fetchPinnedPair(t.preferredPair);
          if (pinned) byToken[key] = pinned;
        }
        if (!byToken[key]) {
          const hit = await fetchTokenDexPrice(t.address);
          if (hit) byToken[key] = { usd: hit.priceUsd, tag: "dex", liquidityUsd: hit.liquidityUsd };
        }
      }
    }

    // Discovered / extra addresses not already priced
    const unique = [...new Set(extraTokenAddresses.map((a) => a.toLowerCase()))];
    await Promise.all(
      unique.map(async (key) => {
        if (byToken[key]) return;
        const cfg = findTokenConfig(key as Address);
        if (cfg?.price === "none") return;
        try {
          const hit = await fetchTokenDexPrice(key as Address);
          if (hit) {
            byToken[key] = { usd: hit.priceUsd, tag: "dex", liquidityUsd: hit.liquidityUsd };
          }
        } catch {
          /* leave unpriced */
        }
      }),
    );

    return { scratchUsd, ethUsd, byToken, fetchedAt: Date.now(), error: null };
  } catch (e) {
    return {
      scratchUsd: null,
      ethUsd: null,
      byToken,
      fetchedAt: null,
      error: e instanceof Error ? e.message : "price fetch failed",
    };
  }
}

export function unitPriceFor(
  address: Address,
  prices: PriceMap,
): TokenUnitPrice | null {
  return prices.byToken[address.toLowerCase()] ?? null;
}

export function amountUsd(
  amount: bigint,
  decimals: number,
  unit: TokenUnitPrice | null,
): number | null {
  if (!unit) return null;
  const human = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(human)) return null;
  return human * unit.usd;
}

/** @deprecated prefer amountUsd + unitPriceFor; kept for prize-table EV helpers. */
export function tokenUsd(
  token: TokenConfig,
  amount: bigint,
  prices: PriceMap,
): number | null {
  const unit = unitPriceFor(token.address, prices);
  if (unit) return amountUsd(amount, token.decimals, unit);
  // Fallback to legacy scratch/eth fields if byToken not populated yet
  const human = Number(formatUnits(amount, token.decimals));
  if (!Number.isFinite(human)) return null;
  if (token.price === "usdg") return human;
  if (token.price === "scratch") {
    return prices.scratchUsd == null ? null : human * prices.scratchUsd;
  }
  if (token.price === "eth") {
    return prices.ethUsd == null ? null : human * prices.ethUsd;
  }
  return null;
}

export function ethUsd(wei: bigint, prices: PriceMap): number | null {
  const human = Number(formatUnits(wei, 18));
  if (!Number.isFinite(human) || prices.ethUsd == null) return null;
  return human * prices.ethUsd;
}

export function priceTagLabel(tag: PriceTag): string | null {
  if (tag === "dex") return "dex px";
  if (tag === "none") return "no price";
  return null;
}
