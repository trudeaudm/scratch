"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type Hash,
  type Log,
} from "viem";
import {
  balanceHolders,
  configuredPrizeVaults,
  contracts,
  activeScratchGame,
  activeStakingVault,
  activeStandardTicketSource,
  findTokenConfig,
  isConfigured,
  tokens,
  type ContractEntry,
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

/** Fallback if on-chain SWEEP_* reads fail — matches PrizeVault.sol. */
const SWEEP_DELAY_DEFAULT = 48 * 60 * 60;
const SWEEP_GRACE_DEFAULT = 24 * 60 * 60;
const RANDOMNESS_SWAP_GRACE = 24 * 60 * 60;
const DAY = 24 * 60 * 60;

const scratchRequestedEvent = parseAbiItem(
  "event ScratchRequested(address indexed user, uint256 indexed requestId, uint8 tier)",
);
const sweepQueuedEvent = parseAbiItem(
  "event SweepQueued(uint256 indexed id, address indexed asset, address indexed to, uint64 eta)",
);
const sweepExecutedEvent = parseAbiItem(
  "event SweepExecuted(uint256 indexed id, address indexed asset, address indexed to, uint256 amount)",
);
const sweepCancelledEvent = parseAbiItem(
  "event SweepCancelled(uint256 indexed id)",
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
  /** Resolved symbol for cancel typed-confirm + display. */
  symbol: string;
};

export type SweepHistoryRow = {
  kind: "SweepQueued" | "SweepExecuted" | "SweepCancelled";
  id: bigint;
  asset: Address | null;
  to: Address | null;
  eta: number | null;
  amount: bigint | null;
  symbol: string | null;
  txHash: Hash;
  blockNumber: bigint;
};

export type PrizeVaultInventoryRow = {
  asset: Address;
  balance: bigint;
  symbol: string;
  decimals: number;
  usd: number | null;
  verified: boolean;
  kind: "crypto" | "stock";
  ticker?: string;
};

export type PrizeVaultVitals = {
  config: ContractEntry;
  inventory: PrizeVaultInventoryRow[];
  sweeps: SweepRow[];
  history: SweepHistoryRow[];
  sweepDelay: number;
  sweepGrace: number;
};

export type StakingVitals = {
  config: ContractEntry;
  /** v1: totalStaked. v2: totalWeight (eligible weight pool). */
  totalStaked: bigint;
  /** Display label for the primary total metric. */
  totalLabel: "totalStaked" | "totalWeight";
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
  /**
   * PrizeVault wired to `activeScratchGame()` (via on-chain `prizeVault()`).
   * Used for fund / prize-table backing. Full inventory of both vaults is in `prizeVaults`.
   */
  prizeVault: PrizeVaultVitals | null;
  /** All configured PrizeVault instances (v1 and/or v2). */
  prizeVaults: PrizeVaultVitals[];
  /** Address returned by active game's `prizeVault()` — source of `vaultAssets`. */
  gamePrizeVault: Address | null;
  staking: StakingVitals | null;
  tickets: TicketSourceVitals | null;
  vesting: VestingVitals | null;
  game: GameVitals | null;
  prizeTables: PrizeTableSnapshot[] | null;
  /** Balances + fallbackRate from the vault linked to the active ScratchGame. */
  vaultAssets: VaultAssetMeta[];
  /** Set when Blockscout tokenlist failed — holdings fell back to config-only. */
  discoveryWarning: string | null;
  error: string | null;
};

function client() {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(robinhoodChain.rpcUrls.default.http[0], {
      timeout: 20_000,
      retryCount: 1,
    }),
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

  return Promise.all(
    balanceHolders
      .filter((holder) => isConfigured(holder.address))
      .map(async (holder) => {
        const eth = await pc.getBalance({ address: holder.address });
        const byAddr = new Map<string, HoldingToken>();

        await Promise.all(
          configuredTokens.map(async (t) => {
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
            // Prefer config decimals — skip per-holder on-chain decimals RPC.
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
          }),
        );

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

        return {
          holder,
          eth,
          ethUsd: ethUsd(eth, prices),
          tokens: tokenRows,
        };
      }),
  );
}

/** One Blockscout pass for all holders — feeds Dex pricing and holding merge. */
async function discoverAllHoldings(): Promise<{
  byHolder: Map<string, DiscoveredBag[]>;
  addresses: Address[];
  warning: string | null;
}> {
  const byHolder = new Map<string, DiscoveredBag[]>();
  const addrs = new Set<string>();
  const holders = balanceHolders.filter((h) => isConfigured(h.address));
  // Sequential — parallel tokenlist stamps Blockscout into 429s every refresh.
  const results: {
    holder: (typeof balanceHolders)[number];
    list: Awaited<ReturnType<typeof fetchBlockscoutTokenList>>;
    error: string | null;
  }[] = [];
  for (const holder of holders) {
    try {
      const list = await fetchBlockscoutTokenList(holder.address);
      results.push({ holder, list, error: null });
    } catch (e) {
      results.push({
        holder,
        list: [],
        error: e instanceof Error ? e.message : "Blockscout tokenlist failed",
      });
    }
  }

  let warning: string | null = null;
  for (const r of results) {
    if (r.error) {
      warning = `Blockscout token discovery failed (${r.error}) — showing config tokens only`;
      continue;
    }
    byHolder.set(
      r.holder.address.toLowerCase(),
      r.list.map((t) => ({
        address: t.address,
        balance: t.balance,
        symbol: t.symbol,
        decimals: t.decimals,
      })),
    );
    for (const t of r.list) {
      if (!findTokenConfig(t.address)) addrs.add(t.address.toLowerCase());
    }
  }
  return { byHolder, addresses: [...addrs] as Address[], warning };
}

async function resolveAssetSymbol(
  pc: ReturnType<typeof client>,
  asset: Address,
): Promise<string> {
  const known = tokens.find((t) => t.address.toLowerCase() === asset.toLowerCase());
  if (known) return known.symbol;
  try {
    return (await pc.readContract({
      address: asset,
      abi: erc20AbiTyped,
      functionName: "symbol",
    })) as string;
  } catch {
    return asset.slice(0, 6) + "…";
  }
}

async function loadSweepHistory(
  pc: ReturnType<typeof client>,
  addr: Address,
): Promise<SweepHistoryRow[]> {
  try {
    const latest = await pc.getBlockNumber();
    // Alchemy caps eth_getLogs at 10k blocks.
    const lookback = 9_000n;
    const fromBlock = latest > lookback ? latest - lookback : 0n;
    const [queued, executed, cancelled] = await Promise.all([
      pc.getLogs({ address: addr, event: sweepQueuedEvent, fromBlock, toBlock: latest }) as Promise<
        Log[]
      >,
      pc.getLogs({
        address: addr,
        event: sweepExecutedEvent,
        fromBlock,
        toBlock: latest,
      }) as Promise<Log[]>,
      pc.getLogs({
        address: addr,
        event: sweepCancelledEvent,
        fromBlock,
        toBlock: latest,
      }) as Promise<Log[]>,
    ]);

    type Raw = {
      kind: SweepHistoryRow["kind"];
      id: bigint;
      asset: Address | null;
      to: Address | null;
      eta: number | null;
      amount: bigint | null;
      txHash: Hash;
      blockNumber: bigint;
    };
    const rows: Raw[] = [];

    for (const l of queued) {
      const args = (l as { args?: { id?: bigint; asset?: Address; to?: Address; eta?: bigint | number } })
        .args;
      if (args?.id === undefined || !l.transactionHash || l.blockNumber === null) continue;
      rows.push({
        kind: "SweepQueued",
        id: args.id,
        asset: args.asset ?? null,
        to: args.to ?? null,
        eta: args.eta !== undefined ? Number(args.eta) : null,
        amount: null,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
      });
    }
    for (const l of executed) {
      const args = (
        l as { args?: { id?: bigint; asset?: Address; to?: Address; amount?: bigint } }
      ).args;
      if (args?.id === undefined || !l.transactionHash || l.blockNumber === null) continue;
      rows.push({
        kind: "SweepExecuted",
        id: args.id,
        asset: args.asset ?? null,
        to: args.to ?? null,
        eta: null,
        amount: args.amount ?? null,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
      });
    }
    for (const l of cancelled) {
      const args = (l as { args?: { id?: bigint } }).args;
      if (args?.id === undefined || !l.transactionHash || l.blockNumber === null) continue;
      rows.push({
        kind: "SweepCancelled",
        id: args.id,
        asset: null,
        to: null,
        eta: null,
        amount: null,
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
      });
    }

    rows.sort((a, b) => {
      if (a.blockNumber === b.blockNumber) return Number(b.id - a.id);
      return a.blockNumber > b.blockNumber ? -1 : 1;
    });

    const symbolCache = new Map<string, string>();
    const out: SweepHistoryRow[] = [];
    for (const r of rows) {
      let symbol: string | null = null;
      if (r.asset) {
        const key = r.asset.toLowerCase();
        if (!symbolCache.has(key)) {
          symbolCache.set(key, await resolveAssetSymbol(pc, r.asset));
        }
        symbol = symbolCache.get(key)!;
      }
      out.push({ ...r, symbol });
    }
    return out;
  } catch {
    return [];
  }
}

async function loadPrizeVault(
  pc: ReturnType<typeof client>,
  config: ContractEntry,
  discovered: Map<string, DiscoveredBag[]>,
  prices: PriceMap,
): Promise<PrizeVaultVitals | null> {
  const addr = config.address;
  if (!isConfigured(addr)) return null;

  /**
   * Same merge as Balances holders: on-chain inventory() (tracked via fund) +
   * every config token's ERC-20 balanceOf(vault) + Blockscout tokenlist extras.
   * inventory() alone misses assets transferred in without fund().
   */
  const byAddr = new Map<string, PrizeVaultInventoryRow>();

  try {
    const [assets, balances] = (await pc.readContract({
      address: addr,
      abi: prizeVaultAbiTyped,
      functionName: "inventory",
    })) as [Address[], bigint[]];
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const cfg = findTokenConfig(asset);
      const decimals = cfg?.decimals ?? 18;
      const symbol = cfg
        ? cfg.kind === "stock" && cfg.ticker
          ? cfg.ticker
          : cfg.symbol
        : await resolveAssetSymbol(pc, asset);
      const unit = unitPriceFor(asset, prices);
      byAddr.set(asset.toLowerCase(), {
        asset,
        balance: balances[i],
        symbol,
        decimals,
        usd: amountUsd(balances[i], decimals, unit),
        verified: Boolean(cfg),
        kind: cfg?.kind ?? "crypto",
        ticker: cfg?.ticker,
      });
    }
  } catch {
    /* continue with config + discovery */
  }

  const configuredTokens = tokens.filter((t) => isConfigured(t.address));
  await Promise.all(
    configuredTokens.map(async (t) => {
      const key = t.address.toLowerCase();
      let balance = 0n;
      try {
        balance = (await pc.readContract({
          address: addr,
          abi: prizeVaultAbiTyped,
          functionName: "balanceOf",
          args: [t.address],
        })) as bigint;
      } catch {
        return;
      }
      const unit = unitPriceFor(t.address, prices);
      const symbol = t.kind === "stock" && t.ticker ? t.ticker : t.symbol;
      const prev = byAddr.get(key);
      // Prefer live balanceOf; keep the higher of inventory vs balanceOf if both exist.
      const merged = prev && prev.balance > balance ? prev.balance : balance;
      byAddr.set(key, {
        asset: t.address,
        balance: merged,
        symbol,
        decimals: t.decimals,
        usd: amountUsd(merged, t.decimals, unit),
        verified: true,
        kind: t.kind ?? "crypto",
        ticker: t.ticker,
      });
    }),
  );

  for (const d of discovered.get(addr.toLowerCase()) ?? []) {
    const key = d.address.toLowerCase();
    if (byAddr.has(key)) continue;
    const unit = unitPriceFor(d.address, prices);
    byAddr.set(key, {
      asset: d.address,
      balance: d.balance,
      symbol: d.symbol,
      decimals: d.decimals,
      usd: amountUsd(d.balance, d.decimals, unit),
      verified: false,
      kind: "crypto",
    });
  }

  const inventory = [...byAddr.values()]
    .filter((r) => r.balance > 0n)
    .sort((a, b) => {
      if (a.verified !== b.verified) return a.verified ? -1 : 1;
      return a.symbol.localeCompare(b.symbol);
    });

  let sweepDelay = SWEEP_DELAY_DEFAULT;
  let sweepGrace = SWEEP_GRACE_DEFAULT;
  try {
    const [d, g] = await Promise.all([
      pc.readContract({
        address: addr,
        abi: prizeVaultAbiTyped,
        functionName: "SWEEP_DELAY",
      }) as Promise<bigint | number>,
      pc.readContract({
        address: addr,
        abi: prizeVaultAbiTyped,
        functionName: "SWEEP_GRACE",
      }) as Promise<bigint | number>,
    ]);
    sweepDelay = Number(d);
    sweepGrace = Number(g);
  } catch {
    /* keep defaults */
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
    const expiry = eta + sweepGrace;
    let status: SweepRow["status"] = "queued";
    if (t >= expiry) status = "expired";
    else if (t >= eta) status = "ready";
    const symbol = await resolveAssetSymbol(pc, asset);
    sweeps.push({
      id,
      asset,
      to,
      eta,
      pending,
      status,
      secondsToEta: Math.max(0, eta - t),
      secondsToExpiry: Math.max(0, expiry - t),
      symbol,
    });
  }

  const history = await loadSweepHistory(pc, addr);
  return { config, inventory, sweeps, history, sweepDelay, sweepGrace };
}

