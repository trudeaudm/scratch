#!/usr/bin/env node
/**
 * Re-grant unexpired v1 StandardTicketSource balances onto the v2 source.
 *
 * Scans v1 TicketsGranted / TicketsCredited recipients, reads ticketsOf/expiryOf,
 * credits 1:1 on V2_SOURCE via the crediter wallet (credit()).
 *
 * Safety: DRY_RUN is the default. Set RUN=true to broadcast.
 * If the total exceeds the crediter's remaining daily cap, credits what fits and
 * prints an OVERFLOW list for a manual treasury grant() batch.
 *
 * Usage:
 *   RPC_URL=… V2_SOURCE=0x… CREDITER_ADDRESS=0x… node regrant-v1.js
 *   RUN=true CREDITER_PRIVATE_KEY=… V2_SOURCE=0x… node regrant-v1.js
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  id,
} from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env"), override: false });
dotenv.config({ path: resolve(__dirname, "..", "..", ".env"), override: false });

const V1_DEFAULT = "0xC94894Cd3986E2D0f85616a0Dc59914f1057f003";
/** Deploy2 / game era — safe lower bound for source event history on 4663. */
const FROM_BLOCK_DEFAULT = 13_138_508;
const LOG_CHUNK_DEFAULT = 9_000;

const SOURCE_ABI = [
  "function credit(address user, uint256 amount)",
  "function ticketsOf(address user) view returns (uint256)",
  "function expiryOf(address user) view returns (uint64)",
  "function crediters(address) view returns (bool authorized, uint256 dailyCap, uint256 usedToday, uint256 dayBucket)",
  "function owner() view returns (address)",
  "event TicketsGranted(address indexed user, uint256 amount)",
  "event TicketsCredited(address indexed user, address indexed crediter, uint256 requested, uint256 credited)",
];

const iface = new Interface(SOURCE_ABI);
const TOPIC_GRANTED = id("TicketsGranted(address,uint256)");
const TOPIC_CREDITED = id("TicketsCredited(address,address,uint256,uint256)");

function remainingCrediterWei(cap, used, dayBucket, nowSec) {
  const currentBucket = BigInt(Math.floor(Number(nowSec) / 86400));
  const usedEffective = currentBucket === BigInt(dayBucket) ? used : 0n;
  return cap > usedEffective ? cap - usedEffective : 0n;
}

async function collectRecipientAddresses(provider, sourceAddr, fromBlock, toBlock, chunk, log) {
  const users = new Set();
  let from = fromBlock;
  while (from <= toBlock) {
    const to = from + BigInt(chunk) - 1n > toBlock ? toBlock : from + BigInt(chunk) - 1n;
    const logs = await provider.getLogs({
      address: sourceAddr,
      fromBlock: from,
      toBlock: to,
      topics: [[TOPIC_GRANTED, TOPIC_CREDITED]],
    });
    for (const raw of logs) {
      try {
        const parsed = iface.parseLog(raw);
        const user = parsed?.args?.user;
        if (user) users.add(String(user).toLowerCase());
      } catch {
        /* skip non-matching */
      }
    }
    if (Number(from / BigInt(chunk)) % 20 === 0) {
      log(`  scanned blocks ${from}–${to} (unique so far: ${users.size})`);
    }
    from = to + 1n;
  }
  return [...users];
}

/**
 * @param {{ live?: boolean, log?: (line: string) => void }} [opts]
 */
