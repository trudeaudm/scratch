"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtToken } from "@/utils/format";
import {
  fmtSupply,
  loadSupplyLocation,
  pctOf,
  type StakerTierHint,
  type SupplyLocation,
} from "@/utils/supplyLocation";

export function SupplyLocationPanel({
  stakerHints = null,
}: {
  /** From Stakers snapshot — splits V2 NORMAL vs ENHANCED. */
  stakerHints?: StakerTierHint[] | null;
}) {
  const [data, setData] = useState<SupplyLocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadSupplyLocation(stakerHints);
      setData(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [stakerHints]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const takenLabel = data
    ? new Date(data.takenAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  return (
    <div className="supply-block">
      <div className="panel-head" style={{ marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>Supply location</h3>
          <p className="section-note" style={{ marginBottom: 0 }}>
            Where SCRATCH sits: freely sellable / LP vs locked ≥4 days (ENHANCED stake, vesting,
            prize inventory). Snapshot {takenLabel ?? "—"}.
          </p>
        </div>
        <button type="button" className="btn ghost" disabled={loading} onClick={() => void refresh()}>
          {loading ? "Loading…" : "Refresh supply"}
        </button>
      </div>

      {error && <p className="err">{error}</p>}
      {data?.warnings.length ? (
        <p className="warn" style={{ fontSize: "0.85rem" }}>
          {data.warnings.join(" · ")}
        </p>
      ) : null}

      {loading && !data ? (
        <p className="empty">Loading supply…</p>
      ) : data ? (
        <>
          <div className="summary-strip">
            <span>
              <span className="label">Total supply</span>
              <strong className="mono">{fmtToken(data.totalSupply, 18, 2)}</strong>
            </span>
            {data.buckets.map((b) => (
              <span key={b.key}>
                <span className="label">{b.label}</span>
                <strong className="mono">
                  {fmtToken(b.amount, 18, 2)} · {pctOf(b.amount, data.totalSupply).toFixed(2)}%
                </strong>
              </span>
            ))}
          </div>

          <div className="supply-bar" aria-hidden="true">
            {data.buckets.map((b) => {
              const pct = pctOf(b.amount, data.totalSupply);
              if (pct <= 0) return null;
              return (
                <span
                  key={b.key}
                  className={b.key === "onMarket" ? "supply-bar-market" : "supply-bar-locked"}
                  style={{ width: `${pct}%` }}
                  title={`${b.label}: ${pct.toFixed(2)}%`}
                />
              );
            })}
          </div>

          <div className="supply-buckets">
            {data.buckets.map((b) => (
              <div key={b.key} className={`card-block supply-bucket supply-bucket-${b.key}`}>
                <h4>
                  {b.label}{" "}
                  <span className="mono muted" style={{ fontWeight: 500, fontSize: "0.85rem" }}>
                    {pctOf(b.amount, data.totalSupply).toFixed(2)}%
                  </span>
                </h4>
                <p className="muted" style={{ marginTop: 0, fontSize: "0.8rem" }}>
                  {b.blurb}
                </p>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Location</th>
                      <th className="num">Amount</th>
                      <th className="num">% supply</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.lines.map((line) => (
                      <tr key={line.key}>
                        <td>
                          {line.label}
                          {line.note ? (
                            <div className="muted" style={{ fontSize: "0.7rem" }}>
                              {line.note}
                            </div>
                          ) : null}
                        </td>
                        <td className="num">{fmtToken(line.amount, 18, 2)}</td>
                        <td className="num">{pctOf(line.amount, data.totalSupply).toFixed(2)}%</td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <strong>Subtotal</strong>
                      </td>
                      <td className="num">
                        <strong>{fmtToken(b.amount, 18, 2)}</strong>
                      </td>
                      <td className="num">
                        <strong>{pctOf(b.amount, data.totalSupply).toFixed(2)}%</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ))}
          </div>

          {data.unclassified > BigInt(0) ? (
            <p className="muted" style={{ fontSize: "0.8rem", marginTop: 10 }}>
              Unclassified residual {fmtSupply(data.unclassified)} SCRATCH (
              {pctOf(data.unclassified, data.totalSupply).toFixed(2)}%) — rounding / unknown holders.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
