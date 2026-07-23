#!/usr/bin/env node
/**
 * Compare on-chain ScratchSettled (since GAME_DEPLOY_BLOCK) to payout-ledger.csv.
 *
 * Env: RPC_URL, GAME_ADDRESS, GAME_DEPLOY_BLOCK, LEDGER_FILE (or PAYOUT_LEDGER_PATH), LOG_CHUNK
 *
 * Loads ops/entropy-operator/.env via dotenv (override: false — process.env wins).
 *
 * NOTE: The laptop checkout CSV is historical-only after Render cutover.
 * Always reconcile against the authoritative LEDGER_FILE on the reveal host (/data).
 */
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import {
  settledAbi,
  settlementKey,
  isGameV2,
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
const SCRATCH = "0xf5e5f4d3c34a14b2fdfd59584fe555cd5e21f196";

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

/**
 * @param {{ silent?: boolean }} [opts]
 * @returns {Promise<object>}
 */
export async function runReconcile(opts = {}) {
  const silent = !!opts.silent;
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL is required");

  const game = defaultGameAddress();
  const v2 = isGameV2(game);
  const fromBlock = Number(process.env.GAME_DEPLOY_BLOCK || DEFAULT_DEPLOY_BLOCK);
  const chunk = Number(process.env.LOG_CHUNK || 9_000);
  const ledgerPath = defaultLedgerPath();

  const provider = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(game, settledAbi(game), provider);
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
      const key = v2
        ? settlementKey({
            requestId,
            cardIndex: Number(log.args.cardIndex),
          })
        : requestId;
      chainIds.push(key);
      const amount = log.args.amount;
      const asset = (log.args.asset || "").toLowerCase();
      const isWin = amount > 0n && asset !== ZERO;
      if (isWin) wins++;
      else noWins++;
      chainById.set(key, {
        requestId: key,
        user: log.args.user,
        asset,
        amount: amount.toString(),
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

  const scratch100k = [...chainById.values()].filter(
    (s) => s.asset === SCRATCH && s.amount === (100000n * 10n ** 18n).toString(),
  );

  const ledger100k = ledgerRows.filter(
    (r) =>
      r.symbol === "SCRATCH" &&
      (r.human === "100000.0" || r.human === "100000" || r.raw === "100000000000000000000000"),
  );

  const inSync =
    missing.length === 0 && extras.length === 0 && ledgerDuplicates.length === 0;

  const summary = {
    game,
    fromBlock,
    toBlock: latest,
    ledgerPath,
    chainEvents: chainIds.length,
    wins,
    noWins,
    ledgerRows: ledgerRows.length,
    ledgerUniqueIds: ledgerIds.size,
    missingCount: missing.length,
    missingFirst40: missing.slice(0, 40),
    extraCount: extras.length,
    extrasFirst40: extras.slice(0, 40),
    chainDuplicates: duplicates.length,
    ledgerDuplicates: ledgerDuplicates.length,
    ledgerDuplicateSample: ledgerDuplicates.slice(0, 20),
    scratch100k: scratch100k.map((s) => ({
      requestId: s.requestId,
      amount: formatUnits(BigInt(s.amount), resolveToken(s.asset).decimals),
      inLedger: ledgerIds.has(s.requestId),
      txHash: s.txHash,
    })),
    ledger100k: ledger100k.map((r) => ({
      requestId: r.requestId,
      timestamp: r.timestamp,
      retro: r.retro,
    })),
    result: inSync ? "in sync" : "drift",
    inSync,
  };

  if (!silent) {
    console.log("=== payout ledger reconcile ===");
    console.log(`game:          ${game} (v2=${v2})`);
    console.log(`blocks:        ${fromBlock} → ${latest}`);
    console.log(`ledger:        ${ledgerPath}`);
    console.log(
      `chain ${v2 ? "cards" : "events"}:  ${chainIds.length} (wins=${wins} no-win=${noWins})`,
    );
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
      for (const s of summary.scratch100k) {
        console.log(
          `  req=${s.requestId} amount=${s.amount} inLedger=${s.inLedger} tx=${s.txHash}`,
        );
      }
    }
    console.log(`ledger 100k SCRATCH rows: ${ledger100k.length}`);
    for (const r of ledger100k) {
      console.log(`  req=${r.requestId} ts=${r.timestamp} retro=${r.retro}`);
    }
    console.log(inSync ? "RESULT: in sync" : "RESULT: drift");
  }

  return summary;
}

async function main() {
  const summary = await runReconcile({ silent: false });
  process.exit(summary.inSync ? 0 : 2);
}

const isDirect =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
