import { NextResponse } from "next/server";
import {
  createPublicClient,
  fallback,
  formatUnits,
  http,
  parseAbiItem,
  type Address,
  zeroAddress,
} from "viem";
import {
  EXPLORER_BASE,
  activeGameDeployBlock,
  activeScratchGame,
} from "@/config/addresses";
import { robinhoodChain } from "@/config/chain";
import { defaultLedgerPath, readLedgerFile, type LedgerRow } from "@/utils/payoutLedger";
import { syncMissingLedgerRows } from "@/utils/syncLedger";
import { resolveTokenMetaBatch, type TokenMeta } from "@/utils/tokenMeta";

const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SCRATCH_SETTLED = parseAbiItem(
  "event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 tier, uint256 rowIndex, address asset, uint256 amount)",
);

const LOG_CHUNK = BigInt(9000);
/** Soft TTL only used to skip duplicate work within the same second; state is incremental. */
const CHAIN_CACHE_TTL_MS = 15_000;
const STALE_MS = 5 * 60 * 1000;

type AssetAgg = {
  asset: Address;
  symbol: string;
  rawTotal: string;
  humanTotal: string;
  usdTotal: number | null;
};

type ChainSettlement = {
  requestId: string;
  user: Address;
  tier: number;
  rowIndex: string;
  asset: Address;
  amount: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
};

type ChainAgg = {
  wins: number;
  noWins: number;
  rawByAsset: Map<string, bigint>;
  newestBlock: bigint | null;
  newestTxHash: `0x${string}` | null;
  settlements: ChainSettlement[];
  error: string | null;
  scannedThrough: bigint | null;
};

/**
 * Incremental settlement cache — full history once per process, then only
 * getLogs(scannedThrough+1 → latest). Avoids 60–80s full rescans that caused
 * the local ledger to lag Render by hours.
 */
let chainState: {
  game: Address;
  at: number;
  scannedThrough: bigint;
  byRequestId: Map<string, ChainSettlement>;
  wins: number;
  noWins: number;
  rawByAsset: Map<string, bigint>;
  newestBlock: bigint | null;
  newestTxHash: `0x${string}` | null;
} | null = null;

function emptyRawByAsset(): Map<string, bigint> {
  return new Map();
}

function applySettlement(
  state: NonNullable<typeof chainState>,
  s: ChainSettlement,
): void {
  if (state.byRequestId.has(s.requestId)) return;
  state.byRequestId.set(s.requestId, s);
  if (state.newestBlock == null || s.blockNumber > state.newestBlock) {
    state.newestBlock = s.blockNumber;
    state.newestTxHash = s.txHash;
  }
  if (s.amount === BigInt(0) || s.asset === zeroAddress) {
    state.noWins += 1;
  } else {
    state.wins += 1;
    state.rawByAsset.set(s.asset, (state.rawByAsset.get(s.asset) ?? BigInt(0)) + s.amount);
  }
}

