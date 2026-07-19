"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtUsd } from "@/utils/format";
import { CopyAddress } from "@/components/CopyAddress";

type AssetAgg = {
  asset: `0x${string}`;
  symbol: string;
  rawTotal: string;
  humanTotal: string;
  usdTotal: number | null;
};

type LedgerRowView = {
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
  txHash: string;
  txUrl: string | null;
};

type BigWin = {
  requestId: string;
  user: string;
  symbol: string;
  humanAmount: string;
  usdValue: number | null;
  ageSec: number | null;
  txHash: string;
  txUrl: string;
  timestamp: string | null;
};

type PayoutsPayload = {
  updatedAt: number;
  chain: {
    wins: number;
    noWins: number;
    byAsset: AssetAgg[];
    error: string | null;
    newestSettledAt: string | null;
    settlementCount: number;
  };
  ledger: {
    path: string;
    present: boolean;
    error: string | null;
    rowCount: number;
    newestTimestamp: string | null;
    stale: boolean;
    staleLagMs: number | null;
    rows: LedgerRowView[];
  };
  biggestWins: BigWin[];
  note: string;
};

type WindowKey = "20" | "100" | "24h";

function fmtHuman(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n === 0) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function isWin(r: LedgerRowView): boolean {
  if (!r.asset || r.asset === "0x0000000000000000000000000000000000000000") return false;
  if (r.symbol === "NO_WIN") return false;
  const n = Number(r.humanAmount);
  return Number.isFinite(n) && n > 0;
}

function ageLabel(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function lagLabel(ms: number | null): string {
  if (ms == null) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function PayoutsPanel() {
  const [data, setData] = useState<PayoutsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [winsOnly, setWinsOnly] = useState(false);
  const [windowKey, setWindowKey] = useState<WindowKey>("20");

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

  const tableRows = useMemo(() => {
    if (!data?.ledger.rows) return [];
    let rows = [...data.ledger.rows].reverse();
    if (winsOnly) rows = rows.filter(isWin);
    if (windowKey === "24h") {
      const cut = Date.now() - 24 * 60 * 60 * 1000;
      rows = rows.filter((r) => {
        const t = Date.parse(r.timestamp);
        return Number.isFinite(t) && t >= cut;
      });
    } else {
      const n = windowKey === "100" ? 100 : 20;
      rows = rows.slice(0, n);
    }
    return rows;
  }, [data, winsOnly, windowKey]);

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
      {data?.ledger.stale && (
        <div className="banner-danger" role="alert" style={{ marginTop: 10 }}>
          <strong>Ledger is behind</strong>
          <p style={{ margin: "6px 0 0" }}>
            Newest onchain settlement{" "}
            <span className="mono">
              {data.chain.newestSettledAt
                ? new Date(data.chain.newestSettledAt).toLocaleString()
                : "—"}
            </span>
            {data.ledger.newestTimestamp && (
              <>
                {" "}
                · newest ledger row{" "}
                <span className="mono">
                  {new Date(data.ledger.newestTimestamp).toLocaleString()}
                </span>
              </>
            )}
            {data.ledger.staleLagMs != null && (
              <> · lag {lagLabel(data.ledger.staleLagMs)}</>
            )}
            . Restart <span className="mono">npm run watch</span> (live append) or run{" "}
            <span className="mono">npm run backfill-ledger</span>.
          </p>
        </div>
      )}

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
                      <div style={{ fontSize: "0.75rem" }}>
                        <CopyAddress address={a.asset} />
                      </div>
                    </td>
                    <td className="num mono">{fmtHuman(a.humanTotal)}</td>
                    <td className="num mono">{fmtUsd(a.usdTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Biggest wins</h3>
          {data.biggestWins.length === 0 ? (
            <p className="muted">No wins yet.</p>
          ) : (
            <div className="row" style={{ gap: 10, marginBottom: 8, alignItems: "stretch" }}>
              {data.biggestWins.map((w) => (
                <div
                  key={w.requestId}
                  className="card-block"
                  style={{ flex: "1 1 140px", minWidth: 140, padding: "10px 12px" }}
                >
                  <div className="token-sym" style={{ color: "var(--accent)" }}>
                    +{fmtHuman(w.humanAmount)} {w.symbol}
                  </div>
                  <div className="muted" style={{ fontSize: "0.75rem", marginTop: 4 }}>
                    {w.usdValue != null ? fmtUsd(w.usdValue) : "USD —"} · {ageLabel(w.ageSec)}
                  </div>
                  <div style={{ fontSize: "0.75rem", marginTop: 4 }}>
                    <CopyAddress address={w.user} />
                  </div>
                  {w.txUrl ? (
                    <a
                      href={w.txUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: "0.75rem", display: "inline-block", marginTop: 6 }}
                    >
                      tx ↗
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          <div
            className="row"
            style={{ marginTop: 18, marginBottom: 8, alignItems: "center", gap: 14 }}
          >
            <h3 style={{ margin: 0 }}>Ledger</h3>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.85rem" }}>
              <input
                type="checkbox"
                checked={winsOnly}
                onChange={(e) => setWinsOnly(e.target.checked)}
              />
              Wins only
            </label>
            <label style={{ fontSize: "0.85rem" }}>
              Window{" "}
              <select
                value={windowKey}
                onChange={(e) => setWindowKey(e.target.value as WindowKey)}
                style={{ marginLeft: 4 }}
              >
                <option value="20">last 20</option>
                <option value="100">last 100</option>
                <option value="24h">last 24h</option>
              </select>
            </label>
          </div>

          {!data.ledger.present || tableRows.length === 0 ? (
            <p className="muted">
              No ledger rows in this window. Run the entropy watcher (live append) or{" "}
              <span className="mono">npm run backfill-ledger</span>.
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
                  {tableRows.map((r) => (
                    <tr key={`${r.requestId}-${r.timestamp}`}>
                      <td className="mono" style={{ fontSize: "0.75rem" }}>
                        {r.timestamp ? new Date(r.timestamp).toLocaleString() : "—"}
                      </td>
                      <td style={{ fontSize: "0.75rem" }}>
                        {r.user ? <CopyAddress address={r.user} /> : "—"}
                      </td>
                      <td>
                        {r.symbol}
                        <div className="muted" style={{ fontSize: "0.7rem" }}>
                          tier {r.tier} · row {r.rowIndex}
                          {r.txUrl ? (
                            <>
                              {" · "}
                              <a href={r.txUrl} target="_blank" rel="noreferrer">
                                tx
                              </a>
                            </>
                          ) : null}
                        </div>
                      </td>
                      <td className="num mono">{fmtHuman(r.humanAmount || "0")}</td>
                      <td className="num mono">
                        {r.usdValue === "" ? "—" : fmtUsd(Number(r.usdValue))}
                      </td>
                      <td className="muted" style={{ fontSize: "0.75rem" }}>
                        {r.retro ? "retro" : "live"}
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
