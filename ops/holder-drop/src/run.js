#!/usr/bin/env node
/**
 * Daily holder-tier drop for StandardTicketSource via the **crediter** path.
 *
 * Uses CREDITER_PRIVATE_KEY (dedicated bot wallet) → credit(user, amount) one-by-one.
 * Does NOT hold the treasury key. Treasury only runs addCrediter once (manual).
 *
 * Safety: dry-run is the default. Set RUN=true to broadcast.
 *
 * Crediter semantics (StandardTicketSource):
 *   - Owner: addCrediter(addr, dailyCap), lowerCrediterCap (down only), grant() batch
 *   - Crediter: credit(user, amount) — consumes caller's dailyCap; 7× balance ceiling
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { Contract, JsonRpcProvider, Wallet, formatUnits } from "ethers";
import { buildExclusionSet, parseExcludeEnv } from "./exclusions.js";
import { fetchAllHolders } from "./fetch-holders.js";
import { filterEligibleHolders, takeWithinAllowance } from "./filter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "..", ".env"), override: false });
// Also accept repo-root .env when launched from the dashboard API.
dotenv.config({ path: resolve(__dirname, "..", "..", "..", ".env"), override: false });

const SOURCE_ABI = [
  "function credit(address user, uint256 amount)",
  "function crediters(address) view returns (bool authorized, uint256 dailyCap, uint256 usedToday, uint256 dayBucket)",
  "function owner() view returns (address)",
];

const codeCache = new Map();

async function isContractAddress(provider, addr) {
  const key = addr.toLowerCase();
  if (codeCache.has(key)) return codeCache.get(key);
  const code = await provider.getCode(addr);
  const yes = !!code && code !== "0x";
  codeCache.set(key, yes);
  return yes;
}

function remainingCrediterWei(cap, used, dayBucket, nowSec) {
  const currentBucket = BigInt(Math.floor(Number(nowSec) / 86400));
  const usedEffective = currentBucket === BigInt(dayBucket) ? used : 0n;
  return cap > usedEffective ? cap - usedEffective : 0n;
}

/**
 * @param {{ live?: boolean, log?: (line: string) => void }} [opts]
 * @returns {Promise<object>}
 */
