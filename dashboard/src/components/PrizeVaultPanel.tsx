"use client";

import { isLegacyContract } from "@/config/addresses";
import { fmtToken, fmtUsd } from "@/utils/format";
import { CopyAddress } from "@/components/CopyAddress";
import type { PrizeVaultVitals } from "@/hooks/useTreasuryData";

export function PrizeVaultPanel({
  vaults,
  loading,
  tokensEpoch = 0,
  onRefresh,
}: {
  vaults: PrizeVaultVitals[];
  loading: boolean;
  tokensEpoch?: number;
  onRefresh: () => void;
}) {
  void tokensEpoch;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>PrizeVault</h2>
        <button type="button" className="btn ghost" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p className="section-note">
        Full holdings per vault (config tokens + Alchemy discovery + on-chain inventory). Sweep
        queue / execute lives under Sweeps.
      </p>

      {loading && vaults.length === 0 ? (
        <p className="empty">Loading…</p>
      ) : vaults.length === 0 ? (
        <p className="empty">No PrizeVault address set in addresses.ts (v1 and/or v2)</p>
      ) : (
        <div className="grid-cards">
          {vaults.map((v) => {
            const legacy = isLegacyContract(v.config);
            return (
              <div key={v.config.key} className={`card-block${legacy ? " legacy" : ""}`}>
                <h3>
                  {v.config.label}
                  {legacy ? <span className="legacy-tag">legacy</span> : null}
                </h3>
                <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
                  <CopyAddress address={v.config.address} />
                </p>
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th className="num">Balance</th>
                        <th className="num">USD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.inventory.length === 0 ? (
                        <tr>
                          <td colSpan={3} className="muted">
                            Empty inventory
                          </td>
                        </tr>
                      ) : (
                        v.inventory.map((row) => (
                          <tr key={row.asset}>
                            <td>
                              <span className="token-sym">{row.symbol}</span>
                              {row.kind === "stock" && row.ticker ? (
                                <span className="ticker-tag">{row.ticker}</span>
                              ) : null}
                              {!row.verified ? (
                                <span className="badge-unverified">unverified</span>
                              ) : null}
                              <div style={{ fontSize: "0.75rem" }}>
                                <CopyAddress address={row.asset} />
                              </div>
                            </td>
                            <td className="num">{fmtToken(row.balance, row.decimals)}</td>
                            <td className="num">{fmtUsd(row.usd)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
