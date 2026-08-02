import { createPublicClient, formatUnits, http, parseAbiItem, type Address } from "viem";
import {
  contracts,
  dexPairs,
  findTokenConfig,
  isConfigured,
  tokens,
} from "@/config/addresses";
import { robinhoodChain } from "@/config/chain";

const FOUR_DAYS_SEC = 4 * 24 * 60 * 60;

const erc20Abi = [
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function totalSupply() view returns (uint256)"),
] as const;

const stakingV2Abi = [
  parseAbiItem("function totalUnlocking() view returns (uint256)"),
  parseAbiItem("function unlockNormal() view returns (uint64)"),
  parseAbiItem("function unlockEnhanced() view returns (uint64)"),
] as const;

export type SupplyLine = {
  key: string;
  label: string;
  amount: bigint;
  note?: string;
};

export type SupplyBucket = {
  key: "onMarket" | "locked4d";
  label: string;
  blurb: string;
  amount: bigint;
  lines: SupplyLine[];
};

export type SupplyLocation = {
  takenAt: number;
  scratch: Address;
  totalSupply: bigint;
  /** Residual after known holders + LP (wallet float). */
  atLarge: bigint;
  lp: bigint;
  lpUsd: number | null;
  unlockNormalSec: number;
  unlockEnhancedSec: number;
  buckets: SupplyBucket[];
  /** Detail rows for the breakdown table (all locations). */
  detail: SupplyLine[];
  warnings: string[];
  /** Sum of classified lines vs totalSupply (should be ~0). */
  unclassified: bigint;
};

export type StakerTierHint = {
  staked: bigint;
  tier: "NORMAL" | "ENHANCED" | "UNSET";
  unlockingAmount: bigint;
  releaseAt: number;
};

function client() {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(robinhoodChain.rpcUrls.default.http[0], {
      timeout: 30_000,
      retryCount: 1,
    }),
  });
}

function scratchAddress(): Address {
  const t = tokens.find((x) => x.symbol === "SCRATCH") ?? findTokenConfig(
    "0xf5E5f4D3C34A14B2fDfD59584Fe555Cd5e21F196",
  );
  return (t?.address ?? "0xf5E5f4D3C34A14B2fDfD59584Fe555Cd5e21F196") as Address;
}

async function balanceOf(
  pc: ReturnType<typeof client>,
  token: Address,
  holder: Address,
): Promise<bigint> {
  if (!isConfigured(holder)) return BigInt(0);
  try {
    return (await pc.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    })) as bigint;
  } catch {
    return BigInt(0);
  }
}

async function fetchLpScratch(): Promise<{ amount: bigint; usd: number | null; warning: string | null }> {
  const { chainId, pairAddress } = dexPairs.scratch;
  if (!isConfigured(pairAddress as Address) && pairAddress.length < 66) {
    return { amount: BigInt(0), usd: null, warning: "SCRATCH LP pair not configured" };
  }
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`DexScreener ${res.status}`);
    const data = (await res.json()) as {
      pair?: {
        liquidity?: { base?: number; usd?: number };
        baseToken?: { address?: string };
      } | null;
      pairs?: {
        liquidity?: { base?: number; usd?: number };
        baseToken?: { address?: string };
      }[] | null;
    };
    const pair = data.pair ?? data.pairs?.[0];
    const base = Number(pair?.liquidity?.base ?? NaN);
    const usd = Number(pair?.liquidity?.usd ?? NaN);
    if (!Number.isFinite(base) || base < 0) {
      return { amount: BigInt(0), usd: null, warning: "DexScreener LP base missing" };
    }
    // DexScreener reports human units for base reserve.
    const amount = BigInt(Math.round(base * 1e18));
    return {
      amount,
      usd: Number.isFinite(usd) ? usd : null,
      warning: null,
    };
  } catch (e) {
    return {
      amount: BigInt(0),
      usd: null,
      warning: e instanceof Error ? e.message : "LP fetch failed",
    };
  }
}

/**
 * Classify SCRATCH supply into on-market vs locked ≥4 days.
 * Optional staker hints (from the Stakers snapshot) split V2 into NORMAL / ENHANCED.
 */
