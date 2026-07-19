import fs from "node:fs";
import path from "node:path";

export const LEDGER_HEADER =
  "timestamp,requestId,user,tier,rowIndex,asset,symbol,raw_amount,human_amount,price_usd,usd_value,retro,tx_hash";

export type LedgerRow = {
  timestamp: string;
  requestId: string;
  user: string;
  tier: string;
  rowIndex: string;
  asset: string;
  symbol: string;
  rawAmount: string;
  humanAmount: string;
  priceUsd: string;
  usdValue: string;
  retro: boolean;
  txHash: string;
};

export function defaultLedgerPath(): string {
  return (
    process.env.PAYOUT_LEDGER_PATH ||
    path.resolve(process.cwd(), "..", "ops", "entropy-operator", "payout-ledger.csv")
  );
}

function splitCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      cols.push(cur);
      cur = "";
    } else cur += c;
  }
  cols.push(cur);
  return cols;
}

export function parseLedgerCsv(text: string): LedgerRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const start = lines[0].startsWith("timestamp") ? 1 : 0;
  const rows: LedgerRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    if (c.length < 12) continue;
    rows.push({
      timestamp: c[0],
      requestId: c[1],
      user: c[2],
      tier: c[3],
      rowIndex: c[4],
      asset: (c[5] || "").toLowerCase(),
      symbol: c[6],
      rawAmount: c[7],
      humanAmount: c[8],
      priceUsd: c[9],
      usdValue: c[10],
      retro: c[11]?.toLowerCase() === "true",
      txHash: c[12] || "",
    });
  }
  return rows;
}

export function readLedgerFile(filePath = defaultLedgerPath()): {
  present: boolean;
  path: string;
  rows: LedgerRow[];
  error: string | null;
} {
  try {
    if (!fs.existsSync(filePath)) {
      return { present: false, path: filePath, rows: [], error: null };
    }
    const text = fs.readFileSync(filePath, "utf8");
    return { present: true, path: filePath, rows: parseLedgerCsv(text), error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { present: false, path: filePath, rows: [], error: msg };
  }
}