export async function runHolderDrop(opts = {}) {
  const log = opts.log || ((line) => console.log(line));
  const rpcUrl = process.env.RPC_URL;
  const pk = process.env.CREDITER_PRIVATE_KEY;
  const sourceAddr =
    process.env.STANDARD_SOURCE || "0x6C7CC31d5eC5899c7f5019516cFA3629167B2fd8";
  const scratch =
    process.env.SCRATCH || "0xf5E5f4D3C34A14B2fDfD59584Fe555Cd5e21F196";
  const threshold = BigInt(process.env.THRESHOLD || "1000000000000000000000000");
  const ticketsEach = BigInt(process.env.TICKETS_EACH || "1000000000000000000");
  const forceDry =
    process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
  // opts.live wins when set; otherwise honor RUN env (CLI).
  const live =
    opts.live === true
      ? !forceDry
      : opts.live === false
        ? false
        : (process.env.RUN === "true" || process.env.RUN === "1") && !forceDry;

  if (!rpcUrl) throw new Error("RPC_URL is required");
  if (live && !pk) {
    throw new Error("CREDITER_PRIVATE_KEY is required when running live");
  }
  if (process.env.GRANTER_PRIVATE_KEY) {
    log(
      "WARN: GRANTER_PRIVATE_KEY is set but ignored — holder-drop uses CREDITER_PRIVATE_KEY + credit() only.",
    );
  }

  const exclusions = buildExclusionSet(parseExcludeEnv(process.env.EXCLUDE));
  const provider = new JsonRpcProvider(rpcUrl);
  const source = new Contract(sourceAddr, SOURCE_ABI, provider);

  let botAddress = (process.env.CREDITER_ADDRESS || "").toLowerCase();
  let wallet = null;
  if (pk) {
    wallet = new Wallet(pk, provider);
    botAddress = wallet.address.toLowerCase();
  }

  log("=== holder-drop (crediter path) ===");
  log(`  scratch:       ${scratch}`);
  log(`  source:        ${sourceAddr}`);
  log(`  crediter:      ${botAddress || "(unset — cap check skipped)"}`);
  log(`  threshold:     ${formatUnits(threshold, 18)} SCRATCH`);
  log(`  ticketsEach:   ${formatUnits(ticketsEach, 18)}`);
  log(`  mode:          ${live ? "LIVE RUN" : "DRY_RUN (no txs)"}`);

  let authorized = false;
  let remaining = 0n;
  let dailyCap = 0n;
  let usedToday = 0n;
  const owner = await source.owner();
  log(`  source.owner:  ${owner}`);

  if (botAddress && /^0x[a-f0-9]{40}$/.test(botAddress)) {
    const c = await source.crediters(botAddress);
    authorized = c.authorized === true || c[0] === true;
    dailyCap = c.dailyCap ?? c[1];
    usedToday = c.usedToday ?? c[2];
    const dayBucket = c.dayBucket ?? c[3];
    log(`  authorized:    ${authorized}`);
    log(
      `  crediterCap:   ${authorized ? formatUnits(dailyCap, 18) : "(not added yet)"}`,
    );
    if (!authorized) {
      log(
        "Crediter not authorized on-chain yet — dry-run will still list recipients.\n" +
          "  Treasury must call addCrediter(bot, 200e18) once (see README).",
      );
    } else {
      const block = await provider.getBlock("latest");
      remaining = remainingCrediterWei(dailyCap, usedToday, dayBucket, block.timestamp);
      log(`  remainingToday:${formatUnits(remaining, 18)} ticket-wei`);
    }
  } else if (live) {
    throw new Error("CREDITER_PRIVATE_KEY is required when running live");
  } else {
    log(
      "  authorized:    (skipped — set CREDITER_ADDRESS or CREDITER_PRIVATE_KEY to resolve crediters())",
    );
  }

  log("fetching holders from Blockscout…");
  const holders = await fetchAllHolders(scratch);
  log(`  raw holders:   ${holders.length}`);

  const filtered = await filterEligibleHolders(holders, {
    threshold,
    exclusions,
    isContract: (addr) => isContractAddress(provider, addr),
  });

  const allowance = authorized
    ? remaining
    : BigInt(filtered.eligible.length) * ticketsEach;
  const { recipients, skippedOverCap } = takeWithinAllowance(
    filtered.eligible,
    allowance,
    ticketsEach,
  );

  log("--- filter ---");
  log(`  eligible EOAs: ${filtered.eligible.length}`);
  log(`  excluded list: ${filtered.excludedListed}`);
  log(`  excluded contracts: ${filtered.excludedContracts}`);
  log(`  below threshold: ${filtered.belowThreshold}`);
  log(`  skipped over cap: ${skippedOverCap}`);
  log(`  will credit:   ${recipients.length}`);

  log("--- recipients (balance-desc) ---");
  for (const r of recipients) {
    log(`  ${r.address}  ${formatUnits(r.balance, 18)} SCRATCH`);
  }

  const preview = {
    mode: live ? "live" : "dry_run",
    scratch,
    source: sourceAddr,
    crediter: botAddress || null,
    owner,
    authorized,
    threshold: threshold.toString(),
    thresholdHuman: formatUnits(threshold, 18),
    ticketsEach: ticketsEach.toString(),
    ticketsEachHuman: formatUnits(ticketsEach, 18),
    dailyCap: authorized ? dailyCap.toString() : null,
    dailyCapHuman: authorized ? formatUnits(dailyCap, 18) : null,
    usedToday: authorized ? usedToday.toString() : null,
    remainingToday: authorized ? remaining.toString() : null,
    remainingTodayHuman: authorized ? formatUnits(remaining, 18) : null,
    rawHolders: holders.length,
    eligible: filtered.eligible.length,
    excludedListed: filtered.excludedListed,
    excludedContracts: filtered.excludedContracts,
    belowThreshold: filtered.belowThreshold,
    skippedOverCap,
    willCredit: recipients.length,
    recipients: recipients.map((r) => ({
      address: r.address,
      balance: r.balance.toString(),
      balanceHuman: formatUnits(r.balance, 18),
    })),
    credited: 0,
    txHashes: [],
  };

  if (!live) {
    log(
      "DRY_RUN complete — set RUN=true with CREDITER_PRIVATE_KEY after addCrediter to broadcast.",
    );
    return preview;
  }

  if (!authorized) {
    throw new Error(
      `crediter ${botAddress} is not authorized — treasury must addCrediter first`,
    );
  }
  if (recipients.length === 0) {
    log("nothing to credit");
    return preview;
  }

  const writable = source.connect(wallet);
  const txHashes = [];
  let credited = 0;

  for (let i = 0; i < recipients.length; i++) {
    const user = recipients[i].address;
    log(`credit ${i + 1}/${recipients.length} ${user}…`);
    const tx = await writable.credit(user, ticketsEach);
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
        eligible: filtered.eligible.length,
        credited,
        excludedContracts: filtered.excludedContracts,
        excludedListed: filtered.excludedListed,
        skippedOverCap,
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
  const result = await runHolderDrop({ live: run && !forceDry });
  if (process.env.DROP_JSON === "1" || process.env.DROP_JSON === "true") {
    console.log("DROP_JSON_RESULT=" + JSON.stringify(result));
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
