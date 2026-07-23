"use client";

import { useState } from "react";
import type { Address } from "viem";
import {
  contracts,
  explorerAddress,
  isConfigured,
} from "@/config/addresses";
import { fmtToken, fmtUsd, countdown } from "@/utils/format";
import { priceTagLabel } from "@/utils/prices";
import type { HoldingToken, TreasurySnapshot } from "@/hooks/useTreasuryData";
import { RemoveVerifiedModal, VerifyTokenModal } from "@/components/VerifyTokenModal";
import { CopyAddress } from "@/components/CopyAddress";
import { PrizeVaultSweeps } from "@/components/PrizeVaultSweeps";

function HoldingRows({
  rows,
  onVerify,
  onRemove,
}: {
  rows: HoldingToken[];
  onVerify: (address: Address) => void;
  onRemove: (token: { symbol: string; address: Address }) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((t) => (
        <tr key={t.address}>
          <td>
            <span className="token-sym">{t.symbol}</span>
            {t.kind === "stock" && t.ticker && (
              <span className="ticker-tag" title="Underlying">
                {t.ticker}
              </span>
            )}
            {!t.verified && (
              <span className="badge-unverified" title="Not in tokens.json — treat with caution">
                unverified
              </span>
            )}
            <div style={{ fontSize: "0.75rem" }}>
              <CopyAddress address={t.address} />
            </div>
            <div className="token-actions">
              {!t.verified ? (
                <button type="button" className="btn ghost btn-xs" onClick={() => onVerify(t.address)}>
                  Verify &amp; add
                </button>
              ) : (
                <button
                  type="button"
                  className="btn ghost btn-xs"
                  onClick={() => onRemove({ symbol: t.symbol, address: t.address })}
                >
                  Remove from verified
                </button>
              )}
            </div>
          </td>
          <td className="num">{fmtToken(t.amount, t.decimals)}</td>
          <td className="num">
            {t.priceTag === "none" || t.usd === null ? (
              <span className="muted">
                —<span className="price-tag">no price</span>
              </span>
            ) : (
              <>
                {fmtUsd(t.usd)}
                {priceTagLabel(t.priceTag) && (
                  <span className="price-tag">{priceTagLabel(t.priceTag)}</span>
                )}
              </>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

function HolderCard({
  h,
  onVerify,
  onRemove,
}: {
  h: TreasurySnapshot["holders"][number];
  onVerify: (address: Address) => void;
  onRemove: (token: { symbol: string; address: Address }) => void;
}) {
  const crypto = h.tokens.filter((t) => t.kind !== "stock");
  const stocks = h.tokens.filter((t) => t.kind === "stock");

  return (
    <div className="card-block holder-card">
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <strong>{h.holder.label}</strong>
        {isConfigured(h.holder.address) ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <CopyAddress address={h.holder.address} />
            <a
              href={explorerAddress(h.holder.address)}
              target="_blank"
              rel="noreferrer"
              className="muted"
              title="Open in Blockscout"
              style={{ fontSize: "0.8rem" }}
            >
              ↗
            </a>
          </span>
        ) : (
          <span className="muted">not configured</span>
        )}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Asset</th>
            <th className="num">Balance</th>
            <th className="num">USD</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>ETH</td>
            <td className="num">{fmtToken(h.eth, 18)}</td>
            <td className="num">{fmtUsd(h.ethUsd)}</td>
          </tr>
          <HoldingRows rows={crypto} onVerify={onVerify} onRemove={onRemove} />
        </tbody>
      </table>

      {stocks.length > 0 && (
        <div className="stocks-block">
          <h4 className="stocks-heading">Stocks &amp; RWAs</h4>
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th className="num">Balance</th>
                <th className="num">USD</th>
              </tr>
            </thead>
            <tbody>
              <HoldingRows rows={stocks} onVerify={onVerify} onRemove={onRemove} />
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ReadPanel({
  data,
  loading,
  onRefresh,
  tokensEpoch = 0,
}: {
  data: TreasurySnapshot | null;
  loading: boolean;
  onRefresh: () => void;
  tokensEpoch?: number;
}) {
  const [verifyAddr, setVerifyAddr] = useState<Address | null>(null);
  const [removeToken, setRemoveToken] = useState<{ symbol: string; address: Address } | null>(
    null,
  );

  return (
    <section className="panel">
      {verifyAddr && (
        <VerifyTokenModal
          address={verifyAddr}
          onClose={() => setVerifyAddr(null)}
          onDone={onRefresh}
        />
      )}
      {removeToken && (
        <RemoveVerifiedModal
          token={removeToken}
          onClose={() => setRemoveToken(null)}
          onDone={onRefresh}
        />
      )}

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <h2>Read</h2>
        <button type="button" className="btn ghost" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {data?.error && <p className="err">Refresh error: {data.error}</p>}
      {data?.prices.error && <p className="err">Prices: {data.prices.error}</p>}
      {data?.discoveryWarning && (
        <div className="banner-warn" role="status">
          {data.discoveryWarning}
        </div>
      )}

      <p className="muted" style={{ marginTop: 0 }}>
        SCRATCH{" "}
        <span className="mono">{fmtUsd(data?.prices.scratchUsd ?? null)}</span>
        {" · "}
        ETH <span className="mono">{fmtUsd(data?.prices.ethUsd ?? null)}</span>
        {" · "}
        USDG $1.00
      </p>

      <h3>Balances</h3>
      {loading && !data ? (
        <p className="empty">Loading balances…</p>
      ) : !data?.holders.length ? (
        <p className="empty">Waiting for first fetch…</p>
      ) : (
        data.holders.map((h) => (
          <HolderCard
            key={h.holder.key}
            h={h}
            onVerify={setVerifyAddr}
            onRemove={setRemoveToken}
          />
        ))
      )}

      <PrizeVaultSweeps
        vaults={data?.prizeVaults ?? []}
        loading={loading}
        tokensEpoch={tokensEpoch}
        onRefresh={onRefresh}
      />

      <h3>StakingVault</h3>
      {loading && !data ? (
        <p className="empty">Loading…</p>
      ) : !data?.staking ? (
        <p className="empty">StakingVault address not set</p>
      ) : (
        <dl className="kv">
          <dt>totalStaked</dt>
          <dd>{fmtToken(data.staking.totalStaked, 18)} SCRATCH</dd>
          <dt>emissionRate</dt>
          <dd>{fmtToken(data.staking.emissionRate, 18)} / s</dd>
          <dt>accTicketsPerShare</dt>
          <dd>{data.staking.accTicketsPerShare.toString()}</dd>
        </dl>
      )}

      <h3>StandardTicketSource</h3>
      {loading && !data ? (
        <p className="empty">Loading…</p>
      ) : !data?.tickets ? (
        <p className="empty">StandardTicketSource address not set</p>
      ) : (
        <dl className="kv">
          <dt>grantDailyCap</dt>
          <dd>{fmtToken(data.tickets.grantDailyCap, 18)}</dd>
          <dt>grantUsedToday</dt>
          <dd>{fmtToken(data.tickets.grantUsedToday, 18)}</dd>
          <dt>remaining today</dt>
          <dd>{fmtToken(data.tickets.remaining, 18)}</dd>
          <dt>day-bucket reset</dt>
          <dd>{countdown(data.tickets.secondsToReset)}</dd>
        </dl>
      )}

      <h3>Ops VestingWallet</h3>
      {loading && !data ? (
        <p className="empty">Loading…</p>
      ) : !data?.vesting ? (
        <p className="empty">
          VestingWallet / SCRATCH not set
          {isConfigured(contracts.vestingWallet.address) ? "" : " (address zero)"}
        </p>
      ) : (
        <>
          <dl className="kv">
            <dt>released</dt>
            <dd>{fmtToken(data.vesting.released, 18)}</dd>
            <dt>releasable</dt>
            <dd>{fmtToken(data.vesting.releasable, 18)}</dd>
            <dt>vested to date</dt>
            <dd>{fmtToken(data.vesting.vestedToDate, 18)}</dd>
            <dt>total at end</dt>
            <dd>{fmtToken(data.vesting.totalAtEnd, 18)}</dd>
          </dl>
          <div className="progress" title={`${(data.vesting.progressBps / 100).toFixed(2)}%`}>
            <span style={{ width: `${Math.min(100, data.vesting.progressBps / 100)}%` }} />
          </div>
          <p className="muted" style={{ marginTop: 6, fontSize: "0.8rem" }}>
            {(data.vesting.progressBps / 100).toFixed(1)}% vested
          </p>
        </>
      )}

      <h3>ScratchGame</h3>
      {loading && !data ? (
        <p className="empty">Loading…</p>
      ) : !data?.game ? (
        <p className="empty">ScratchGame address not set</p>
      ) : (
        <dl className="kv">
          <dt>randomness provider</dt>
          <dd>
            <CopyAddress address={data.game.randomness} />{" "}
            <a
              href={explorerAddress(data.game.randomness)}
              target="_blank"
              rel="noreferrer"
              className="muted"
              title="Open in Blockscout"
            >
              ↗
            </a>
          </dd>
          <dt>pending swap</dt>
          <dd>
            {data.game.swapStatus === "none" ? (
              "—"
            ) : (
              <span className={data.game.swapStatus === "expired" ? "danger" : "warn"}>
                <CopyAddress address={data.game.pendingRandomness} className="mono" /> (
                {data.game.swapStatus}
                {data.game.swapStatus === "queued"
                  ? ` · eta ${countdown(data.game.secondsToEta)}`
                  : data.game.swapStatus === "ready"
                    ? ` · expires ${countdown(data.game.secondsToExpiry)}`
                    : ""}
                )
              </span>
            )}
          </dd>
          <dt>Pending requests</dt>
          <dd className={data.game.pendingCount > 0 ? "warn" : undefined}>
            {data.game.pendingCount}
          </dd>
          <dt>stale Pending (&gt; rescueDelay)</dt>
          <dd className={data.game.stalePendingCount > 0 ? "danger" : undefined}>
            {data.game.stalePendingCount}
            {data.game.stalePendingCount > 0 ? " ⚠" : ""}
          </dd>
          <dt>rescueDelay</dt>
          <dd>{countdown(data.game.rescueDelay)}</dd>
        </dl>
      )}
    </section>
  );
}
