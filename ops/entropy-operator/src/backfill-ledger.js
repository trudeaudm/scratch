#!/usr/bin/env node
/**
 * Backfill payout-ledger.csv from ScratchSettled logs since GAME_DEPLOY_BLOCK.
 * Settlements already in the ledger are skipped. New rows use current prices
 * with retro=true.
 *
 * Env:
 *   RPC_URL              required
 *   GAME_ADDRESS         ScratchGame (default production)
 *   GAME_DEPLOY_BLOCK    start block (default 13138508)
 *   LEDGER_FILE          CSV path (alias: PAYOUT_LEDGER_PATH)
 *   LOG_CHUNK            eth_getLogs span (default 9000)
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

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "..", ".env"), override: false });

const DEFAULT_DEPLOY_BLOCK = 13_138_508;

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL is required");

  const game = defaultGameAddress();
  const fromBlock = Number(process.env.GAME_DEPLOY_BLOCK || DEFAULT_DEPLOY_BLOCK);
  const chunk = Number(process.env.LOG_CHUNK || 9_000);
  const ledgerPath = defaultLedgerPath();

  const provider = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(game, SCRATCH_SETTLED_ABI, provider);
  const existing = loadLedgerRequestIds(ledgerPath);
  const latest = await provider.getBlockNumber();

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
