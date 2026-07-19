import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, formatUnits, id } from "ethers";
import { priceUsd } from "./prices.js";
import { resolveToken, ZERO } from "./token-map.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LEDGER_HEADER =
  "timestamp,requestId,user,tier,rowIndex,asset,symbol,raw_amount,human_amount,price_usd,usd_value,retro,tx_hash";

export const SCRATCH_SETTLED_ABI = [
  "event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 tier, uint256 rowIndex, address asset, uint256 amount)",
];

const settledIface = new Interface(SCRATCH_SETTLED_ABI);
const SETTLED_TOPIC = id(
  "ScratchSettled(address,uint256,uint8,uint256,address,uint256)",
);

export function defaultLedgerPath() {
  return (
    process.env.LEDGER_FILE ||
    process.env.PAYOUT_LEDGER_PATH ||
    path.join(__dirname, "..", "payout-ledger.csv")
  );
}

export function defaultErrorsPath() {
  return (
    process.env.LEDGER_ERRORS_PATH ||
    path.join(__dirname, "..", "ledger-errors.log")
  );
}

export function defaultGameAddress() {
  return (
    process.env.GAME_ADDRESS ||
    process.env.SCRATCH_GAME ||
    "0xBeD604b5AB226134EdF154cc31881d8C93f4C9e6"
  );
}

/** Loud console + ledger-errors.log — never throws. */
export function logLedgerError(message, detail) {
  const line = `[${new Date().toISOString()}] ${message}${
    detail ? ` | ${typeof detail === "string" ? detail : detail?.stack || detail?.message || String(detail)}` : ""
  }`;
  console.error(`LEDGER ERROR: ${message}`);
  if (detail) console.error(detail);
  try {
    fs.appendFileSync(defaultErrorsPath(), line + "\n", "utf8");
  } catch (e) {
    console.error(`LEDGER ERROR: could not write ledger-errors.log: ${e?.message || e}`);
  }
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
    return;
  }
  const lines = existing.split(/\r?\n/);
  if (lines[0] && lines[0].startsWith("timestamp") && !lines[0].includes("tx_hash")) {
    lines[0] = LEDGER_HEADER;
    fs.writeFileSync(filePath, lines.join("\n").replace(/\n*$/, "\n"), "utf8");
  }
}

function logAddress(log) {
  return (log.address || log.emitter || "").toLowerCase();
}

/**
 * Parse ScratchSettled logs from a reveal/fulfill receipt.
 */
export function parseScratchSettledFromReceipt(receipt, gameAddress) {
  const game = (gameAddress || defaultGameAddress()).toLowerCase();
  const out = [];
  for (const log of receipt?.logs || []) {
    if (logAddress(log) !== game) continue;
    const topics = log.topics || [];
    if (topics[0] && topics[0].toLowerCase() !== SETTLED_TOPIC.toLowerCase()) continue;
    try {
      const parsed = settledIface.parseLog({
        topics: [...topics],
        data: log.data,
      });
      if (!parsed || parsed.name !== "ScratchSettled") continue;
      out.push({
        user: parsed.args.user,
        requestId: parsed.args.requestId.toString(),
        tier: Number(parsed.args.tier),
        rowIndex: parsed.args.rowIndex.toString(),
        asset: parsed.args.asset,
        amount: parsed.args.amount,
        txHash: receipt.hash || receipt.transactionHash || log.transactionHash || "",
      });
    } catch (e) {
      logLedgerError("parseLog ScratchSettled failed on receipt log", e);
    }
  }
  return out;
}

/**
 * Fallback: query ScratchSettled for requestId around the receipt block.
 */