async function loadAllPrizeVaults(
  pc: ReturnType<typeof client>,
  discovered: Map<string, DiscoveredBag[]>,
  prices: PriceMap,
): Promise<PrizeVaultVitals[]> {
  const configs = configuredPrizeVaults();
  const results = await Promise.all(
    configs.map((c) => loadPrizeVault(pc, c, discovered, prices)),
  );
  return results.filter((v): v is PrizeVaultVitals => v !== null);
}

async function loadStaking(pc: ReturnType<typeof client>): Promise<StakingVitals | null> {
  const config = activeStakingVault();
  const addr = config.address;
  if (!isConfigured(addr)) return null;

  if (config.key === "stakingVaultV2") {
    // StakingVault.json is v1 — read v2 surface via minimal ABI fragments.
    const v2Abi = [
      parseAbiItem("function totalWeight() view returns (uint256)"),
      parseAbiItem("function emissionRate() view returns (uint256)"),
      parseAbiItem("function accTicketsPerShare() view returns (uint256)"),
    ] as const;
    const [totalWeight, emissionRate, accTicketsPerShare] = await Promise.all([
      pc.readContract({
        address: addr,
        abi: v2Abi,
        functionName: "totalWeight",
      }) as Promise<bigint>,
      pc.readContract({
        address: addr,
        abi: v2Abi,
        functionName: "emissionRate",
      }) as Promise<bigint>,
      pc.readContract({
        address: addr,
        abi: v2Abi,
        functionName: "accTicketsPerShare",
      }) as Promise<bigint>,
    ]);
    return {
      config,
      totalStaked: totalWeight,
      totalLabel: "totalWeight",
      emissionRate,
      accTicketsPerShare,
    };
  }

  const [totalStaked, emissionRate, accTicketsPerShare] = await Promise.all([
    pc.readContract({
      address: addr,
      abi: stakingVaultAbiTyped,
      functionName: "totalStaked",
    }) as Promise<bigint>,
    pc.readContract({
      address: addr,
      abi: stakingVaultAbiTyped,
      functionName: "emissionRate",
    }) as Promise<bigint>,
    pc.readContract({
      address: addr,
      abi: stakingVaultAbiTyped,
      functionName: "accTicketsPerShare",
    }) as Promise<bigint>,
  ]);
  return {
    config,
    totalStaked,
    totalLabel: "totalStaked",
    emissionRate,
    accTicketsPerShare,
  };
}

