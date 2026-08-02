/**
 * Per-wallet SCRATCH market flow + FIFO historical USD PnL.
 *
 * Market classification:
 *  - Bought: RobinhoodSettler fills, or any SCRATCH transfer with a contract
 *    counterparty in a tx whose receipt contains a Uniswap v4 PoolManager Swap
 *  - Sold: same Swap rule on outflows
 *  - Not market: protocol vaults/games, EOA transfers, LP via PositionManager
 *    (ModifyLiquidity without Swap), settler outflows
 *
 * Pricing: GeckoTerminal daily SCRATCH/USD close at transfer time.
 * PnL = realized (FIFO) + unrealized (remaining lots vs live spot).
 */
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { contracts, isConfigured } from "@/config/addresses";
import { robinhoodChain } from "@/config/chain";
import { alchemyGetAssetTransfers, type AlchemyAssetTransfer } from "@/utils/alchemy";
import {
  ensureScratchHistoryPrices,
  scratchUsdAt,
} from "@/utils/scratchHistoryPrice";
import {
  flushPnlFillsStore,
  getWalletFills,
  loadPnlFillsStore,
  PNL_LOGIC_VERSION,
  setWalletFills,
  type StoredPnlFill,
} from "@/utils/stakerPnlFills";

const SCRATCH = getAddress("0xf5E5f4D3C34A14B2fDfD59584Fe555Cd5e21F196");

export { PNL_LOGIC_VERSION, flushPnlFillsStore };

const ROBINHOOD_SETTLERS = [
  "0x1d4b86491ec211257cbedd77a4380a7494624eff",
  "0xe72688f7d25d7318b9a81f21edda640ca948c83b",
] as const;

/** Uniswap v4 PoolManager — ERC-20 counterparty for both swaps and LP. */
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

/**
 * Known swap routers — used only as a fast-path hint when receipt fetch fails.
 * Ground truth is the PoolManager Swap log.
 */
const SWAP_ROUTERS = [
  "0x8876789976decbfcbbbe364623c63652db8c0904",
  "0x6ff5693b99212da76ad316178a184ab56d299b43",
  "0x315a93f2d325eb67d7bf3d575bc89da4b0db76ce",
  "0xbe71849c6be231b89b4f006a5d8fcfdbb201d7cb",
  "0xbfbb2bcbc9dffa029c27a249ae9be031e1d83b1c",
  "0xb0222f52b8b62c5e447e1dbe1c81f0586a7e4724",
  "0x7eaa6884b4119ace171135c321792a79f66807a3",
  "0xc6da9c87cae2fcecad79e22c398de16bfab0cfda",
  // Dag/aggregator DexRouter seen on Robinhood Chain SCRATCH fills
  "0xe58b3089df6667fbf99b75595a1671baf6797d6d",
  // Aggregator entrypoints that settle via intermediate token holders (e.g. 0x1111…)
  "0x5a705de8982235a7fa45bb83dcacf03a211389c7",
  "0x0442155fba34b0507682039624ffa0135abda435",
  "0x0ed11c595b56fbcf02917e1e0d05b34645ecf3be",
] as const;

/** Uniswap v4 PositionManager — LP mint/burn multicalls (not market trades). */
const POSITION_MANAGERS = [
  "0x58daec3116aae6d93017baaea7749052e8a04fa7",
] as const;

/**
 * ERC-4337 EntryPoints — one tx can bundle many UserOps, so a Swap log from
 * another op must not classify unrelated token moves (e.g. settler hops) as fills.
 */
const ENTRY_POINTS = [
  "0x0000000071727de22e5e9d8baf0edac6f37da032", // v0.7
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", // v0.6
] as const;

/**
 * PoolManager `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)` topic0.
 * LP path emits ModifyLiquidity instead — those must not count as buys/sells.
 */
const POOL_SWAP_TOPIC =
  "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f" as const;

