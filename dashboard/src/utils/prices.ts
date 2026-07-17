import { formatUnits, type Address } from "viem";
import { dexPairs, type TokenConfig } from "@/config/addresses";

export type PriceMap = {
  scratchUsd: number | null;
  ethUsd: number | null;
  fetchedAt: number | null;
  error: string | null;
};

async function fetchPairUsd(chainId: string, pairAddress: Address): Promise<number | null> {
  if (pairAddress === "0x0000000000000000000000000000000000000000") return null;
  const url = `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const data = (await res.json()) as {
    pair?: { priceUsd?: string } | null;
    pairs?: { priceUsd?: string }[] | null;
  };
  const priceStr = data.pair?.priceUsd ?? data.pairs?.[0]?.priceUsd;
  if (!priceStr) return null;
  const n = Number(priceStr);
  return Number.isFinite(n) ? n : null;
}

export async function fetchPrices(): Promise<PriceMap> {
  try {
    const [scratchUsd, ethUsd] = await Promise.all([
      fetchPairUsd(dexPairs.scratch.chainId, dexPairs.scratch.pairAddress),
      fetchPairUsd(dexPairs.weth.chainId, dexPairs.weth.pairAddress),
    ]);
    return { scratchUsd, ethUsd, fetchedAt: Date.now(), error: null };
  } catch (e) {
    return {
      scratchUsd: null,
      ethUsd: null,
      fetchedAt: null,
      error: e instanceof Error ? e.message : "price fetch failed",
    };
  }
}

export function tokenUsd(
  token: TokenConfig,
  amount: bigint,
  prices: PriceMap,
): number | null {
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