async function loadChainAgg(): Promise<ChainAgg> {
  if (chainState && Date.now() - chainState.at < CHAIN_CACHE_TTL_MS) {
    return {
      wins: chainState.wins,
      noWins: chainState.noWins,
      rawByAsset: new Map(chainState.rawByAsset),
      newestBlock: chainState.newestBlock,
      newestTxHash: chainState.newestTxHash,
      settlements: [...chainState.byRequestId.values()],
      error: null,
      scannedThrough: chainState.scannedThrough,
    };
  }

  const deployBlock = activeGameDeployBlock();
  const game = activeScratchGame().address;
  // Prefer public RPC; Alchemy is not needed for payout getLogs.
  const primary = process.env.NEXT_PUBLIC_RPC_URL?.trim() || PUBLIC_RPC;
  const urls =
    primary === PUBLIC_RPC || primary.includes("alchemy.com")
      ? [PUBLIC_RPC]
      : [primary, PUBLIC_RPC];

  const client = createPublicClient({
    chain: robinhoodChain,
    transport: fallback(urls.map((url) => http(url, { timeout: 20_000 }))),
  });

  if (chainState && chainState.game.toLowerCase() !== game.toLowerCase()) {
    chainState = null;
  }

  if (!chainState) {
    chainState = {
      game,
      at: 0,
      scannedThrough: deployBlock - BigInt(1),
      byRequestId: new Map(),
      wins: 0,
      noWins: 0,
      rawByAsset: emptyRawByAsset(),
      newestBlock: null,
      newestTxHash: null,
    };
  }

  let error: string | null = null;
  try {
    const latest = await client.getBlockNumber();
    let start = chainState.scannedThrough + BigInt(1);
    if (start > latest) {
      chainState.at = Date.now();
    } else {
      for (; start <= latest; start += LOG_CHUNK) {
        const end = start + LOG_CHUNK - BigInt(1) > latest ? latest : start + LOG_CHUNK - BigInt(1);
        const logs = await client.getLogs({
          address: game,
          event: SCRATCH_SETTLED,
          fromBlock: start,
          toBlock: end,
        });
        for (const log of logs) {
          const amount = log.args.amount ?? BigInt(0);
          const asset = (log.args.asset ?? zeroAddress).toLowerCase() as Address;
          const requestId = (log.args.requestId ?? BigInt(0)).toString();
          const user = (log.args.user ?? zeroAddress) as Address;
          const tier = Number(log.args.tier ?? 0);
          const rowIndex = (log.args.rowIndex ?? BigInt(0)).toString();
          const txHash = log.transactionHash;
          applySettlement(chainState, {
            requestId,
            user,
            tier,
            rowIndex,
            asset,
            amount,
            txHash,
            blockNumber: log.blockNumber,
          });
        }
        chainState.scannedThrough = end;
      }
      chainState.at = Date.now();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return {
    wins: chainState.wins,
    noWins: chainState.noWins,
    rawByAsset: new Map(chainState.rawByAsset),
    newestBlock: chainState.newestBlock,
    newestTxHash: chainState.newestTxHash,
    settlements: [...chainState.byRequestId.values()],
    error,
    scannedThrough: chainState.scannedThrough,
  };
}

function isWinRow(symbol: string, humanAmount: string, asset: string): boolean {
  if (!asset || asset === zeroAddress) return false;
  if (symbol === "NO_WIN") return false;
  const n = Number(humanAmount);
  return Number.isFinite(n) && n > 0;
}

function metaFor(asset: string, metaByAsset: Map<string, TokenMeta>): TokenMeta {
  const key = (asset || zeroAddress).toLowerCase();
  return metaByAsset.get(key) ?? { symbol: "NO_WIN", decimals: 18, source: "config" };
}

function serializeLedgerRow(r: LedgerRow, metaByAsset: Map<string, TokenMeta>) {
  const { symbol } = metaFor(r.asset || zeroAddress, metaByAsset);
  return {
    timestamp: r.timestamp,
    requestId: r.requestId,
    user: r.user,
    tier: r.tier,
    rowIndex: r.rowIndex,
    asset: r.asset,
    symbol,
    humanAmount: r.humanAmount,
    priceUsd: r.priceUsd,
    usdValue: r.usdValue,
    retro: r.retro,
    txHash: r.txHash,
    txUrl: r.txHash ? `${EXPLORER_BASE}/tx/${r.txHash}` : null,
  };
}

export async function GET() {
  const ledgerPath = defaultLedgerPath();
  let ledger = readLedgerFile(ledgerPath);

  const chain = await loadChainAgg();

  // Local CSV is not the live Render writer — fill gaps from chain logs we already scanned.
  // Sync even on partial chain.error so progress isn't discarded after a mid-scan RPC blip.
  let sync: { appended: number; skipped: number; error: string | null } | null = null;
  if (chain.settlements.length > 0) {
    const have = new Set(ledger.rows.map((r) => r.requestId));
    const missing = chain.settlements.filter((s) => !have.has(s.requestId));
    if (missing.length > 0) {
      sync = await syncMissingLedgerRows(missing, ledgerPath);
      if (sync.appended > 0) {
        ledger = readLedgerFile(ledgerPath);
      }
    }
  }

  const usdByAsset = new Map<string, number>();
  const usdByRequest = new Map<string, number>();
  for (const row of ledger.rows) {
    if (!row.asset || row.asset === zeroAddress) continue;
    const v = Number(row.usdValue);
    if (!Number.isFinite(v)) continue;
    usdByAsset.set(row.asset, (usdByAsset.get(row.asset) ?? 0) + v);
    usdByRequest.set(row.requestId, v);
  }

  const assetKeys = [
    ...chain.rawByAsset.keys(),
    ...ledger.rows.map((r) => r.asset || zeroAddress),
    ...chain.settlements.map((s) => s.asset),
  ];
  const metaByAsset = await resolveTokenMetaBatch(assetKeys);

  const byAsset: AssetAgg[] = [...chain.rawByAsset.entries()]
    .map(([asset, raw]) => {
      const { symbol, decimals } = metaFor(asset, metaByAsset);
      const human = formatUnits(raw, decimals);
      const usd = usdByAsset.has(asset) ? usdByAsset.get(asset)! : null;
      return {
        asset: asset as Address,
        symbol,
        rawTotal: raw.toString(),
        humanTotal: human,
        usdTotal: usd,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  // Newest chain settlement time (one RPC).
  let newestChainSettledAt: string | null = null;
  if (chain.newestBlock != null && !chain.error) {
    try {
      const raw = process.env.NEXT_PUBLIC_RPC_URL?.trim() || PUBLIC_RPC;
      const url = raw.includes("alchemy.com") ? PUBLIC_RPC : raw;
      const client = createPublicClient({
        chain: robinhoodChain,
        transport: http(url, { timeout: 15_000 }),
      });
      const block = await client.getBlock({ blockNumber: chain.newestBlock });
      newestChainSettledAt = new Date(Number(block.timestamp) * 1000).toISOString();
    } catch {
      newestChainSettledAt = null;
    }
  }

  const newestLedgerAt =
    ledger.rows.length > 0
      ? ledger.rows.reduce((best, r) => {
          const t = Date.parse(r.timestamp);
          if (!Number.isFinite(t)) return best;
          if (!best || t > Date.parse(best)) return r.timestamp;
          return best;
        }, "" as string) || null
      : null;

  let stale = false;
  let staleLagMs: number | null = null;
  if (newestChainSettledAt && newestLedgerAt) {
    const lag = Date.parse(newestChainSettledAt) - Date.parse(newestLedgerAt);
    if (Number.isFinite(lag) && lag > STALE_MS) {
      stale = true;
      staleLagMs = lag;
    }
  } else if (newestChainSettledAt && !newestLedgerAt && chain.settlements.length > 0) {
    stale = true;
  }

  // Biggest wins: prefer ledger USD; else quantity from chain.
  type BigWin = {
    requestId: string;
    user: string;
    symbol: string;
    humanAmount: string;
    usdValue: number | null;
    sortKey: number;
    ageSec: number | null;
    txHash: string;
    txUrl: string;
    timestamp: string | null;
  };

  const bigCandidates: BigWin[] = [];
  const now = Date.now();

  // Prefer ledger win rows (have prices + timestamps).
  for (const r of ledger.rows) {
    const { symbol } = metaFor(r.asset || zeroAddress, metaByAsset);
    if (!isWinRow(symbol, r.humanAmount, r.asset)) continue;
    const usd = Number(r.usdValue);
    const qty = Number(r.humanAmount);
    const sortKey = Number.isFinite(usd) && usd > 0 ? usd : Number.isFinite(qty) ? qty : 0;
    const ts = Date.parse(r.timestamp);
    const chainHit = chain.settlements.find((s) => s.requestId === r.requestId);
    const txHash = r.txHash || chainHit?.txHash || "";
    bigCandidates.push({
      requestId: r.requestId,
      user: r.user,
      symbol,
      humanAmount: r.humanAmount,
      usdValue: Number.isFinite(usd) && r.usdValue !== "" ? usd : null,
      sortKey,
      ageSec: Number.isFinite(ts) ? Math.max(0, Math.floor((now - ts) / 1000)) : null,
      txHash,
      txUrl: txHash ? `${EXPLORER_BASE}/tx/${txHash}` : "",
      timestamp: r.timestamp || null,
    });
  }

  // Fill from chain if ledger sparse.
  if (bigCandidates.length < 5) {
    const have = new Set(bigCandidates.map((b) => b.requestId));
    for (const s of chain.settlements) {
      if (have.has(s.requestId)) continue;
      if (s.amount === BigInt(0) || s.asset === zeroAddress) continue;
      const { symbol, decimals } = metaFor(s.asset, metaByAsset);
      const human = formatUnits(s.amount, decimals);
      const usd = usdByRequest.get(s.requestId);
      const qty = Number(human);
      bigCandidates.push({
        requestId: s.requestId,
        user: s.user,
        symbol,
        humanAmount: human,
        usdValue: usd ?? null,
        sortKey: usd != null && usd > 0 ? usd : qty,
        ageSec: null,
        txHash: s.txHash,
        txUrl: `${EXPLORER_BASE}/tx/${s.txHash}`,
        timestamp: null,
      });
    }
  }

  const biggestWins = [...bigCandidates]
    .sort((a, b) => b.sortKey - a.sortKey)
    .slice(0, 5)
    .map(({ sortKey: _s, ...rest }) => rest);

  const allLedger = ledger.rows.map((r) => serializeLedgerRow(r, metaByAsset));

  const deployBlock = activeGameDeployBlock().toString();

  return NextResponse.json({
    updatedAt: Date.now(),
    game: activeScratchGame().address,
    deployBlock,
    chain: {
      wins: chain.wins,
      noWins: chain.noWins,
      byAsset,
      error: chain.error,
      newestSettledAt: newestChainSettledAt,
      newestTxHash: chain.newestTxHash,
      settlementCount: chain.settlements.length,
    },
    ledger: {
      path: ledgerPath,
      present: ledger.present,
      error: ledger.error,
      rowCount: ledger.rows.length,
      newestTimestamp: newestLedgerAt,
      stale,
      staleLagMs,
      sync,
      rows: allLedger,
    },
    biggestWins,
    note:
      "Quantities are from chain ScratchSettled logs. USD joins the local payout-ledger.csv; gaps vs chain are auto-filled (retro prices). Live appends still run on the Render operator.",
  });
}