export type WalletScratchFlow = {
  bought: bigint;
  sold: bigint;
  boughtUsd: number;
  soldUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  /** realized + unrealized */
  pnlUsd: number;
  transferCount: number;
  unpricedCount: number;
};

type Fill = {
  side: "buy" | "sell";
  amount: bigint;
  ts: number;
};

function protocolExcludeSet(): Set<string> {
  const addrs = [
    contracts.prizeVault.address,
    contracts.prizeVaultV2.address,
    contracts.stakingVault.address,
    contracts.stakingVaultV2.address,
    contracts.standardTicketSource.address,
    contracts.standardTicketSourceV2.address,
    contracts.scratchGame.address,
    contracts.scratchGameV2.address,
    contracts.selfEntropyProvider.address,
    contracts.selfEntropyProviderV2.address,
    contracts.vestingWallet.address,
    contracts.treasury.address,
  ];
  const set = new Set<string>();
  for (const a of addrs) {
    if (isConfigured(a)) set.add(a.toLowerCase());
  }
  set.add("0x0000000000000000000000000000000000000000");
  return set;
}

let excludeCache: Set<string> | null = null;
function exclusions(): Set<string> {
  if (!excludeCache) excludeCache = protocolExcludeSet();
  return excludeCache;
}

const settlerSet = new Set(ROBINHOOD_SETTLERS.map((a) => a.toLowerCase()));
const routerSet = new Set(SWAP_ROUTERS.map((a) => a.toLowerCase()));
const positionManagerSet = new Set(POSITION_MANAGERS.map((a) => a.toLowerCase()));
const entryPointSet = new Set(ENTRY_POINTS.map((a) => a.toLowerCase()));
const poolManager = POOL_MANAGER.toLowerCase();

function isSettler(addr: string): boolean {
  return settlerSet.has(addr.toLowerCase());
}

function isSwapRouter(addr: string): boolean {
  return routerSet.has(addr.toLowerCase());
}

function isEntryPoint(addr: string | null): boolean {
  return addr != null && entryPointSet.has(addr.toLowerCase());
}

function isPoolManagerAddr(addr: string): boolean {
  return addr.toLowerCase() === poolManager;
}

function client(): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(robinhoodChain.rpcUrls.default.http[0], {
      timeout: 30_000,
      retryCount: 1,
    }),
  });
}

type TxMeta = {
  to: string | null;
  hasPoolSwap: boolean;
  fetched: boolean;
};
const txMetaCache = new Map<string, TxMeta>();
const contractCache = new Map<string, boolean>();

async function isContract(pc: PublicClient, addr: string): Promise<boolean> {
  const key = addr.toLowerCase();
  const hit = contractCache.get(key);
  if (hit != null) return hit;
  // Known venues — skip bytecode fetch.
  if (
    key === poolManager ||
    routerSet.has(key) ||
    positionManagerSet.has(key) ||
    settlerSet.has(key)
  ) {
    contractCache.set(key, true);
    return true;
  }
  try {
    const code = await pc.getBytecode({ address: getAddress(key) });
    const ok = Boolean(code && code !== "0x");
    contractCache.set(key, ok);
    return ok;
  } catch {
    contractCache.set(key, false);
    return false;
  }
}

async function loadTxMeta(pc: PublicClient, hash: string): Promise<TxMeta> {
  const key = hash.toLowerCase();
  const hit = txMetaCache.get(key);
  if (hit) return hit;

  const [tx, receipt] = await Promise.all([
    pc.getTransaction({ hash: hash as Hash }).catch(() => null),
    pc.getTransactionReceipt({ hash: hash as Hash }).catch(() => null),
  ]);

  const to = tx?.to ? tx.to.toLowerCase() : null;
  let hasPoolSwap = false;
  if (receipt) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== poolManager) continue;
      if ((log.topics[0] || "").toLowerCase() === POOL_SWAP_TOPIC) {
        hasPoolSwap = true;
        break;
      }
    }
  }

  const meta: TxMeta = { to, hasPoolSwap, fetched: Boolean(tx || receipt) };
  txMetaCache.set(key, meta);
  return meta;
}

