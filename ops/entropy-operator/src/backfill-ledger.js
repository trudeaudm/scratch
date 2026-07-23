#!/usr/bin/env node
/**
 * Backfill payout-ledger.csv from ScratchSettled logs.
 * Settlements already in the ledger are skipped. New rows use current prices
 * with retro=true.
 *
 * By default starts near the newest ledger tx (incremental). Pass
 * FULL_BACKFILL=1 to scan from GAME_DEPLOY_BLOCK.
 *
 * Env:
 *   RPC_URL              required
 *   GAME_ADDRESS         ScratchGame (default production)
 *   GAME_DEPLOY_BLOCK    full-scan start (default 13138508)
 *   LEDGER_FILE          CSV path (alias: PAYOUT_LEDGER_PATH)
 *   LOG_CHUNK            eth_getLogs span (default 9000)
 *   FULL_BACKFILL        1 = scan from deploy block
 *   LOOKBACK_BLOCKS      extra blocks before last ledger tx (default 500)
 *
 * Loads ops/entropy-operator/.env via dotenv (override: false — process.env wins).
 */
import { Contract, JsonRpcProvider } from "ethers";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  SCRATCH_SETTLED_ABI,
  appendLedgerRow,
  defaultGameAddress,
  defaultLedgerPath,
  loadLedgerRequestIds,
} from "./payout-ledger.js";
import fs from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "..", ".env"), override: false });

const DEFAULT_DEPLOY_BLOCK = 13_138_508;

function lastLedgerTxHash(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return null;
  const lines = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("timestamp")) continue;
    // naive split is fine for our ledger (hashes aren't quoted)
    const cols = lines[i].split(",");
    const hash = (cols[12] || "").trim();
    if (hash.startsWith("0x") && hash.length >= 66) return hash;
  }
  return null;
}

async function resolveFromBlock(provider, ledgerPath, deployBlock) {
  if (process.env.FULL_BACKFILL === "1") return deployBlock;
  const lookback = Number(process.env.LOOKBACK_BLOCKS || 500);
  const hash = lastLedgerTxHash(ledgerPath);
  if (!hash) return deployBlock;
  try {
    const tx = await provider.getTransaction(hash);
    if (tx?.blockNumber != null) {
      const start = Math.max(deployBlock, Number(tx.blockNumber) - lookback);
      console.log(`  incremental from block ${start} (last ledger tx ${hash.slice(0, 10)}…)`);
      return start;
    }
  } catch (e) {
    console.warn(`  could not resolve last ledger tx block (${e?.message || e}); full scan`);
  }
  return deployBlock;
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL is required");

  const game = defaultGameAddress();
  const deployBlock = Number(process.env.GAME_DEPLOY_BLOCK || DEFAULT_DEPLOY_BLOCK);
  const chunk = Number(process.env.LOG_CHUNK || 9_000);
  const ledgerPath = defaultLedgerPath();

  const provider = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(game, SCRATCH_SETTLED_ABI, provider);
  const existing = loadLedgerRequestIds(ledgerPath);
  const latest = await provider.getBlockNumber();
  const fromBlock = await resolveFromBlock(provider, ledgerPath, deployBlock);

  console.log(`backfill ScratchSettled on ${game}`);
  console.log(`  blocks ${fromBlock} → ${latest} (chunk ${chunk})`);
  console.log(`  ledger: ${ledgerPath}`);
  console.log(`  already have ${existing.size} requestId(s)`);

  let scanned = 0;
  let appended = 0;
  let skipped = 0;

  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = Math.min(latest, start + chunk - 1);
    const logs = await contract.queryFilter(
      contract.filters.ScratchSettled(),
      start,
      end,
    );
    scanned += logs.length;

    for (const log of logs) {
      const requestId = log.args.requestId.toString();
      if (existing.has(requestId)) {
        skipped++;
        continue;
      }

      let iso;
      try {
        const block = await provider.getBlock(log.blockNumber);
        if (block?.timestamp != null) {
          iso = new Date(Number(block.timestamp) * 1000).toISOString();
        }
      } catch {
        /* appendLedgerRow falls back */
      }

      const ok = await appendLedgerRow(
        provider,
        {
          user: log.args.user,
          requestId,
          tier: Number(log.args.tier),
          rowIndex: log.args.rowIndex.toString(),
          asset: log.args.asset,
          amount: log.args.amount,
          txHash: log.transactionHash || "",
        },
        { retro: true, timestampIso: iso, txHash: log.transactionHash || "" },
      );
      if (ok) {
        existing.add(requestId);
        appended++;
      }
    }

    console.log(`  … ${end}/${latest} (scanned ${scanned}, +${appended}, skip ${skipped})`);
  }

  console.log(`done: scanned=${scanned} appended=${appended} skipped=${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
