#!/usr/bin/env node
/**
 * Daily holder-tier granter for StandardTicketSource.
 *
 * Safety defaults: DRY_RUN (or unset RUN) prints the recipient list and exits 0
 * without sending. Set RUN=true to broadcast grant() batches.
 *
 * GRANTER_PRIVATE_KEY must be the StandardTicketSource owner (treasury).
 * onlyOwner = treasury — this key can raise caps and addCrediters. Handle as hot-treasury.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Contract, JsonRpcProvider, Wallet, formatUnits } from "ethers";
import { buildExclusionSet, parseExcludeEnv } from "./exclusions.js";
import { fetchAllHolders } from "./fetch-holders.js";
import {
  chunkAddresses,
  filterEligibleHolders,
  takeWithinAllowance,
} from "./filter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "..", ".env"), override: false });

const SOURCE_ABI = [
  "function grant(address[] users, uint256 amountEach)",
  "function grantDailyCap() view returns (uint256)",
  "function grantUsedToday() view returns (uint256)",
  "function grantDayBucket() view returns (uint256)",
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

function remainingGrantWei(cap, used, dayBucket, nowSec) {
  const currentBucket = BigInt(Math.floor(Number(nowSec) / 86400));
  const usedEffective = currentBucket === dayBucket ? used : 0n;
  return cap > usedEffective ? cap - usedEffective : 0n;
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const pk = process.env.GRANTER_PRIVATE_KEY;
  const sourceAddr =
    process.env.STANDARD_SOURCE || "0xC94894Cd3986E2D0f85616a0Dc59914f1057f003";
  const scratch =
    process.env.SCRATCH || "0xf5E5f4D3C34A14B2fDfD59584Fe555Cd5e21F196";
  const threshold = BigInt(process.env.THRESHOLD || "1000000000000000000000000");
  const ticketsEach = BigInt(process.env.TICKETS_EACH || "1000000000000000000");
  const run = process.env.RUN === "true" || process.env.RUN === "1";
  // Dry-run is the default unless RUN=true. DRY_RUN=true forces dry-run even if RUN is set.
  const forceDry =
    process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
  const willSend = run && !forceDry;

  if (!rpcUrl) throw new Error("RPC_URL is required");
  if (willSend && !pk) {
    throw new Error("GRANTER_PRIVATE_KEY is required when RUN=true");
  }

  const exclusions = buildExclusionSet(parseExcludeEnv(process.env.EXCLUDE));
  const provider = new JsonRpcProvider(rpcUrl);
  const source = new Contract(sourceAddr, SOURCE_ABI, provider);

  console.log("=== holder-drop ===");
  console.log(`  scratch:       ${scratch}`);
  console.log(`  source:        ${sourceAddr}`);
  console.log(`  threshold:     ${formatUnits(threshold, 18)} SCRATCH`);
  console.log(`  ticketsEach:   ${formatUnits(ticketsEach, 18)}`);
  console.log(`  mode:          ${willSend ? "LIVE RUN" : "DRY_RUN (no txs)"}`);

  const [cap, used, dayBucket, owner, block] = await Promise.all([
    source.grantDailyCap(),
    source.grantUsedToday(),
    source.grantDayBucket(),
    source.owner(),
    provider.getBlock("latest"),
  ]);
  const remaining = remainingGrantWei(cap, used, dayBucket, block.timestamp);
  console.log(`  owner:         ${owner}`);
  console.log(`  grantDailyCap: ${formatUnits(cap, 18)}`);
  console.log(`  remainingToday:${formatUnits(remaining, 18)} ticket-wei`);

  if (willSend) {
    const wallet = new Wallet(pk, provider);
    if (wallet.address.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(
        `GRANTER_PRIVATE_KEY ${wallet.address} != StandardTicketSource.owner() ${owner} — grant is onlyOwner (treasury).`,
      );
    }
  }

  console.log("fetching holders from Blockscout…");
  const holders = await fetchAllHolders(scratch);
  console.log(`  raw holders:   ${holders.length}`);

  const filtered = await filterEligibleHolders(holders, {
    threshold,
    exclusions,
    isContract: (addr) => isContractAddress(provider, addr),
  });

  const { recipients, skippedOverCap } = takeWithinAllowance(
    filtered.eligible,
    remaining,
    ticketsEach,
  );

  console.log("--- filter ---");
  console.log(`  eligible EOAs: ${filtered.eligible.length}`);
  console.log(`  excluded list: ${filtered.excludedListed}`);
  console.log(`  excluded contracts: ${filtered.excludedContracts}`);
  console.log(`  below threshold: ${filtered.belowThreshold}`);
  console.log(`  skipped over cap: ${skippedOverCap}`);
  console.log(`  will grant:    ${recipients.length}`);

  console.log("--- recipients (balance-desc) ---");
  for (const r of recipients) {
    console.log(`  ${r.address}  ${formatUnits(r.balance, 18)} SCRATCH`);
  }

  if (!willSend) {
    console.log("DRY_RUN complete — set RUN=true (and unset DRY_RUN) to broadcast.");
    return;
  }

  if (recipients.length === 0) {
    console.log("nothing to grant");
    return;
  }

  const wallet = new Wallet(pk, provider);
  const writable = source.connect(wallet);
  const batches = chunkAddresses(
    recipients.map((r) => r.address),
    100,
  );
  const txHashes = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`granting batch ${i + 1}/${batches.length} size=${batch.length}…`);
    const tx = await writable.grant(batch, ticketsEach);
    console.log(`  submitted ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`grant batch ${i + 1} failed tx=${tx.hash}`);
    }
    txHashes.push(tx.hash);
    console.log(`  confirmed block=${receipt.blockNumber}`);
  }

  console.log("--- summary ---");
  console.log(
    JSON.stringify(
      {
        eligible: filtered.eligible.length,
        granted: recipients.length,
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
