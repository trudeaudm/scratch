"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtUsd, shortAddr } from "@/utils/format";
import type { Address } from "viem";

type AssetAgg = {
  asset: Address;
  symbol: string;
  rawTotal: string;
  humanTotal: string;
  usdTotal: number | null;
};

type RecentRow = {
  timestamp: string;
  requestId: string;
  user: string;
  tier: string;
  rowIndex: string;
  asset: string;
  symbol: string;
  humanAmount: string;
  priceUsd: string;
  usdValue: string;
  retro: boolean;
};

type PayoutsPayload = {
  updatedAt: number;
  chain: {
    wins: number;
    noWins: number;
    byAsset: AssetAgg[];
    error: string | null;
  };
  ledger: {
    path: string;
    present: boolean;
    error: string | null;
    rowCount: number;
    recent: RecentRow[];
  };
  note: string;
};

function fmtHuman(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n === 0) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function PayoutsPanel() {
  const [data, setData] = useState<PayoutsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/payouts", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as PayoutsPayload;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <section className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <h2>Payouts</h2>
        <button type="button" className="btn ghost" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <p className="danger">{error}</p>}
      {data?.chain.error && <p className="warn">Chain logs: {data.chain.error}</p>}
      {data?.ledger.error && <p className="warn">Ledger: {data.ledger.error}</p>}

      {loading && !data ? (
        <p className="muted">Loading settlements…</p>
      ) : data ? (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="ok">
              Wins <strong className="mono">{data.chain.wins}</strong>
            </span>
            <span className="muted">
              No-win <strong className="mono">{data.chain.noWins}</strong>
            </span>
            <span className="muted">
              Ledger rows{" "}
              <strong className="mono">
                {data.ledger.present ? data.ledger.rowCount : "—"}
              </strong>
              {!data.ledger.present && " (CSV not found)"}
            </span>
          </div>

          <p className="muted" style={{ fontSize: "0.8rem", marginTop: 0 }}>
            {data.note}
          </p>

          <h3>Per-asset totals</h3>
          {data.chain.byAsset.length === 0 ? (
            <p className="muted">No winning settlements yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">Quantity</th>
                  <th className="num">USD (ledger)</th>
                </tr>
              </thead>
              <tbody>
                {data.chain.byAsset.map((a) => (
                  <tr key={a.asset}>
                    <td>
                      <span className="token-sym">{a.symbol}</span>
                      <div className="mono muted" style={{ fontSize: "0.75rem" }}>
                        {shortAddr(a.asset)}
                      </div>
                    </td>
                    <td className="num mono">{fmtHuman(a.humanTotal)}</td>
                    <td className="num mono">{fmtUsd(a.usdTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Last 20 ledger rows</h3>
          {!data.ledger.present || data.ledger.recent.length === 0 ? (
            <p className="muted">
              No CSV rows yet. Run the entropy watcher (live append) or{" "}
              <span className="mono">npm run backfill-ledger</span> in{" "}
              <span className="mono">ops/entropy-operator</span>.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>User</th>
                    <th>Asset</th>
                    <th className="num">Amount</th>
                    <th className="num">USD</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ledger.recent.map((r) => (
                    <tr key={`${r.requestId}-${r.timestamp}`}>
                      <td className="mono" style={{ fontSize: "0.75rem" }}>
                        {r.timestamp ? new Date(r.timestamp).toLocaleString() : "—"}
                      </td>
                      <td className="mono" style={{ fontSize: "0.75rem" }}>
                        {r.user ? shortAddr(r.user as Address) : "—"}
                      </td>
                      <td>
                        {r.symbol}
                        <div className="muted" style={{ fontSize: "0.7rem" }}>
                          tier {r.tier} · row {r.rowIndex}
                        </div>
                      </td>
                      <td className="num mono">{fmtHuman(r.humanAmount || "0")}</td>
                      <td className="num mono">
                        {r.usdValue === "" ? "—" : fmtUsd(Number(r.usdValue))}
                      </td>
                      <td className="muted" style={{ fontSize: "0.75rem" }}>
                        {r.retro ? "retro" : ""}
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