/**
 * True when this SCRATCH transfer is a market buy/sell (not LP / protocol / EOA transfer).
 */
async function isMarketFill(
  pc: PublicClient,
  t: AlchemyAssetTransfer,
  counterparty: string,
  side: "buy" | "sell",
): Promise<boolean> {
  // Settler: inbound CCA fills only. Outbound settler hops are never sells (often AA-bundled).
  if (isSettler(counterparty)) return side === "buy";

  // Plain wallet↔wallet transfers are never market fills.
  if (!(await isContract(pc, counterparty))) return false;

  if (!t.hash) {
    return isSwapRouter(counterparty) || isPoolManagerAddr(counterparty);
  }

  const meta = await loadTxMeta(pc, t.hash);

  // LP mint/burn via PositionManager must never count, even if a Swap sneaks into the multicall.
  if (meta.to && positionManagerSet.has(meta.to)) return false;

  if (meta.hasPoolSwap) {
    // EntryPoint bundles many UserOps — only count transfers that touch a swap venue.
    if (isEntryPoint(meta.to)) {
      return isPoolManagerAddr(counterparty) || isSwapRouter(counterparty);
    }
    // Normal (non-AA) txs: Swap + contract counterparty covers aggregator legs (0x1111…).
    return true;
  }

  // Receipt missing/failed: fall back to allowlisted venues.
  if (!meta.fetched) {
    if (isSwapRouter(counterparty) || isPoolManagerAddr(counterparty)) return true;
    if (meta.to && isSwapRouter(meta.to)) return true;
  }

  return false;
}

function weiToHuman(amount: bigint): number {
  return Number(formatUnits(amount, 18));
}

export type FetchWalletScratchFlowOpts = {
  /**
   * `incremental` (default): load cached fills, pull Transfers only after
   * `transfersThroughBlock`, merge + recompute.
   * `mark`: recompute unrealized from cached fills + live spot; no Alchemy.
   */
  mode?: "incremental" | "mark";
};

function fifoFromFills(
  fills: Fill[],
  liveSpotUsd: number | null,
): Omit<WalletScratchFlow, "transferCount"> & { transferCount: number } {
  fills.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.side === b.side) return 0;
    return a.side === "buy" ? -1 : 1;
  });

  type Lot = { amount: bigint; costUsd: number };
  const lots: Lot[] = [];
  let bought = 0n;
  let sold = 0n;
  let boughtUsd = 0;
  let soldUsd = 0;
  let realizedPnlUsd = 0;
  let unpricedCount = 0;

  for (const f of fills) {
    const px = scratchUsdAt(f.ts);
    if (px == null) {
      unpricedCount += 1;
      if (f.side === "buy") bought += f.amount;
      else sold += f.amount;
      continue;
    }
    const human = weiToHuman(f.amount);
    if (f.side === "buy") {
      bought += f.amount;
      const cost = human * px;
      boughtUsd += cost;
      lots.push({ amount: f.amount, costUsd: cost });
    } else {
      sold += f.amount;
      const proceeds = human * px;
      soldUsd += proceeds;
      let remain = f.amount;
      let costOfSold = 0;
      while (remain > 0n && lots.length > 0) {
        const lot = lots[0];
        if (lot.amount <= remain) {
          costOfSold += lot.costUsd;
          remain -= lot.amount;
          lots.shift();
        } else {
          const frac = Number(formatUnits(remain, 18)) / Number(formatUnits(lot.amount, 18));
          const sliceCost = lot.costUsd * frac;
          costOfSold += sliceCost;
          lot.costUsd -= sliceCost;
          lot.amount -= remain;
          remain = 0n;
        }
      }
      realizedPnlUsd += proceeds - costOfSold;
    }
  }

  let remainingAmount = 0n;
  let remainingCost = 0;
  for (const lot of lots) {
    remainingAmount += lot.amount;
    remainingCost += lot.costUsd;
  }

  let unrealizedPnlUsd = 0;
  if (
    remainingAmount > 0n &&
    liveSpotUsd != null &&
    Number.isFinite(liveSpotUsd) &&
    liveSpotUsd > 0
  ) {
    unrealizedPnlUsd = weiToHuman(remainingAmount) * liveSpotUsd - remainingCost;
  }

  return {
    bought,
    sold,
    boughtUsd,
    soldUsd,
    realizedPnlUsd,
    unrealizedPnlUsd,
    pnlUsd: realizedPnlUsd + unrealizedPnlUsd,
    transferCount: fills.length,
    unpricedCount,
  };
}

