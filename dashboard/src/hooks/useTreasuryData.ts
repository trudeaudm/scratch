"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type Log,
} from "viem";
import {
  balanceHolders,
  contracts,
  findTokenConfig,
  isConfigured,
  tokens,
} from "@/config/addresses";
import {
  prizeVaultAbiTyped,
  stakingVaultAbiTyped,
  standardTicketSourceAbiTyped,
  scratchGameAbiTyped,
  vestingWalletAbiTyped,
  erc20AbiTyped,
} from "@/config/abis";
import { robinhoodChain, REFRESH_MS } from "@/config/chain";
import { ethUsd, fetchPrices, amountUsd, unitPriceFor, type PriceMap, type PriceTag } from "@/utils/prices";
import { fetchBlockscoutTokenList } from "@/utils/blockscout";

const SWEEP_GRACE = 24 * 60 * 60;
const RANDOMNESS_SWAP_GRACE = 24 * 60 * 60;
const DAY = 24 * 60 * 60;

const scratchRequestedEvent = parseAbiItem(
  "event ScratchRequested(address indexed user, uint256 indexed requestId, uint8 tier)",
);

export type HoldingToken = {
  symbol: string;
  address: Address;
  amount: bigint;
  decimals: number;
  usd: number | null;
  /** Present in tokens.json verified config. */
  verified: boolean;
  kind: "crypto" | "stock";
  /** Underlying ticker for stocks (e.g. AAPL). */
  ticker?: string;
  priceTag: import("@/utils/prices").PriceTag;
};

export type HolderBalances = {
  holder: (typeof balanceHolders)[number];
  eth: bigint;
  ethUsd: number | null;
  tokens: HoldingToken[];
};

export type SweepRow = {
  id: bigint;
  asset: Address;
  to: Address;
  eta: number;
  pending: boolean;
  status: "queued" | "ready" | "expired";
  secondsToEta: number;
  secondsToExpiry: number;
};

export type PrizeVaultVitals = {
  inventory: { asset: Address; balance: bigint; symbol: string }[];
  sweeps: SweepRow[];
};

export type StakingVitals = {
  totalStaked: bigint;
  emissionRate: bigint;
  accTicketsPerShare: bigint;
};

export type TicketSourceVitals = {
  grantDailyCap: bigint;
  grantUsedToday: bigint;
  grantDayBucket: bigint;
  remaining: bigint;
  secondsToReset: number;
};

export type VestingVitals = {
  token: Address;
  released: bigint;
  releasable: bigint;
  vestedToDate: bigint;
  totalAtEnd: bigint;
  progressBps: number;
  start: number;
  end: number;
};

export type GameVitals = {
  randomness: Address;
  pendingRandomness: Address;
  randomnessSwapEta: number;
  swapStatus: "none" | "queued" | "ready" | "expired";
  secondsToEta: number;
  secondsToExpiry: number;
  rescueDelay: number;
  /** All Pending (status=1) requests in the lookback window. */
  pendingCount: number;
  /** Pending requests older than rescueDelay. */
  stalePendingCount: number;
};

export type PrizeTableSnapshot = {
  tier: 0 | 1;
  rows: import("@/utils/prizeTable").PrizeRow[];
};

export type VaultAssetMeta = {
  asset: Address;
  balance: bigint;
  fallbackRate: bigint;
};

export type TreasurySnapshot = {
  updatedAt: number;
  prices: PriceMap;
  holders: HolderBalances[];
  prizeVault: PrizeVaultVitals | null;
  staking: StakingVitals | null;
  tickets: TicketSourceVitals | null;
  vesting: VestingVitals | null;
  game: GameVitals | null;
  prizeTables: PrizeTableSnapshot[] | null;
  vaultAssets: VaultAssetMeta[];
  /** Set when Blockscout tokenlist failed — holdings fell back to config-only. */
  discoveryWarning: string | null;
  error: string | null;
};

function client() {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(robinhoodChain.rpcUrls.default.http[0]),
  });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

type DiscoveredBag = { address: Address; balance: bigint; symbol: string; decimals: number };

