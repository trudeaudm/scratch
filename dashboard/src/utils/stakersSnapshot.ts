import type { Address } from "viem";

export type StakerTierLabel = "NORMAL" | "ENHANCED" | "UNSET";

export type StoredStakerRow = {
  address: Address;
  staked: string;
  tier: StakerTierLabel;
  tickets: string;
  unlockingAmount: string;
  releaseAt: number;
  bought: string | null;
  sold: string | null;
  /** Historical USD cost of market buys (FIFO basis). */
  boughtUsd?: number | null;
  /** Historical USD proceeds of market sells. */
  soldUsd?: number | null;
  realizedPnlUsd?: number | null;
  unrealizedPnlUsd?: number | null;
  /** realized + unrealized */
  pnlUsd?: number | null;
};

export type StoredStakeEvent = {
  user: Address;
  kind: "deposit" | "unlock_request" | "unlock_cancel";
  blockNumber: string;
  logIndex: number;
  txHash: `0x${string}`;
  /** Positive SCRATCH-wei; sign is implied by kind. */
  amount: string;
};

export type StoredSnapshot = {
  takenAt: number;
  rows: StoredStakerRow[];
  warnings: string[];
  addressesFound: number;
  chunksScanned: number;
  chunksFailed: number;
  scannedThroughBlock?: number | null;
  /** Stake-moving vault logs covered through scannedThroughBlock. */
  stakeEvents?: StoredStakeEvent[];
  pnlAt?: number;
  scratchUsd?: number | null;
  /** Bump when market-fill classification changes (invalidates cached PnL). */
  pnlLogicVersion?: number;
};

const STORAGE_KEY = "scratch-dashboard:stakers-v2-snapshot-v6";
const STORAGE_KEY_LEGACY = "scratch-dashboard:stakers-v2-snapshot-v5";
const STORAGE_KEY_LEGACY_V4 = "scratch-dashboard:stakers-v2-snapshot-v4";

export function isStoredSnapshot(v: unknown): v is StoredSnapshot {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.takenAt === "number" && Array.isArray(o.rows);
}

/** Sync browser cache — source of truth for the Deposit-log cursor is the disk file. */
export function loadLocalSnapshot(): StoredSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ??
      window.localStorage.getItem(STORAGE_KEY_LEGACY) ??
      window.localStorage.getItem(STORAGE_KEY_LEGACY_V4);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredSnapshot(parsed)) return null;
    if (!window.localStorage.getItem(STORAGE_KEY)) {
      writeLocalSnapshot(parsed);
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeLocalSnapshot(snap: StoredSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch {
    /* quota / private mode */
  }
}

export async function fetchDiskSnapshot(): Promise<StoredSnapshot | null> {
  const res = await fetch("/api/stakers-snapshot", { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`stakers-snapshot GET ${res.status}`);
  const data = (await res.json()) as { snapshot: StoredSnapshot | null };
  if (!data.snapshot || !isStoredSnapshot(data.snapshot)) return null;
  return data.snapshot;
}

export async function putDiskSnapshot(snap: StoredSnapshot): Promise<void> {
  const res = await fetch("/api/stakers-snapshot", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snapshot: snap }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `stakers-snapshot PUT ${res.status}`);
  }
}

/** Prefer the snapshot with the farther Deposit-log cursor, then newer takenAt. */
export function preferSnapshot(
  a: StoredSnapshot | null,
  b: StoredSnapshot | null,
): StoredSnapshot | null {
  if (!a) return b;
  if (!b) return a;
  const aCursor = typeof a.scannedThroughBlock === "number" ? a.scannedThroughBlock : -1;
  const bCursor = typeof b.scannedThroughBlock === "number" ? b.scannedThroughBlock : -1;
  if (bCursor !== aCursor) return bCursor > aCursor ? b : a;
  return b.takenAt >= a.takenAt ? b : a;
}

let diskWriteTimer: ReturnType<typeof setTimeout> | null = null;
let diskWritePending: StoredSnapshot | null = null;
let diskWriteInFlight: Promise<void> | null = null;

/** Debounced disk persist so mid-PnL commits don't thrash the filesystem. */
export function scheduleDiskSnapshotWrite(snap: StoredSnapshot): void {
  diskWritePending = snap;
  if (diskWriteTimer) clearTimeout(diskWriteTimer);
  diskWriteTimer = setTimeout(() => {
    diskWriteTimer = null;
    void flushDiskSnapshotWrite();
  }, 400);
}

export async function flushDiskSnapshotWrite(): Promise<void> {
  if (diskWriteTimer) {
    clearTimeout(diskWriteTimer);
    diskWriteTimer = null;
  }
  const snap = diskWritePending;
  if (!snap) return;
  diskWritePending = null;
  const run = putDiskSnapshot(snap).catch((e) => {
    console.warn("[stakers-snapshot] disk write failed:", e);
  });
  diskWriteInFlight = run;
  await run;
  diskWriteInFlight = null;
  // A newer snap may have arrived while we wrote.
  if (diskWritePending) await flushDiskSnapshotWrite();
}
