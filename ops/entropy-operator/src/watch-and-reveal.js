#!/usr/bin/env node
/**
 * Watch SelfEntropyProvider.RandomnessRequested and submit reveal() in order.
 *
 * Env:
 *   RPC_URL                 HTTP(S) JSON-RPC
 *   OPERATOR_PRIVATE_KEY    operator key (must match on-chain operator) — preferred
 *   PRIVATE_KEY             fallback if OPERATOR_PRIVATE_KEY unset
 *   SELF_ENTROPY_ADDRESS    SelfEntropyProvider address
 *   CHAIN_FILE              path to state from generate-chain.js (default ../entropy-state.json)
 *   POLL_MS                 log poll interval (default 4000)
 *   REVEAL_MAX_RETRIES      tx retries (default 8)
 *   FROM_BLOCK              manual recovery override — scan start (alias: START_BLOCK)
 *   CATCH_UP_ONCE           if "1", drain pending then exit (no perpetual poll)
 *   GAME_ADDRESS            ScratchGame (for ScratchSettled ledger parse)
 *   PAYOUT_LEDGER_PATH      CSV path (default ../payout-ledger.csv)
 *
 * Startup lookback never clamps away unfulfilled requests: scans from
 *   min(lastProcessedBlock, block of on-chain nextFulfillSeq request)
 * to latest in ≤2k-block chunks, regardless of total span.
 *
 * Reveal loop always reads nextFulfillSeq on-chain and reveals that id only.
 *
 * Usage:
 *   node src/watch-and-reveal.js
 *   FROM_BLOCK=13390000 CATCH_UP_ONCE=1 node src/watch-and-reveal.js
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, keccak256, solidityPacked } from "ethers";
import { defaultLedgerPath, logLedgerError, recordRevealSettlements } from "./payout-ledger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(__dirname, "..", "entropy-state.json");
/** eth_getLogs chunk size — stay under Alchemy's 10k cap with margin. */
const LOG_CHUNK = 2_000;