async function loadTickets(pc: ReturnType<typeof client>): Promise<TicketSourceVitals | null> {
  const addr = activeStandardTicketSource().address;
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
  const addr = activeScratchGame().address;
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
    // Alchemy caps eth_getLogs at 10k blocks — keep a short recent window for pending ops.
    const lookback = 9_000n;
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
    const statuses = await Promise.all(
      ids.map(async (id) => {
        const req = (await pc.readContract({
          address: addr,
          abi: scratchGameAbiTyped,
          functionName: "requests",
          args: [id],
        })) as readonly [Address, number, number | bigint, number];
        return { requestedAt: Number(req[2]), status: req[3] };
      }),
    );
    for (const s of statuses) {
      // Status: 0 None, 1 Pending, 2 Settled, 3 Rescued
      if (s.status === 1) {
        pendingCount += 1;
        if (s.requestedAt < cutoff) stalePendingCount += 1;
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
  const addr = activeScratchGame().address;
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

/**
 * Resolve the PrizeVault wired to a ScratchGame via on-chain `prizeVault()`.
 * This is the only correct source for table backing / bps / 10% checks.
 */
async function resolveGamePrizeVault(
  pc: ReturnType<typeof client>,
  gameAddr: Address,
): Promise<Address | null> {
  if (!isConfigured(gameAddr)) return null;
  try {
    const vault = (await pc.readContract({
      address: gameAddr,
      abi: scratchGameAbiTyped,
      functionName: "prizeVault",
    })) as Address;
    return isConfigured(vault) ? vault : null;
  } catch {
    return null;
  }
}

async function loadVaultAssets(
  pc: ReturnType<typeof client>,
  vault: Address | null,
  discovered: Map<string, DiscoveredBag[]>,
): Promise<VaultAssetMeta[]> {
  if (!vault || !isConfigured(vault)) return [];

  const metas: VaultAssetMeta[] = [];
  const seen = new Set<string>();

  try {
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
  } catch {
    /* config + discovery still apply */
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
    seen.add(t.address.toLowerCase());
    metas.push({ asset: t.address, balance, fallbackRate });
  }

  for (const d of discovered.get(vault.toLowerCase()) ?? []) {
    const key = d.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let fallbackRate = 0n;
    try {
      fallbackRate = (await pc.readContract({
        address: vault,
        abi: prizeVaultAbiTyped,
        functionName: "fallbackRate",
        args: [d.address],
      })) as bigint;
    } catch {
      /* */
    }
    metas.push({ asset: d.address, balance: d.balance, fallbackRate });
  }

  return metas;
}

export function useTreasuryData() {
  const [data, setData] = useState<TreasurySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const inflightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    // Single-flight: overlapping 30s polls were stacking thousands of RPC calls.
    if (inflightRef.current) return inflightRef.current;

    const run = (async () => {
      setLoading(true);
      try {
        const pc = client();
        const discovery = await discoverAllHoldings();
        const prices = await fetchPrices(discovery.addresses);
        const gameAddr = activeScratchGame().address;
        const gamePrizeVault = await resolveGamePrizeVault(pc, gameAddr);
        const [holders, prizeVaults, staking, tickets, vesting, game, prizeTables, vaultAssets] =
          await Promise.all([
            loadHolders(pc, prices, discovery.byHolder),
            loadAllPrizeVaults(pc, discovery.byHolder, prices),
            loadStaking(pc),
            loadTickets(pc),
            loadVesting(pc),
            loadGame(pc),
            loadPrizeTables(pc),
            loadVaultAssets(pc, gamePrizeVault, discovery.byHolder),
          ]);
        const prizeVault =
          (gamePrizeVault
            ? prizeVaults.find(
                (v) => v.config.address.toLowerCase() === gamePrizeVault.toLowerCase(),
              )
            : null) ?? null;
        setData({
          updatedAt: Date.now(),
          prices,
          holders,
          prizeVault,
          prizeVaults,
          gamePrizeVault,
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
          prizeVaults: prev?.prizeVaults ?? [],
          gamePrizeVault: prev?.gamePrizeVault ?? null,
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
        inflightRef.current = null;
      }
    })();

    inflightRef.current = run;
    return run;
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { data, loading, refresh };
}