function storedToFills(rows: StoredPnlFill[]): Fill[] {
  return rows.map((r) => ({
    side: r.side,
    amount: BigInt(r.amount),
    ts: r.ts,
  }));
}

function fillsToStored(fills: Fill[]): StoredPnlFill[] {
  return fills.map((f) => ({
    side: f.side,
    amount: f.amount.toString(),
    ts: f.ts,
  }));
}

/**
 * Sum market SCRATCH bought/sold and FIFO USD PnL for `wallet`.
 * Uses persisted fills when present; Alchemy Transfers only for new blocks.
 */
export async function fetchWalletScratchFlow(
  wallet: Address,
  liveSpotUsd: number | null,
  opts: FetchWalletScratchFlowOpts = {},
): Promise<WalletScratchFlow> {
  await ensureScratchHistoryPrices();
  const mode = opts.mode ?? "incremental";
  const store = await loadPnlFillsStore();
  const cached = getWalletFills(store, wallet);

  if (mode === "mark") {
    if (!cached) {
      return fetchWalletScratchFlow(wallet, liveSpotUsd, { mode: "incremental" });
    }
    return fifoFromFills(storedToFills(cached.fills), liveSpotUsd);
  }

  const skip = exclusions();
  const pc = client();
  const tip = Number(await pc.getBlockNumber());
  const fromBlock =
    cached && cached.transfersThroughBlock >= 0
      ? cached.transfersThroughBlock + 1
      : 0;

  const fills: Fill[] = cached ? storedToFills(cached.fills) : [];

  if (fromBlock <= tip) {
    const transferOpts = {
      contractAddresses: [SCRATCH] as Address[],
      fromBlock,
      maxPages: fromBlock === 0 ? 50 : 10,
    };
    const [inbounds, outbounds] = await Promise.all([
      alchemyGetAssetTransfers({
        ...transferOpts,
        toAddress: wallet,
      }),
      alchemyGetAssetTransfers({
        ...transferOpts,
        fromAddress: wallet,
      }),
    ]);

    for (const t of inbounds) {
      const from = t.from;
      const value = t.rawValue;
      if (value === 0n) continue;
      if (skip.has(from)) continue;
      if (await isMarketFill(pc, t, from, "buy")) {
        fills.push({ side: "buy", amount: value, ts: t.blockTimestamp });
      }
    }

    for (const t of outbounds) {
      const to = (t.to || "").toLowerCase();
      const value = t.rawValue;
      if (value === 0n) continue;
      if (!to || skip.has(to)) continue;
      if (await isMarketFill(pc, t, to, "sell")) {
        fills.push({ side: "sell", amount: value, ts: t.blockTimestamp });
      }
    }
  }

  // Dedupe fills by side+amount+ts (re-fetch overlapping tip).
  const seen = new Set<string>();
  const deduped: Fill[] = [];
  for (const f of fills) {
    const key = `${f.side}:${f.amount.toString()}:${f.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }

  const flow = fifoFromFills(deduped, liveSpotUsd);
  setWalletFills(store, wallet, {
    transfersThroughBlock: tip,
    fills: fillsToStored(deduped),
    logicVersion: PNL_LOGIC_VERSION,
  });

  return flow;
}

export { SCRATCH as SCRATCH_TOKEN };
