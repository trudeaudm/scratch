import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  formatUnits,
  http,
  type Address,
  zeroAddress,
} from "viem";
import { findTokenConfig, tokens } from "@/config/addresses";
import { robinhoodChain } from "@/config/chain";
import { fetchPrices, unitPriceFor } from "@/utils/prices";
import {
  LEDGER_HEADER,
  defaultLedgerPath,
  readLedgerFile,
  type LedgerRow,
} from "@/utils/payoutLedger";

export type SyncSettlement = {
  requestId: string;
  user: Address;
  tier: number;
  rowIndex: string;
  asset: Address;
  amount: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
};

export type SyncResult = {
  appended: number;
  skipped: number;
  error: string | null;
};

const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

let inflight: Promise<SyncResult> | null = null;

function csvEscape(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function resolveMeta(asset: string): { symbol: string; decimals: number } {
  const key = asset.toLowerCase();
  if (key === zeroAddress) return { symbol: "NO_WIN", decimals: 18 };
  const cfg =
    findTokenConfig(asset as Address) ??
    tokens.find((t) => t.address.toLowerCase() === key);
  if (cfg) {
    const symbol =
      cfg.kind === "stock" && cfg.ticker?.trim() ? cfg.ticker.trim() : cfg.symbol;
    return { symbol, decimals: cfg.decimals };
  }
  return { symbol: key.slice(0, 10), decimals: 18 };
}

function ensureLedgerFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${LEDGER_HEADER}\n`, "utf8");
    return;
  }
  const existing = fs.readFileSync(filePath, "utf8");
  if (!existing.trim()) {
    fs.writeFileSync(filePath, `${LEDGER_HEADER}\n`, "utf8");
  }
}

function client() {
  const primary = process.env.NEXT_PUBLIC_RPC_URL ?? PUBLIC_RPC;
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(primary, { timeout: 20_000, retryCount: 1 }),
  });
}

/**
 * Append chain settlements missing from the local CSV (retro=true, current prices).
 * Live reveals still belong on Render — this keeps the local dashboard CSV caught up.
 */
export async function syncMissingLedgerRows(
  missing: SyncSettlement[],
  ledgerPath = defaultLedgerPath(),
): Promise<SyncResult> {
  if (missing.length === 0) return { appended: 0, skipped: 0, error: null };
  if (inflight) return inflight;

  inflight = (async (): Promise<SyncResult> => {
    try {
      ensureLedgerFile(ledgerPath);
      const have = new Set(readLedgerFile(ledgerPath).rows.map((r) => r.requestId));
      const toAdd = missing.filter((s) => !have.has(s.requestId));
      if (toAdd.length === 0) return { appended: 0, skipped: missing.length, error: null };

      const pc = client();
      const assets = [...new Set(toAdd.map((s) => s.asset.toLowerCase() as Address))];
      const prices = await fetchPrices(assets);

      const blockNums = [...new Set(toAdd.map((s) => s.blockNumber))];
      const tsByBlock = new Map<string, string>();
      await Promise.all(
        blockNums.map(async (bn) => {
          try {
            const block = await pc.getBlock({ blockNumber: bn });
            tsByBlock.set(
              bn.toString(),
              new Date(Number(block.timestamp) * 1000).toISOString(),
            );
          } catch {
            tsByBlock.set(bn.toString(), new Date().toISOString());
          }
        }),
      );

      // Stable order by requestId for readable CSV tails.
      toAdd.sort((a, b) => Number(a.requestId) - Number(b.requestId));

      const lines: string[] = [];
      for (const s of toAdd) {
        if (have.has(s.requestId)) continue;
        const { symbol, decimals } = resolveMeta(s.asset);
        let human = "0";
        try {
          human = formatUnits(s.amount, decimals);
        } catch {
          human = s.amount.toString();
        }

        let priceUsd = "";
        let usdValue = "";
        if (s.asset === zeroAddress || s.amount === 0n) {
          usdValue = "0";
        } else {
          const unit = unitPriceFor(s.asset, prices);
          if (unit) {
            priceUsd = String(unit.usd);
            const hum = Number(human);
            if (Number.isFinite(hum)) usdValue = String(hum * unit.usd);
          }
        }

        const iso = tsByBlock.get(s.blockNumber.toString()) ?? new Date().toISOString();
        lines.push(
          [
            iso,
            s.requestId,
            s.user,
            String(s.tier),
            s.rowIndex,
            s.asset.toLowerCase(),
            symbol,
            s.amount.toString(),
            human,
            priceUsd,
            usdValue,
            "true",
            s.txHash,
          ]
            .map((c) => csvEscape(String(c)))
            .join(","),
        );
        have.add(s.requestId);
      }

      if (lines.length > 0) {
        fs.appendFileSync(ledgerPath, `${lines.join("\n")}\n`, "utf8");
      }
      return { appended: lines.length, skipped: missing.length - lines.length, error: null };
    } catch (e) {
      return {
        appended: 0,
        skipped: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export function ledgerRequestIds(rows: LedgerRow[]): Set<string> {
  return new Set(rows.map((r) => r.requestId));
}