async function loadHolders(
  pc: ReturnType<typeof client>,
  prices: PriceMap,
  discovered: Map<string, DiscoveredBag[]>,
): Promise<HolderBalances[]> {
  const configuredTokens = tokens.filter((t) => isConfigured(t.address));
  const holders: HolderBalances[] = [];

  for (const holder of balanceHolders) {
    if (!isConfigured(holder.address)) {
      holders.push({ holder, eth: 0n, ethUsd: null, tokens: [] });
      continue;
    }

    const eth = await pc.getBalance({ address: holder.address });
    const byAddr = new Map<string, HoldingToken>();

    for (const t of configuredTokens) {
      let amount = 0n;
      let decimals = t.decimals;
      try {
        amount = (await pc.readContract({
          address: t.address,
          abi: erc20AbiTyped,
          functionName: "balanceOf",
          args: [holder.address],
        })) as bigint;
      } catch {
        amount = 0n;
      }
      try {
        const onChain = (await pc.readContract({
          address: t.address,
          abi: erc20AbiTyped,
          functionName: "decimals",
        })) as number | bigint;
        const n = Number(onChain);
        if (Number.isInteger(n) && n >= 0 && n <= 36) decimals = n;
      } catch {
        /* keep config decimals */
      }
      const unit = unitPriceFor(t.address, prices);
      let priceTag: PriceTag = "none";
      if (t.price === "usdg") priceTag = "peg";
      else if (unit?.tag === "dex") priceTag = "dex";
      else if (unit) priceTag = "config";
      byAddr.set(t.address.toLowerCase(), {
        symbol: t.symbol,
        address: t.address,
        amount,
        decimals,
        usd: amountUsd(amount, decimals, unit),
        verified: true,
        kind: t.kind ?? "crypto",
        ticker: t.ticker,
        priceTag,
      });
    }

    for (const d of discovered.get(holder.address.toLowerCase()) ?? []) {
      if (findTokenConfig(d.address)) continue;
      const unit = unitPriceFor(d.address, prices);
      byAddr.set(d.address.toLowerCase(), {
        symbol: d.symbol,
        address: d.address,
        amount: d.balance,
        decimals: d.decimals,
        usd: amountUsd(d.balance, d.decimals, unit),
        verified: false,
        kind: "crypto",
        priceTag: unit ? "dex" : "none",
      });
    }

    const tokenRows = [...byAddr.values()]
      .filter((t) => t.amount > 0n)
      .sort((a, b) => {
        if (a.verified !== b.verified) return a.verified ? -1 : 1;
        return a.symbol.localeCompare(b.symbol);
      });

    holders.push({
      holder,
      eth,
      ethUsd: ethUsd(eth, prices),
      tokens: tokenRows,
    });
  }

  return holders;
}

/** One Blockscout pass for all holders — feeds Dex pricing and holding merge. */
async function discoverAllHoldings(): Promise<{
  byHolder: Map<string, DiscoveredBag[]>;
  addresses: Address[];
  warning: string | null;
}> {
  const byHolder = new Map<string, DiscoveredBag[]>();
  const addrs = new Set<string>();
  for (const holder of balanceHolders) {
    if (!isConfigured(holder.address)) continue;
    try {
      const list = await fetchBlockscoutTokenList(holder.address);
      byHolder.set(
        holder.address.toLowerCase(),
        list.map((t) => ({
          address: t.address,
          balance: t.balance,
          symbol: t.symbol,
          decimals: t.decimals,
        })),
      );
      for (const t of list) {
        if (!findTokenConfig(t.address)) addrs.add(t.address.toLowerCase());
      }
    } catch (e) {
      return {
        byHolder,
        addresses: [],
        warning:
          e instanceof Error
            ? `Blockscout token discovery failed (${e.message}) — showing config tokens only`
            : "Blockscout token discovery failed — showing config tokens only",
      };
    }
  }
  return { byHolder, addresses: [...addrs] as Address[], warning: null };
}

