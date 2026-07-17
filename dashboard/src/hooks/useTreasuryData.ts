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
import { ethUsd, fetchPrices, tokenUsd, type PriceMap } from "@/utils/prices";

const SWEEP_GRACE = 24 * 60 * 60;
const RANDOMNESS_SWAP_GRACE = 24 * 60 * 60;
const DAY = 24 * 60 * 60;

const scratchRequestedEvent = parseAbiItem(
  "event ScratchRequested(address indexed user, uint256 indexed requestId, uint8 tier)",
);

export type HolderBalances = {
  holder: (typeof balanceHolders)[number];
  eth: bigint;
  ethUsd: number | null;
  tokens: {
    symbol: string;
    address: Address;
    amount: bigint;
    decimals: number;
    usd: number | null;
  }[];
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
  stalePendingCount: number;
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

async function loadHolders(pc: ReturnType<typeof client>, prices: PriceMap) {
  const configuredTokens = tokens.filter((t) => isConfigured(t.address));
  const holders: HolderBalances[] = [];

  for (const holder of balanceHolders) {
    if (!isConfigured(holder.address)) {
      holders.push({
        holder,
        eth: 0n,
        ethUsd: null,
        tokens: configuredTokens.map((t) => ({
          symbol: t.symbol,
          address: t.address,
          amount: 0n,
          decimals: t.decimals,
          usd: null,
        })),
      });
      continue;
    }

    const eth = await pc.getBalance({ address: holder.address });
    const tokenRows = [];
    for (const t of configuredTokens) {
      const amount = (await pc.readContract({
        address: t.address,
        abi: erc20AbiTyped,
        functionName: "balanceOf",
        args: [holder.address],
      })) as bigint;
      tokenRows.push({
        symbol: t.symbol,
        address: t.address,
        amount,
        decimals: t.decimals,
        usd: tokenUsd(t, amount, prices),
      });
    }
    holders.push({
      holder,
      eth,
      ethUsd: ethUsd(eth, prices),
      tokens: tokenRows,
    });
  }
  return holders;
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
      if (status === 1 && Number(requestedAt) < cutoff) {
        stalePendingCount += 1;
      }
    }
  } catch {
    // Log scan can fail on RPC limits; leave count at 0 and surface via vitals still.
  }

  return {
    randomness,
    pendingRandomness,
    randomnessSwapEta: eta,
    swapStatus,
    secondsToEta,
    secondsToExpiry,
    rescueDelay: rescueDelayN,
    stalePendingCount,
  };
}

export function useTreasuryData() {
  const [data, setData] = useState<TreasurySnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const pc = client();
      const prices = await fetchPrices();
      const [holders, prizeVault, staking, tickets, vesting, game] = await Promise.all([
        loadHolders(pc, prices),
        loadPrizeVault(pc),
        loadStaking(pc),
        loadTickets(pc),
        loadVesting(pc),
        loadGame(pc),
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
        error: null,
      });
    } catch (e) {
      setData((prev) => ({
        updatedAt: Date.now(),
        prices: prev?.prices ?? {
          scratchUsd: null,
          ethUsd: null,
          fetchedAt: null,
          error: null,
        },
        holders: prev?.holders ?? [],
        prizeVault: prev?.prizeVault ?? null,
        staking: prev?.staking ?? null,
        tickets: prev?.tickets ?? null,
        vesting: prev?.vesting ?? null,
        game: prev?.game ?? null,
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
