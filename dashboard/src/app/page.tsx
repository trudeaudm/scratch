"use client";

import { useSyncExternalStore } from "react";
import { ReadPanel } from "@/components/ReadPanel";
import { WritePanel } from "@/components/WritePanel";
import { PrizeTablesPanel } from "@/components/PrizeTablesPanel";
import { PayoutsPanel } from "@/components/PayoutsPanel";
import { useTreasuryData } from "@/hooks/useTreasuryData";
import { getTokensEpoch, subscribeTokens } from "@/config/addresses";
import { REFRESH_MS } from "@/config/chain";

export default function HomePage() {
  const { data, loading, refresh } = useTreasuryData();
  const tokensEpoch = useSyncExternalStore(subscribeTokens, getTokensEpoch, getTokensEpoch);

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

      <div className="grid grid-2">
        <ReadPanel
          data={data}
          loading={loading}
          onRefresh={() => void refresh()}
          tokensEpoch={tokensEpoch}
        />
        <WritePanel tickets={data?.tickets ?? null} tokensEpoch={tokensEpoch} />
      </div>

      <PrizeTablesPanel
        key={tokensEpoch}
        prizeTables={data?.prizeTables ?? null}
        vaultAssets={data?.vaultAssets ?? []}
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

      <PayoutsPanel />
    </main>
  );
}
