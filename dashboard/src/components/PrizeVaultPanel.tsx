"use client";

import { isLegacyContract, writePanelTokens } from "@/config/addresses";
import { fmtToken } from "@/utils/format";
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
  const saleTokens = writePanelTokens();

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>PrizeVault</h2>
        <button type="button" className="btn ghost" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p className="section-note">
        On-chain inventory per vault. Sweep queue / execute lives under Sweeps.
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
                      </tr>
                    </thead>
                    <tbody>
                      {v.inventory.length === 0 ? (
                        <tr>
                          <td colSpan={2} className="muted">
                            Empty inventory
                          </td>
                        </tr>
                      ) : (
                        v.inventory.map((row) => (
                          <tr key={row.asset}>
                            <td>
                              {row.symbol} <CopyAddress address={row.asset} />
                            </td>
                            <td className="num">
                              {fmtToken(
                                row.balance,
                                saleTokens.find(
                                  (t) => t.address.toLowerCase() === row.asset.toLowerCase(),
                                )?.decimals ?? 18,
                              )}
                            </td>
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
