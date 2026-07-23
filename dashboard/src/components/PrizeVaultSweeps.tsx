"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { injected } from "@/utils/injected";
import type { Address, Hash } from "viem";
import {
  contracts,
  explorerTx,
  isConfigured,
  sendTargets,
  writePanelTokens,
} from "@/config/addresses";
import { prizeVaultAbiTyped } from "@/config/abis";
import { countdown, fmtToken, shortAddr } from "@/utils/format";
import { CopyAddress } from "@/components/CopyAddress";
import type { PrizeVaultVitals, SweepRow } from "@/hooks/useTreasuryData";

type PendingAction =
  | {
      kind: "sweep";
      summary: string;
      vault: Address;
      asset: Address;
      to: Address;
    }
  | {
      kind: "executeSweep";
      summary: string;
      vault: Address;
      id: bigint;
    }
  | {
      kind: "cancelSweep";
      summary: string;
      vault: Address;
      id: bigint;
      symbol: string;
    };

function TxResult({ hash }: { hash?: Hash }) {
  if (!hash) return null;
  return (
    <p className="tx-link">
      Tx:{" "}
      <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="mono">
        {hash.slice(0, 10)}…{hash.slice(-8)}
      </a>
    </p>
  );
}

function formatEta(sec: number): string {
  try {
    return new Date(sec * 1000).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return `unix ${sec}`;
  }
}

function liveStatus(
  sweep: SweepRow,
  now: number,
  grace: number,
): { status: SweepRow["status"]; secondsToEta: number; secondsToExpiry: number } {
  const expiry = sweep.eta + grace;
  let status: SweepRow["status"] = "queued";
  if (now >= expiry) status = "expired";
  else if (now >= sweep.eta) status = "ready";
  return {
    status,
    secondsToEta: Math.max(0, sweep.eta - now),
    secondsToExpiry: Math.max(0, expiry - now),
  };
}

function labelFor(addr: Address): string {
  const hit = sendTargets.find((t) => t.address.toLowerCase() === addr.toLowerCase());
  return hit ? hit.label : shortAddr(addr);
}

