import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, formatUnits, id } from "ethers";
import { priceUsd } from "./prices.js";
import { resolveToken, ZERO } from "./token-map.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LEDGER_HEADER =
  "timestamp,requestId,user,tier,rowIndex,asset,symbol,raw_amount,human_amount,price_usd,usd_value,retro,tx_hash";

/** v1 ScratchSettled (no cardIndex). */
export const SCRATCH_SETTLED_ABI_V1 = [
  "event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 tier, uint256 rowIndex, address asset, uint256 amount)",
];

/** v2 ScratchSettled — one event per card; cardIndex after requestId. */
export const SCRATCH_SETTLED_ABI_V2 = [
  "event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 cardIndex, uint8 tier, uint256 rowIndex, address asset, uint256 amount)",
];

/** @deprecated use SCRATCH_SETTLED_ABI_V1 or settledAbi() */
export const SCRATCH_SETTLED_ABI = SCRATCH_SETTLED_ABI_V1;

const settledIfaceV1 = new Interface(SCRATCH_SETTLED_ABI_V1);
const settledIfaceV2 = new Interface(SCRATCH_SETTLED_ABI_V2);
const SETTLED_TOPIC_V1 = id(
  "ScratchSettled(address,uint256,uint8,uint256,address,uint256)",
);
const SETTLED_TOPIC_V2 = id(
  "ScratchSettled(address,uint256,uint8,uint8,uint256,address,uint256)",
);

/**
 * Gate for v2 ledger parsing. Set GAME_V2=1/true, or set GAME_V2 / GAME_V2_ADDRESS
 * to the ScratchGameV2 address and point GAME_ADDRESS at it.
 * Leave unset → v1 pipeline unchanged.
 */
export function isGameV2(gameAddress) {
  const flag = (process.env.GAME_V2 || "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  const v2Addr = (
    process.env.GAME_V2_ADDRESS ||
    (flag.startsWith("0x") ? flag : "")
  ).toLowerCase();
  if (!v2Addr) return false;
  const game = (gameAddress || defaultGameAddress()).toLowerCase();
  return game === v2Addr;
}

export function settledAbi(gameAddress) {
  return isGameV2(gameAddress) ? SCRATCH_SETTLED_ABI_V2 : SCRATCH_SETTLED_ABI_V1;
}

export function settledTopic(gameAddress) {
  return isGameV2(gameAddress) ? SETTLED_TOPIC_V2 : SETTLED_TOPIC_V1;
}

/** Ledger uniqueness key: requestId (v1) or requestId:cardIndex (v2). */
export function settlementKey(event) {
  if (event.cardIndex != null && event.cardIndex !== "") {
    return `${event.requestId}:${event.cardIndex}`;
  }
  return String(event.requestId);
}

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
 * v2: one row per card (cardIndex present). v1: one row per request.
 */
export function parseScratchSettledFromReceipt(receipt, gameAddress) {
  const game = (gameAddress || defaultGameAddress()).toLowerCase();
  const v2 = isGameV2(game);
  const topic = settledTopic(game);
  const iface = v2 ? settledIfaceV2 : settledIfaceV1;
  const out = [];
  for (const log of receipt?.logs || []) {
    if (logAddress(log) !== game) continue;
    const topics = log.topics || [];
    if (topics[0] && topics[0].toLowerCase() !== topic.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({
        topics: [...topics],
        data: log.data,
      });
      if (!parsed || parsed.name !== "ScratchSettled") continue;
      const row = {
        user: parsed.args.user,
        requestId: parsed.args.requestId.toString(),
        tier: Number(parsed.args.tier),
        rowIndex: parsed.args.rowIndex.toString(),
        asset: parsed.args.asset,
        amount: parsed.args.amount,
        txHash: receipt.hash || receipt.transactionHash || log.transactionHash || "",
      };
      if (v2) {
        row.cardIndex = Number(parsed.args.cardIndex);
      }
      out.push(row);
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
  const v2 = isGameV2(game);
  const contract = new Contract(game, settledAbi(game), provider);
  const tip = await provider.getBlockNumber();
  const fromBlock = Math.max(0, Number(opts.fromBlock ?? tip - 50_000));
  const logs = await contract.queryFilter(
    contract.filters.ScratchSettled(null, requestId),
    fromBlock,
    tip,
  );
  if (!logs.length) return [];
  return logs.map((log) => {
    const row = {
      user: log.args.user,
      requestId: log.args.requestId.toString(),
      tier: Number(log.args.tier),
      rowIndex: log.args.rowIndex.toString(),
      asset: log.args.asset,
      amount: log.args.amount,
      txHash: log.transactionHash || "",
    };
    if (v2) row.cardIndex = Number(log.args.cardIndex);
    return row;
  });
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
 * v2: requestId column stores `requestId:cardIndex` so multi-card batches don't collide.
 */
export async function appendLedgerRow(
  provider,
  event,
  { retro = false, timestampIso, txHash } = {},
) {
  const filePath = defaultLedgerPath();
  try {
    ensureHeader(filePath);

    const key = settlementKey(event);
    const existing = loadLedgerRequestIds(filePath);
    if (existing.has(key)) {
      console.log(`ledger: skip existing key=${key}`);
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
      logLedgerError(`price fetch failed key=${key}`, e);
    }

    const hash = txHash || event.txHash || "";
    const row = [
      iso,
      key,
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
      `ledger: + ${tok.symbol} ${human || "0"} key=${key} retro=${retro} file=${filePath}`,
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
      `ledger: recording reveal tx=${txHash || "?"} block=${receipt.blockNumber} game=${game} v2=${isGameV2(game)}`,
    );

    let events = parseScratchSettledFromReceipt(receipt, game);

    if (events.length === 0 && txHash) {
      try {
        const full = await provider.getTransactionReceipt(txHash);
        events = parseScratchSettledFromReceipt(full || receipt, game);
        if (events.length) console.log("ledger: recovered ScratchSettled via getTransactionReceipt");
      } catch (e) {
        logLedgerError("getTransactionReceipt fallback failed", e);
      }
    }

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
            `ledger: recovered ScratchSettled via getLogs requestId=${opts.requestId} cards=${events.length}`,
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
