"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits, type Address } from "viem";
import { explorerAddress, explorerTx } from "@/config/addresses";
import { CopyAddress } from "@/components/CopyAddress";
import { fmtToken } from "@/utils/format";
import {
  fetchStakeHistory,
  type StakeHistoryKind,
  type StakeHistoryPoint,
  type StakeHistoryResult,
} from "@/utils/stakeHistory";
import type { StoredStakeEvent } from "@/utils/stakersSnapshot";

function kindLabel(kind: StakeHistoryKind): string {
  switch (kind) {
    case "deposit":
      return "Deposit";
    case "unlock_request":
      return "Unlock request";
    case "unlock_cancel":
      return "Unlock cancel";
    case "now":
      return "Now";
  }
}

function formatTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function formatDelta(delta: bigint): string {
  if (delta === 0n) return "0";
  const sign = delta > 0n ? "+" : "−";
  const abs = delta < 0n ? -delta : delta;
  return `${sign}${fmtToken(abs, 18, 4)}`;
}

/** SVG step chart of staked balance over time. */
function StakeStepChart({ points }: { points: StakeHistoryPoint[] }) {
  const width = 640;
  const height = 220;
  const padL = 56;
  const padR = 16;
  const padT = 16;
  const padB = 36;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const chartPoints = useMemo(() => {
    const series = points.filter((p) => p.timestamp > 0);
    if (series.length === 0) return null;
    const minT = series[0].timestamp;
    const maxT = Math.max(series[series.length - 1].timestamp, minT + 1);
    let maxBal = 0n;
    for (const p of series) if (p.balance > maxBal) maxBal = p.balance;
    if (maxBal === 0n) maxBal = 1n;
    const maxBalNum = Number(formatUnits(maxBal, 18));

    const xy = series.map((p) => {
      const x = padL + ((p.timestamp - minT) / (maxT - minT)) * plotW;
      const y =
        padT + plotH - (Number(formatUnits(p.balance, 18)) / maxBalNum) * plotH;
      return { x, y, p };
    });

    // Step path: horizontal then vertical between points.
    let d = `M ${xy[0].x.toFixed(1)} ${xy[0].y.toFixed(1)}`;
    for (let i = 1; i < xy.length; i++) {
      d += ` H ${xy[i].x.toFixed(1)} V ${xy[i].y.toFixed(1)}`;
    }

    const yTicks = [0, 0.5, 1].map((f) => ({
      y: padT + plotH * (1 - f),
      label: fmtToken((maxBal * BigInt(Math.round(f * 1000))) / 1000n, 18, 2),
    }));

    const xTicks = [0, 0.5, 1].map((f) => {
      const ts = minT + (maxT - minT) * f;
      return {
        x: padL + f * plotW,
        label: new Date(ts * 1000).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
      };
    });

    return { d, xy, yTicks, xTicks, maxBal };
  }, [points, plotH, plotW]);

  if (!chartPoints) {
    return <p className="muted">No timed events to plot.</p>;
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label="Staked balance over time"
      style={{ display: "block", maxWidth: width }}
    >
      {chartPoints.yTicks.map((t) => (
        <g key={t.y}>
          <line
            x1={padL}
            x2={width - padR}
            y1={t.y}
            y2={t.y}
            stroke="var(--border)"
            strokeWidth={1}
          />
          <text
            x={padL - 8}
            y={t.y + 4}
            textAnchor="end"
            fill="var(--muted)"
            fontSize={10}
            fontFamily="var(--mono, ui-monospace, monospace)"
          >
            {t.label}
          </text>
        </g>
      ))}
      {chartPoints.xTicks.map((t) => (
        <text
          key={t.x}
          x={t.x}
          y={height - 10}
          textAnchor="middle"
          fill="var(--muted)"
          fontSize={10}
        >
          {t.label}
        </text>
      ))}
      <path
        d={chartPoints.d}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {chartPoints.xy.map((pt, i) => (
        <circle
          key={i}
          cx={pt.x}
          cy={pt.y}
          r={pt.p.kind === "now" ? 4 : 3}
          fill={pt.p.kind === "now" ? "var(--ok, #3ecf8e)" : "var(--accent)"}
        >
          <title>
            {kindLabel(pt.p.kind)} · {fmtToken(pt.p.balance, 18, 4)} SCRATCH ·{" "}
            {formatTime(pt.p.timestamp)}
          </title>
        </circle>
      ))}
    </svg>
  );
}

export function StakeHistoryModal({
  address,
  currentStaked,
  knownEvents,
  eventsThroughBlock,
  onClose,
}: {
  address: Address;
  currentStaked: bigint;
  knownEvents?: StoredStakeEvent[];
  eventsThroughBlock?: number | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StakeHistoryResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setProgress("loading…");
      try {
        const data = await fetchStakeHistory(address, currentStaked, {
          knownEvents,
          eventsThroughBlock,
          onProgress: (done, total) => {
            if (!cancelled) setProgress(`scanning… ${done}/${total}`);
          },
        });
        if (cancelled) return;
        setResult(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setProgress(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, currentStaked, eventsThroughBlock, knownEvents?.length]);

  const eventRows = result?.points.filter((p) => p.kind !== "now") ?? [];

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stake-history-title"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(720px, 100%)" }}
      >
        <div className="modal-head">
          <h3 id="stake-history-title">Stake history</h3>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <p className="muted" style={{ marginTop: 0 }}>
          Active staked balance for <CopyAddress address={address} />{" "}
          <a
            href={explorerAddress(address)}
            target="_blank"
            rel="noreferrer"
            className="muted"
            title="Open in Blockscout"
          >
            ↗
          </a>
          {" · "}
          live <span className="mono">{fmtToken(currentStaked, 18, 4)}</span> SCRATCH
        </p>

        {loading && <p className="muted">{progress ?? "loading…"}</p>}
        {error && <p className="err">{error}</p>}

        {result?.warnings.length ? (
          <div className="banner-warn" role="status" style={{ marginBottom: 12 }}>
            {result.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        ) : null}

        {result && !loading ? (
          <>
            <StakeStepChart points={result.points} />

            {eventRows.length === 0 ? (
              <p className="empty">No deposit / unlock events for this address.</p>
            ) : (
              <div className="table-scroll" style={{ maxHeight: 280, marginTop: 16 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th className="num">Δ</th>
                      <th className="num">Balance</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...eventRows].reverse().map((p, i) => (
                      <tr key={`${p.txHash}-${i}`}>
                        <td className="mono" style={{ fontSize: "0.8rem" }}>
                          {formatTime(p.timestamp)}
                        </td>
                        <td>{kindLabel(p.kind)}</td>
                        <td className="num mono">{formatDelta(p.delta)}</td>
                        <td className="num mono">{fmtToken(p.balance, 18, 4)}</td>
                        <td>
                          {p.txHash ? (
                            <a
                              href={explorerTx(p.txHash)}
                              target="_blank"
                              rel="noreferrer"
                              className="muted"
                            >
                              ↗
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