function VaultSweepSection({
  vault,
  tokensEpoch,
  onRefresh,
}: {
  vault: PrizeVaultVitals;
  tokensEpoch: number;
  onRefresh: () => void;
}) {
  const { address, isConnected } = useAccount();
  const { connect, isPending: connecting } = useConnect();
  const { writeContractAsync, data: writeHash, isPending: writing, reset: resetWrite } =
    useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({
    hash: writeHash,
  });

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [confirmSymbol, setConfirmSymbol] = useState("");
  const [actionErr, setActionErr] = useState<string | null>(null);

  const saleTokens = useMemo(
    () => writePanelTokens(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tokensEpoch from parent
    [tokensEpoch],
  );
  const destinations = useMemo(
    () => sendTargets.filter((t) => isConfigured(t.address)),
    [],
  );

  const defaultAsset = saleTokens[0]?.symbol ?? "";
  const treasuryKey = contracts.treasury.key;
  const [sweepAsset, setSweepAsset] = useState(defaultAsset);
  const [sweepDestKey, setSweepDestKey] = useState(
    destinations.some((d) => d.key === treasuryKey)
      ? treasuryKey
      : (destinations[0]?.key ?? ""),
  );

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (saleTokens.length && !saleTokens.some((t) => t.symbol === sweepAsset)) {
      setSweepAsset(saleTokens[0].symbol);
    }
  }, [saleTokens, sweepAsset]);

  function clearPending() {
    setPending(null);
    setConfirmSymbol("");
    setActionErr(null);
  }

  function prepareQueue() {
    setActionErr(null);
    const token = saleTokens.find((t) => t.symbol === sweepAsset);
    if (!token) {
      setActionErr("Pick a configured token");
      return;
    }
    const dest = destinations.find((d) => d.key === sweepDestKey);
    if (!dest) {
      setActionErr("Pick a labeled destination");
      return;
    }
    if (!isConfigured(vault.config.address)) {
      setActionErr("PrizeVault address not set");
      return;
    }
    const eta = now + vault.sweepDelay;
    const expiry = eta + vault.sweepGrace;
    setPending({
      kind: "sweep",
      vault: vault.config.address,
      asset: token.address,
      to: dest.address,
      summary: `On ${vault.config.label} (${shortAddr(vault.config.address)}): queues a FULL-BALANCE sweep of ${token.symbol}, executable between ${formatEta(eta)} and ${formatEta(expiry)}; prizes keep paying meanwhile and the sweep delivers whatever balance remains at execution. Destination: ${dest.label} (${shortAddr(dest.address)}). Calls sweep(asset, to).`,
    });
  }

  function prepareExecute(sweep: SweepRow) {
    setActionErr(null);
    const live = liveStatus(sweep, now, vault.sweepGrace);
    if (live.status !== "ready") {
      setActionErr(
        live.status === "queued"
          ? `Execute opens in ${countdown(live.secondsToEta)}`
          : "Sweep expired — re-queue via Queue sweep",
      );
      return;
    }
    setPending({
      kind: "executeSweep",
      vault: vault.config.address,
      id: sweep.id,
      summary: `On ${vault.config.label}: executeSweep(#${String(sweep.id)}) — transfer the vault's FULL remaining ${sweep.symbol} balance to ${labelFor(sweep.to)} (${shortAddr(sweep.to)}). Window open until ${formatEta(sweep.eta + vault.sweepGrace)} (${countdown(live.secondsToExpiry)} left).`,
    });
  }

  function prepareCancel(sweep: SweepRow) {
    setActionErr(null);
    setConfirmSymbol("");
    setPending({
      kind: "cancelSweep",
      vault: vault.config.address,
      id: sweep.id,
      symbol: sweep.symbol,
      summary: `On ${vault.config.label}: cancelSweep(#${String(sweep.id)}) — drop the pending FULL-BALANCE ${sweep.symbol} sweep to ${labelFor(sweep.to)}. Type ${sweep.symbol} to confirm.`,
    });
  }

  async function confirmSign() {
    if (!pending || !address) return;
    if (pending.kind === "cancelSweep" && confirmSymbol !== pending.symbol) {
      setActionErr(`Type ${pending.symbol} to confirm cancel`);
      return;
    }
    setActionErr(null);
    resetWrite();
    try {
      if (pending.kind === "sweep") {
        await writeContractAsync({
          address: pending.vault,
          abi: prizeVaultAbiTyped,
          functionName: "sweep",
          args: [pending.asset, pending.to],
        });
      } else if (pending.kind === "executeSweep") {
        await writeContractAsync({
          address: pending.vault,
          abi: prizeVaultAbiTyped,
          functionName: "executeSweep",
          args: [pending.id],
        });
      } else {
        await writeContractAsync({
          address: pending.vault,
          abi: prizeVaultAbiTyped,
          functionName: "cancelSweep",
          args: [pending.id],
        });
      }
      setPending(null);
      setConfirmSymbol("");
      onRefresh();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "tx failed");
    }
  }

  const busy = writing || confirming;
  const cancelReady =
    pending?.kind === "cancelSweep" ? confirmSymbol === pending.symbol : true;

  return (
    <div className="vault-sweep-block">
      <h3>
        {vault.config.label}{" "}
        <span className="muted" style={{ fontWeight: 400, fontSize: "0.85rem" }}>
          <CopyAddress address={vault.config.address} />
        </span>
      </h3>

      <table className="table">
        <thead>
          <tr>
            <th>Asset</th>
            <th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          {vault.inventory.length === 0 ? (
            <tr>
              <td colSpan={2} className="muted">
                Empty inventory
              </td>
            </tr>
          ) : (
            vault.inventory.map((row) => (
              <tr key={row.asset}>
                <td>
                  {row.symbol} <CopyAddress address={row.asset} />
                </td>
                <td className="num">
                  {fmtToken(
                    row.balance,
                    saleTokens.find((t) => t.address.toLowerCase() === row.asset.toLowerCase())
                      ?.decimals ?? 18,
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h3>Queued sweeps</h3>
      {vault.sweeps.length === 0 ? (
        <p className="empty">No pending sweeps</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Asset → to</th>
              <th>Status</th>
              <th className="num">Countdown</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {vault.sweeps.map((s) => {
              const live = liveStatus(s, now, vault.sweepGrace);
              return (
                <tr key={String(s.id)}>
                  <td className="mono">{String(s.id)}</td>
                  <td>
                    <span className="token-sym">{s.symbol}</span>{" "}
                    <span className="mono">
                      <CopyAddress address={s.asset} /> → {labelFor(s.to)}{" "}
                      <CopyAddress address={s.to} />
                    </span>
                  </td>
                  <td
                    className={
                      live.status === "expired"
                        ? "danger"
                        : live.status === "ready"
                          ? "ok"
                          : "warn"
                    }
                  >
                    {live.status}
                  </td>
                  <td
                    className={`num ${live.status === "ready" ? "danger" : live.status === "queued" ? "warn" : "muted"}`}
                  >
                    {live.status === "queued"
                      ? `enable ${countdown(live.secondsToEta)}`
                      : live.status === "ready"
                        ? `expires ${countdown(live.secondsToExpiry)}`
                        : "re-queue"}
                  </td>
                  <td>
                    <div className="row" style={{ marginBottom: 0, gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-xs"
                        disabled={!isConnected || busy || live.status !== "ready"}
                        title={
                          live.status === "queued"
                            ? `Opens in ${countdown(live.secondsToEta)}`
                            : live.status === "expired"
                              ? "Expired — re-queue"
                              : "Execute within grace window"
                        }
                        onClick={() => prepareExecute(s)}
                      >
                        Execute
                      </button>
                      <button
                        type="button"
                        className="btn danger btn-xs"
                        disabled={!isConnected || busy}
                        onClick={() => prepareCancel(s)}
                      >
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3>Queue sweep</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Timelock {countdown(vault.sweepDelay)} · grace {countdown(vault.sweepGrace)} ·
        full balance at execution (prizes keep paying until then)
      </p>
      {!isConnected ? (
        <div className="row">
          <button
            type="button"
            className="btn secondary"
            disabled={connecting}
            onClick={() => connect({ connector: injected() })}
          >
            {connecting ? "Connecting…" : "Connect treasury wallet"}
          </button>
        </div>
      ) : null}
      <div className="row">
        <div className="field">
          <label>Asset</label>
          <select value={sweepAsset} onChange={(e) => setSweepAsset(e.target.value)}>
            {saleTokens.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Destination</label>
          <select value={sweepDestKey} onChange={(e) => setSweepDestKey(e.target.value)}>
            {destinations.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn secondary"
          disabled={!isConnected || busy || !saleTokens.length}
          onClick={prepareQueue}
        >
          Review queue
        </button>
      </div>

      {busy && (
        <p className="muted">{confirming ? "Waiting for confirmation…" : "Confirm in wallet…"}</p>
      )}
      {isSuccess && writeHash && <TxResult hash={writeHash} />}

      {pending && (
        <div className="summary">
          <div>
            You are about to sign: <strong>{pending.summary}</strong>
          </div>
          {pending.kind === "cancelSweep" && (
            <label style={{ display: "block", marginTop: 10 }}>
              Type <span className="mono">{pending.symbol}</span> to confirm
              <input
                value={confirmSymbol}
                onChange={(e) => setConfirmSymbol(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="mono"
                style={{ display: "block", marginTop: 4, width: "100%" }}
              />
            </label>
          )}
          <div className="row" style={{ marginTop: 12, marginBottom: 0 }}>
            <button
              type="button"
              className="btn"
              disabled={busy || !cancelReady}
              onClick={() => void confirmSign()}
            >
              Confirm &amp; open wallet
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={clearPending}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {actionErr && <p className="err">{actionErr}</p>}

      <h3>Sweep history</h3>
      {vault.history.length === 0 ? (
        <p className="empty">No SweepQueued / SweepExecuted / SweepCancelled in recent blocks</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Event</th>
              <th>ID</th>
              <th>Detail</th>
              <th>Tx</th>
            </tr>
          </thead>
          <tbody>
            {vault.history.map((h) => (
              <tr key={`${h.kind}-${String(h.id)}-${h.txHash}`}>
                <td
                  className={
                    h.kind === "SweepExecuted"
                      ? "ok"
                      : h.kind === "SweepCancelled"
                        ? "danger"
                        : "warn"
                  }
                >
                  {h.kind}
                </td>
                <td className="mono">{String(h.id)}</td>
                <td className="mono">
                  {h.kind === "SweepCancelled" ? (
                    "—"
                  ) : (
                    <>
                      {h.symbol ?? "?"}
                      {h.to ? (
                        <>
                          {" "}
                          → {labelFor(h.to)}
                        </>
                      ) : null}
                      {h.kind === "SweepQueued" && h.eta != null
                        ? ` · eta ${formatEta(h.eta)}`
                        : null}
                      {h.kind === "SweepExecuted" && h.amount != null
                        ? ` · ${fmtToken(
                            h.amount,
                            saleTokens.find(
                              (t) =>
                                h.asset &&
                                t.address.toLowerCase() === h.asset.toLowerCase(),
                            )?.decimals ?? 18,
                          )}`
                        : null}
                    </>
                  )}
                </td>
                <td>
                  <a
                    href={explorerTx(h.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                  >
                    {h.txHash.slice(0, 10)}…
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function PrizeVaultSweeps({
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
  if (loading && vaults.length === 0) {
    return <p className="empty">Loading…</p>;
  }
  if (vaults.length === 0) {
    return (
      <p className="empty">
        No PrizeVault address set in addresses.ts (v1 and/or v2)
      </p>
    );
  }
  return (
    <>
      {vaults.map((v) => (
        <VaultSweepSection
          key={v.config.key}
          vault={v}
          tokensEpoch={tokensEpoch}
          onRefresh={onRefresh}
        />
      ))}
    </>
  );
}
