"use client";

import {
  contracts,
  explorerAddress,
  isConfigured,
  tokens,
} from "@/config/addresses";
import { fmtToken, fmtUsd, countdown, shortAddr } from "@/utils/format";
import { priceTagLabel } from "@/utils/prices";
import type { HoldingToken, TreasurySnapshot } from "@/hooks/useTreasuryData";

function tokenDecimals(asset: string): number {
  const t = tokens.find((x) => x.address.toLowerCase() === asset.toLowerCase());
  return t?.decimals ?? 18;
}

function HoldingRows({ rows }: { rows: HoldingToken[] }) {
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
              <span className="badge-unverified" title="Not in addresses.ts — treat with caution">
                unverified
              </span>
            )}
            <div className="mono muted" style={{ fontSize: "0.75rem" }}>
              {shortAddr(t.address)}
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
}: {
  h: TreasurySnapshot["holders"][number];
}) {
  const crypto = h.tokens.filter((t) => t.kind !== "stock");
  const stocks = h.tokens.filter((t) => t.kind === "stock");

  return (
    <div className="card-block holder-card">
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <strong>{h.holder.label}</strong>
        {isConfigured(h.holder.address) ? (
          <a
            href={explorerAddress(h.holder.address)}
            target="_blank"
            rel="noreferrer"
            className="mono muted"
          >
            {shortAddr(h.holder.address)}
          </a>
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
          <HoldingRows rows={crypto} />
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
              <HoldingRows rows={stocks} />
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
}: {
  data: TreasurySnapshot | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="panel">
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
      {!data?.holders.length ? (
        <p className="empty">Waiting for first fetch…</p>
      ) : (
        data.holders.map((h) => <HolderCard key={h.holder.key} h={h} />)
      )}

      <h3>PrizeVault inventory</h3>
      {!data?.prizeVault ? (
        <p className="empty">PrizeVault address not set in addresses.ts</p>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.prizeVault.inventory.length === 0 ? (
                <tr>
                  <td colSpan={2} className="muted">
                    Empty inventory
                  </td>
                </tr>
              ) : (
                data.prizeVault.inventory.map((row) => (
                  <tr key={row.asset}>
                    <td>
                      {row.symbol}{" "}
                      <span className="mono muted">{shortAddr(row.asset)}</span>
                    </td>
                    <td className="num">{fmtToken(row.balance, tokenDecimals(row.asset))}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <h3>Queued sweeps</h3>
          {data.prizeVault.sweeps.length === 0 ? (
            <p className="empty">No pending sweeps</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Asset → to</th>
                  <th>Status</th>
                  <th className="num">Countdown</th>
                </tr>
              </thead>
              <tbody>
                {data.prizeVault.sweeps.map((s) => (
                  <tr key={String(s.id)}>
                    <td className="mono">{String(s.id)}</td>
                    <td className="mono">
                      {shortAddr(s.asset)} → {shortAddr(s.to)}
                    </td>
                    <td className={s.status === "expired" ? "danger" : s.status === "ready" ? "ok" : "warn"}>
                      {s.status}
                    </td>
                    <td className="num">
                      {s.status === "queued"
                        ? `eta ${countdown(s.secondsToEta)}`
                        : s.status === "ready"
                          ? `expires ${countdown(s.secondsToExpiry)}`
                          : "re-queue"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h3>StakingVault</h3>
      {!data?.staking ? (
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
      {!data?.tickets ? (
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
      {!data?.vesting ? (
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
      {!data?.game ? (
        <p className="empty">ScratchGame address not set</p>
      ) : (
        <dl className="kv">
          <dt>randomness provider</dt>
          <dd>
            <a href={explorerAddress(data.game.randomness)} target="_blank" rel="noreferrer">
              {shortAddr(data.game.randomness)}
            </a>
          </dd>
          <dt>pending swap</dt>
          <dd>
            {data.game.swapStatus === "none" ? (
              "—"
            ) : (
              <span className={data.game.swapStatus === "expired" ? "danger" : "warn"}>
                {shortAddr(data.game.pendingRandomness)} ({data.game.swapStatus}
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
