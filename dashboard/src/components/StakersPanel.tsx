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
import { countdown, fmtToken, shortAddr } from "@/utils/format";
import { CopyAddress } from "@/components/CopyAddress";

const VAULT = contracts.stakingVaultV2.address;
/** Max blocks per getLogs window (≤2k per buildspec / RPC limits). */
const LOG_CHUNK_SIZE = 2000;
const READ_BATCH = 40;

const depositedEvent = parseAbiItem(
  "event Deposited(address indexed user, uint256 amount, uint8 tier)",
);

const stakingV2Abi = [
  parseAbiItem(
    "function users(address) view returns (uint256 staked, uint256 debt, uint256 banked, uint8 tier)",
  ),
  parseAbiItem("function unlocking(address) view returns (uint256 amount, uint64 releaseAt)"),
  parseAbiItem("function ticketsOf(address user) view returns (uint256)"),
] as const;

const TIER_NORMAL = 1;
const TIER_ENHANCED = 2;

type TierLabel = "NORMAL" | "ENHANCED" | "UNSET";

type StakerRow = {
  address: Address;
  staked: bigint;
  tier: TierLabel;
  tickets: bigint;
  unlockingAmount: bigint;
  releaseAt: number;
};

type Snapshot = {
  takenAt: number;
  rows: StakerRow[];
  warnings: string[];
  addressesFound: number;
  chunksScanned: number;
  chunksFailed: number;
};

type SortKey = "address" | "staked" | "tier" | "tickets" | "unlock";

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

