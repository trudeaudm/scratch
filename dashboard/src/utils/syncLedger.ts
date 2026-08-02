import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  formatUnits,
  http,
  type Address,
  zeroAddress,
} from "viem";
import { robinhoodChain } from "@/config/chain";
import { fetchPrices, unitPriceFor } from "@/utils/prices";
import {
  LEDGER_HEADER,
  defaultLedgerPath,
  readLedgerFile,
  type LedgerRow,
} from "@/utils/payoutLedger";
import { resolveTokenMeta } from "@/utils/tokenMeta";

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
  const raw = process.env.NEXT_PUBLIC_RPC_URL?.trim() || PUBLIC_RPC;
  const url = raw.includes("alchemy.com") ? PUBLIC_RPC : raw;
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(url, { timeout: 20_000, retryCount: 1 }),
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
      // Sequential batches — parallel getBlock for 100+ blocks trips RPC rate limits.
      const BATCH = 8;
      for (let i = 0; i < blockNums.length; i += BATCH) {
        const slice = blockNums.slice(i, i + BATCH);
        await Promise.all(
          slice.map(async (bn) => {
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
      }

      // Stable order by requestId for readable CSV tails.
      toAdd.sort((a, b) => Number(a.requestId) - Number(b.requestId));

      const lines: string[] = [];
      for (const s of toAdd) {
        if (have.has(s.requestId)) continue;
        const { symbol, decimals } = await resolveTokenMeta(s.asset, pc);
        let human = "0";
        try {
          human = formatUnits(s.amount, decimals);
        } catch {
          human = s.amount.toString();
        }

        let priceUsd = "";
        let usdValue = "";
        if (s.asset === zeroAddress || s.amount === BigInt(0)) {
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