async function loadPrizeVault(pc: ReturnType<typeof client>): Promise<PrizeVaultVitals | null> {
  const addr = contracts.prizeVault.address;
  if (!isConfigured(addr)) return null;

  const [assets, balances] = (await pc.readContract({
    address: addr,
    abi: prizeVaultAbiTyped,
    functionName: "inventory",
  })) as [Address[], bigint[]];

  const inventory = [];
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    let symbol = asset.slice(0, 6) + "…";
    const known = tokens.find((t) => t.address.toLowerCase() === asset.toLowerCase());
    if (known) symbol = known.symbol;
    else {
      try {
        symbol = (await pc.readContract({
          address: asset,
          abi: erc20AbiTyped,
          functionName: "symbol",
        })) as string;
      } catch {
        /* keep short */
      }
    }
    inventory.push({ asset, balance: balances[i], symbol });
  }

  const sweepCount = (await pc.readContract({
    address: addr,
    abi: prizeVaultAbiTyped,
    functionName: "sweepCount",
  })) as bigint;

  const sweeps: SweepRow[] = [];
  const t = nowSec();
  for (let id = 1n; id <= sweepCount; id++) {
    const row = (await pc.readContract({
      address: addr,
      abi: prizeVaultAbiTyped,
      functionName: "sweeps",
      args: [id],
    })) as readonly [Address, Address, number | bigint, boolean];
    const [asset, to, etaRaw, pending] = row;
    if (!pending) continue;
    const eta = Number(etaRaw);
    const expiry = eta + SWEEP_GRACE;
    let status: SweepRow["status"] = "queued";
    if (t >= expiry) status = "expired";
    else if (t >= eta) status = "ready";
    sweeps.push({
      id,
      asset,
      to,
      eta,
      pending,
      status,
      secondsToEta: Math.max(0, eta - t),
      secondsToExpiry: Math.max(0, expiry - t),
    });
  }

  return { inventory, sweeps };
}

async function loadStaking(pc: ReturnType<typeof client>): Promise<StakingVitals | null> {
  const addr = contracts.stakingVault.address;
  if (!isConfigured(addr)) return null;
  const [totalStaked, emissionRate, accTicketsPerShare] = await Promise.all([
    pc.readContract({ address: addr, abi: stakingVaultAbiTyped, functionName: "totalStaked" }) as Promise<bigint>,
    pc.readContract({ address: addr, abi: stakingVaultAbiTyped, functionName: "emissionRate" }) as Promise<bigint>,
    pc.readContract({
      address: addr,
      abi: stakingVaultAbiTyped,
      functionName: "accTicketsPerShare",
    }) as Promise<bigint>,
  ]);
  return { totalStaked, emissionRate, accTicketsPerShare };
}

async function loadTickets(pc: ReturnType<typeof client>): Promise<TicketSourceVitals | null> {
  const addr = contracts.standardTicketSource.address;
  if (!isConfigured(addr)) return null;
  const [grantDailyCap, grantUsedToday, grantDayBucket] = await Promise.all([
    pc.readContract({
      address: addr,
      abi: standardTicketSourceAbiTyped,
      functionName: "grantDailyCap",
    }) as Promise<bigint>,
    pc.readContract({
      address: addr,
      abi: standardTicketSourceAbiTyped,
      functionName: "grantUsedToday",
    }) as Promise<bigint>,
    pc.readContract({
      address: addr,
      abi: standardTicketSourceAbiTyped,
      functionName: "grantDayBucket",
    }) as Promise<bigint>,
  ]);

  const t = nowSec();
  const currentBucket = BigInt(Math.floor(t / DAY));
  const usedEffective = currentBucket === grantDayBucket ? grantUsedToday : 0n;
  const remaining = grantDailyCap > usedEffective ? grantDailyCap - usedEffective : 0n;
  const nextReset = (Math.floor(t / DAY) + 1) * DAY;
  return {
    grantDailyCap,
    grantUsedToday: usedEffective,
    grantDayBucket,
    remaining,
    secondsToReset: Math.max(0, nextReset - t),
  };
}