export async function fetchSettledByRequest(provider, requestId, opts = {}) {
  const game = opts.gameAddress || defaultGameAddress();
  const contract = new Contract(game, SCRATCH_SETTLED_ABI, provider);
  const tip = await provider.getBlockNumber();
  const fromBlock = Math.max(0, Number(opts.fromBlock ?? tip - 50_000));
  const logs = await contract.queryFilter(
    contract.filters.ScratchSettled(null, requestId),
    fromBlock,
    tip,
  );
  if (!logs.length) return [];
  const log = logs[logs.length - 1];
  return [
    {
      user: log.args.user,
      requestId: log.args.requestId.toString(),
      tier: Number(log.args.tier),
      rowIndex: log.args.rowIndex.toString(),
      asset: log.args.asset,
      amount: log.args.amount,
      txHash: log.transactionHash || "",
    },
  ];
}

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

export function splitCsvLine(line) {
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
 * Append one ledger row. Never throws to caller — logs loudly and returns false.
 */
export async function appendLedgerRow(
  provider,
  event,
  { retro = false, timestampIso, txHash } = {},
) {
  const filePath = defaultLedgerPath();
  try {
    ensureHeader(filePath);

    // Strictly additive: never rewrite an existing requestId.
    const existing = loadLedgerRequestIds(filePath);
    if (existing.has(String(event.requestId))) {
      console.log(`ledger: skip existing requestId=${event.requestId}`);
      return false;
    }

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
      logLedgerError(`price fetch failed req=${event.requestId}`, e);
    }

    const hash = txHash || event.txHash || "";
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
      hash,
    ]
      .map(csvEscape)
      .join(",");

    fs.appendFileSync(filePath, row + "\n", "utf8");
    console.log(
      `ledger: + ${tok.symbol} ${human || "0"} req=${event.requestId} retro=${retro} file=${filePath}`,
    );
    return true;
  } catch (e) {
    logLedgerError(`append failed req=${event?.requestId}`, e);
    return false;
  }
}

/**
 * After a successful reveal — parse receipt + append. Never throws.
 */
export async function recordRevealSettlements(provider, receipt, opts = {}) {
  try {
    if (!receipt) {
      logLedgerError("recordRevealSettlements called with empty receipt");
      return;
    }
    const game = opts.gameAddress || defaultGameAddress();
    const txHash = receipt.hash || receipt.transactionHash || "";
    console.log(
      `ledger: recording reveal tx=${txHash || "?"} block=${receipt.blockNumber} game=${game}`,
    );

    let events = parseScratchSettledFromReceipt(receipt, game);

    // Re-fetch receipt if provider stripped internal logs.
    if (events.length === 0 && txHash) {
      try {
        const full = await provider.getTransactionReceipt(txHash);
        events = parseScratchSettledFromReceipt(full || receipt, game);
        if (events.length) console.log("ledger: recovered ScratchSettled via getTransactionReceipt");
      } catch (e) {
        logLedgerError("getTransactionReceipt fallback failed", e);
      }
    }

    // Query by requestId if still missing (indexed log scan near tip).
    if (events.length === 0 && opts.requestId != null) {
      try {
        const fromBlock =
          receipt.blockNumber != null
            ? Math.max(0, Number(receipt.blockNumber) - 5)
            : undefined;
        events = await fetchSettledByRequest(provider, opts.requestId, {
          gameAddress: game,
          fromBlock,
        });
        if (events.length) {
          console.log(
            `ledger: recovered ScratchSettled via getLogs requestId=${opts.requestId}`,
          );
        }
      } catch (e) {
        logLedgerError(`getLogs fallback failed req=${opts.requestId}`, e);
      }
    }

    if (events.length === 0) {
      logLedgerError(
        `no ScratchSettled after reveal tx=${txHash} req=${opts.requestId ?? "?"} logs=${receipt.logs?.length ?? 0}`,
      );
      return;
    }

    let iso;
    try {
      const block = await provider.getBlock(receipt.blockNumber);
      if (block?.timestamp != null) {
        iso = new Date(Number(block.timestamp) * 1000).toISOString();
      }
    } catch (e) {
      logLedgerError("getBlock for ledger timestamp failed", e);
    }

    for (const ev of events) {
      await appendLedgerRow(provider, ev, {
        retro: false,
        timestampIso: iso,
        txHash: ev.txHash || txHash,
      });
    }
  } catch (e) {
    logLedgerError("recordRevealSettlements fatal", e);
  }
}
