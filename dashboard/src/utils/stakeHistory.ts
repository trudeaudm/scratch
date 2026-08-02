/**
 * Reconstruct active `users.staked` over time from StakingVaultV2 logs.
 * Deposited / UnlockCancelled → +amount; UnlockRequested → −amount.
 *
 * Refresh persists events into the stakers snapshot; History reuses those and
 * only eth_getLogs for blocks after `eventsThroughBlock`.
 */
import {
  createPublicClient,
  getAddress,
  http,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem";
import { contracts, stakingV2DeployBlock } from "@/config/addresses";
import { robinhoodChain } from "@/config/chain";
import type { StoredStakeEvent } from "@/utils/stakersSnapshot";

const VAULT = contracts.stakingVaultV2.address;
/** Stay under Alchemy eth_getLogs ~10k block cap. */
export const STAKE_LOG_CHUNK = 9000n;
const BLOCK_TS_BATCH = 40;

const depositedEvent = parseAbiItem(
  "event Deposited(address indexed user, uint256 amount, uint8 tier)",
);
const unlockRequestedEvent = parseAbiItem(
  "event UnlockRequested(address indexed user, uint256 amount, uint256 ticketsBurned, uint64 releaseAt)",
);
const unlockCancelledEvent = parseAbiItem(
  "event UnlockCancelled(address indexed user, uint256 amount)",
);

export type StakeHistoryKind = "deposit" | "unlock_request" | "unlock_cancel" | "now";

export type StakeHistoryPoint = {
  kind: StakeHistoryKind;
  /** Unix seconds (block timestamp, or wall clock for `now`). */
  timestamp: number;
  blockNumber: bigint | null;
  txHash: `0x${string}` | null;
  delta: bigint;
  /** Active staked balance after this event. */
  balance: bigint;
};

export type StakeHistoryResult = {
  address: Address;
  tipBlock: bigint;
  points: StakeHistoryPoint[];
  /** Reconstructed tip (before appending `now`). */
  reconstructed: bigint;
  /** True when reconstructed tip ≠ live `currentStaked`. */
  mismatch: boolean;
  warnings: string[];
};

type CacheEntry = { tipBlock: bigint; result: StakeHistoryResult };
const cache = new Map<string, CacheEntry>();

function client(): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(robinhoodChain.rpcUrls.default.http[0], {
      timeout: 30_000,
      retryCount: 1,
    }),
  });
}

function eventKey(e: Pick<StoredStakeEvent, "txHash" | "logIndex">): string {
  return `${e.txHash.toLowerCase()}:${e.logIndex}`;
}

function deltaFor(kind: StoredStakeEvent["kind"], amount: bigint): bigint {
  return kind === "unlock_request" ? -amount : amount;
}