function downloadCsv(snapshot: Snapshot): void {
  const header = [
    "address",
    "staked",
    "tier",
    "tickets",
    "unlockingAmount",
    "releaseAt",
    "unlockStatus",
  ];
  const now = Math.floor(Date.now() / 1000);
  const lines = [header.join(",")];
  for (const r of snapshot.rows) {
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
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date(snapshot.takenAt).toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `staking-v2-stakers-${ts}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function scanDepositors(
  pc: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  onProgress: (done: number, total: number) => void,
): Promise<{ addresses: Address[]; chunksScanned: number; chunksFailed: number; warnings: string[] }> {
  const chunk = BigInt(LOG_CHUNK_SIZE);
  const span = toBlock - fromBlock;
  const totalChunks = Math.max(1, Number(span / chunk) + 1);
  const seen = new Set<string>();
  const addresses: Address[] = [];
  const warnings: string[] = [];
  let chunksScanned = 0;
  let chunksFailed = 0;
  let done = 0;

  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - BigInt(1) > toBlock ? toBlock : start + chunk - BigInt(1);
    done += 1;
    onProgress(done, totalChunks);
    try {
      const logs = await pc.getLogs({
        address: VAULT,
        event: depositedEvent,
        fromBlock: start,
        toBlock: end,
      });
      chunksScanned += 1;
      for (const log of logs) {
        const user = log.args.user;
        if (!user) continue;
        const key = user.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        addresses.push(user);
      }
    } catch (e) {
      chunksFailed += 1;
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`Log chunk ${start.toString()}–${end.toString()} failed: ${msg}`);
    }
  }

  return { addresses, chunksScanned, chunksFailed, warnings };
}

async function readStakerStates(
  pc: PublicClient,
  addresses: Address[],
  onProgress: (done: number, total: number) => void,
): Promise<{ rows: StakerRow[]; warnings: string[] }> {
  const rows: StakerRow[] = [];
  const warnings: string[] = [];
  const total = addresses.length || 1;

  for (let i = 0; i < addresses.length; i += READ_BATCH) {
    const batch = addresses.slice(i, i + READ_BATCH);
    onProgress(Math.min(i + batch.length, addresses.length), total);

    const contractsCall = batch.flatMap((addr) => [
      { address: VAULT, abi: stakingV2Abi, functionName: "users" as const, args: [addr] as const },
      {
        address: VAULT,
        abi: stakingV2Abi,
        functionName: "unlocking" as const,
        args: [addr] as const,
      },
      {
        address: VAULT,
        abi: stakingV2Abi,
        functionName: "ticketsOf" as const,
        args: [addr] as const,
      },
    ]);

    try {
      const results = await pc.multicall({ contracts: contractsCall, allowFailure: true });
      for (let j = 0; j < batch.length; j++) {
        const userRes = results[j * 3];
        const unlockRes = results[j * 3 + 1];
        const ticketsRes = results[j * 3 + 2];
        if (userRes.status !== "success" || unlockRes.status !== "success") {
          warnings.push(`State read failed for ${shortAddr(batch[j])}`);
          continue;
        }
        const [staked, , , tierRaw] = userRes.result as readonly [bigint, bigint, bigint, number];
        const [unlockingAmount, releaseAtRaw] = unlockRes.result as readonly [bigint, number | bigint];
        const tickets =
          ticketsRes.status === "success" ? (ticketsRes.result as bigint) : BigInt(0);
        if (ticketsRes.status !== "success") {
          warnings.push(`ticketsOf failed for ${shortAddr(batch[j])}`);
        }
        rows.push({
          address: batch[j],
          staked,
          tier: tierLabel(Number(tierRaw)),
          tickets,
          unlockingAmount,
          releaseAt: Number(releaseAtRaw),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`Multicall batch @${i} failed: ${msg}`);
      // Degrade: try one-by-one for this batch
      for (const addr of batch) {
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
          rows.push({
            address: addr,
            staked,
            tier: tierLabel(Number(tierRaw)),
            tickets: tickets as bigint,
            unlockingAmount,
            releaseAt: Number(releaseAtRaw),
          });
        } catch (inner) {
          const im = inner instanceof Error ? inner.message : String(inner);
          warnings.push(`State read failed for ${shortAddr(addr)}: ${im}`);
        }
      }
    }
  }

  onProgress(addresses.length, total);
  return { rows, warnings };
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
  const [scanning, setScanning] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("staked");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    if (!isConfigured(VAULT)) {
      setError("StakingVaultV2 address not set");
      return;
    }
    setScanning(true);
    setError(null);
    setProgressLabel("scanning… 0/1");
    const warnings: string[] = [];

    try {
      const pc = client();
      const latest = await pc.getBlockNumber();
      const from = stakingV2DeployBlock();
      if (from > latest) {
        setSnapshot({
          takenAt: Date.now(),
          rows: [],
          warnings: ["Deploy block is ahead of chain tip"],
          addressesFound: 0,
          chunksScanned: 0,
          chunksFailed: 0,
        });
        return;
      }

      const { addresses, chunksScanned, chunksFailed, warnings: logWarnings } =
        await scanDepositors(pc, from, latest, (done, total) => {
          setProgressLabel(`scanning… ${done}/${total}`);
        });
      warnings.push(...logWarnings);

      const chunk = BigInt(LOG_CHUNK_SIZE);
      const logTotal = Math.max(1, Number((latest - from) / chunk) + 1);
      const readTotal = Math.max(1, addresses.length);
      const combinedTotal = logTotal + readTotal;

      setProgressLabel(`scanning… ${logTotal}/${combinedTotal}`);

      const { rows, warnings: stateWarnings } = await readStakerStates(
        pc,
        addresses,
        (done) => {
          setProgressLabel(`scanning… ${logTotal + done}/${combinedTotal}`);
        },
      );
      warnings.push(...stateWarnings);

      setSnapshot({
        takenAt: Date.now(),
        rows,
        warnings,
        addressesFound: addresses.length,
        chunksScanned,
        chunksFailed,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      // Keep prior snapshot if any — never blank the table on a failed refresh
      setSnapshot((prev) =>
        prev ?? {
          takenAt: Date.now(),
          rows: [],
          warnings: [msg],
          addressesFound: 0,
          chunksScanned: 0,
          chunksFailed: 0,
        },
      );
    } finally {
      setScanning(false);
      setProgressLabel(null);
    }
  }, []);

  const sorted = useMemo(() => {
    if (!snapshot) return [];
    const rows = [...snapshot.rows];
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
      }
      return cmp * dir;
    });
    return rows;
  }, [snapshot, sortKey, sortDir]);

  const summary = useMemo(() => {
    const rows = snapshot?.rows ?? [];
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
    };
  }, [snapshot]);

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

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Stakers</h2>
          <p className="section-note" style={{ marginBottom: 0 }}>
            Manual snapshot of {contracts.stakingVaultV2.label} (
            <CopyAddress address={VAULT} />
            ). No on-chain enumeration — click Refresh to scan Deposit logs. Cached in this session
            only.
          </p>
        </div>
        <div className="row" style={{ marginBottom: 0, gap: 8 }}>
          {snapshot && (
            <button
              type="button"
              className="btn secondary"
              disabled={!snapshot.rows.length}
              onClick={() => downloadCsv(snapshot)}
            >
              Export CSV
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={scanning || !isConfigured(VAULT)}
            onClick={() => void refresh()}
          >
            {scanning ? progressLabel ?? "scanning…" : "Refresh stakers"}
          </button>
        </div>
      </div>

      {error && <p className="err">{error}</p>}
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

      {!snapshot && !scanning ? (
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
              <span className="label">Stakers</span>
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

          {sorted.length === 0 ? (
            <p className="empty">
              No depositors found
              {snapshot.chunksFailed > 0 ? " (scan had failures — try again)" : ""}.
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
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={r.address}>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
