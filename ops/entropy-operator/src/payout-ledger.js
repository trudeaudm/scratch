import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Interface, formatUnits } from "ethers";
import { priceUsd } from "./prices.js";
import { resolveToken, ZERO } from "./token-map.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LEDGER_HEADER =
  "timestamp,requestId,user,tier,rowIndex,asset,symbol,raw_amount,human_amount,price_usd,usd_value,retro";

export const SCRATCH_SETTLED_ABI = [
  "event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 tier, uint256 rowIndex, address asset, uint256 amount)",
];

const settledIface = new Interface(SCRATCH_SETTLED_ABI);

export function defaultLedgerPath() {
  return (
    process.env.PAYOUT_LEDGER_PATH ||
    path.join(__dirname, "..", "payout-ledger.csv")
  );
}

export function defaultGameAddress() {
  return (
    process.env.GAME_ADDRESS ||
    process.env.SCRATCH_GAME ||
    "0xBeD604b5AB226134EdF154cc31881d8C93f4C9e6"
  );
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function ensureHeader(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, LEDGER_HEADER + "\n", "utf8");
    return;
  }
  const existing = fs.readFileSync(filePath, "utf8");
  if (!existing.trim()) {
    fs.writeFileSync(filePath, LEDGER_HEADER + "\n", "utf8");
  }
}

/**
 * Parse ScratchSettled logs from a reveal/fulfill receipt.
 * @returns {Array<{user:string,requestId:string,tier:number,rowIndex:string,asset:string,amount:bigint}>}
 */
export function parseScratchSettledFromReceipt(receipt, gameAddress) {
  const game = (gameAddress || defaultGameAddress()).toLowerCase();
  const out = [];
  for (const log of receipt?.logs || []) {
    if ((log.address || "").toLowerCase() !== game) continue;
    try {
      const parsed = settledIface.parseLog(log);
      if (!parsed || parsed.name !== "ScratchSettled") continue;
      out.push({
        user: parsed.args.user,
        requestId: parsed.args.requestId.toString(),
        tier: Number(parsed.args.tier),
        rowIndex: parsed.args.rowIndex.toString(),
        asset: parsed.args.asset,
        amount: parsed.args.amount,
      });
    } catch {
      /* not this event */
    }
  }
  return out;
}

/**
 * Load requestIds already present in the ledger (for backfill skip).
 */
export function loadLedgerRequestIds(filePath = defaultLedgerPath()) {
  const ids = new Set();
  if (!fs.existsSync(filePath)) return ids;
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols[1]) ids.add(cols[1]);
  }
  return ids;
}

function splitCsvLine(line) {
  const cols = [];
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

/**
 * Append one ledger row. Never throws to caller — logs and returns false.
 */
export async function appendLedgerRow(provider, event, { retro = false, timestampIso } = {}) {
  const filePath = defaultLedgerPath();
  try {
    ensureHeader(filePath);

    let iso = timestampIso;
    if (!iso) {
      try {
        const block = await provider.getBlock("latest");
        iso = new Date(Number(block.timestamp) * 1000).toISOString();
      } catch {
        iso = new Date().toISOString();
      }
    }

    const tok = resolveToken(event.asset);
    const raw = event.amount?.toString?.() ?? String(event.amount ?? "0");
    let human = "";
    try {
      human = formatUnits(BigInt(raw), tok.decimals);
    } catch {
      human = raw;
    }

    let price = "";
    let usdValue = "";
    try {
      if (tok.address !== ZERO && BigInt(raw) > 0n) {
        const p = await priceUsd(tok.address, tok.price);
        if (p != null) {
          price = String(p);
          const hum = Number(human);
          if (Number.isFinite(hum)) usdValue = String(hum * p);
        }
      } else if (tok.address === ZERO || BigInt(raw) === 0n) {
        price = "";
        usdValue = "0";
      }
    } catch (e) {
      console.warn(`ledger price: ${e?.message || e}`);
    }

    const row = [
      iso,
      event.requestId,
      event.user,
      event.tier,
      event.rowIndex,
      (event.asset || "").toLowerCase(),
      tok.symbol,
      raw,
      human,
      price,
      usdValue,
      retro ? "true" : "false",
    ]
      .map(csvEscape)
      .join(",");

    fs.appendFileSync(filePath, row + "\n", "utf8");
    console.log(
      `ledger: + ${tok.symbol} ${human || "0"} req=${event.requestId}${retro ? " (retro)" : ""}`,
    );
    return true;
  } catch (e) {
    console.warn(`ledger append failed: ${e?.message || e}`);
    return false;
  }
}

/**
 * After a successful reveal — parse receipt + append. Never throws.
 */
export async function recordRevealSettlements(provider, receipt, opts = {}) {
  try {
    if (!receipt) return;
    const game = opts.gameAddress || defaultGameAddress();
    const events = parseScratchSettledFromReceipt(receipt, game);
    if (events.length === 0) {
      console.warn("ledger: no ScratchSettled in reveal receipt");
      return;
    }

    let iso;
    try {
      const block = await provider.getBlock(receipt.blockNumber);
      if (block?.timestamp != null) {
        iso = new Date(Number(block.timestamp) * 1000).toISOString();
      }
    } catch {
      /* use append default */
    }

    for (const ev of events) {
      await appendLedgerRow(provider, ev, { retro: false, timestampIso: iso });
    }
  } catch (e) {
    console.warn(`ledger recordRevealSettlements: ${e?.message || e}`);
  }
}
