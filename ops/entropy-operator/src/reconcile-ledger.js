#!/usr/bin/env node
/**
 * Compare on-chain ScratchSettled (since GAME_DEPLOY_BLOCK) to payout-ledger.csv.
 *
 * Env: RPC_URL, GAME_ADDRESS, GAME_DEPLOY_BLOCK, LEDGER_FILE (or PAYOUT_LEDGER_PATH), LOG_CHUNK
 *
 * Loads ops/entropy-operator/.env via dotenv (override: false — process.env wins).
 */
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  SCRATCH_SETTLED_ABI,
  defaultGameAddress,
  defaultLedgerPath,
  loadLedgerRequestIds,
  splitCsvLine,
} from "./payout-ledger.js";
import fs from "node:fs";
import { resolveToken, ZERO } from "./token-map.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "..", ".env"), override: false });

const DEFAULT_DEPLOY_BLOCK = 13_138_508;

function loadLedgerRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const start = lines[0]?.startsWith("timestamp") ? 1 : 0;
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    if (c.length < 12) continue;
    rows.push({
      requestId: c[1],
      symbol: c[6],
      human: c[8],
      raw: c[7],
      retro: c[11]?.toLowerCase() === "true",
      timestamp: c[0],
    });
  }
  return rows;
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL is required");

  const game = defaultGameAddress();
  const fromBlock = Number(process.env.GAME_DEPLOY_BLOCK || DEFAULT_DEPLOY_BLOCK);
  const chunk = Number(process.env.LOG_CHUNK || 9_000);
  const ledgerPath = defaultLedgerPath();

  const provider = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(game, SCRATCH_SETTLED_ABI, provider);
  const latest = await provider.getBlockNumber();

  const chainIds = [];
  const chainById = new Map();
  let wins = 0;
  let noWins = 0;

  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = Math.min(latest, start + chunk - 1);
    const logs = await contract.queryFilter(
      contract.filters.ScratchSettled(),
      start,
      end,
    );
    for (const log of logs) {
      const requestId = log.args.requestId.toString();
      chainIds.push(requestId);
      const amount = log.args.amount;
      const asset = (log.args.asset || "").toLowerCase();
      const isWin = amount > 0n && asset !== ZERO;
      if (isWin) wins++;
      else noWins++;
      chainById.set(requestId, {
        requestId,
        user: log.args.user,
        asset,
        amount,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      });
    }
  }

  const ledgerRows = loadLedgerRows(ledgerPath);
  const ledgerIds = loadLedgerRequestIds(ledgerPath);
  const chainSet = new Set(chainIds);

  const missing = chainIds.filter((id) => !ledgerIds.has(id));
  const extras = [...ledgerIds].filter((id) => !chainSet.has(id));

  const seen = new Map();
  const duplicates = [];
  for (const id of chainIds) {
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  for (const [id, n] of seen) {
    if (n > 1) duplicates.push({ requestId: id, count: n });
  }

  const ledgerDupCounts = new Map();
  for (const r of ledgerRows) {
    ledgerDupCounts.set(r.requestId, (ledgerDupCounts.get(r.requestId) || 0) + 1);
  }
  const ledgerDuplicates = [...ledgerDupCounts.entries()]
    .filter(([, n]) => n > 1)
    .map(([requestId, count]) => ({ requestId, count }));

  const bigScratch = [...chainById.values()].filter((s) => {
    if (s.asset !== "0xf5e5f4d3c34a14b2fdfd59584fe555cd5e21f196") return false;
    try {
      return formatUnits(s.amount, 18) === "100000.0" || s.amount === 100000n * 10n ** 18n;
    } catch {
      return false;
    }
  });

  const scratch100k = [...chainById.values()].filter(
    (s) =>
      s.asset === "0xf5e5f4d3c34a14b2fdfd59584fe555cd5e21f196" &&
      s.amount === 100000n * 10n ** 18n,
  );

  console.log("=== payout ledger reconcile ===");
  console.log(`game:          ${game}`);
  console.log(`blocks:        ${fromBlock} → ${latest}`);
  console.log(`ledger:        ${ledgerPath}`);
  console.log(`chain events:  ${chainIds.length} (wins=${wins} no-win=${noWins})`);
  console.log(`ledger rows:   ${ledgerRows.length} (unique ids=${ledgerIds.size})`);
  console.log(`missing ids:   ${missing.length}`);
  if (missing.length) {
    console.log(
      `  first 40: ${missing.slice(0, 40).join(", ")}${missing.length > 40 ? "…" : ""}`,
    );
  }
  console.log(`extra in CSV:  ${extras.length}`);
  if (extras.length) console.log(`  ${extras.slice(0, 40).join(", ")}`);
  console.log(`chain dups:    ${duplicates.length}`);
  console.log(`ledger dups:   ${ledgerDuplicates.length}`);
  if (ledgerDuplicates.length) console.log(JSON.stringify(ledgerDuplicates.slice(0, 20)));

  console.log("--- 100,000 SCRATCH wins ---");
  if (scratch100k.length === 0) {
    console.log("  none found on chain");
  } else {
    for (const s of scratch100k) {
      const inLedger = ledgerIds.has(s.requestId);
      const tok = resolveToken(s.asset);
      console.log(
        `  req=${s.requestId} amount=${formatUnits(s.amount, tok.decimals)} inLedger=${inLedger} tx=${s.txHash}`,
      );
    }
  }

  // Also flag any ~100000 human amounts in ledger
  const ledger100k = ledgerRows.filter(
    (r) =>
      r.symbol === "SCRATCH" &&
      (r.human === "100000.0" || r.human === "100000" || r.raw === "100000000000000000000000"),
  );
  console.log(`ledger 100k SCRATCH rows: ${ledger100k.length}`);
  for (const r of ledger100k) {
    console.log(`  req=${r.requestId} ts=${r.timestamp} retro=${r.retro}`);
  }

  const ok = missing.length === 0 && extras.length === 0 && ledgerDuplicates.length === 0;
  console.log(ok ? "RESULT: in sync" : "RESULT: drift");
  process.exit(ok ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