const ABI = [
  "event RandomnessRequested(uint256 indexed requestId, address indexed requester)",
  "event ChainRegistered(uint64 indexed epoch, bytes32 commitment)",
  "function reveal(uint256 requestId, bytes32 preimage)",
  "function nextFulfillSeq(uint64 epoch) view returns (uint256)",
  "function nextSeq() view returns (uint256)",
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
      const msg = err.shortMessage || err.message || String(err);
      // Wrong key / hard reverts: fail fast — do not hammer the sequencer.
      if (/NotOperator|bad address checksum|insufficient funds/i.test(msg + (err.data || ""))) {
        throw err;
      }
      const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      console.warn(`  reveal failed (attempt ${attempt}/${maxRetries}): ${msg}`);
      if (attempt < maxRetries) await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Locate the block of RandomnessRequested(requestId) via indexed topic scans.
 * Returns null if not found in [scanFrom, latest].
 */
async function findRequestBlock(contract, requestId, scanFrom, latest) {
  const filter = contract.filters.RandomnessRequested(requestId);
  for (let start = scanFrom; start <= latest; start += LOG_CHUNK) {
    const end = Math.min(latest, start + LOG_CHUNK - 1);
    const logs = await contract.queryFilter(filter, start, end);
    if (logs.length) return Number(logs[0].blockNumber);
  }
  return null;
}

/**
 * Resolve inclusive scan start. Never clamps a gap that still has unfulfilled head.
 * Priority: FROM_BLOCK / START_BLOCK override → min(lastProcessed, headRequestBlock) → head → last → tip-1.
 */
async function resolveFromBlock(contract, state, latest) {
  const override = process.env.FROM_BLOCK ?? process.env.START_BLOCK;
  if (override !== undefined && override !== "") {
    const n = Number(override);
    if (!Number.isFinite(n) || n < 0) throw new Error(`invalid FROM_BLOCK: ${override}`);
    console.log(`  fromBlock:       ${n} (FROM_BLOCK/START_BLOCK override)`);
    return n;
  }

  const epoch = await contract.currentEpoch();
  const headSeq = await contract.nextFulfillSeq(epoch);
  const nextSeq = await contract.nextSeq();
  const lastProcessed =
    state.lastProcessedBlock !== undefined && state.lastProcessedBlock !== null
      ? Number(state.lastProcessedBlock)
      : null;

  // Search far enough back that a long restart gap cannot hide the head request.
  const searchFloor = Math.min(
    lastProcessed ?? latest,
    Math.max(0, latest - 2_000_000),
  );
  let headBlock = null;
  if (headSeq < nextSeq) {
    // There is at least one unfulfilled (or in-flight) id at/after head.
    headBlock = await findRequestBlock(contract, headSeq, searchFloor, latest);
    if (headBlock == null) {
      // Wider emergency scan from an explicit low floor used in ops recovery.
      const emergencyFloor = Number(process.env.REQUEST_SCAN_FLOOR || 13_000_000);
      console.warn(
        `  head request ${headSeq.toString()} not found from ${searchFloor}; scanning from ${emergencyFloor}`,
      );
      headBlock = await findRequestBlock(contract, headSeq, emergencyFloor, latest);
    }
  }

  let fromBlock;
  if (lastProcessed != null && headBlock != null) {
    fromBlock = Math.min(lastProcessed, headBlock);
  } else if (headBlock != null) {
    fromBlock = headBlock;
  } else if (lastProcessed != null) {
    fromBlock = lastProcessed;
  } else {
    fromBlock = Math.max(0, latest - 1);
  }

  console.log(`  nextFulfillSeq:  ${headSeq.toString()} (epoch ${epoch})`);
  console.log(`  nextSeq:         ${nextSeq.toString()}`);
  console.log(`  headReqBlock:    ${headBlock ?? "(none pending / not found)"}`);
  console.log(`  lastProcessed:   ${lastProcessed ?? "(unset)"}`);
  console.log(`  fromBlock:       ${fromBlock}`);
  return fromBlock;
}

/**
 * Reveal strictly the on-chain head (`nextFulfillSeq`) until the queue is drained
 * or the head is not yet pending. Event order is never trusted for targeting.
 * @returns {Promise<number>} number of reveals confirmed this call
 */
async function drainHeadReveals(contract, provider, state, chainFile, maxRetries) {
  let drained = 0;
  for (;;) {
    const currentEpoch = await contract.currentEpoch();
    const requestId = await contract.nextFulfillSeq(currentEpoch);
    const req = await contract.requests(requestId);

    const pending = Boolean(req.pending);
    const reqEpoch = BigInt(req.epoch ?? 0);
    if (!pending) {
      // Head id is not pending — caught up (typically requestId == nextSeq with empty slot).
      break;
    }
    if (reqEpoch !== BigInt(currentEpoch)) {
      console.warn(
        `head ${requestId.toString()}: epoch ${reqEpoch} != current ${currentEpoch} (orphaned) — stop`,
      );
      break;
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

    const key = requestId.toString();
    console.log(`revealing request ${key} with chain index ${state.nextRevealIndex}`);
    const receipt = await revealWithRetries(contract, requestId, preimage, maxRetries);

    state.nextRevealIndex -= 1;
    saveState(chainFile, state);
    drained += 1;
    console.log(`  nextRevealIndex now ${state.nextRevealIndex}`);

    // Ledger must never block or fail a reveal — isolated try/catch + ledger-errors.log.
    try {
      await recordRevealSettlements(provider, receipt, { requestId });
    } catch (ledgerErr) {
      try {
        logLedgerError(`reveal hook threw req=${key}`, ledgerErr);
      } catch (logErr) {
        console.error(`LEDGER ERROR: secondary log failure req=${key}:`, logErr);
      }
    }
  }
  return drained;
}

async function scanRequestedLogs(contract, fromBlock, toBlock, intoMap) {
  let rangeStart = fromBlock;
  while (rangeStart <= toBlock) {
    const rangeEnd = Math.min(toBlock, rangeStart + LOG_CHUNK - 1);
    const logs = await contract.queryFilter(
      contract.filters.RandomnessRequested(),
      rangeStart,
      rangeEnd,
    );
    for (const log of logs) {
      const requestId = log.args.requestId;
      intoMap.set(requestId.toString(), {
        requestId,
        blockNumber: Number(log.blockNumber),
        requester: log.args.requester,
      });
    }
    rangeStart = rangeEnd + 1;
  }
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
  const catchUpOnce = process.env.CATCH_UP_ONCE === "1" || process.env.CATCH_UP_ONCE === "true";

  if (!existsSync(chainFile)) {
    throw new Error(`chain state file not found: ${chainFile}`);
  }
  let state = loadState(chainFile);
  if (!state.secret || state.nextRevealIndex === undefined) {
    throw new Error(`invalid chain state at ${chainFile}`);
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(pk, provider);
  const contract = new Contract(address, ABI, wallet);

  const onChainOp = await contract.operator();
  if (onChainOp.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `wallet ${wallet.address} != on-chain operator ${onChainOp} — refusing to run (reveals would revert). Set OPERATOR_PRIVATE_KEY.`,
    );
  }

  const latest0 = await provider.getBlockNumber();
  let fromBlock = await resolveFromBlock(contract, state, latest0);

  const ledgerPath = defaultLedgerPath();
  console.log(`watching RandomnessRequested on ${address}`);
  console.log(`  operator wallet: ${wallet.address}`);
  console.log(`  chain file:      ${chainFile}`);
  console.log(`  nextRevealIndex: ${state.nextRevealIndex}`);
  console.log(`  payout ledger:   ${ledgerPath} (live append after each reveal)`);
  console.log(`  mode:            ${catchUpOnce ? "catch-up-once" : "poll"}`);

  const seen = new Map();
  let totalDrained = 0;

  for (;;) {
    try {
      const latest = await provider.getBlockNumber();

      // Re-anchor if on-chain head is older than our cursor (gap after crash / wrong tip).
      const epoch = await contract.currentEpoch();
      const headSeq = await contract.nextFulfillSeq(epoch);
      const headReq = await contract.requests(headSeq);
      if (headReq.pending) {
        const headBlock = await findRequestBlock(
          contract,
          headSeq,
          Math.min(fromBlock, Math.max(0, latest - 2_000_000)),
          latest,
        );
        if (headBlock != null && headBlock < fromBlock) {
          console.warn(
            `  re-anchoring fromBlock ${fromBlock} → ${headBlock} (unfulfilled head ${headSeq.toString()})`,
          );
          fromBlock = headBlock;
        }
      }

      if (latest >= fromBlock) {
        await scanRequestedLogs(contract, fromBlock, latest, seen);
        fromBlock = latest + 1;
        state.lastProcessedBlock = latest;
        saveState(chainFile, state);
      }

      const drained = await drainHeadReveals(contract, provider, state, chainFile, maxRetries);
      totalDrained += drained;
      if (drained > 0) {
        console.log(`  drained ${drained} request(s) this pass (session total ${totalDrained})`);
      }

      if (catchUpOnce) {
        const ep = await contract.currentEpoch();
        const head = await contract.nextFulfillSeq(ep);
        const ns = await contract.nextSeq();
        const still = await contract.requests(head);
        if (!still.pending || head >= ns) {
          console.log(
            `catch-up complete: drained=${totalDrained} nextFulfillSeq=${head.toString()} nextSeq=${ns.toString()}`,
          );
          return;
        }
        // Head still pending but we didn't drain — likely transient; one more loop then exit on persistent fail.
        if (drained === 0) {
          throw new Error(
            `catch-up stalled: head ${head.toString()} still pending but reveal did not proceed`,
          );
        }
      }
    } catch (err) {
      console.error(`poll error: ${err.shortMessage || err.message}`);
      if (catchUpOnce) throw err;
      // Wrong operator / desync: do not spin forever.
      const msg = err.shortMessage || err.message || "";
      if (/!= on-chain operator|refusing to run|state desync|hash chain exhausted/i.test(msg)) {
        throw err;
      }
    }
    if (catchUpOnce) continue;
    await sleep(pollMs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
