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
import { EXPLORER_BASE, contracts, findTokenConfig, tokens } from "@/config/addresses";
import { robinhoodChain } from "@/config/chain";
import { defaultLedgerPath, readLedgerFile, type LedgerRow } from "@/utils/payoutLedger";

const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SCRATCH_SETTLED = parseAbiItem(
  "event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 tier, uint256 rowIndex, address asset, uint256 amount)",
);

const DEFAULT_DEPLOY_BLOCK = 13_138_508n;
const LOG_CHUNK = 9_000n;
const CHAIN_CACHE_TTL_MS = 60_000;
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
};

let chainCache: { at: number; value: ChainAgg } | null = null;

function resolveSymbol(asset: string): { symbol: string; decimals: number } {
  const key = asset.toLowerCase();
  if (key === zeroAddress) return { symbol: "NO_WIN", decimals: 18 };
  const cfg = findTokenConfig(asset as Address);
  if (cfg) return { symbol: cfg.symbol, decimals: cfg.decimals };
  const hit = tokens.find((t) => t.address.toLowerCase() === key);
  if (hit) return { symbol: hit.symbol, decimals: hit.decimals };
  return { symbol: key.slice(0, 10), decimals: 18 };
}

function isWinRow(symbol: string, humanAmount: string, asset: string): boolean {
  if (!asset || asset === zeroAddress) return false;
  if (symbol === "NO_WIN") return false;
  const n = Number(humanAmount);
  return Number.isFinite(n) && n > 0;
}

async function loadChainAgg(): Promise<ChainAgg> {
  if (chainCache && Date.now() - chainCache.at < CHAIN_CACHE_TTL_MS) {
    return chainCache.value;
  }

  const deployBlock = BigInt(process.env.GAME_DEPLOY_BLOCK || DEFAULT_DEPLOY_BLOCK.toString());
  const game = contracts.scratchGame.address;
  const primary = process.env.NEXT_PUBLIC_RPC_URL ?? PUBLIC_RPC;
  const urls = primary === PUBLIC_RPC ? [PUBLIC_RPC] : [primary, PUBLIC_RPC];

  const client = createPublicClient({
    chain: robinhoodChain,
    transport: fallback(urls.map((url) => http(url, { timeout: 20_000 }))),
  });

  let wins = 0;
  let noWins = 0;
  const rawByAsset = new Map<string, bigint>();
  const settlements: ChainSettlement[] = [];
  let newestBlock: bigint | null = null;
  let newestTxHash: `0x${string}` | null = null;
  let error: string | null = null;

  try {
    const latest = await client.getBlockNumber();
    for (let start = deployBlock; start <= latest; start += LOG_CHUNK) {
      const end = start + LOG_CHUNK - 1n > latest ? latest : start + LOG_CHUNK - 1n;
      const logs = await client.getLogs({
        address: game,
        event: SCRATCH_SETTLED,
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) {
        const amount = log.args.amount ?? 0n;
        const asset = (log.args.asset ?? zeroAddress).toLowerCase() as Address;
        const requestId = (log.args.requestId ?? 0n).toString();
        const user = (log.args.user ?? zeroAddress) as Address;
        const tier = Number(log.args.tier ?? 0);
        const txHash = log.transactionHash;
        settlements.push({
          requestId,
          user,
          tier,
          asset,
          amount,
          txHash,
          blockNumber: log.blockNumber,
        });
        if (newestBlock == null || log.blockNumber > newestBlock) {
          newestBlock = log.blockNumber;
          newestTxHash = txHash;
        }
        if (amount === 0n || asset === zeroAddress) {
          noWins++;
          continue;
        }
        wins++;
        rawByAsset.set(asset, (rawByAsset.get(asset) ?? 0n) + amount);
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const value: ChainAgg = {
    wins,
    noWins,
    rawByAsset,
    newestBlock,
    newestTxHash,
    settlements,
    error,
  };
  if (!error) chainCache = { at: Date.now(), value };
  return value;
}

function serializeLedgerRow(r: LedgerRow) {
  return {
    timestamp: r.timestamp,
    requestId: r.requestId,
    user: r.user,
    tier: r.tier,
    rowIndex: r.rowIndex,
    asset: r.asset,
    symbol: r.symbol,
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
  const ledger = readLedgerFile(ledgerPath);

  const usdByAsset = new Map<string, number>();
  const usdByRequest = new Map<string, number>();
  for (const row of ledger.rows) {
    if (!row.asset || row.asset === zeroAddress) continue;
    const v = Number(row.usdValue);
    if (!Number.isFinite(v)) continue;
    usdByAsset.set(row.asset, (usdByAsset.get(row.asset) ?? 0) + v);
    usdByRequest.set(row.requestId, v);
  }

  const chain = await loadChainAgg();

  const byAsset: AssetAgg[] = [...chain.rawByAsset.entries()]
    .map(([asset, raw]) => {
      const { symbol, decimals } = resolveSymbol(asset);
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
      const primary = process.env.NEXT_PUBLIC_RPC_URL ?? PUBLIC_RPC;
      const client = createPublicClient({
        chain: robinhoodChain,
        transport: http(primary, { timeout: 15_000 }),
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
    if (!isWinRow(r.symbol, r.humanAmount, r.asset)) continue;
    const usd = Number(r.usdValue);
    const qty = Number(r.humanAmount);
    const sortKey = Number.isFinite(usd) && usd > 0 ? usd : Number.isFinite(qty) ? qty : 0;
    const ts = Date.parse(r.timestamp);
    const chainHit = chain.settlements.find((s) => s.requestId === r.requestId);
    const txHash = r.txHash || chainHit?.txHash || "";
    bigCandidates.push({
      requestId: r.requestId,
      user: r.user,
      symbol: r.symbol,
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
      if (s.amount === 0n || s.asset === zeroAddress) continue;
      const { symbol, decimals } = resolveSymbol(s.asset);
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

  const allLedger = ledger.rows.map(serializeLedgerRow);

  const deployBlock = process.env.GAME_DEPLOY_BLOCK || DEFAULT_DEPLOY_BLOCK.toString();

  return NextResponse.json({
    updatedAt: Date.now(),
    game: contracts.scratchGame.address,
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
      rows: allLedger,
    },
    biggestWins,
    note:
      "Quantities are from chain ScratchSettled logs. USD totals join the operator payout-ledger.csv when present (pull the CSV from the VPS running the bot).",
  });
}