/** Merge + dedupe stake events (stable chronological order). */
export function mergeStakeEvents(
  prev: StoredStakeEvent[],
  next: StoredStakeEvent[],
): StoredStakeEvent[] {
  const byKey = new Map<string, StoredStakeEvent>();
  for (const e of prev) byKey.set(eventKey(e), e);
  for (const e of next) byKey.set(eventKey(e), e);
  const out = [...byKey.values()];
  out.sort((a, b) => {
    const ab = BigInt(a.blockNumber);
    const bb = BigInt(b.blockNumber);
    if (ab !== bb) return ab < bb ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
  return out;
}

/**
 * Chunked getLogs for Deposit / UnlockRequested / UnlockCancelled.
 * Pass `user` to filter one wallet; omit for the full Refresh scan.
 */
export async function scanVaultStakeEvents(
  pc: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  opts?: {
    user?: Address;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<{
  events: StoredStakeEvent[];
  addresses: Address[];
  chunksScanned: number;
  chunksFailed: number;
  warnings: string[];
}> {
  const events: StoredStakeEvent[] = [];
  const seenAddr = new Set<string>();
  const addresses: Address[] = [];
  const warnings: string[] = [];
  let chunksScanned = 0;
  let chunksFailed = 0;

  const span = toBlock - fromBlock;
  const totalChunks = Math.max(1, Number(span / STAKE_LOG_CHUNK) + 1);
  let done = 0;
  const userFilter = opts?.user;

  for (let start = fromBlock; start <= toBlock; start += STAKE_LOG_CHUNK) {
    const end =
      start + STAKE_LOG_CHUNK - 1n > toBlock ? toBlock : start + STAKE_LOG_CHUNK - 1n;
    done += 1;
    opts?.onProgress?.(done, totalChunks);

    try {
      const [deps, reqs, cans] = await Promise.all([
        pc.getLogs({
          address: VAULT,
          event: depositedEvent,
          ...(userFilter ? { args: { user: userFilter } } : {}),
          fromBlock: start,
          toBlock: end,
        }),
        pc.getLogs({
          address: VAULT,
          event: unlockRequestedEvent,
          ...(userFilter ? { args: { user: userFilter } } : {}),
          fromBlock: start,
          toBlock: end,
        }),
        pc.getLogs({
          address: VAULT,
          event: unlockCancelledEvent,
          ...(userFilter ? { args: { user: userFilter } } : {}),
          fromBlock: start,
          toBlock: end,
        }),
      ]);

      const push = (
        kind: StoredStakeEvent["kind"],
        log: {
          args: { user?: Address; amount?: bigint };
          blockNumber: bigint | null;
          logIndex: number | null;
          transactionHash: `0x${string}` | null;
        },
      ) => {
        const user = log.args.user;
        const amount = log.args.amount;
        if (
          !user ||
          amount == null ||
          log.blockNumber == null ||
          log.logIndex == null ||
          !log.transactionHash
        ) {
          return;
        }
        let addr: Address;
        try {
          addr = getAddress(user);
        } catch {
          return;
        }
        const key = addr.toLowerCase();
        if (!seenAddr.has(key)) {
          seenAddr.add(key);
          addresses.push(addr);
        }
        events.push({
          user: addr,
          kind,
          blockNumber: log.blockNumber.toString(),
          logIndex: log.logIndex,
          txHash: log.transactionHash,
          amount: amount.toString(),
        });
      };

      for (const log of deps) push("deposit", log);
      for (const log of reqs) push("unlock_request", log);
      for (const log of cans) push("unlock_cancel", log);
      chunksScanned += 1;
    } catch (e) {
      chunksFailed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`Log chunk ${start.toString()}–${end.toString()} failed: ${msg}`);
    }
  }

  return {
    events: mergeStakeEvents([], events),
    addresses,
    chunksScanned,
    chunksFailed,
    warnings,
  };
}

async function resolveTimestamps(
  pc: PublicClient,
  blockNumbers: bigint[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(blockNumbers.map((b) => b.toString()))].map((s) => BigInt(s));

  for (let i = 0; i < unique.length; i += BLOCK_TS_BATCH) {
    const batch = unique.slice(i, i + BLOCK_TS_BATCH);
    const blocks = await Promise.all(
      batch.map((n) => pc.getBlock({ blockNumber: n }).catch(() => null)),
    );
    for (let j = 0; j < batch.length; j++) {
      const block = blocks[j];
      if (block) out.set(batch[j].toString(), Number(block.timestamp));
    }
  }
  return out;
}

function buildResult(
  user: Address,
  tip: bigint,
  moves: { kind: Exclude<StakeHistoryKind, "now">; blockNumber: bigint; txHash: `0x${string}`; delta: bigint }[],
  tsMap: Map<string, number>,
  currentStaked: bigint,
  warnings: string[],
): StakeHistoryResult {
  const points: StakeHistoryPoint[] = [];
  let balance = 0n;
  for (const m of moves) {
    balance += m.delta;
    if (balance < 0n) balance = 0n;
    points.push({
      kind: m.kind,
      timestamp: tsMap.get(m.blockNumber.toString()) ?? 0,
      blockNumber: m.blockNumber,
      txHash: m.txHash,
      delta: m.delta,
      balance,
    });
  }

  const reconstructed = balance;
  const mismatch = reconstructed !== currentStaked;
  const warn = [...warnings];
  if (mismatch) {
    warn.push(
      `Reconstructed staked (${reconstructed.toString()}) ≠ live reading (${currentStaked.toString()})`,
    );
  }

  const nowTs = Math.floor(Date.now() / 1000);
  points.push({
    kind: "now",
    timestamp: nowTs,
    blockNumber: tip,
    txHash: null,
    delta: currentStaked - reconstructed,
    balance: currentStaked,
  });

  return {
    address: user,
    tipBlock: tip,
    points,
    reconstructed,
    mismatch,
    warnings: warn,
  };
}

/**
 * Fetch + reconstruct stake history for `user`.
 * Pass `knownEvents` + `eventsThroughBlock` from the stakers snapshot to skip
 * re-scanning the range already covered by Refresh.
 */
export async function fetchStakeHistory(
  user: Address,
  currentStaked: bigint,
  opts?: {
    tipBlock?: bigint;
    onProgress?: (done: number, total: number) => void;
    skipCache?: boolean;
    /** Snapshot events for this user (or all — filtered here). */
    knownEvents?: StoredStakeEvent[];
    /** Last block included in knownEvents (scannedThroughBlock). */
    eventsThroughBlock?: number | null;
  },
): Promise<StakeHistoryResult> {
  const pc = client();
  const tip = opts?.tipBlock ?? (await pc.getBlockNumber());
  const cacheKey = user.toLowerCase();

  if (!opts?.skipCache) {
    const hit = cache.get(cacheKey);
    if (hit && hit.tipBlock === tip) {
      const prior = hit.result.points.filter((p) => p.kind !== "now");
      const reconstructed = hit.result.reconstructed;
      const nowTs = Math.floor(Date.now() / 1000);
      return {
        ...hit.result,
        mismatch: reconstructed !== currentStaked,
        points: [
          ...prior,
          {
            kind: "now",
            timestamp: nowTs,
            blockNumber: tip,
            txHash: null,
            delta: currentStaked - reconstructed,
            balance: currentStaked,
          },
        ],
      };
    }
  }

  const warnings: string[] = [];
  const deploy = stakingV2DeployBlock();
  const me = user.toLowerCase();

  let stored = (opts?.knownEvents ?? []).filter((e) => e.user.toLowerCase() === me);
  const through =
    typeof opts?.eventsThroughBlock === "number" ? BigInt(opts.eventsThroughBlock) : null;

  let from = deploy;
  if (through != null && stored.length > 0) {
    from = through + 1n;
  } else if (stored.length === 0 && through == null) {
    from = deploy;
  } else if (through != null && stored.length === 0) {
    // Cursor without this wallet's events (legacy snapshot) — full walk once.
    from = deploy;
    warnings.push(
      "No cached stake events for this wallet — scanning from deploy (Refresh stakers once to cache)",
    );
  }

  if (from > tip) {
    // Fully covered by snapshot cache.
  } else if (deploy > tip) {
    warnings.push("Deploy block is ahead of chain tip");
  } else {
    const scanned = await scanVaultStakeEvents(pc, from, tip, {
      user,
      onProgress: opts?.onProgress,
    });
    warnings.push(...scanned.warnings);
    stored = mergeStakeEvents(stored, scanned.events);
  }

  const moves = stored.map((e) => ({
    kind: e.kind as Exclude<StakeHistoryKind, "now">,
    blockNumber: BigInt(e.blockNumber),
    txHash: e.txHash,
    delta: deltaFor(e.kind, BigInt(e.amount)),
    logIndex: e.logIndex,
  }));
  moves.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });

  const tsMap = await resolveTimestamps(
    pc,
    moves.map((m) => m.blockNumber),
  );

  const result = buildResult(user, tip, moves, tsMap, currentStaked, warnings);
  cache.set(cacheKey, { tipBlock: tip, result });
  return result;
}

export function clearStakeHistoryCache(): void {
  cache.clear();
}