async function loadVesting(pc: ReturnType<typeof client>): Promise<VestingVitals | null> {
  const addr = contracts.vestingWallet.address;
  const scratch = tokens.find((t) => t.symbol === "SCRATCH");
  if (!isConfigured(addr) || !scratch || !isConfigured(scratch.address)) return null;

  const token = scratch.address;
  const [released, releasable, start, end] = await Promise.all([
    pc.readContract({
      address: addr,
      abi: vestingWalletAbiTyped,
      functionName: "released",
      args: [token],
    }) as Promise<bigint>,
    pc.readContract({
      address: addr,
      abi: vestingWalletAbiTyped,
      functionName: "releasable",
      args: [token],
    }) as Promise<bigint>,
    pc.readContract({ address: addr, abi: vestingWalletAbiTyped, functionName: "start" }) as Promise<
      bigint | number
    >,
    pc.readContract({ address: addr, abi: vestingWalletAbiTyped, functionName: "end" }) as Promise<
      bigint | number
    >,
  ]);

  const endN = Number(end);
  const [vestedToDate, totalAtEnd] = await Promise.all([
    pc.readContract({
      address: addr,
      abi: vestingWalletAbiTyped,
      functionName: "vestedAmount",
      args: [token, BigInt(nowSec())],
    }) as Promise<bigint>,
    pc.readContract({
      address: addr,
      abi: vestingWalletAbiTyped,
      functionName: "vestedAmount",
      args: [token, BigInt(endN)],
    }) as Promise<bigint>,
  ]);

  const progressBps =
    totalAtEnd === 0n ? 0 : Number((vestedToDate * 10_000n) / totalAtEnd);

  return {
    token,
    released,
    releasable,
    vestedToDate,
    totalAtEnd,
    progressBps,
    start: Number(start),
    end: endN,
  };
}

async function loadGame(pc: ReturnType<typeof client>): Promise<GameVitals | null> {
  const addr = contracts.scratchGame.address;
  if (!isConfigured(addr)) return null;

  const [randomness, pendingRandomness, randomnessSwapEta, rescueDelay] = await Promise.all([
    pc.readContract({ address: addr, abi: scratchGameAbiTyped, functionName: "randomness" }) as Promise<Address>,
    pc.readContract({
      address: addr,
      abi: scratchGameAbiTyped,
      functionName: "pendingRandomness",
    }) as Promise<Address>,
    pc.readContract({
      address: addr,
      abi: scratchGameAbiTyped,
      functionName: "randomnessSwapEta",
    }) as Promise<bigint | number>,
    pc.readContract({
      address: addr,
      abi: scratchGameAbiTyped,
      functionName: "rescueDelay",
    }) as Promise<bigint | number>,
  ]);

  const t = nowSec();
  const eta = Number(randomnessSwapEta);
  let swapStatus: GameVitals["swapStatus"] = "none";
  let secondsToEta = 0;
  let secondsToExpiry = 0;
  if (pendingRandomness !== "0x0000000000000000000000000000000000000000") {
    const expiry = eta + RANDOMNESS_SWAP_GRACE;
    secondsToEta = Math.max(0, eta - t);
    secondsToExpiry = Math.max(0, expiry - t);
    if (t >= expiry) swapStatus = "expired";
    else if (t >= eta) swapStatus = "ready";
    else swapStatus = "queued";
  }

  const rescueDelayN = Number(rescueDelay);
  let stalePendingCount = 0;
  let pendingCount = 0;

  try {
    const latest = await pc.getBlockNumber();
    // ~100ms blocks on Orbit → ~10 blocks/sec; 14 days lookback for ops visibility.
    const lookback = 14n * 24n * 60n * 60n * 10n;
    const fromBlock = latest > lookback ? latest - lookback : 0n;
    const logs = (await pc.getLogs({
      address: addr,
      event: scratchRequestedEvent,
      fromBlock,
      toBlock: latest,
    })) as Log[];

    const ids = [
      ...new Set(
        logs
          .map((l) => (l as { args?: { requestId?: bigint } }).args?.requestId)
          .filter((id): id is bigint => id !== undefined),
      ),
    ];

    const cutoff = t - rescueDelayN;
    for (const id of ids) {
      const req = (await pc.readContract({
        address: addr,
        abi: scratchGameAbiTyped,
        functionName: "requests",
        args: [id],
      })) as readonly [Address, number, number | bigint, number];
      const [, , requestedAt, status] = req;
      // Status: 0 None, 1 Pending, 2 Settled, 3 Rescued
      if (status === 1) {
        pendingCount += 1;
        if (Number(requestedAt) < cutoff) stalePendingCount += 1;
      }
    }
  } catch {
    // Log scan can fail on RPC limits; leave counts at 0.
  }

  return {
    randomness,
    pendingRandomness,
    randomnessSwapEta: eta,
    swapStatus,
    secondsToEta,
    secondsToExpiry,
    rescueDelay: rescueDelayN,
    pendingCount,
    stalePendingCount,
  };
}