export async function runRegrantV1(opts = {}) {
  const log = opts.log || ((line) => console.log(line));
  const rpcUrl = process.env.RPC_URL;
  const pk = process.env.CREDITER_PRIVATE_KEY;
  const v1Addr = process.env.V1_SOURCE || V1_DEFAULT;
  const v2Addr = process.env.V2_SOURCE;
  const fromBlock = BigInt(process.env.FROM_BLOCK || FROM_BLOCK_DEFAULT);
  const chunk = Number(process.env.LOG_CHUNK || LOG_CHUNK_DEFAULT);
  const forceDry =
    process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
  const live =
    opts.live === true
      ? !forceDry
      : opts.live === false
        ? false
        : (process.env.RUN === "true" || process.env.RUN === "1") && !forceDry;

  if (!rpcUrl) throw new Error("RPC_URL is required");
  if (!v2Addr || !/^0x[a-fA-F0-9]{40}$/.test(v2Addr)) {
    throw new Error("V2_SOURCE (new StandardTicketSource address) is required");
  }
  if (v2Addr.toLowerCase() === v1Addr.toLowerCase()) {
    throw new Error("V2_SOURCE must differ from V1_SOURCE");
  }
  if (live && !pk) {
    throw new Error("CREDITER_PRIVATE_KEY is required when running live");
  }
  if (process.env.GRANTER_PRIVATE_KEY || process.env.TREASURY_PRIVATE_KEY) {
    log(
      "WARN: treasury/granter key env is set but ignored — regrant uses CREDITER_PRIVATE_KEY + credit() only.",
    );
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const v1 = new Contract(v1Addr, SOURCE_ABI, provider);
  const v2 = new Contract(v2Addr, SOURCE_ABI, provider);

  let botAddress = (process.env.CREDITER_ADDRESS || "").toLowerCase();
  let wallet = null;
  if (pk) {
    wallet = new Wallet(pk, provider);
    botAddress = wallet.address.toLowerCase();
  }

  const latest = BigInt(await provider.getBlockNumber());
  const block = await provider.getBlock("latest");
  const now = BigInt(block.timestamp);

  log("=== regrant-v1 → v2 (crediter path) ===");
  log(`  v1 source:     ${v1Addr}`);
  log(`  v2 source:     ${v2Addr}`);
  log(`  crediter:      ${botAddress || "(unset — cap check skipped)"}`);
  log(`  fromBlock:     ${fromBlock} → ${latest}`);
  log(`  mode:          ${live ? "LIVE RUN" : "DRY_RUN (no txs)"}`);
  log(`  v2.owner:      ${await v2.owner()}`);

  let authorized = false;
  let remaining = 0n;
  let dailyCap = 0n;
  let usedToday = 0n;
  if (botAddress && /^0x[a-f0-9]{40}$/.test(botAddress)) {
    const c = await v2.crediters(botAddress);
    authorized = c.authorized === true || c[0] === true;
    dailyCap = c.dailyCap ?? c[1];
    usedToday = c.usedToday ?? c[2];
    const dayBucket = c.dayBucket ?? c[3];
    log(`  authorized:    ${authorized}`);
    log(
      `  crediterCap:   ${authorized ? formatUnits(dailyCap, 18) : "(not added yet on v2)"}`,
    );
    if (authorized) {
      remaining = remainingCrediterWei(dailyCap, usedToday, dayBucket, block.timestamp);
      log(`  remainingToday:${formatUnits(remaining, 18)} ticket-wei`);
    } else {
      log(
        "Crediter not authorized on v2 yet — dry-run will still list holders.\n" +
          "  Treasury must addCrediter(bot, 200e18) on the NEW source first.",
      );
    }
  } else if (live) {
    throw new Error("CREDITER_PRIVATE_KEY is required when running live");
  }

  log("scanning v1 grant/credit events…");
  const candidates = await collectRecipientAddresses(
    provider,
    v1Addr,
    fromBlock,
    latest,
    chunk,
    log,
  );
  log(`  unique recipients from events: ${candidates.length}`);

  /** @type {{ address: string, tickets: bigint, expiry: bigint }[]} */
  const holders = [];
  for (const addr of candidates) {
    const tickets = await v1.ticketsOf(addr);
    const expiry = await v1.expiryOf(addr);
    if (tickets > 0n && expiry > now) {
      holders.push({ address: addr, tickets, expiry });
    }
  }
  holders.sort((a, b) => (a.tickets === b.tickets ? 0 : a.tickets > b.tickets ? -1 : 1));

  const totalWei = holders.reduce((s, h) => s + h.tickets, 0n);
  log("--- unexpired v1 balances ---");
  log(`  holders:       ${holders.length}`);
  log(`  total tickets: ${formatUnits(totalWei, 18)}`);
  for (const h of holders) {
    log(
      `  ${h.address}  ${formatUnits(h.tickets, 18)}  expires ${h.expiry} (${new Date(Number(h.expiry) * 1000).toISOString()})`,
    );
  }

  const allowance = authorized ? remaining : totalWei;
  /** @type {typeof holders} */
  const willCredit = [];
  /** @type {typeof holders} */
  const overflow = [];
  let used = 0n;
  for (const h of holders) {
    if (used + h.tickets <= allowance) {
      willCredit.push(h);
      used += h.tickets;
    } else {
      overflow.push(h);
    }
  }

  log("--- plan ---");
  log(`  will credit:   ${willCredit.length} (${formatUnits(used, 18)} tickets)`);
  log(
    `  overflow:      ${overflow.length} (${formatUnits(
      overflow.reduce((s, h) => s + h.tickets, 0n),
      18,
    )} tickets)`,
  );

  if (overflow.length > 0) {
    log("--- OVERFLOW (manual treasury grant on v2) ---");
    log(
      "Paste into a grant() batch (or split by grantDailyCap). amountEach may differ per row — group equal amounts.",
    );
    for (const h of overflow) {
      log(`  ${h.address}  amountWei=${h.tickets.toString()}  human=${formatUnits(h.tickets, 18)}`);
    }
    // Group by identical amount for convenient grant(users, amountEach) calls.
    const byAmt = new Map();
    for (const h of overflow) {
      const k = h.tickets.toString();
      if (!byAmt.has(k)) byAmt.set(k, []);
      byAmt.get(k).push(h.address);
    }
    log("--- OVERFLOW grouped by amountEach ---");
    for (const [amt, addrs] of byAmt) {
      log(`  amountEach=${amt} (${formatUnits(BigInt(amt), 18)}) users=${JSON.stringify(addrs)}`);
    }
  }

  const preview = {
    mode: live ? "live" : "dry_run",
    v1: v1Addr,
    v2: v2Addr,
    crediter: botAddress || null,
    authorized,
    dailyCap: authorized ? dailyCap.toString() : null,
    remainingToday: authorized ? remaining.toString() : null,
    holders: holders.map((h) => ({
      address: h.address,
      tickets: h.tickets.toString(),
      ticketsHuman: formatUnits(h.tickets, 18),
      expiry: h.expiry.toString(),
    })),
    willCredit: willCredit.map((h) => ({
      address: h.address,
      tickets: h.tickets.toString(),
    })),
    overflow: overflow.map((h) => ({
      address: h.address,
      tickets: h.tickets.toString(),
      ticketsHuman: formatUnits(h.tickets, 18),
    })),
    totalTicketsHuman: formatUnits(totalWei, 18),
    credited: 0,
    txHashes: [],
  };

  if (!live) {
    log(
      "DRY_RUN complete — set RUN=true with CREDITER_PRIVATE_KEY after addCrediter on v2 to broadcast.",
    );
    return preview;
  }

  if (!authorized) {
    throw new Error(
      `crediter ${botAddress} is not authorized on v2 — treasury must addCrediter first`,
    );
  }
  if (willCredit.length === 0) {
    log("nothing to credit within today's cap (see OVERFLOW if any)");
    return preview;
  }

  const writable = v2.connect(wallet);
  const txHashes = [];
  let credited = 0;

  for (let i = 0; i < willCredit.length; i++) {
    const { address: user, tickets } = willCredit[i];
    log(`credit ${i + 1}/${willCredit.length} ${user} ${formatUnits(tickets, 18)}…`);
    const tx = await writable.credit(user, tickets);
    log(`  submitted ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`credit failed user=${user} tx=${tx.hash}`);
    }
    txHashes.push(tx.hash);
    credited++;
    log(`  confirmed block=${receipt.blockNumber}`);
  }

  preview.credited = credited;
  preview.txHashes = txHashes;
  log("--- summary ---");
  log(
    JSON.stringify(
      {
        credited,
        overflow: overflow.length,
        txHashes,
      },
      null,
      2,
    ),
  );
  return preview;
}

async function main() {
  const run = process.env.RUN === "true" || process.env.RUN === "1";
  const forceDry =
    process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
  const result = await runRegrantV1({ live: run && !forceDry });
  if (process.env.DROP_JSON === "1" || process.env.DROP_JSON === "true") {
    console.log("REGRANT_JSON_RESULT=" + JSON.stringify(result));
  }
}

const isCli =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
