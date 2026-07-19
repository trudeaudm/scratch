#!/usr/bin/env node
/**
 * Prove live append path: re-fetch a ScratchSettled fulfill receipt and run
 * recordRevealSettlements (retro=false). Target requestId must be absent from CSV.
 *
 * Env: RPC_URL, optional PROVE_REQUEST_ID (default: latest on chain)
 */
import fs from "node:fs";
import { Contract, JsonRpcProvider } from "ethers";
import {
  SCRATCH_SETTLED_ABI,
  defaultGameAddress,
  defaultLedgerPath,
  loadLedgerRequestIds,
  recordRevealSettlements,
  splitCsvLine,
} from "./payout-ledger.js";

const DEFAULT_DEPLOY_BLOCK = 13_138_508;

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL required");
  const provider = new JsonRpcProvider(rpcUrl);
  const game = defaultGameAddress();
  const contract = new Contract(game, SCRATCH_SETTLED_ABI, provider);
  const tip = await provider.getBlockNumber();
  const from = Math.max(DEFAULT_DEPLOY_BLOCK, tip - 200_000);

  let requestId = process.env.PROVE_REQUEST_ID || "";
  let txHash = process.env.PROVE_TX_HASH || "";

  if (!txHash) {
    // Chunked scan for latest (or matching) ScratchSettled.
    const chunk = 9_000;
    let target = null;
    for (let start = tip; start >= from && !target; ) {
      const end = start;
      const rangeStart = Math.max(from, start - chunk + 1);
      const logs = await contract.queryFilter(
        contract.filters.ScratchSettled(),
        rangeStart,
        end,
      );
      if (logs.length) {
        if (requestId) {
          target = logs.find((l) => l.args.requestId.toString() === requestId) || null;
        } else {
          target = logs[logs.length - 1];
        }
      }
      start = rangeStart - 1;
    }
    if (!target) throw new Error("no ScratchSettled found");
    requestId = target.args.requestId.toString();
    txHash = target.transactionHash;
  }

  if (!requestId) {
    // Derive from receipt logs after fetch.
    requestId = process.env.PROVE_REQUEST_ID || "";
  }
  const ledgerPath = defaultLedgerPath();

  // Remove existing row for this requestId so live append can write (additive skip otherwise).
  if (fs.existsSync(ledgerPath)) {
    const lines = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/);
    const kept = lines.filter((line, i) => {
      if (i === 0 || !line.trim()) return true;
      const cols = splitCsvLine(line);
      return cols[1] !== requestId;
    });
    while (kept.length && kept[kept.length - 1] === "") kept.pop();
    fs.writeFileSync(ledgerPath, kept.join("\n") + "\n", "utf8");
  }

  console.log(`prove: replaying req=${requestId || "?"} tx=${txHash}`);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("receipt not found");

  await recordRevealSettlements(provider, receipt, {
    requestId: requestId ? BigInt(requestId) : undefined,
  });

  if (!requestId) {
    // Recover id from newly appended last line.
    const lines = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean);
    requestId = splitCsvLine(lines[lines.length - 1])[1];
  }

  const ids = loadLedgerRequestIds(ledgerPath);
  const text = fs.readFileSync(ledgerPath, "utf8");
  const row = text
    .split(/\r?\n/)
    .filter(Boolean)
    .find((l) => splitCsvLine(l)[1] === requestId);
  if (!ids.has(requestId) || !row) {
    throw new Error("FAIL: row not written");
  }
  const cols = splitCsvLine(row);
  const retro = cols[11];
  const price = cols[9];
  console.log(`prove: row written retro=${retro} price_usd=${price || "(blank)"}`);
  console.log(row);
  if (retro !== "false") throw new Error(`FAIL: expected retro=false got ${retro}`);
  console.log("PROVE OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
