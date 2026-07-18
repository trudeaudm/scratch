import { NextResponse } from "next/server";
import {
  createPublicClient,
  formatUnits,
  http,
  parseAbiItem,
  type Address,
  zeroAddress,
} from "viem";
import { contracts, findTokenConfig, tokens } from "@/config/addresses";
import { robinhoodChain } from "@/config/chain";
import { defaultLedgerPath, readLedgerFile } from "@/utils/payoutLedger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SCRATCH_SETTLED = parseAbiItem(
  "event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 tier, uint256 rowIndex, address asset, uint256 amount)",
);

const DEFAULT_DEPLOY_BLOCK = 13_138_508n;
const LOG_CHUNK = 9_000n;
const CHAIN_CACHE_TTL_MS = 60_000;

type AssetAgg = {
  asset: Address;
  symbol: string;
  rawTotal: string;
  humanTotal: string;
  usdTotal: number | null;
};

type ChainAgg = {
  wins: number;
  noWins: number;
  rawByAsset: Map<string, bigint>;
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

async function loadChainAgg(): Promise<ChainAgg> {
  if (chainCache && Date.now() - chainCache.at < CHAIN_CACHE_TTL_MS) {
    return chainCache.value;
  }

  const deployBlock = BigInt(process.env.GAME_DEPLOY_BLOCK || DEFAULT_DEPLOY_BLOCK.toString());
  const game = contracts.scratchGame.address;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.robinhoodchain.com";

  const client = createPublicClient({
    chain: robinhoodChain,
    transport: http(rpcUrl),
  });

  let wins = 0;
  let noWins = 0;
  const rawByAsset = new Map<string, bigint>();
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

  const value: ChainAgg = { wins, noWins, rawByAsset, error };
  if (!error) chainCache = { at: Date.now(), value };
  return value;
}

export async function GET() {
  const ledgerPath = defaultLedgerPath();
  const ledger = readLedgerFile(ledgerPath);

  const usdByAsset = new Map<string, number>();
  for (const row of ledger.rows) {
    if (!row.asset || row.asset === zeroAddress) continue;
    const v = Number(row.usdValue);
    if (!Number.isFinite(v)) continue;
    usdByAsset.set(row.asset, (usdByAsset.get(row.asset) ?? 0) + v);
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

  const recent = [...ledger.rows]
    .reverse()
    .slice(0, 20)
    .map((r) => ({
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
    }));

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
    },
    ledger: {
      path: ledgerPath,
      present: ledger.present,
      error: ledger.error,
      rowCount: ledger.rows.length,
      recent,
    },
    note:
      "Quantities are from chain ScratchSettled logs. USD totals join the operator payout-ledger.csv when present (pull the CSV from the VPS running the bot).",
  });
}
