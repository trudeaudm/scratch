"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  formatUnits,
  http,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem";
import {
  contracts,
  explorerAddress,
  isConfigured,
  stakingV2DeployBlock,
} from "@/config/addresses";
import { robinhoodChain } from "@/config/chain";
import { countdown, fmtToken, fmtUsd, shortAddr } from "@/utils/format";
import { CopyAddress } from "@/components/CopyAddress";
import { SupplyLocationPanel } from "@/components/SupplyLocationPanel";
import { StakeHistoryModal } from "@/components/StakeHistoryModal";
import type { StakerTierHint } from "@/utils/supplyLocation";
import {
  fetchWalletScratchFlow,
  flushPnlFillsStore,
  PNL_LOGIC_VERSION,
} from "@/utils/stakerPnl";
import { fetchPrices } from "@/utils/prices";
import {
  clearStakeHistoryCache,
  mergeStakeEvents,
  scanVaultStakeEvents,
} from "@/utils/stakeHistory";
import {
  fetchDiskSnapshot,
  flushDiskSnapshotWrite,
  loadLocalSnapshot,
  preferSnapshot,
  scheduleDiskSnapshotWrite,
  writeLocalSnapshot,
  type StoredSnapshot,
  type StoredStakeEvent,
  type StakerTierLabel,
} from "@/utils/stakersSnapshot";

const VAULT = contracts.stakingVaultV2.address;
const READ_BATCH = 40;
/** Parallel Alchemy PnL fetches (Transfers CU budget ≫ Blockscout). */
const PNL_CONCURRENCY = 4;

/** Run `worker` over items with at most `limit` in flight; optional progress callback. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;
  async function run(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      results[i] = await worker(items[i], i);
      done += 1;
      onProgress?.(done, total);
    }
  }
  const n = Math.min(limit, Math.max(1, total));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

const stakingV2Abi = [
  parseAbiItem(
    "function users(address) view returns (uint256 staked, uint256 debt, uint256 banked, uint8 tier)",
  ),
  parseAbiItem("function unlocking(address) view returns (uint256 amount, uint64 releaseAt)"),
  parseAbiItem("function ticketsOf(address user) view returns (uint256)"),
] as const;

const TIER_NORMAL = 1;
const TIER_ENHANCED = 2;

type TierLabel = StakerTierLabel;

type StakerRow = {
  address: Address;
  staked: bigint;
  tier: TierLabel;
  tickets: bigint;
  unlockingAmount: bigint;
  releaseAt: number;
  /** Market SCRATCH bought; null = PnL not loaded. */
  bought: bigint | null;
  /** Market SCRATCH sold; null = PnL not loaded. */
  sold: bigint | null;
  boughtUsd: number | null;
  soldUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  /** realized + unrealized; null = not loaded. */
  pnlUsd: number | null;
};

type Snapshot = {
  takenAt: number;
  rows: StakerRow[];
  warnings: string[];
  addressesFound: number;
  chunksScanned: number;
  chunksFailed: number;
  /**
   * Last block whose stake-moving logs are included in `stakeEvents` / address set.
   * Next Refresh scans only (scannedThroughBlock + 1)…tip when set.
   */
  scannedThroughBlock: number | null;
  /** Vault Deposit / UnlockRequested / UnlockCancelled logs through the cursor. */
  stakeEvents: StoredStakeEvent[];
  /** When trade-flow columns were last filled (0 = never). */
  pnlAt: number;
  /** Live SCRATCH/USD used for unrealized mark (null if price fetch failed). */
  scratchUsd: number | null;
  /** Must match PNL_LOGIC_VERSION or PnL fields are cleared. */
  pnlLogicVersion: number;
};

type PnlFields = {
  bought: bigint | null;
  sold: bigint | null;
  boughtUsd: number | null;
  soldUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  pnlUsd: number | null;
};

const EMPTY_PNL: PnlFields = {
  bought: null,
  sold: null,
  boughtUsd: null,
  soldUsd: null,
  realizedPnlUsd: null,
  unrealizedPnlUsd: null,
  pnlUsd: null,
};

function hasHistoricalPnl(r: PnlFields): boolean {
  return r.pnlUsd != null && r.bought != null && r.sold != null;
}

type SortKey = "address" | "staked" | "tier" | "tickets" | "unlock" | "bought" | "sold" | "pnl";

function client(): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(robinhoodChain.rpcUrls.default.http[0], {
      timeout: 30_000,
      retryCount: 1,
    }),
  });
}

function tierLabel(tier: number): TierLabel {
  if (tier === TIER_NORMAL) return "NORMAL";
  if (tier === TIER_ENHANCED) return "ENHANCED";
  return "UNSET";
}