async function loadPrizeTables(
  pc: ReturnType<typeof client>,
): Promise<PrizeTableSnapshot[] | null> {
  const addr = contracts.scratchGame.address;
  if (!isConfigured(addr)) return null;

  const out: PrizeTableSnapshot[] = [];
  for (const tier of [0, 1] as const) {
    const len = Number(
      (await pc.readContract({
        address: addr,
        abi: scratchGameAbiTyped,
        functionName: "tableLength",
        args: [tier],
      })) as bigint,
    );
    const rows = [];
    for (let i = 0; i < len; i++) {
      const r = (await pc.readContract({
        address: addr,
        abi: scratchGameAbiTyped,
        functionName: "getPrizeRow",
        args: [tier, BigInt(i)],
      })) as {
        asset: Address;
        amountOrBps: bigint | number;
        isBpsOfPool: boolean;
        cumOdds: number;
      };
      rows.push({
        asset: r.asset,
        amountOrBps: BigInt(r.amountOrBps),
        isBpsOfPool: r.isBpsOfPool,
        cumOdds: Number(r.cumOdds),
      });
    }
    out.push({ tier, rows });
  }
  return out;
}

async function loadVaultAssets(pc: ReturnType<typeof client>): Promise<VaultAssetMeta[]> {
  const vault = contracts.prizeVault.address;
  if (!isConfigured(vault)) return [];

  const metas: VaultAssetMeta[] = [];
  const seen = new Set<string>();

  const inventory = (await pc.readContract({
    address: vault,
    abi: prizeVaultAbiTyped,
    functionName: "inventory",
  })) as [Address[], bigint[]];

  for (let i = 0; i < inventory[0].length; i++) {
    const asset = inventory[0][i];
    seen.add(asset.toLowerCase());
    const fallbackRate = (await pc.readContract({
      address: vault,
      abi: prizeVaultAbiTyped,
      functionName: "fallbackRate",
      args: [asset],
    })) as bigint;
    metas.push({ asset, balance: inventory[1][i], fallbackRate });
  }

  for (const t of tokens) {
    if (!isConfigured(t.address) || seen.has(t.address.toLowerCase())) continue;
    const [balance, fallbackRate] = await Promise.all([
      pc.readContract({
        address: vault,
        abi: prizeVaultAbiTyped,
        functionName: "balanceOf",
        args: [t.address],
      }) as Promise<bigint>,
      pc.readContract({
        address: vault,
        abi: prizeVaultAbiTyped,
        functionName: "fallbackRate",
        args: [t.address],
      }) as Promise<bigint>,
    ]);
    metas.push({ asset: t.address, balance, fallbackRate });
  }

  return metas;
}

export function useTreasuryData() {
  const [data, setData] = useState<TreasurySnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const pc = client();
      const discovery = await discoverAllHoldings();
      const prices = await fetchPrices(discovery.addresses);
      const [holders, prizeVault, staking, tickets, vesting, game, prizeTables, vaultAssets] =
        await Promise.all([
          loadHolders(pc, prices, discovery.byHolder),
          loadPrizeVault(pc),
          loadStaking(pc),
          loadTickets(pc),
          loadVesting(pc),
          loadGame(pc),
          loadPrizeTables(pc),
          loadVaultAssets(pc),
        ]);
      setData({
        updatedAt: Date.now(),
        prices,
        holders,
        prizeVault,
        staking,
        tickets,
        vesting,
        game,
        prizeTables,
        vaultAssets,
        discoveryWarning: discovery.warning,
        error: null,
      });
    } catch (e) {
      setData((prev) => ({
        updatedAt: Date.now(),
        prices: prev?.prices ?? {
          scratchUsd: null,
          ethUsd: null,
          byToken: {},
          fetchedAt: null,
          error: null,
        },
        holders: prev?.holders ?? [],
        prizeVault: prev?.prizeVault ?? null,
        staking: prev?.staking ?? null,
        tickets: prev?.tickets ?? null,
        vesting: prev?.vesting ?? null,
        game: prev?.game ?? null,
        prizeTables: prev?.prizeTables ?? null,
        vaultAssets: prev?.vaultAssets ?? [],
        discoveryWarning: prev?.discoveryWarning ?? null,
        error: e instanceof Error ? e.message : "refresh failed",
      }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { data, loading, refresh };
}
