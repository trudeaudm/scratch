#!/usr/bin/env node
/**
 * Watch SelfEntropyProvider.RandomnessRequested and submit reveal() in order.
 *
 * Env:
 *   RPC_URL                 HTTP(S) JSON-RPC
 *   PRIVATE_KEY             operator key (must match on-chain operator)
 *   SELF_ENTROPY_ADDRESS    SelfEntropyProvider address
 *   CHAIN_FILE              path to state from generate-chain.js (default ../entropy-state.json)
 *   POLL_MS                 log poll interval (default 4000)
 *   REVEAL_MAX_RETRIES      tx retries (default 8)
 *   START_BLOCK             optional from-block for backfill (default: latest - 1)
 *   GAME_ADDRESS            ScratchGame (for ScratchSettled ledger parse)
 *   PAYOUT_LEDGER_PATH      CSV path (default ../payout-ledger.csv)
 *
 * Usage:
 *   node src/watch-and-reveal.js
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, keccak256, solidityPacked } from "ethers";
import { defaultLedgerPath, logLedgerError, recordRevealSettlements } from "./payout-ledger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(__dirname, "..", "entropy-state.json");

const ABI = [
  "event RandomnessRequested(uint256 indexed requestId, address indexed requester)",
  "event ChainRegistered(uint64 indexed epoch, bytes32 commitment)",
  "function reveal(uint256 requestId, bytes32 preimage)",
  "function nextFulfillSeq(uint64 epoch) view returns (uint256)",
  "function currentEpoch() view returns (uint64)",
  "function epochCursor(uint64 epoch) view returns (bytes32)",
  "function operator() view returns (address)",
  "function requests(uint256 requestId) view returns (address requester, uint64 epoch, bool pending)",
];

function hashPacked(preimageHex) {
  return keccak256(solidityPacked(["bytes32"], [preimageHex]));
}

/** Rebuild preimage at index i from secret (chain[0]=secret, tip=chain[n]). */
function preimageAt(secret, index) {
  let h = secret;
  for (let i = 0; i < index; i++) {
    h = hashPacked(h);
  }
  return h;
}

function loadState(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveState(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function revealWithRetries(contract, requestId, preimage, maxRetries) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const tx = await contract.reveal(requestId, preimage);
      console.log(`  reveal tx submitted (attempt ${attempt}): ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  reveal confirmed in block ${receipt.blockNumber}`);
      return receipt;
    } catch (err) {
      lastErr = err;
      const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      console.warn(`  reveal failed (attempt ${attempt}/${maxRetries}): ${err.shortMessage || err.message}`);
      if (attempt < maxRetries) await sleep(delay);
    }
  }
  throw lastErr;
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const pk = process.env.OPERATOR_PRIVATE_KEY || process.env.PRIVATE_KEY;
  const address = process.env.SELF_ENTROPY_ADDRESS;
  if (!rpcUrl || !pk || !address) {
    throw new Error(
      "RPC_URL, SELF_ENTROPY_ADDRESS, and OPERATOR_PRIVATE_KEY (or PRIVATE_KEY) are required",
    );
  }

  const chainFile = resolve(process.env.CHAIN_FILE || DEFAULT_FILE);
  const pollMs = Number(process.env.POLL_MS || 4000);
  const maxRetries = Number(process.env.REVEAL_MAX_RETRIES || 8);

  let state = loadState(chainFile);
  if (!state.secret || state.nextRevealIndex === undefined) {
    throw new Error(`invalid chain state at ${chainFile}`);
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(pk, provider);
  const contract = new Contract(address, ABI, wallet);

  const onChainOp = await contract.operator();
  if (onChainOp.toLowerCase() !== wallet.address.toLowerCase()) {
    console.warn(
      `warning: wallet ${wallet.address} != on-chain operator ${onChainOp} — reveals will revert`
    );
  }

  let fromBlock =
    process.env.START_BLOCK !== undefined
      ? Number(process.env.START_BLOCK)
      : Math.max(0, (await provider.getBlockNumber()) - 1);

  const ledgerPath = defaultLedgerPath();
  console.log(`watching RandomnessRequested on ${address}`);
  console.log(`  operator wallet: ${wallet.address}`);
  console.log(`  chain file:      ${chainFile}`);
  console.log(`  nextRevealIndex: ${state.nextRevealIndex}`);
  console.log(`  fromBlock:       ${fromBlock}`);
  console.log(`  payout ledger:   ${ledgerPath} (live append after each reveal)`);

  const processed = new Set();
  const MAX_LOG_RANGE = 9_000; // Alchemy (and many RPCs) cap eth_getLogs span

  for (;;) {
    try {
      const latest = await provider.getBlockNumber();
      if (latest >= fromBlock) {
        let rangeStart = fromBlock;
        while (rangeStart <= latest) {
          const rangeEnd = Math.min(latest, rangeStart + MAX_LOG_RANGE - 1);
          const logs = await contract.queryFilter(
            contract.filters.RandomnessRequested(),
            rangeStart,
            rangeEnd,
          );
          for (const log of logs) {
            const requestId = log.args.requestId;
            const key = requestId.toString();
            if (processed.has(key)) continue;

            const req = await contract.requests(requestId);
            const epoch = req.epoch;
            const pending = req.pending;
            if (!pending) {
              console.log(`request ${key}: already fulfilled/orphaned — skip`);
              processed.add(key);
              continue;
            }

            const currentEpoch = await contract.currentEpoch();
            if (epoch !== currentEpoch) {
              console.warn(`request ${key}: epoch ${epoch} != current ${currentEpoch} (orphaned) — skip`);
              processed.add(key);
              continue;
            }

            const expected = await contract.nextFulfillSeq(currentEpoch);
            if (requestId !== expected) {
              // Wait for in-order head; leave unprocessed so a later poll retries.
              console.log(`request ${key}: waiting for in-order head ${expected.toString()}`);
              continue;
            }

            if (state.nextRevealIndex < 0) {
              throw new Error("hash chain exhausted — register a new chain and regenerate state");
            }

            const preimage = preimageAt(state.secret, state.nextRevealIndex);
            const cursor = await contract.epochCursor(currentEpoch);
            if (hashPacked(preimage) !== cursor) {
              throw new Error(
                `preimage at index ${state.nextRevealIndex} does not match on-chain cursor — state desync`,
              );
            }

            console.log(`revealing request ${key} with chain index ${state.nextRevealIndex}`);
            const receipt = await revealWithRetries(contract, requestId, preimage, maxRetries);

            state.nextRevealIndex -= 1;
            saveState(chainFile, state);
            processed.add(key);
            console.log(`  nextRevealIndex now ${state.nextRevealIndex}`);

            // Ledger must never block or fail a reveal — errors log loudly + ledger-errors.log.
            try {
              await recordRevealSettlements(provider, receipt, { requestId });
            } catch (ledgerErr) {
              logLedgerError(`reveal hook threw req=${key}`, ledgerErr);
            }
          }
          rangeStart = rangeEnd + 1;
        }
        fromBlock = latest + 1;
      }
    } catch (err) {
      console.error(`poll error: ${err.shortMessage || err.message}`);
    }
    await sleep(pollMs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
