#!/usr/bin/env node
/**
 * Paced staker-compensation granter (v1 stranded tickets → v2 standard).
 *
 * Reads snapshot-v1-stakers.csv; owed = floor(ticketsAtFlip) whole tickets (1:1, no 2×).
 * Credits via the crediter wallet on STANDARD_SOURCE (default v2 Deploy3).
 * Persistent ledger comp-paid.csv prevents double-pay across waves.
 *
 * Limits per wave:
 *   - PER_WALLET_WAVE_CAP (default 100) — standard tickets expire in 7 days
 *   - min(grantDailyCap remaining, crediter dailyCap remaining)
 *   - top-owed-first; excess deferred to the next wave
 *
 * Safety: DRY_RUN is the default. Set RUN=true to broadcast.
 * Ledger updates only after confirmed txs.
 *
 * Usage:
 *   node --use-system-ca comp-grant.js
 *   node --use-system-ca comp-grant.js --status
 *   RUN=true node --use-system-ca comp-grant.js
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { Contract, JsonRpcProvider, Wallet, formatUnits } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env"), override: false });
dotenv.config({ path: resolve(__dirname, "..", "..", ".env"), override: false });

const SOURCE_DEFAULT = "0x6C7CC31d5eC5899c7f5019516cFA3629167B2fd8";
const ONE = 10n ** 18n;

const SOURCE_ABI = [
  "function credit(address user, uint256 amount)",
  "function ticketsOf(address user) view returns (uint256)",
  "function crediters(address) view returns (bool authorized, uint256 dailyCap, uint256 usedToday, uint256 dayBucket)",
  "function grantDailyCap() view returns (uint256)",
  "function grantUsedToday() view returns (uint256)",
  "function grantDayBucket() view returns (uint256)",
  "function owner() view returns (address)",
  "function CREDIT_CEILING_MULT() view returns (uint256)",
];

function parseAddressList(raw) {
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[a-f0-9]{40}$/.test(s));
}

/** Floor a human ticket decimal string ("1050.405…") to whole tickets. */
function floorHumanTickets(s) {
  const t = String(s ?? "").trim();
  if (!t) return 0n;
  const body = t.startsWith("-") ? t.slice(1) : t;
  const whole = (body.split(".")[0] || "0").replace(/^0+(?=\d)/, "") || "0";
  if (!/^\d+$/.test(whole)) throw new Error(`bad ticketsAtFlip value: ${s}`);
  return t.startsWith("-") ? 0n : BigInt(whole);
}

function csvEscape(value) {
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseCsv(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const row = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]] = (cols[c] ?? "").trim();
    }
    rows.push(row);
  }
  return { header, rows };
}

function remainingBucketWei(cap, used, dayBucket, nowSec) {
  const currentBucket = BigInt(Math.floor(Number(nowSec) / 86400));
  const usedEffective = currentBucket === BigInt(dayBucket) ? used : 0n;
  return cap > usedEffective ? cap - usedEffective : 0n;
}

function utcDateISO(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function ceilDiv(a, b) {
  if (b <= 0n) return 0n;
  return (a + b - 1n) / b;
}

function loadSnapshot(path) {
  if (!existsSync(path)) {
    throw new Error(
      `snapshot CSV not found: ${path}\nRun: npm run snapshot-v1-stakers`,
    );
  }
  const { rows } = parseCsv(readFileSync(path, "utf8"));
  /** @type {Map<string, bigint>} */
  const owed = new Map();
  for (const r of rows) {
    const addr = String(r.address || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(addr)) continue;
    const floor = floorHumanTickets(r.ticketsAtFlip);
    if (floor > 0n) owed.set(addr, floor);
  }
  return owed;
}

function loadLedger(path) {
  /** @type {Map<string, { totalPaid: bigint, lastWaveDate: string }>} */
  const paid = new Map();
  if (!existsSync(path)) return paid;
  const { rows } = parseCsv(readFileSync(path, "utf8"));
  for (const r of rows) {
    const addr = String(r.addr || r.address || "").toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(addr)) continue;
    const totalPaid = floorHumanTickets(r.totalPaid || "0");
    paid.set(addr, {
      totalPaid,
      lastWaveDate: String(r.lastWaveDate || ""),
    });
  }
  return paid;
}

