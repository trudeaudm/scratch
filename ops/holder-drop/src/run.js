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
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Contract, JsonRpcProvider, Wallet, formatUnits } from "ethers";
import { buildExclusionSet, parseExcludeEnv } from "./exclusions.js";
import { fetchAllHolders } from "./fetch-holders.js";
import { filterEligibleHolders, takeWithinAllowance } from "./filter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "..", ".env"), override: false });

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

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const pk = process.env.CREDITER_PRIVATE_KEY;
  const sourceAddr =
    process.env.STANDARD_SOURCE || "0xC94894Cd3986E2D0f85616a0Dc59914f1057f003";
  const scratch =
    process.env.SCRATCH || "0xf5E5f4D3C34A14B2fDfD59584Fe555Cd5e21F196";
  const threshold = BigInt(process.env.THRESHOLD || "1000000000000000000000000");
  const ticketsEach = BigInt(process.env.TICKETS_EACH || "1000000000000000000");
  const run = process.env.RUN === "true" || process.env.RUN === "1";
  const forceDry =
    process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
  const willSend = run && !forceDry;

  if (!rpcUrl) throw new Error("RPC_URL is required");
  if (willSend && !pk) {
    throw new Error("CREDITER_PRIVATE_KEY is required when RUN=true");
  }
  if (process.env.GRANTER_PRIVATE_KEY) {
    console.warn(
      "WARN: GRANTER_PRIVATE_KEY is set but ignored — holder-drop uses CREDITER_PRIVATE_KEY + credit() only.",
    );
  }

  const exclusions = buildExclusionSet(parseExcludeEnv(process.env.EXCLUDE));
  const provider = new JsonRpcProvider(rpcUrl);
  const source = new Contract(sourceAddr, SOURCE_ABI, provider);

  // Resolve bot address: from key if present, else CREDITER_ADDRESS for dry-run without key.
  let botAddress = (process.env.CREDITER_ADDRESS || "").toLowerCase();
  let wallet = null;
  if (pk) {
    wallet = new Wallet(pk, provider);
    botAddress = wallet.address.toLowerCase();
  }

  console.log("=== holder-drop (crediter path) ===");
  console.log(`  scratch:       ${scratch}`);
  console.log(`  source:        ${sourceAddr}`);
  console.log(`  crediter:      ${botAddress || "(unset — cap check skipped)"}`);
  console.log(`  threshold:     ${formatUnits(threshold, 18)} SCRATCH`);
  console.log(`  ticketsEach:   ${formatUnits(ticketsEach, 18)}`);
  console.log(`  mode:          ${willSend ? "LIVE RUN" : "DRY_RUN (no txs)"}`);

  let authorized = false;
  let remaining = 0n;
  const owner = await source.owner();
  console.log(`  source.owner:  ${owner}`);

  if (botAddress && /^0x[a-f0-9]{40}$/.test(botAddress)) {
    const c = await source.crediters(botAddress);
    authorized = c.authorized === true || c[0] === true;
    const dailyCap = c.dailyCap ?? c[1];
    const usedToday = c.usedToday ?? c[2];
    const dayBucket = c.dayBucket ?? c[3];
    console.log(`  authorized:    ${authorized}`);
    console.log(
      `  crediterCap:   ${authorized ? formatUnits(dailyCap, 18) : "(not added yet)"}`,
    );
    if (!authorized) {
      console.log(
        "Crediter not authorized on-chain yet — dry-run will still list recipients.\n" +
          "  Treasury must call addCrediter(bot, 200e18) once (see README).",
      );
    } else {
      const block = await provider.getBlock("latest");
      remaining = remainingCrediterWei(dailyCap, usedToday, dayBucket, block.timestamp);
      console.log(`  remainingToday:${formatUnits(remaining, 18)} ticket-wei`);
    }
  } else if (willSend) {
    throw new Error("CREDITER_PRIVATE_KEY is required when RUN=true");
  } else {
    console.log(
      "  authorized:    (skipped — set CREDITER_ADDRESS or CREDITER_PRIVATE_KEY to resolve crediters())",
    );
  }

  console.log("fetching holders from Blockscout…");
  const holders = await fetchAllHolders(scratch);
  console.log(`  raw holders:   ${holders.length}`);

  const filtered = await filterEligibleHolders(holders, {
    threshold,
    exclusions,
    isContract: (addr) => isContractAddress(provider, addr),
  });

  // If not yet authorized, show full eligible list (cap unknown); live runs use remaining.
  const allowance = authorized ? remaining : BigInt(filtered.eligible.length) * ticketsEach;
  const { recipients, skippedOverCap } = takeWithinAllowance(
    filtered.eligible,
    allowance,
    ticketsEach,
  );

  console.log("--- filter ---");
  console.log(`  eligible EOAs: ${filtered.eligible.length}`);
  console.log(`  excluded list: ${filtered.excludedListed}`);
  console.log(`  excluded contracts: ${filtered.excludedContracts}`);
  console.log(`  below threshold: ${filtered.belowThreshold}`);
  console.log(`  skipped over cap: ${skippedOverCap}`);
  console.log(`  will credit:   ${recipients.length}`);

  console.log("--- recipients (balance-desc) ---");
  for (const r of recipients) {
    console.log(`  ${r.address}  ${formatUnits(r.balance, 18)} SCRATCH`);
  }

  if (!willSend) {
    console.log(
      "DRY_RUN complete — set RUN=true with CREDITER_PRIVATE_KEY after addCrediter to broadcast.",
    );
    return;
  }

  if (!authorized) {
    throw new Error(
      `crediter ${botAddress} is not authorized — treasury must addCrediter first`,
    );
  }
  if (recipients.length === 0) {
    console.log("nothing to credit");
    return;
  }

  const writable = source.connect(wallet);
  const txHashes = [];
  let credited = 0;

  for (let i = 0; i < recipients.length; i++) {
    const user = recipients[i].address;
    console.log(`credit ${i + 1}/${recipients.length} ${user}…`);
    const tx = await writable.credit(user, ticketsEach);
    console.log(`  submitted ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`credit failed user=${user} tx=${tx.hash}`);
    }
    txHashes.push(tx.hash);
    credited++;
    console.log(`  confirmed block=${receipt.blockNumber}`);
  }

  console.log("--- summary ---");
  console.log(
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