function isActive(row: StakerRow): boolean {
  return row.staked > BigInt(0);
}

function compareUnlock(a: StakerRow, b: StakerRow): number {
  const aActive = a.unlockingAmount > BigInt(0);
  const bActive = b.unlockingAmount > BigInt(0);
  if (!aActive && !bActive) return 0;
  if (!aActive) return -1;
  if (!bActive) return 1;
  if (a.releaseAt !== b.releaseAt) return a.releaseAt - b.releaseAt;
  if (a.unlockingAmount === b.unlockingAmount) return 0;
  return a.unlockingAmount < b.unlockingAmount ? -1 : 1;
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function serializeSnapshot(snapshot: Snapshot): StoredSnapshot {
  return {
    takenAt: snapshot.takenAt,
    warnings: snapshot.warnings,
    addressesFound: snapshot.addressesFound,
    chunksScanned: snapshot.chunksScanned,
    chunksFailed: snapshot.chunksFailed,
    scannedThroughBlock: snapshot.scannedThroughBlock,
    stakeEvents: snapshot.stakeEvents,
    pnlAt: snapshot.pnlAt,
    scratchUsd: snapshot.scratchUsd,
    pnlLogicVersion: snapshot.pnlLogicVersion,
    rows: snapshot.rows.map((r) => ({
      address: r.address,
      staked: r.staked.toString(),
      tier: r.tier,
      tickets: r.tickets.toString(),
      unlockingAmount: r.unlockingAmount.toString(),
      releaseAt: r.releaseAt,
      bought: r.bought == null ? null : r.bought.toString(),
      sold: r.sold == null ? null : r.sold.toString(),
      boughtUsd: r.boughtUsd,
      soldUsd: r.soldUsd,
      realizedPnlUsd: r.realizedPnlUsd,
      unrealizedPnlUsd: r.unrealizedPnlUsd,
      pnlUsd: r.pnlUsd,
    })),
  };
}

function deserializeSnapshot(raw: StoredSnapshot): Snapshot | null {
  if (!raw || typeof raw.takenAt !== "number" || !Array.isArray(raw.rows)) return null;
  try {
    return {
      takenAt: raw.takenAt,
      warnings: raw.warnings ?? [],
      addressesFound: raw.addressesFound ?? raw.rows.length,
      chunksScanned: raw.chunksScanned ?? 0,
      chunksFailed: raw.chunksFailed ?? 0,
      scannedThroughBlock:
        typeof raw.scannedThroughBlock === "number" ? raw.scannedThroughBlock : null,
      stakeEvents: Array.isArray(raw.stakeEvents) ? raw.stakeEvents : [],
      pnlLogicVersion:
        typeof raw.pnlLogicVersion === "number" ? raw.pnlLogicVersion : 0,
      pnlAt:
        raw.pnlLogicVersion === PNL_LOGIC_VERSION ? (raw.pnlAt ?? 0) : 0,
      scratchUsd:
        raw.pnlLogicVersion === PNL_LOGIC_VERSION ? (raw.scratchUsd ?? null) : null,
      rows: raw.rows.map((r) => {
        const bought = r.bought == null || r.bought === undefined ? null : BigInt(r.bought);
        const sold = r.sold == null || r.sold === undefined ? null : BigInt(r.sold);
        const logicOk = raw.pnlLogicVersion === PNL_LOGIC_VERSION;
        // Legacy spot-only / stale classification — force recompute.
        const hasUsd =
          logicOk && typeof r.pnlUsd === "number" && Number.isFinite(r.pnlUsd);
        return {
          address: r.address,
          staked: BigInt(r.staked),
          tier: r.tier,
          tickets: BigInt(r.tickets),
          unlockingAmount: BigInt(r.unlockingAmount),
          releaseAt: r.releaseAt,
          bought: hasUsd ? bought : null,
          sold: hasUsd ? sold : null,
          boughtUsd: hasUsd && typeof r.boughtUsd === "number" ? r.boughtUsd : null,
          soldUsd: hasUsd && typeof r.soldUsd === "number" ? r.soldUsd : null,
          realizedPnlUsd:
            hasUsd && typeof r.realizedPnlUsd === "number" ? r.realizedPnlUsd : null,
          unrealizedPnlUsd:
            hasUsd && typeof r.unrealizedPnlUsd === "number" ? r.unrealizedPnlUsd : null,
          pnlUsd: hasUsd ? r.pnlUsd! : null,
        };
      }),
    };
  } catch {
    return null;
  }
}

/** Sync read of browser cache (kept mirrored on every commit). */
function loadStoredSnapshot(): Snapshot | null {
  const raw = loadLocalSnapshot();
  return raw ? deserializeSnapshot(raw) : null;
}

function persistSnapshot(snapshot: Snapshot): void {
  const stored = serializeSnapshot(snapshot);
  writeLocalSnapshot(stored);
  scheduleDiskSnapshotWrite(stored);
}

function downloadCsv(rows: StakerRow[], takenAt: number, scratchUsd: number | null): void {
  const header = [
    "address",
    "staked",
    "tier",
    "tickets",
    "unlockingAmount",
    "releaseAt",
    "unlockStatus",
    "bought",
    "sold",
    "boughtUsd",
    "soldUsd",
    "pnlUsd",
    "realizedPnlUsd",
    "unrealizedPnlUsd",
    "scratchUsdSpot",
  ];
  const now = Math.floor(Date.now() / 1000);
  const lines = [header.join(",")];
  for (const r of rows) {
    let unlockStatus = "—";
    if (r.unlockingAmount > BigInt(0)) {
      unlockStatus = now >= r.releaseAt ? "claimable" : `unlocking until ${r.releaseAt}`;
    }
    lines.push(
      [
        r.address,
        formatUnits(r.staked, 18),
        r.tier,
        formatUnits(r.tickets, 18),
        formatUnits(r.unlockingAmount, 18),
        r.releaseAt ? String(r.releaseAt) : "",
        unlockStatus,
        r.bought == null ? "" : formatUnits(r.bought, 18),
        r.sold == null ? "" : formatUnits(r.sold, 18),
        r.boughtUsd == null ? "" : r.boughtUsd.toFixed(6),
        r.soldUsd == null ? "" : r.soldUsd.toFixed(6),
        r.pnlUsd == null ? "" : r.pnlUsd.toFixed(6),
        r.realizedPnlUsd == null ? "" : r.realizedPnlUsd.toFixed(6),
        r.unrealizedPnlUsd == null ? "" : r.unrealizedPnlUsd.toFixed(6),
        scratchUsd == null ? "" : String(scratchUsd),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date(takenAt).toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `staking-v2-stakers-${ts}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function readStakerStates(
  pc: PublicClient,
  addresses: Address[],
  onProgress: (done: number, total: number) => void,
): Promise<{ rows: StakerRow[]; warnings: string[] }> {
  const rows: StakerRow[] = [];
  const warnings: string[] = [];
  const total = addresses.length || 1;

  // Robinhood Chain has no Multicall3 in viem — batch with Promise.all of eth_calls.
  for (let i = 0; i < addresses.length; i += READ_BATCH) {
    const batch = addresses.slice(i, i + READ_BATCH);
    onProgress(Math.min(i + batch.length, addresses.length), total);

    const batchRows = await Promise.all(
      batch.map(async (addr) => {
        try {
          const [user, unlock, tickets] = await Promise.all([
            pc.readContract({
              address: VAULT,
              abi: stakingV2Abi,
              functionName: "users",
              args: [addr],
            }),
            pc.readContract({
              address: VAULT,
              abi: stakingV2Abi,
              functionName: "unlocking",
              args: [addr],
            }),
            pc.readContract({
              address: VAULT,
              abi: stakingV2Abi,
              functionName: "ticketsOf",
              args: [addr],
            }),
          ]);
          const [staked, , , tierRaw] = user as readonly [bigint, bigint, bigint, number];
          const [unlockingAmount, releaseAtRaw] = unlock as readonly [bigint, number | bigint];
          return {
            address: addr,
            staked,
            tier: tierLabel(Number(tierRaw)),
            tickets: tickets as bigint,
            unlockingAmount,
            releaseAt: Number(releaseAtRaw),
            ...EMPTY_PNL,
          } satisfies StakerRow;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          warnings.push(`State read failed for ${shortAddr(addr)}: ${msg}`);
          return null;
        }
      }),
    );

    for (const row of batchRows) {
      if (row) rows.push(row);
    }
  }

  onProgress(addresses.length, total);
  return { rows, warnings };
}

function FlowCell({
  value,
  usd,
}: {
  value: bigint | null;
  usd?: number | null;
}) {
  if (value == null) return <span className="muted">—</span>;
  const title =
    usd != null && Number.isFinite(usd) ? `Historical USD: ${fmtUsd(usd)}` : undefined;
  return (
    <span className="num" title={title}>
      {fmtToken(value, 18, 2)}
    </span>
  );
}

function PnlCell({ row }: { row: StakerRow }) {
  if (row.pnlUsd == null) return <span className="muted">—</span>;
  const pnlUsd = row.pnlUsd;
  const realizedUsd = row.realizedPnlUsd;
  const cls = pnlUsd > 0 ? "ok" : pnlUsd < 0 ? "danger" : "muted";
  const sign = pnlUsd > 0 ? "+" : "";
  return (
    <span
      className={`num ${cls}`}
      title="Total = FIFO realized + unrealized on remaining lots at live spot · (realized) in parentheses"
    >
      {sign}
      {fmtUsd(pnlUsd)}
      <span className="muted" style={{ fontWeight: 400, marginLeft: 4 }}>
        ({realizedUsd == null ? "—" : fmtUsd(realizedUsd)} realized)
      </span>
    </span>
  );
}

function UnlockCell({ row, now }: { row: StakerRow; now: number }) {
  if (row.unlockingAmount === BigInt(0)) {
    return <span className="muted">—</span>;
  }
  const claimable = now >= row.releaseAt;
  const left = Math.max(0, row.releaseAt - now);
  return (
    <div>
      <div className="num" style={{ textAlign: "left" }}>
        {fmtToken(row.unlockingAmount, 18, 4)} SCRATCH
      </div>
      {claimable ? (
        <span className="ok" style={{ fontSize: "0.75rem", fontWeight: 600 }}>
          claimable
        </span>
      ) : (
        <span className="warn" style={{ fontSize: "0.75rem" }}>
          release {countdown(left)}
        </span>
      )}
    </div>
  );
}

export function StakersPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("staked");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [showHistorical, setShowHistorical] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<{
    address: Address;
    staked: bigint;
  } | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const localRaw = loadLocalSnapshot();
      const local = localRaw ? deserializeSnapshot(localRaw) : null;
      if (local && !cancelled) setSnapshot(local);

      try {
        const diskRaw = await fetchDiskSnapshot();
        if (cancelled) return;
        const chosen = preferSnapshot(localRaw, diskRaw);
        if (chosen) {
          const snap = deserializeSnapshot(chosen);
          if (snap) {
            setSnapshot(snap);
            writeLocalSnapshot(chosen);
            // Migrate local-only → disk, or push ahead-of-disk local.
            if (!diskRaw || preferSnapshot(diskRaw, chosen) === chosen) {
              scheduleDiskSnapshotWrite(chosen);
            }
          }
        }
      } catch (e) {
        console.warn("[stakers-snapshot] disk hydrate failed:", e);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();

    const onHide = () => {
      void flushDiskSnapshotWrite();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
      void flushDiskSnapshotWrite();
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const commitSnapshot = useCallback((next: Snapshot) => {
    setSnapshot(next);
    persistSnapshot(next);
  }, []);

  const refresh = useCallback(async (opts?: { full?: boolean }) => {
    if (!isConfigured(VAULT)) {
      setError("StakingVaultV2 address not set");
      return;
    }
    setScanning(true);
    setError(null);
    setProgressLabel("scanning… 0/1");
    const warnings: string[] = [];
    if (opts?.full) clearStakeHistoryCache();

    try {
      const pc = client();
      const latest = await pc.getBlockNumber();
      const deploy = stakingV2DeployBlock();
      const prev = loadStoredSnapshot();
      const needsEventBackfill =
        prev != null &&
        prev.scannedThroughBlock != null &&
        prev.rows.length > 0 &&
        (!prev.stakeEvents || prev.stakeEvents.length === 0);
      const full =
        Boolean(opts?.full) || prev?.scannedThroughBlock == null || needsEventBackfill;
      if (needsEventBackfill) {
        warnings.push(
          "Snapshot had no cached stake events — full log rescan to populate History",
        );
      }

      let from = deploy;
      if (!full && prev?.scannedThroughBlock != null) {
        from = BigInt(prev.scannedThroughBlock) + 1n;
      }

      if (deploy > latest) {
        commitSnapshot({
          takenAt: Date.now(),
          rows: [],
          warnings: ["Deploy block is ahead of chain tip"],
          addressesFound: 0,
          chunksScanned: 0,
          chunksFailed: 0,
          scannedThroughBlock: null,
          stakeEvents: [],
          pnlAt: 0,
          scratchUsd: null,
          pnlLogicVersion: PNL_LOGIC_VERSION,
        });
        return;
      }

      const known = new Map<string, Address>();
      if (!full && prev) {
        for (const r of prev.rows) known.set(r.address.toLowerCase(), r.address);
      }

      let chunksScanned = 0;
      let chunksFailed = 0;
      let newEvents: StoredStakeEvent[] = [];

      if (from <= latest) {
        const scanned = await scanVaultStakeEvents(pc, from, latest, {
          onProgress: (done, total) => {
            setProgressLabel(
              full ? `scanning… ${done}/${total}` : `scanning new… ${done}/${total}`,
            );
          },
        });
        chunksScanned = scanned.chunksScanned;
        chunksFailed = scanned.chunksFailed;
        warnings.push(...scanned.warnings);
        newEvents = scanned.events;
        for (const a of scanned.addresses) known.set(a.toLowerCase(), a);
      } else {
        setProgressLabel("positions…");
      }

      const stakeEvents = mergeStakeEvents(
        full ? [] : prev?.stakeEvents ?? [],
        newEvents,
      );

      const addresses = [...known.values()];
      setProgressLabel(`positions… 0/${addresses.length || 1}`);

      const { rows: freshRows, warnings: stateWarnings } = await readStakerStates(
        pc,
        addresses,
        (done) => {
          setProgressLabel(`positions… ${done}/${addresses.length || 1}`);
        },
      );
      warnings.push(...stateWarnings);

      // Carry prior historical PnL; only re-fetch wallets missing FIFO USD fields.
      // Drop cache when fill-classification logic changed.
      const priorFlow = new Map<string, PnlFields>();
      if (prev && prev.pnlLogicVersion === PNL_LOGIC_VERSION) {
        for (const r of prev.rows) {
          priorFlow.set(r.address.toLowerCase(), {
            bought: r.bought,
            sold: r.sold,
            boughtUsd: r.boughtUsd,
            soldUsd: r.soldUsd,
            realizedPnlUsd: r.realizedPnlUsd,
            unrealizedPnlUsd: r.unrealizedPnlUsd,
            pnlUsd: r.pnlUsd,
          });
        }
      }
      const rows: StakerRow[] = freshRows.map((r) => {
        const prior = priorFlow.get(r.address.toLowerCase());
        if (!prior || !hasHistoricalPnl(prior)) return r;
        return { ...r, ...prior };
      });

      const scannedThroughBlock =
        chunksFailed === 0
          ? Number(latest)
          : prev?.scannedThroughBlock ?? null;
      if (chunksFailed > 0) {
        warnings.push(
          "Log scan had failures — cursor not advanced; next Refresh will retry the same range",
        );
      }

      const base: Snapshot = {
        takenAt: Date.now(),
        rows,
        warnings,
        addressesFound: addresses.length,
        chunksScanned,
        chunksFailed,
        scannedThroughBlock,
        stakeEvents: chunksFailed === 0 ? stakeEvents : prev?.stakeEvents ?? stakeEvents,
        pnlAt: prev?.pnlAt ?? 0,
        scratchUsd: prev?.scratchUsd ?? null,
        pnlLogicVersion: prev?.pnlLogicVersion ?? 0,
      };
      commitSnapshot(base);

      const needPnl = rows.filter((r) => !hasHistoricalPnl(r));
      if (needPnl.length === 0) {
        return;
      }

      setProgressLabel("pnl… ohlcv");
      const prices = await fetchPrices();
      const scratchUsd = prices.scratchUsd;
      if (scratchUsd == null) {
        warnings.push(
          "Live SCRATCH/USD unavailable — unrealized mark needs DexScreener spot (realized still uses historical candles)",
        );
      }
      const withPnl = [...rows];
      const indexByAddr = new Map(withPnl.map((r, i) => [r.address.toLowerCase(), i]));
      const pnlWarnings = [...warnings];
      await mapPool(
        needPnl,
        PNL_CONCURRENCY,
        async (row) => {
          const i = indexByAddr.get(row.address.toLowerCase());
          if (i == null) return row;
          try {
            const flow = await fetchWalletScratchFlow(row.address, scratchUsd, {
              mode: "incremental",
            });
            withPnl[i] = {
              ...withPnl[i],
              bought: flow.bought,
              sold: flow.sold,
              boughtUsd: flow.boughtUsd,
              soldUsd: flow.soldUsd,
              realizedPnlUsd: flow.realizedPnlUsd,
              unrealizedPnlUsd: flow.unrealizedPnlUsd,
              pnlUsd: flow.pnlUsd,
            };
            if (flow.unpricedCount > 0) {
              pnlWarnings.push(
                `${shortAddr(row.address)}: ${flow.unpricedCount} fill(s) missing historical candle`,
              );
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            pnlWarnings.push(`PnL fetch failed for ${shortAddr(row.address)}: ${msg}`);
          }
          return withPnl[i];
        },
        (done, total) => {
          setProgressLabel(`pnl… ${done}/${total}`);
          if (done % 5 === 0 || done === total) {
            commitSnapshot({
              ...base,
              rows: [...withPnl],
              warnings: pnlWarnings,
              pnlAt: Date.now(),
              scratchUsd,
              pnlLogicVersion: PNL_LOGIC_VERSION,
            });
          }
        },
      );
      await flushPnlFillsStore().catch(() => {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setSnapshot((prevSnap) => {
        if (prevSnap) return prevSnap;
        const empty: Snapshot = {
          takenAt: Date.now(),
          rows: [],
          warnings: [msg],
          addressesFound: 0,
          chunksScanned: 0,
          chunksFailed: 0,
          scannedThroughBlock: null,
          stakeEvents: [],
          pnlAt: 0,
          scratchUsd: null,
          pnlLogicVersion: PNL_LOGIC_VERSION,
        };
        persistSnapshot(empty);
        return empty;
      });
    } finally {
      setScanning(false);
      setProgressLabel(null);
    }
  }, [commitSnapshot]);

  const loadPnl = useCallback(async () => {
    if (!snapshot?.rows.length) return;
    setScanning(true);
    setError(null);
    const warnings = [...snapshot.warnings];
    const rows = [...snapshot.rows];
    const total = rows.length;

    try {
      setProgressLabel("pnl… ohlcv");
      const prices = await fetchPrices();
      const scratchUsd = prices.scratchUsd;
      if (scratchUsd == null) {
        warnings.push(
          "Live SCRATCH/USD unavailable — unrealized mark needs DexScreener spot (realized still uses historical candles)",
        );
      }
      await mapPool(
        rows,
        PNL_CONCURRENCY,
        async (row, i) => {
          const addr = row.address;
          try {
            // Prefer mark-to-market from cached fills; falls back to incremental Transfers.
            const flow = await fetchWalletScratchFlow(addr, scratchUsd, {
              mode: "mark",
            });
            rows[i] = {
              ...row,
              bought: flow.bought,
              sold: flow.sold,
              boughtUsd: flow.boughtUsd,
              soldUsd: flow.soldUsd,
              realizedPnlUsd: flow.realizedPnlUsd,
              unrealizedPnlUsd: flow.unrealizedPnlUsd,
              pnlUsd: flow.pnlUsd,
            };
            if (flow.unpricedCount > 0) {
              warnings.push(
                `${shortAddr(addr)}: ${flow.unpricedCount} fill(s) missing historical candle`,
              );
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            warnings.push(`PnL fetch failed for ${shortAddr(addr)}: ${msg}`);
            rows[i] = { ...row, ...EMPTY_PNL };
          }
          return rows[i];
        },
        (done) => {
          setProgressLabel(`pnl… ${done}/${total}`);
          if (done % 5 === 0 || done === total) {
            commitSnapshot({
              ...snapshot,
              rows: [...rows],
              warnings,
              pnlAt: Date.now(),
              scratchUsd,
              pnlLogicVersion: PNL_LOGIC_VERSION,
            });
          }
        },
      );
      await flushPnlFillsStore().catch(() => {});
      commitSnapshot({
        ...snapshot,
        rows,
        warnings,
        pnlAt: Date.now(),
        scratchUsd,
        pnlLogicVersion: PNL_LOGIC_VERSION,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setScanning(false);
      setProgressLabel(null);
    }
  }, [snapshot, commitSnapshot]);

  const activeRows = useMemo(
    () => (snapshot?.rows ?? []).filter(isActive),
    [snapshot],
  );
  const historicalRows = useMemo(
    () => (snapshot?.rows ?? []).filter((r) => !isActive(r)),
    [snapshot],
  );
  const visibleRows = showHistorical
    ? [...activeRows, ...historicalRows]
    : activeRows;

  const sorted = useMemo(() => {
    const rows = [...visibleRows];
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "address":
          cmp = a.address.localeCompare(b.address);
          break;
        case "staked":
          cmp = a.staked === b.staked ? 0 : a.staked < b.staked ? -1 : 1;
          break;
        case "tier":
          cmp = a.tier.localeCompare(b.tier);
          break;
        case "tickets":
          cmp = a.tickets === b.tickets ? 0 : a.tickets < b.tickets ? -1 : 1;
          break;
        case "unlock":
          cmp = compareUnlock(a, b);
          break;
        case "bought": {
          const av = a.bought ?? -1n;
          const bv = b.bought ?? -1n;
          cmp = av === bv ? 0 : av < bv ? -1 : 1;
          break;
        }
        case "sold": {
          const av = a.sold ?? -1n;
          const bv = b.sold ?? -1n;
          cmp = av === bv ? 0 : av < bv ? -1 : 1;
          break;
        }
        case "pnl": {
          const ap = a.pnlUsd;
          const bp = b.pnlUsd;
          if (ap == null && bp == null) cmp = 0;
          else if (ap == null) cmp = -1;
          else if (bp == null) cmp = 1;
          else cmp = ap === bp ? 0 : ap < bp ? -1 : 1;
          break;
        }
      }
      return cmp * dir;
    });
    return rows;
  }, [visibleRows, sortKey, sortDir]);

  const summary = useMemo(() => {
    // Headline stats always from current stakers (staked > 0).
    const rows = activeRows;
    let totalStaked = BigInt(0);
    let normalCount = 0;
    let normalStaked = BigInt(0);
    let enhancedCount = 0;
    let enhancedStaked = BigInt(0);
    let unlockCount = 0;
    let totalUnlocking = BigInt(0);
    for (const r of rows) {
      totalStaked += r.staked;
      if (r.tier === "NORMAL") {
        normalCount += 1;
        normalStaked += r.staked;
      } else if (r.tier === "ENHANCED") {
        enhancedCount += 1;
        enhancedStaked += r.staked;
      }
      if (r.unlockingAmount > BigInt(0)) {
        unlockCount += 1;
        totalUnlocking += r.unlockingAmount;
      }
    }
    return {
      totalStakers: rows.length,
      totalStaked,
      normalCount,
      normalStaked,
      enhancedCount,
      enhancedStaked,
      unlockCount,
      totalUnlocking,
      historicalCount: historicalRows.length,
    };
  }, [activeRows, historicalRows.length]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "address" || key === "tier" ? "asc" : "desc");
    }
  }

  function sortMark(key: SortKey): string {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  const takenLabel = snapshot
    ? new Date(snapshot.takenAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  const supplyHints: StakerTierHint[] | null = useMemo(() => {
    if (!snapshot?.rows.length) return null;
    return snapshot.rows.map((r) => ({
      staked: r.staked,
      tier: r.tier,
      unlockingAmount: r.unlockingAmount,
      releaseAt: r.releaseAt,
    }));
  }, [snapshot]);

  return (
    <section className="panel">
      <SupplyLocationPanel stakerHints={supplyHints} />

      <div className="panel-head">
        <div>
          <h2>Stakers</h2>
          <p className="section-note" style={{ marginBottom: 0 }}>
            Manual snapshot of {contracts.stakingVaultV2.label} (
            <CopyAddress address={VAULT} />
            ). First scan walks Deposit/Unlock logs from deploy (cached for History); later
            Refresh only scans blocks since last success, then re-reads positions. Persisted to{" "}
            <code>dashboard/.data/stakers-v2-snapshot.json</code> (survives cookie / site-data
            clears) with a localStorage cache. Bought / sold count <em>market</em> SCRATCH only
            (DEX swaps + CCA settler fills) — stake deposits, wallet transfers, and AA hops are
            excluded. PnL uses historical FIFO cost basis (GeckoTerminal daily close at each
            fill); total = realized + unrealized on remaining lots at live spot; figure in
            parentheses is realized only. Market fills require a Uniswap v4 Swap (or settler
            buy); LP and plain transfers are excluded.
          </p>
        </div>
        <div className="row" style={{ marginBottom: 0, gap: 8 }}>
          {snapshot && (
            <button
              type="button"
              className="btn secondary"
              disabled={!visibleRows.length}
              onClick={() => downloadCsv(visibleRows, snapshot.takenAt, snapshot.scratchUsd)}
            >
              Export CSV
            </button>
          )}
          {snapshot && snapshot.rows.length > 0 && (
            <button
              type="button"
              className="btn secondary"
              disabled={scanning}
              onClick={() => void loadPnl()}
            >
              {scanning && progressLabel?.startsWith("pnl")
                ? progressLabel
                : snapshot.pnlAt
                  ? "Refresh PnL"
                  : "Load PnL"}
            </button>
          )}
          {snapshot?.scannedThroughBlock != null && (
            <button
              type="button"
              className="btn secondary"
              disabled={scanning || !isConfigured(VAULT)}
              title="Re-walk Deposit logs from the vault deploy block"
              onClick={() => void refresh({ full: true })}
            >
              Full rescan
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={scanning || !isConfigured(VAULT)}
            onClick={() => void refresh()}
          >
            {scanning && !progressLabel?.startsWith("pnl")
              ? progressLabel ?? "scanning…"
              : "Refresh stakers"}
          </button>
        </div>
      </div>

      {error && <p className="err">{error}</p>}
      {snapshot?.scannedThroughBlock != null && !scanning ? (
        <p className="muted" style={{ marginTop: 0 }}>
          Deposit logs through block {snapshot.scannedThroughBlock.toLocaleString()}
          {snapshot.takenAt
            ? ` · positions @ ${new Date(snapshot.takenAt).toLocaleString()}`
            : ""}
        </p>
      ) : null}
      {snapshot?.warnings.length ? (
        <div className="banner-warn" role="status">
          Partial results — {snapshot.warnings.length} issue
          {snapshot.warnings.length === 1 ? "" : "s"} during scan.
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {snapshot.warnings.slice(0, 6).map((w) => (
              <li key={w} style={{ marginBottom: 4 }}>
                {w}
              </li>
            ))}
            {snapshot.warnings.length > 6 && (
              <li>…and {snapshot.warnings.length - 6} more</li>
            )}
          </ul>
        </div>
      ) : null}

      {hydrated && !snapshot && !scanning ? (
        <p className="empty">No snapshot yet — click Refresh stakers to scan from deploy block.</p>
      ) : null}

      {scanning && !snapshot ? (
        <p className="muted">{progressLabel ?? "scanning…"}</p>
      ) : null}

      {snapshot ? (
        <>
          <div className="summary-strip">
            <span>
              <span className="label">Snapshot</span>
              <strong className="mono">{takenLabel}</strong>
            </span>
            <span>
              <span className="label">Current stakers</span>
              <strong className="mono">{summary.totalStakers}</strong>
            </span>
            <span>
              <span className="label">Total staked</span>
              <strong className="mono">{fmtToken(summary.totalStaked, 18, 4)}</strong>
            </span>
            <span>
              <span className="label">NORMAL</span>
              <strong className="mono">
                {summary.normalCount} · {fmtToken(summary.normalStaked, 18, 4)}
              </strong>
            </span>
            <span>
              <span className="label">ENHANCED</span>
              <strong className="mono">
                {summary.enhancedCount} · {fmtToken(summary.enhancedStaked, 18, 4)}
              </strong>
            </span>
            <span>
              <span className="label">Unlocking</span>
              <strong className="mono">
                {summary.unlockCount} · {fmtToken(summary.totalUnlocking, 18, 4)}
              </strong>
            </span>
          </div>

          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
              fontSize: "0.85rem",
            }}
          >
            <input
              type="checkbox"
              checked={showHistorical}
              onChange={(e) => setShowHistorical(e.target.checked)}
            />
            Show historical (staked=0)
            {summary.historicalCount > 0 ? (
              <span className="muted">· {summary.historicalCount}</span>
            ) : null}
          </label>

          {sorted.length === 0 ? (
            <p className="empty">
              {showHistorical
                ? "No depositors found"
                : "No current stakers (staked = 0 for all scanned addresses)"}
              {snapshot.chunksFailed > 0 ? " — scan had failures; try again" : ""}.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => toggleSort("address")}>
                      Address{sortMark("address")}
                    </th>
                    <th className="num sortable" onClick={() => toggleSort("staked")}>
                      Staked{sortMark("staked")}
                    </th>
                    <th className="sortable" onClick={() => toggleSort("tier")}>
                      Tier{sortMark("tier")}
                    </th>
                    <th className="num sortable" onClick={() => toggleSort("tickets")}>
                      Tickets{sortMark("tickets")}
                    </th>
                    <th className="sortable" onClick={() => toggleSort("unlock")}>
                      Unlock{sortMark("unlock")}
                    </th>
                    <th className="num sortable" onClick={() => toggleSort("bought")}>
                      Bought{sortMark("bought")}
                    </th>
                    <th className="num sortable" onClick={() => toggleSort("sold")}>
                      Sold{sortMark("sold")}
                    </th>
                    <th className="num sortable" onClick={() => toggleSort("pnl")}>
                      PnL (USD){sortMark("pnl")}
                    </th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={r.address} className={!isActive(r) ? "muted" : undefined}>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <CopyAddress address={r.address} />
                          <a
                            href={explorerAddress(r.address)}
                            target="_blank"
                            rel="noreferrer"
                            className="muted"
                            title="Open in Blockscout"
                            style={{ fontSize: "0.8rem" }}
                          >
                            ↗
                          </a>
                        </span>
                      </td>
                      <td className="num">{fmtToken(r.staked, 18, 4)}</td>
                      <td>{r.tier === "UNSET" ? <span className="muted">—</span> : r.tier}</td>
                      <td className="num">{fmtToken(r.tickets, 18, 4)}</td>
                      <td>
                        <UnlockCell row={r} now={now} />
                      </td>
                      <td className="num">
                        <FlowCell value={r.bought} usd={r.boughtUsd} />
                      </td>
                      <td className="num">
                        <FlowCell value={r.sold} usd={r.soldUsd} />
                      </td>
                      <td className="num">
                        <PnlCell row={r} />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn ghost"
                          style={{ padding: "2px 8px", fontSize: "0.8rem" }}
                          onClick={() =>
                            setHistoryTarget({ address: r.address, staked: r.staked })
                          }
                        >
                          History
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {historyTarget ? (
        <StakeHistoryModal
          address={historyTarget.address}
          currentStaked={historyTarget.staked}
          knownEvents={snapshot?.stakeEvents}
          eventsThroughBlock={snapshot?.scannedThroughBlock ?? null}
          onClose={() => setHistoryTarget(null)}
        />
      ) : null}
    </section>
  );
}
