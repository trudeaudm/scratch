#!/usr/bin/env node
/**
 * Watch SelfEntropyProvider.RandomnessRequested and submit reveal() in order.
 *
 * Env:
 *   RPC_URL                 HTTP(S) JSON-RPC
 *   WSS_URL                 optional WebSocket RPC (preferred for low latency)
 *   OPERATOR_PRIVATE_KEY    operator key (must match on-chain operator) — preferred
 *   PRIVATE_KEY             fallback if OPERATOR_PRIVATE_KEY unset
 *   SELF_ENTROPY_ADDRESS    SelfEntropyProvider address
 *   CHAIN_FILE              path to state from generate-chain.js (default ../entropy-state.json)
 *   POLL_MS                 HTTP poll interval when not on ws (default 2500)
 *   HEAD_CHECK_MS           independent nextFulfillSeq lag check (default 60000)
 *   REVEAL_MAX_RETRIES      tx retries (default 8)
 *   FROM_BLOCK              manual recovery override — scan start (alias: START_BLOCK)
 *   CATCH_UP_ONCE           if "1", drain pending then exit (no perpetual poll)
 *   GAME_ADDRESS            ScratchGame (for ScratchSettled ledger parse)
 *   LEDGER_FILE             CSV path (alias: PAYOUT_LEDGER_PATH; default ../payout-ledger.csv)
 *
 * Reveal targeting always reads on-chain nextFulfillSeq (never event order).
 * getLogs / websocket only accelerate discovery + latency metrics.
 *
 * Usage:
 *   node src/watch-and-reveal.js
 *   FROM_BLOCK=13390000 CATCH_UP_ONCE=1 node src/watch-and-reveal.js
 *
 * Loads ops/entropy-operator/.env via dotenv (override: false — existing
 * process.env wins over the file).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  Contract,
  JsonRpcProvider,
  WebSocketProvider,
  Wallet,
  keccak256,
  solidityPacked,
} from "ethers";
import { defaultLedgerPath, logLedgerError, recordRevealSettlements } from "./payout-ledger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dirname, "..", ".env");
dotenv.config({ path: ENV_FILE, override: false });
const DEFAULT_FILE = resolve(__dirname, "..", "entropy-state.json");
/** eth_getLogs chunk size — stay under Alchemy's 10k cap with margin. */
const LOG_CHUNK = 2_000;
/** Max blocks to walk when locating a single request for latency / resync. */
const HEAD_FIND_MAX = 50_000;

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

