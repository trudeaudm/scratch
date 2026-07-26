import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
  zeroAddress,
} from "viem";
import { findTokenConfig, tokens } from "@/config/addresses";
import { erc20AbiTyped } from "@/config/abis";
import { robinhoodChain } from "@/config/chain";
import { shortAddr } from "@/utils/format";

export type TokenMeta = {
  symbol: string;
  decimals: number;
  /** Where the label came from. */
  source: "config" | "chain" | "fallback";
};

const cache = new Map<string, TokenMeta>();

function fromConfig(asset: Address): TokenMeta | null {
  const cfg =
    findTokenConfig(asset) ??
    tokens.find((t) => t.address.toLowerCase() === asset.toLowerCase());
  if (!cfg) return null;
  const symbol =
    cfg.kind === "stock" && cfg.ticker?.trim() ? cfg.ticker.trim() : cfg.symbol;
  return { symbol, decimals: cfg.decimals, source: "config" };
}

/** Sync path — config only; truncated address if unknown (no RPC). */
export function resolveTokenMetaSync(asset: string): TokenMeta {
  const key = asset.toLowerCase();
  if (!asset || key === zeroAddress) {
    return { symbol: "NO_WIN", decimals: 18, source: "config" };
  }
  const hit = cache.get(key);
  if (hit) return hit;
  const cfg = fromConfig(asset as Address);
  if (cfg) {
    cache.set(key, cfg);
    return cfg;
  }
  return { symbol: shortAddr(asset as Address), decimals: 18, source: "fallback" };
}

/**
 * Config first, then on-chain symbol()/decimals() (cached), then truncated address.
 * Safe for server routes and client code that have an RPC.
 */
export async function resolveTokenMeta(
  asset: string,
  pc?: PublicClient,
): Promise<TokenMeta> {
  const key = (asset || "").toLowerCase();
  if (!asset || key === zeroAddress) {
    return { symbol: "NO_WIN", decimals: 18, source: "config" };
  }
  const cached = cache.get(key);
  if (cached && cached.source !== "fallback") return cached;

  const cfg = fromConfig(asset as Address);
  if (cfg) {
    cache.set(key, cfg);
    return cfg;
  }

  const client =
    pc ??
    createPublicClient({
      chain: robinhoodChain,
      transport: http(robinhoodChain.rpcUrls.default.http[0], {
        timeout: 15_000,
        retryCount: 1,
      }),
    });

  try {
    const [symbolRaw, decimalsRaw] = await Promise.all([
      client.readContract({
        address: asset as Address,
        abi: erc20AbiTyped,
        functionName: "symbol",
      }) as Promise<string>,
      client.readContract({
        address: asset as Address,
        abi: erc20AbiTyped,
        functionName: "decimals",
      }) as Promise<number | bigint>,
    ]);
    const decimals = Number(decimalsRaw);
    const meta: TokenMeta = {
      symbol: String(symbolRaw || "").slice(0, 32) || shortAddr(asset as Address),
      decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18,
      source: "chain",
    };
    cache.set(key, meta);
    return meta;
  } catch {
    const fallback: TokenMeta = {
      symbol: shortAddr(asset as Address),
      decimals: 18,
      source: "fallback",
    };
    cache.set(key, fallback);
    return fallback;
  }
}

/** Resolve many assets; unique RPC work only for unmapped addresses. */
export async function resolveTokenMetaBatch(
  assets: string[],
  pc?: PublicClient,
): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  const unique = [...new Set(assets.map((a) => (a || "").toLowerCase()).filter(Boolean))];
  await Promise.all(
    unique.map(async (key) => {
      const meta = await resolveTokenMeta(key, pc);
      out.set(key, meta);
    }),
  );
  return out;
}
