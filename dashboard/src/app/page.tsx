"use client";

import { useState, useSyncExternalStore } from "react";
import { BalancesPanel, StakingOpsPanel } from "@/components/ReadPanel";
import { WritePanel } from "@/components/WritePanel";
import { PrizeTablesPanel } from "@/components/PrizeTablesPanel";
import { PayoutsPanel } from "@/components/PayoutsPanel";
import { PrizeVaultPanel } from "@/components/PrizeVaultPanel";
import { PrizeVaultSweeps } from "@/components/PrizeVaultSweeps";
import { StakersPanel } from "@/components/StakersPanel";
import { useTreasuryData } from "@/hooks/useTreasuryData";
import { getTokensEpoch, subscribeTokens } from "@/config/addresses";
import { REFRESH_MS } from "@/config/chain";

const TABS = [
  { id: "balances", label: "Balances" },
  { id: "prizeVault", label: "PrizeVault" },
  { id: "staking", label: "Staking" },
  { id: "sweeps", label: "Sweeps" },
  { id: "prizeTables", label: "Prize Tables" },
  { id: "payouts", label: "Payouts" },
  { id: "stakers", label: "Stakers" },
  { id: "writes", label: "Writes" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function HomePage() {
  const { data, loading, refresh } = useTreasuryData();
  const tokensEpoch = useSyncExternalStore(subscribeTokens, getTokensEpoch, getTokensEpoch);
  const [tab, setTab] = useState<TabId>("balances");

  return (
    <main className="app">
      <header className="header">
        <div>
          <span className="badge">Local only · never deploy</span>
          <h1>$SCRATCH Treasury</h1>
          <p className="sub">Chain 4663 · auto-refresh every {REFRESH_MS / 1000}s · no auth</p>
        </div>
        <div className="meta">
          {data?.updatedAt ? (
            <div>
              Last update{" "}
              <span className="mono">{new Date(data.updatedAt).toLocaleTimeString()}</span>
            </div>
          ) : (
            <div>Fetching…</div>
          )}
        </div>
      </header>

      <nav className="tabs" aria-label="Dashboard sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab${tab === t.id ? " active" : ""}`}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="tab-panel">
        {tab === "balances" && (
          <BalancesPanel
            data={data}
            loading={loading}
            onRefresh={() => void refresh()}
            tokensEpoch={tokensEpoch}
          />
        )}

        {tab === "prizeVault" && (
          <PrizeVaultPanel
            vaults={data?.prizeVaults ?? []}
            loading={loading}
            tokensEpoch={tokensEpoch}
            onRefresh={() => void refresh()}
          />
        )}

        {tab === "staking" && (
          <StakingOpsPanel
            data={data}
            loading={loading}
            onRefresh={() => void refresh()}
            tokensEpoch={tokensEpoch}
          />
        )}

        {tab === "sweeps" && (
          <PrizeVaultSweeps
            vaults={data?.prizeVaults ?? []}
            loading={loading}
            tokensEpoch={tokensEpoch}
            onRefresh={() => void refresh()}
          />
        )}

        {tab === "prizeTables" && (
          <PrizeTablesPanel
            key={tokensEpoch}
            prizeTables={data?.prizeTables ?? null}
            vaultAssets={data?.vaultAssets ?? []}
            gamePrizeVault={data?.gamePrizeVault ?? null}
            prices={
              data?.prices ?? {
                scratchUsd: null,
                ethUsd: null,
                byToken: {},
                fetchedAt: null,
                error: null,
              }
            }
            pendingCount={data?.game?.pendingCount ?? 0}
            loading={loading && !data}
            onRefresh={() => void refresh()}
          />
        )}

        {tab === "payouts" && <PayoutsPanel />}

        {tab === "stakers" && <StakersPanel />}

        {tab === "writes" && (
          <WritePanel
            tickets={data?.tickets ?? null}
            tokensEpoch={tokensEpoch}
            fundVault={data?.gamePrizeVault ?? null}
          />
        )}
      </div>
    </main>
  );
}