/** Derive wss:// from common Alchemy https:// URLs when WSS_URL unset. */
function inferWssUrl(httpUrl) {
  if (!httpUrl) return null;
  try {
    const u = new URL(httpUrl);
    if (u.protocol === "https:" && u.hostname.includes("alchemy.com")) {
      u.protocol = "wss:";
      return u.toString();
    }
    if (u.protocol === "http:" && u.hostname.includes("alchemy.com")) {
      u.protocol = "ws:";
      return u.toString();
    }
  } catch {
    /* ignore */
  }
  return null;
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
 * Locate RandomnessRequested(requestId) scanning backward from `latest` at most
 * HEAD_FIND_MAX blocks (never a multi-million-block walk on the hot path).
 */
async function findRequestBlockNearTip(contract, requestId, latest, maxSpan = HEAD_FIND_MAX) {
  const filter = contract.filters.RandomnessRequested(requestId);
  const floor = Math.max(0, latest - maxSpan);
  for (let end = latest; end >= floor; end -= LOG_CHUNK) {
    const start = Math.max(floor, end - LOG_CHUNK + 1);
    const logs = await contract.queryFilter(filter, start, end);
    if (logs.length) return Number(logs[logs.length - 1].blockNumber);
  }
  return null;
}

/**
 * Startup / forced resync start block. Never clamps away an unfulfilled head.
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

  let headBlock = null;
  if (headSeq < nextSeq) {
    headBlock = await findRequestBlockNearTip(contract, headSeq, latest, 2_000_000);
    if (headBlock == null) {
      const emergencyFloor = Number(process.env.REQUEST_SCAN_FLOOR || 13_000_000);
      console.warn(
        `  head request ${headSeq.toString()} not near tip; scanning from ${emergencyFloor}`,
      );
      headBlock = await findRequestBlockNearTip(
        contract,
        headSeq,
        latest,
        Math.max(0, latest - emergencyFloor),
      );
    }
  }

  let fromBlock;
  if (lastProcessed != null && headBlock != null) {
    fromBlock = Math.min(lastProcessed, headBlock);
  } else if (headBlock != null) {
    fromBlock = headBlock;
  } else if (lastProcessed != null) {
    // Resume from last successful scan tip (inclusive re-scan of that block).
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

async function scanRequestedLogs(contract, fromBlock, toBlock, intoMap) {
  if (fromBlock > toBlock) return;
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

/**
 * Reveal strictly the on-chain head until drained.
 * @returns {Promise<number>} confirms this call
 */
async function drainHeadReveals(ctx) {
  const { contract, httpProvider, state, chainFile, maxRetries, requestMeta } = ctx;
  let drained = 0;
  for (;;) {
    const currentEpoch = await contract.currentEpoch();
    const requestId = await contract.nextFulfillSeq(currentEpoch);
    const req = await contract.requests(requestId);

    const pending = Boolean(req.pending);
    const reqEpoch = BigInt(req.epoch ?? 0);
    if (!pending) break;
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
    const noticedAt = Date.now();
    let reqBlockTs = null;
    let reqBlockNumber = requestMeta.get(key)?.blockNumber ?? null;
    if (reqBlockNumber == null) {
      const tip = await httpProvider.getBlockNumber();
      reqBlockNumber = await findRequestBlockNearTip(contract, requestId, tip);
      if (reqBlockNumber != null) {
        requestMeta.set(key, { requestId, blockNumber: reqBlockNumber });
      }
    }
    if (reqBlockNumber != null) {
      try {
        const blk = await httpProvider.getBlock(reqBlockNumber);
        reqBlockTs = Number(blk.timestamp) * 1000;
      } catch {
        /* latency log best-effort */
      }
    }

    console.log(`revealing request ${key} with chain index ${state.nextRevealIndex}`);
    const receipt = await revealWithRetries(contract, requestId, preimage, maxRetries);

    const confirmedAt = Date.now();
    if (reqBlockTs != null) {
      const latencySec = ((confirmedAt - reqBlockTs) / 1000).toFixed(2);
      console.log(
        `  reveal latency: ${latencySec}s (request block ${reqBlockNumber} → confirm ${receipt.blockNumber})`,
      );
    } else {
      const sinceNotice = ((confirmedAt - noticedAt) / 1000).toFixed(2);
      console.log(`  reveal latency: ${sinceNotice}s since drain noticed head (request block unknown)`);
    }

    state.nextRevealIndex -= 1;
    saveState(chainFile, state);
    drained += 1;
    console.log(`  nextRevealIndex now ${state.nextRevealIndex}`);

    try {
      await recordRevealSettlements(httpProvider, receipt, { requestId });
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

/**
 * If nextFulfillSeq lags nextSeq, force fromBlock back to the head request
 * (bounded search) so the next scan cannot skip it.
 */
async function headLagResync(contract, httpProvider, fromBlockRef, requestMeta) {
  const epoch = await contract.currentEpoch();
  const head = await contract.nextFulfillSeq(epoch);
  const nextSeq = await contract.nextSeq();
  if (head >= nextSeq) return { lagged: false, head, nextSeq };

  const headReq = await contract.requests(head);
  if (!headReq.pending) return { lagged: false, head, nextSeq };

  console.error(
    `HEAD LAG: nextFulfillSeq=${head.toString()} < nextSeq=${nextSeq.toString()} — forcing head resync`,
  );
  const tip = await httpProvider.getBlockNumber();
  let headBlock = requestMeta.get(head.toString())?.blockNumber ?? null;
  if (headBlock == null) {
    headBlock = await findRequestBlockNearTip(contract, head, tip, 500_000);
  }
  if (headBlock != null && headBlock < fromBlockRef.value) {
    console.warn(`  resync fromBlock ${fromBlockRef.value} → ${headBlock}`);
    fromBlockRef.value = headBlock;
  } else if (headBlock != null) {
    // Re-scan a small window ending at tip so the head log is seen again.
    fromBlockRef.value = Math.min(fromBlockRef.value, headBlock);
  } else {
    // Unknown block — re-scan a recent window rather than advancing past the tip.
    fromBlockRef.value = Math.max(0, tip - HEAD_FIND_MAX);
    console.warn(`  head block unknown; resync scan from ${fromBlockRef.value}`);
  }
  return { lagged: true, head, nextSeq, headBlock };
}

async function connectWs(wssUrl) {
  const ws = new WebSocketProvider(wssUrl);
  // Force a round-trip so we fail fast on bad URLs.
  await ws.getBlockNumber();
  return ws;
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
  const pollMs = Number(process.env.POLL_MS || 2500);
  const headCheckMs = Number(process.env.HEAD_CHECK_MS || 60_000);
  const maxRetries = Number(process.env.REVEAL_MAX_RETRIES || 8);
  const catchUpOnce = process.env.CATCH_UP_ONCE === "1" || process.env.CATCH_UP_ONCE === "true";
  const wssUrl = process.env.WSS_URL || inferWssUrl(rpcUrl);

  if (!existsSync(chainFile)) {
    throw new Error(`chain state file not found: ${chainFile}`);
  }
  let state = loadState(chainFile);
  if (!state.secret || state.nextRevealIndex === undefined) {
    throw new Error(`invalid chain state at ${chainFile}`);
  }

  const httpProvider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(pk, httpProvider);
  // Writes always go over HTTP (more reliable than ws for txs).
  const contract = new Contract(address, ABI, wallet);

  const onChainOp = await contract.operator();
  if (onChainOp.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `wallet ${wallet.address} != on-chain operator ${onChainOp} — refusing to run (reveals would revert). Set OPERATOR_PRIVATE_KEY.`,
    );
  }

  const latest0 = await httpProvider.getBlockNumber();
  const fromBlockRef = { value: await resolveFromBlock(contract, state, latest0) };

  const ledgerPath = defaultLedgerPath();
  console.log(`watching RandomnessRequested on ${address}`);
  console.log(`  operator wallet: ${wallet.address}`);
  console.log(`  chain file:      ${chainFile}`);
  console.log(`  nextRevealIndex: ${state.nextRevealIndex}`);
  console.log(`  payout ledger:   ${ledgerPath} (live append after each reveal)`);
  console.log(`  pollMs:          ${pollMs}`);
  console.log(`  headCheckMs:     ${headCheckMs}`);
  console.log(`  mode:            ${catchUpOnce ? "catch-up-once" : "poll"}`);

  const requestMeta = new Map();
  const drainCtx = {
    contract,
    httpProvider,
    state,
    chainFile,
    maxRetries,
    requestMeta,
  };

  let totalDrained = 0;
  let revealInFlight = false;
  let lastHeadCheck = 0;
  let useWs = false;
  let wsProvider = null;
  let wsContract = null;
  let wakePoll = null; // resolve to interrupt sleep on ws event
  let wsBackoffMs = 1000;

  const bumpWake = () => {
    if (wakePoll) {
      const r = wakePoll;
      wakePoll = null;
      r();
    }
  };

  async function attachWs() {
    if (!wssUrl || catchUpOnce) return;
    try {
      if (wsProvider) {
        try {
          await wsProvider.destroy();
        } catch {
          /* ignore */
        }
        wsProvider = null;
        wsContract = null;
      }
      wsProvider = await connectWs(wssUrl);
      wsContract = new Contract(address, ABI, wsProvider);
      useWs = true;
      wsBackoffMs = 1000;
      console.log(`  transport:       websocket ${wssUrl.replace(/\/v2\/.+$/, "/v2/***")}`);
      wsContract.on(wsContract.filters.RandomnessRequested(), (requestId, requester, event) => {
        try {
          const key = requestId.toString();
          const blockNumber = Number(event.log?.blockNumber ?? event.blockNumber ?? 0);
          requestMeta.set(key, { requestId, blockNumber, requester });
          console.log(`ws: RandomnessRequested ${key} block=${blockNumber || "?"}`);
          bumpWake();
        } catch (err) {
          console.error(`ws event handler error: ${err?.message || err}`);
        }
      });
      wsProvider.websocket?.addEventListener?.("close", () => {
        console.warn("ws: disconnected — falling back to HTTP poll, will retry ws");
        useWs = false;
        bumpWake();
        scheduleWsReconnect();
      });
      // ethers v6 WebsocketProvider
      if (typeof wsProvider.websocket?.on === "function") {
        wsProvider.websocket.on("close", () => {
          console.warn("ws: disconnected — falling back to HTTP poll, will retry ws");
          useWs = false;
          bumpWake();
          scheduleWsReconnect();
        });
      }
    } catch (err) {
      useWs = false;
      console.warn(`ws: unavailable (${err?.shortMessage || err?.message || err}) — HTTP poll @ ${pollMs}ms`);
      scheduleWsReconnect();
    }
  }

  let wsReconnectTimer = null;
  function scheduleWsReconnect() {
    if (catchUpOnce || !wssUrl) return;
    if (wsReconnectTimer) return;
    const delay = wsBackoffMs;
    wsBackoffMs = Math.min(60_000, wsBackoffMs * 2);
    wsReconnectTimer = setTimeout(async () => {
      wsReconnectTimer = null;
      if (!useWs) await attachWs();
    }, delay);
  }

  await attachWs();
  if (!useWs) {
    console.log(`  transport:       HTTP poll every ${pollMs}ms`);
  }

  // Startup drain (same as steady-state drain — no million-block pre-walk).
  try {
    revealInFlight = true;
    const drained = await drainHeadReveals(drainCtx);
    totalDrained += drained;
    if (drained > 0) {
      console.log(`  startup drained ${drained} request(s)`);
    }
  } finally {
    revealInFlight = false;
  }

  for (;;) {
    try {
      const latest = await httpProvider.getBlockNumber();

      // Independent lag safety net (~60s): does not depend on getLogs success.
      const now = Date.now();
      if (now - lastHeadCheck >= headCheckMs) {
        lastHeadCheck = now;
        if (!revealInFlight) {
          const lag = await headLagResync(contract, httpProvider, fromBlockRef, requestMeta);
          if (lag.lagged) {
            // Immediate drain attempt after resync.
            revealInFlight = true;
            try {
              const drained = await drainHeadReveals(drainCtx);
              totalDrained += drained;
              if (drained > 0) {
                console.log(
                  `  resync drained ${drained} request(s) (session total ${totalDrained})`,
                );
              } else {
                console.error(
                  `HEAD LAG persists after resync: head=${lag.head.toString()} nextSeq=${lag.nextSeq.toString()}`,
                );
              }
            } finally {
              revealInFlight = false;
            }
          }
        }
      }

      // Scan only a small forward window. lastProcessed advances ONLY after success.
      if (latest >= fromBlockRef.value) {
        try {
          await scanRequestedLogs(contract, fromBlockRef.value, latest, requestMeta);
          fromBlockRef.value = latest + 1;
          state.lastProcessedBlock = latest;
          saveState(chainFile, state);
        } catch (scanErr) {
          console.error(
            `scan error (lastProcessed NOT advanced): ${scanErr.shortMessage || scanErr.message}`,
          );
          // Do not bump fromBlock / lastProcessed — retry same window next iteration.
        }
      }

      // Always attempt drain — on-chain head is authoritative (events are optional).
      revealInFlight = true;
      try {
        const drained = await drainHeadReveals(drainCtx);
        totalDrained += drained;
        if (drained > 0) {
          console.log(`  drained ${drained} request(s) this pass (session total ${totalDrained})`);
        }
      } finally {
        revealInFlight = false;
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
        if (totalDrained === 0) {
          throw new Error(
            `catch-up stalled: head ${head.toString()} still pending but reveal did not proceed`,
          );
        }
      }
    } catch (err) {
      console.error(`poll error: ${err.shortMessage || err.message || err}`);
      if (err?.stack) console.error(err.stack);
      if (catchUpOnce) throw err;
      const msg = err.shortMessage || err.message || "";
      if (/!= on-chain operator|refusing to run|state desync|hash chain exhausted/i.test(msg)) {
        throw err;
      }
    }

    if (catchUpOnce) continue;

    // Sleep, but wake early on websocket RandomnessRequested.
    await new Promise((resolveSleep) => {
      wakePoll = resolveSleep;
      const t = setTimeout(() => {
        if (wakePoll === resolveSleep) wakePoll = null;
        resolveSleep();
      }, useWs ? Math.min(pollMs, 5000) : pollMs);
      // stash timer unused — fine for ops process
      void t;
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