export async function loadSupplyLocation(
  stakerHints?: StakerTierHint[] | null,
): Promise<SupplyLocation> {
  const pc = client();
  const scratch = scratchAddress();
  const warnings: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  const [
    totalSupply,
    stakeV2,
    prizeV1,
    prizeV2,
    vesting,
    ticketsV1,
    ticketsV2,
    treasury,
    lpRes,
  ] = await Promise.all([
    pc.readContract({
      address: scratch,
      abi: erc20Abi,
      functionName: "totalSupply",
    }) as Promise<bigint>,
    balanceOf(pc, scratch, contracts.stakingVaultV2.address),
    balanceOf(pc, scratch, contracts.prizeVault.address),
    balanceOf(pc, scratch, contracts.prizeVaultV2.address),
    balanceOf(pc, scratch, contracts.vestingWallet.address),
    balanceOf(pc, scratch, contracts.standardTicketSource.address),
    balanceOf(pc, scratch, contracts.standardTicketSourceV2.address),
    balanceOf(pc, scratch, contracts.treasury.address),
    fetchLpScratch(),
  ]);

  if (lpRes.warning) warnings.push(lpRes.warning);

  let unlockNormalSec = 48 * 3600;
  let unlockEnhancedSec = 120 * 3600;
  let totalUnlocking = BigInt(0);
  try {
    const [n, e, u] = await Promise.all([
      pc.readContract({
        address: contracts.stakingVaultV2.address,
        abi: stakingV2Abi,
        functionName: "unlockNormal",
      }) as Promise<number | bigint>,
      pc.readContract({
        address: contracts.stakingVaultV2.address,
        abi: stakingV2Abi,
        functionName: "unlockEnhanced",
      }) as Promise<number | bigint>,
      pc.readContract({
        address: contracts.stakingVaultV2.address,
        abi: stakingV2Abi,
        functionName: "totalUnlocking",
      }) as Promise<bigint>,
    ]);
    unlockNormalSec = Number(n);
    unlockEnhancedSec = Number(e);
    totalUnlocking = u;
  } catch {
    warnings.push("Could not read StakingVaultV2 unlock params");
  }

  let normalStaked = BigInt(0);
  let enhancedStaked = BigInt(0);
  let unlockNear = BigInt(0); // < 4d remaining (or claimable)
  let unlockFar = BigInt(0); // ≥ 4d remaining
  let hintsCovered = BigInt(0);

  if (stakerHints && stakerHints.length > 0) {
    for (const h of stakerHints) {
      if (h.tier === "ENHANCED") enhancedStaked += h.staked;
      else if (h.tier === "NORMAL") normalStaked += h.staked;
      else normalStaked += h.staked; // treat unset as short-lock residual
      hintsCovered += h.staked + h.unlockingAmount;
      if (h.unlockingAmount > BigInt(0)) {
        const remaining = h.releaseAt - now;
        if (remaining >= FOUR_DAYS_SEC) unlockFar += h.unlockingAmount;
        else unlockNear += h.unlockingAmount;
      }
    }
  }

  // Active stake in vault ≈ vault balance − unlocking. Prefer on-chain totalUnlocking.
  const v2Active = stakeV2 > totalUnlocking ? stakeV2 - totalUnlocking : BigInt(0);
  const hintedActive = normalStaked + enhancedStaked;
  let v2Normal = normalStaked;
  let v2Enhanced = enhancedStaked;
  let v2Unclassified = BigInt(0);

  if (hintedActive > BigInt(0) && v2Active > BigInt(0)) {
    // Scale hint tiers to match on-chain active stake (snapshot may be slightly stale).
    if (hintedActive !== v2Active) {
      v2Normal = (normalStaked * v2Active) / hintedActive;
      v2Enhanced = v2Active - v2Normal;
    }
  } else if (v2Active > BigInt(0)) {
    // No snapshot — lock period of ENHANCED is ≥4d, NORMAL is not; can't split → mark by period.
    if (unlockEnhancedSec >= FOUR_DAYS_SEC && unlockNormalSec < FOUR_DAYS_SEC) {
      v2Unclassified = v2Active;
      warnings.push(
        "Refresh stakers to split V2 NORMAL vs ENHANCED; unclassified V2 stake shown until then",
      );
    } else if (unlockNormalSec >= FOUR_DAYS_SEC) {
      v2Enhanced = v2Active;
    } else {
      v2Normal = v2Active;
    }
  }

  // If snapshot didn't cover unlocking, fall back to on-chain totalUnlocking as near-term
  // (conservative: count as <4d / on-market side unless we know otherwise).
  if (unlockNear + unlockFar === BigInt(0) && totalUnlocking > BigInt(0)) {
    unlockNear = totalUnlocking;
  }

  const prizeVaults = prizeV1 + prizeV2;
  const ticketSources = ticketsV1 + ticketsV2;
  const lp = lpRes.amount;

  // At large = everything not in known protocol contracts and not in LP.
  // Treasury is freely sellable → counted in on-market (shown separately).
  // Show treasury as its own on-market line; at large = residual wallets.
  // v1 StakingVault retired (empty) — omitted from watched protocol set.
  const knownNonTreasuryProtocol = stakeV2 + prizeVaults + vesting + ticketSources;
  let atLarge = totalSupply - knownNonTreasuryProtocol - treasury - lp;
  if (atLarge < BigInt(0)) {
    warnings.push("At-large residual went negative — check LP / balance overlap");
    atLarge = BigInt(0);
  }

  const lockedLines: SupplyLine[] = [
    {
      key: "v2Enhanced",
      label: "Staked V2 ENHANCED",
      amount: v2Enhanced,
      note: `unlock ${Math.round(unlockEnhancedSec / 3600)}h`,
    },
    {
      key: "unlockFar",
      label: "Unlocking (≥4d remaining)",
      amount: unlockFar,
    },
    {
      key: "vesting",
      label: "Ops VestingWallet",
      amount: vesting,
      note: "time-vested",
    },
    {
      key: "prizeVaults",
      label: "Prize vaults (v1+v2)",
      amount: prizeVaults,
      note: "protocol inventory",
    },
  ].filter((l) => l.amount > BigInt(0));

  // Unclassified V2 (no snapshot): if ENHANCED period ≥4d, park under locked with note.
  if (v2Unclassified > BigInt(0) && unlockEnhancedSec >= FOUR_DAYS_SEC) {
    lockedLines.push({
      key: "v2UnclassifiedLocked",
      label: "Staked V2 (tier unknown)",
      amount: v2Unclassified,
      note: "refresh stakers to split",
    });
  }

  const onMarketLines: SupplyLine[] = [
    {
      key: "lp",
      label: "In LP (Uniswap v4)",
      amount: lp,
      note: lpRes.usd != null ? `~$${Math.round(lpRes.usd).toLocaleString()} liq` : undefined,
    },
    {
      key: "atLarge",
      label: "At large (wallets)",
      amount: atLarge,
      note: "freely sellable",
    },
    {
      key: "treasury",
      label: "Treasury EOA",
      amount: treasury,
      note: "ops-held, sellable",
    },
    {
      key: "v2Normal",
      label: "Staked V2 NORMAL",
      amount: v2Normal,
      note: `unlock ${Math.round(unlockNormalSec / 3600)}h (<4d)`,
    },
    {
      key: "unlockNear",
      label: "Unlocking (<4d / claimable)",
      amount: unlockNear,
    },
    {
      key: "tickets",
      label: "Ticket sources",
      amount: ticketSources,
    },
  ].filter((l) => l.amount > BigInt(0));

  if (v2Unclassified > BigInt(0) && unlockEnhancedSec < FOUR_DAYS_SEC) {
    onMarketLines.push({
      key: "v2UnclassifiedMarket",
      label: "Staked V2 (tier unknown)",
      amount: v2Unclassified,
      note: "refresh stakers to split",
    });
  }

  const lockedAmt = lockedLines.reduce((a, l) => a + l.amount, BigInt(0));
  const onMarketAmt = onMarketLines.reduce((a, l) => a + l.amount, BigInt(0));
  const classified = lockedAmt + onMarketAmt;
  const unclassified = totalSupply > classified ? totalSupply - classified : BigInt(0);

  const detail: SupplyLine[] = [
    { key: "total", label: "Total supply", amount: totalSupply },
    ...onMarketLines,
    ...lockedLines,
  ];

  return {
    takenAt: Date.now(),
    scratch,
    totalSupply,
    atLarge,
    lp,
    lpUsd: lpRes.usd,
    unlockNormalSec,
    unlockEnhancedSec,
    buckets: [
      {
        key: "onMarket",
        label: "On market",
        blurb: "LP + freely sellable float + short unlock (<4d)",
        amount: onMarketAmt,
        lines: onMarketLines,
      },
      {
        key: "locked4d",
        label: "Locked 4 days+",
        blurb: "ENHANCED stake, long unlocks, vesting, prize inventory",
        amount: lockedAmt,
        lines: lockedLines,
      },
    ],
    detail,
    warnings,
    unclassified,
  };
}

export function fmtSupply(amount: bigint): string {
  return formatUnits(amount, 18);
}

export function pctOf(amount: bigint, total: bigint): number {
  if (total <= BigInt(0)) return 0;
  return Number((amount * 10_000n) / total) / 100;
}