function writeLedger(path, paid) {
  const addrs = [...paid.keys()].sort();
  const lines = ["addr,totalPaid,lastWaveDate"];
  for (const addr of addrs) {
    const row = paid.get(addr);
    lines.push(
      [addr, row.totalPaid.toString(), row.lastWaveDate]
        .map(csvEscape)
        .join(","),
    );
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

/**
 * @param {{ live?: boolean, statusOnly?: boolean, log?: (line: string) => void }} [opts]
 */
export async function runCompGrant(opts = {}) {
  const log = opts.log || ((line) => console.log(line));
  const statusOnly =
    opts.statusOnly === true ||
    process.argv.includes("--status") ||
    process.env.STATUS === "true" ||
    process.env.STATUS === "1";

  const snapshotPath = resolve(
    __dirname,
    process.env.SNAPSHOT_CSV || "snapshot-v1-stakers.csv",
  );
  const ledgerPath = resolve(
    __dirname,
    process.env.COMP_PAID_CSV || "comp-paid.csv",
  );
  const sourceAddr = process.env.STANDARD_SOURCE || SOURCE_DEFAULT;
  const perWalletCap = BigInt(process.env.PER_WALLET_WAVE_CAP || "100");
  const known = new Set(parseAddressList(process.env.KNOWN_WALLETS));

  const forceDry =
    process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
  const live =
    statusOnly
      ? false
      : opts.live === true
        ? !forceDry
        : opts.live === false
          ? false
          : (process.env.RUN === "true" || process.env.RUN === "1") && !forceDry;

  if (perWalletCap <= 0n) {
    throw new Error("PER_WALLET_WAVE_CAP must be > 0");
  }

  const owedMap = loadSnapshot(snapshotPath);
  const paidMap = loadLedger(ledgerPath);

  /** @type {{ address: string, owed: bigint, alreadyPaid: bigint, remaining: bigint }[]} */
  const wallets = [];
  let excludedKnown = 0;
  for (const [addr, owed] of owedMap) {
    if (known.has(addr)) {
      excludedKnown += 1;
      continue;
    }
    const alreadyPaid = paidMap.get(addr)?.totalPaid ?? 0n;
    const remaining = owed > alreadyPaid ? owed - alreadyPaid : 0n;
    wallets.push({ address: addr, owed, alreadyPaid, remaining });
  }
  wallets.sort((a, b) => {
    if (a.remaining === b.remaining) {
      return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    }
    return a.remaining > b.remaining ? -1 : 1;
  });

  const totalOwed = wallets.reduce((s, w) => s + w.owed, 0n);
  const totalPaid = wallets.reduce((s, w) => s + w.alreadyPaid, 0n);
  const totalRemaining = wallets.reduce((s, w) => s + w.remaining, 0n);

  if (statusOnly) {
    log("=== comp-grant --status ===");
    log(`  snapshot:      ${snapshotPath}`);
    log(`  ledger:        ${ledgerPath}`);
    log(`  known excluded:${excludedKnown}`);
    log(`  wallets owed:  ${wallets.length}`);
    log(`  total owed:    ${totalOwed}`);
    log(`  total paid:    ${totalPaid}`);
    log(`  still owed:    ${totalRemaining}`);
    const pct =
      totalOwed === 0n
        ? "100.0"
        : ((Number(totalPaid) / Number(totalOwed)) * 100).toFixed(1);
    log(`  complete:      ${pct}%`);
    log("--- ledger (owed vs paid) ---");
    log(
      "address                                      owed   paid  remain     %",
    );
    for (const w of wallets) {
      const done =
        w.owed === 0n
          ? 100
          : Number((w.alreadyPaid * 1000n) / w.owed) / 10;
      log(
        `${w.address}  ${w.owed.toString().padStart(5)}  ${w.alreadyPaid.toString().padStart(5)}  ${w.remaining.toString().padStart(6)}  ${done.toFixed(1).padStart(5)}%`,
      );
    }
    return {
      mode: "status",
      wallets: wallets.length,
      totalOwed: totalOwed.toString(),
      totalPaid: totalPaid.toString(),
      totalRemaining: totalRemaining.toString(),
      pctComplete: pct,
    };
  }

  const rpcUrl = process.env.RPC_URL;
  const pk = process.env.CREDITER_PRIVATE_KEY;
  if (!rpcUrl) throw new Error("RPC_URL is required");
  if (live && !pk) {
    throw new Error("CREDITER_PRIVATE_KEY is required when running live");
  }
  if (process.env.GRANTER_PRIVATE_KEY || process.env.TREASURY_PRIVATE_KEY) {
    log(
      "WARN: treasury/granter key env is set but ignored — comp-grant uses CREDITER_PRIVATE_KEY + credit() only.",
    );
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const source = new Contract(sourceAddr, SOURCE_ABI, provider);

  let botAddress = (process.env.CREDITER_ADDRESS || "").toLowerCase();
  let wallet = null;
  if (pk) {
    wallet = new Wallet(pk, provider);
    botAddress = wallet.address.toLowerCase();
  }

  const block = await provider.getBlock("latest");
  const nowSec = block.timestamp;

  const [grantDailyCap, grantUsedToday, grantDayBucket, ceilingMult] =
    await Promise.all([
      source.grantDailyCap(),
      source.grantUsedToday(),
      source.grantDayBucket(),
      source.CREDIT_CEILING_MULT(),
    ]);
  const grantRemaining = remainingBucketWei(
    grantDailyCap,
    grantUsedToday,
    grantDayBucket,
    nowSec,
  );

  let authorized = false;
  let crediterCap = 0n;
  let crediterUsed = 0n;
  let crediterRemaining = 0n;
  if (botAddress && /^0x[a-f0-9]{40}$/.test(botAddress)) {
    const c = await source.crediters(botAddress);
    authorized = c.authorized === true || c[0] === true;
    crediterCap = c.dailyCap ?? c[1];
    crediterUsed = c.usedToday ?? c[2];
    const dayBucket = c.dayBucket ?? c[3];
    if (authorized) {
      crediterRemaining = remainingBucketWei(
        crediterCap,
        crediterUsed,
        dayBucket,
        nowSec,
      );
    }
  } else if (live) {
    throw new Error("CREDITER_PRIVATE_KEY is required when running live");
  }

  // Binding daily allowance = min(owner grant remaining, crediter remaining).
  // credit() only enforces the crediter cap on-chain; grant remaining is an
  // operational ceiling so we never outpace the source's daily blast radius.
  let dailyAllowanceTickets;
  if (authorized) {
    const grantTickets = grantRemaining / ONE;
    const crediterTickets = crediterRemaining / ONE;
    dailyAllowanceTickets =
      grantTickets < crediterTickets ? grantTickets : crediterTickets;
  } else {
    // Dry-run without auth: still plan against grant remaining + a generous fallback.
    dailyAllowanceTickets = grantRemaining / ONE;
  }

  log("=== comp-grant (staker compensation, 1:1 floor) ===");
  log(`  source:           ${sourceAddr}`);
  log(`  crediter:         ${botAddress || "(unset — cap check skipped)"}`);
  log(`  snapshot:         ${snapshotPath}`);
  log(`  ledger:           ${ledgerPath}`);
  log(`  perWalletWaveCap: ${perWalletCap}`);
  log(`  known excluded:   ${excludedKnown}`);
  log(`  mode:             ${live ? "LIVE RUN" : "DRY_RUN (no txs)"}`);
  log(`  source.owner:     ${await source.owner()}`);
  log(
    `  grantDailyCap:    ${formatUnits(grantDailyCap, 18)} (remaining ${formatUnits(grantRemaining, 18)})`,
  );
  log(`  authorized:       ${authorized}`);
  if (authorized) {
    log(
      `  crediterCap:      ${formatUnits(crediterCap, 18)} (remaining ${formatUnits(crediterRemaining, 18)})`,
    );
  } else {
    log(
      "  crediterCap:      (not authorized / address unset — dry-run plans against grant remaining)",
    );
  }
  log(`  waveAllowance:    ${dailyAllowanceTickets} tickets (min of grant+crediter remaining)`);
  log(`  wallets owed>0:   ${wallets.filter((w) => w.remaining > 0n).length}`);
  log(`  total still owed: ${totalRemaining}`);

  /** @type {{ address: string, owed: bigint, alreadyPaid: bigint, thisWave: bigint, remainingAfter: bigint }[]} */
  const plan = [];
  /** @type {{ address: string, owed: bigint, alreadyPaid: bigint, deferred: bigint, reason: string }[]} */
  const deferred = [];
  let allowanceLeft = dailyAllowanceTickets;

  for (const w of wallets) {
    if (w.remaining <= 0n) continue;

    const want =
      w.remaining < perWalletCap ? w.remaining : perWalletCap;

    if (allowanceLeft <= 0n) {
      deferred.push({
        address: w.address,
        owed: w.owed,
        alreadyPaid: w.alreadyPaid,
        deferred: w.remaining,
        reason: "daily-allowance-exhausted",
      });
      continue;
    }

    const thisWave = want < allowanceLeft ? want : allowanceLeft;
    allowanceLeft -= thisWave;
    const remainingAfter = w.remaining - thisWave;
    plan.push({
      address: w.address,
      owed: w.owed,
      alreadyPaid: w.alreadyPaid,
      thisWave,
      remainingAfter,
    });
    if (remainingAfter > 0n) {
      deferred.push({
        address: w.address,
        owed: w.owed,
        alreadyPaid: w.alreadyPaid,
        deferred: remainingAfter,
        reason:
          thisWave < want
            ? "partial-daily-cap"
            : "per-wallet-wave-cap",
      });
    }
  }

  const thisWaveTotal = plan.reduce((s, p) => s + p.thisWave, 0n);
  const deferredTickets = deferred.reduce((s, d) => s + d.deferred, 0n);
  const paidAfterWave = totalPaid + thisWaveTotal;
  const stillAfterWave = totalOwed > paidAfterWave ? totalOwed - paidAfterWave : 0n;

  // Estimate remaining waves: max(per-wallet ceil, total/dailyAllowance).
  let maxWalletWaves = 0n;
  for (const w of wallets) {
    const rem = w.remaining;
    // After this planned wave, remaining for recipients in plan is remainingAfter;
    // for fully deferred, full remaining.
    const planned = plan.find((p) => p.address === w.address);
    const after = planned ? planned.remainingAfter : rem;
    if (after <= 0n) continue;
    const waves = ceilDiv(after, perWalletCap);
    if (waves > maxWalletWaves) maxWalletWaves = waves;
  }
  const dailyWaves =
    dailyAllowanceTickets > 0n
      ? ceilDiv(stillAfterWave, dailyAllowanceTickets)
      : stillAfterWave > 0n
        ? 999999n
        : 0n;
  const estWaves =
    maxWalletWaves > dailyWaves ? maxWalletWaves : dailyWaves;

  log("--- wave plan ---");
  log(
    "address                                      owed  paid  thisWave  remainAfter",
  );
  for (const p of plan) {
    log(
      `${p.address}  ${p.owed.toString().padStart(5)}  ${p.alreadyPaid.toString().padStart(4)}  ${p.thisWave.toString().padStart(8)}  ${p.remainingAfter.toString().padStart(11)}`,
    );
  }
  if (plan.length === 0) {
    log("(nothing to grant this wave)");
  }

  if (deferred.length > 0) {
    log("--- deferred (next wave+) ---");
    log(
      "address                                      deferred  reason",
    );
    for (const d of deferred) {
      log(
        `${d.address}  ${d.deferred.toString().padStart(8)}  ${d.reason}`,
      );
    }
  }

  log("--- summary ---");
  log(`  wallets touched:       ${plan.length}`);
  log(`  tickets this wave:     ${thisWaveTotal}`);
  log(`  total granted to date: ${paidAfterWave}${live ? "" : " (projected)"}`);
  log(`  total still owed:      ${stillAfterWave}${live ? "" : " (after this wave)"}`);
  log(`  deferred tickets:      ${deferredTickets}`);
  log(
    `  est. waves remaining:  ${estWaves}${dailyAllowanceTickets === 0n && stillAfterWave > 0n ? " (daily allowance is 0 — unblock crediter/grant cap)" : ""}`,
  );

  const preview = {
    mode: live ? "live" : "dry_run",
    source: sourceAddr,
    crediter: botAddress || null,
    authorized,
    perWalletWaveCap: perWalletCap.toString(),
    grantRemaining: grantRemaining.toString(),
    crediterRemaining: authorized ? crediterRemaining.toString() : null,
    waveAllowanceTickets: dailyAllowanceTickets.toString(),
    plan: plan.map((p) => ({
      address: p.address,
      owed: p.owed.toString(),
      alreadyPaid: p.alreadyPaid.toString(),
      thisWave: p.thisWave.toString(),
      remainingAfter: p.remainingAfter.toString(),
    })),
    deferred: deferred.map((d) => ({
      address: d.address,
      deferred: d.deferred.toString(),
      reason: d.reason,
    })),
    walletsTouched: plan.length,
    ticketsThisWave: thisWaveTotal.toString(),
    totalGrantedToDate: paidAfterWave.toString(),
    totalStillOwed: stillAfterWave.toString(),
    estimatedWavesRemaining: estWaves.toString(),
    credited: 0,
    txHashes: [],
  };

  if (!live) {
    log(
      "DRY_RUN complete — set RUN=true with CREDITER_PRIVATE_KEY to broadcast; ledger updates only on confirmed txs.",
    );
    return preview;
  }

  if (!authorized) {
    throw new Error(
      `crediter ${botAddress} is not authorized — treasury must addCrediter first`,
    );
  }
  if (plan.length === 0) {
    log("nothing to credit this wave");
    return preview;
  }

  const writable = source.connect(wallet);
  const txHashes = [];
  let credited = 0;
  const waveDate = utcDateISO();

  for (let i = 0; i < plan.length; i++) {
    const { address: user, thisWave } = plan[i];
    const amountWei = thisWave * ONE;

    // Warn if existing balance would fully clip this credit (ceiling = 7× amount).
    const bal = await source.ticketsOf(user);
    const ceiling = ceilingMult * amountWei;
    if (bal >= ceiling) {
      log(
        `WARN skip ${user}: balance ${formatUnits(bal, 18)} ≥ ceiling ${formatUnits(ceiling, 18)} — credit would be clipped; scratch first`,
      );
      continue;
    }

    log(
      `credit ${i + 1}/${plan.length} ${user} ${thisWave} tickets (${formatUnits(amountWei, 18)})…`,
    );
    const tx = await writable.credit(user, amountWei);
    log(`  submitted ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`credit failed user=${user} tx=${tx.hash}`);
    }
    txHashes.push(tx.hash);
    credited += 1;
    log(`  confirmed block=${receipt.blockNumber}`);

    const prev = paidMap.get(user) ?? { totalPaid: 0n, lastWaveDate: "" };
    paidMap.set(user, {
      totalPaid: prev.totalPaid + thisWave,
      lastWaveDate: waveDate,
    });
    writeLedger(ledgerPath, paidMap);
  }

  preview.credited = credited;
  preview.txHashes = txHashes;
  log("--- live summary ---");
  log(
    JSON.stringify(
      {
        credited,
        ticketsThisWave: thisWaveTotal.toString(),
        txHashes,
        ledger: ledgerPath,
      },
      null,
      2,
    ),
  );
  return preview;
}

async function main() {
  const statusOnly = process.argv.includes("--status");
  const run = process.env.RUN === "true" || process.env.RUN === "1";
  const forceDry =
    process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
  const result = await runCompGrant({
    live: statusOnly ? false : run && !forceDry,
    statusOnly,
  });
  if (process.env.DROP_JSON === "1" || process.env.DROP_JSON === "true") {
    console.log("COMP_GRANT_JSON_RESULT=" + JSON.stringify(result));
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
