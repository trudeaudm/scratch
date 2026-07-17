"use client";

import { useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { zeroAddress, type Address, type Hash } from "viem";
import {
  contracts,
  explorerTx,
  isConfigured,
  tokens,
} from "@/config/addresses";
import { scratchGameAbiTyped } from "@/config/abis";
import { injected } from "@/utils/injected";
import { fmtToken, fmtUsd, shortAddr } from "@/utils/format";
import {
  TIER_LABELS,
  TIER_PREMIUM,
  TIER_STANDARD,
  annotateRows,
  assetLabel,
  blockingIssues,
  diffTables,
  editorToPrizeRows,
  formatOneInN,
  formatProbability,
  newEditorRow,
  prizeRowsToEditor,
  tableEvUsd,
  validatePrizeTable,
  type EditorRow,
  type PrizeRow,
  type TierId,
} from "@/utils/prizeTable";
import type { PriceMap } from "@/utils/prices";
import type { PrizeTableSnapshot, VaultAssetMeta } from "@/hooks/useTreasuryData";

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

function vaultMaps(vaultAssets: VaultAssetMeta[]) {
  const balances = new Map<string, bigint>();
  const coverage = vaultAssets.map((v) => ({
    asset: v.asset,
    vaultBalance: v.balance,
    fallbackRate: v.fallbackRate,
  }));
  for (const v of vaultAssets) balances.set(v.asset.toLowerCase(), v.balance);
  return { balances, coverage };
}

function RowTable({
  rows,
  prices,
  vaultAssets,
}: {
  rows: PrizeRow[];
  prices: PriceMap;
  vaultAssets: VaultAssetMeta[];
}) {
  const { balances } = vaultMaps(vaultAssets);
  const annotated = annotateRows(rows, balances, prices);
  const ev = tableEvUsd(annotated);

  if (rows.length === 0) {
    return <p className="empty">No prize table set</p>;
  }

  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Asset</th>
            <th>Payout</th>
            <th>Probability</th>
            <th className="num">EV share</th>
          </tr>
        </thead>
        <tbody>
          {annotated.map((a) => {
            const { symbol } = assetLabel(a.row.asset);
            const token = tokens.find(
              (t) => t.address.toLowerCase() === a.row.asset.toLowerCase(),
            );
            const decimals = token?.decimals ?? 18;
            let payoutLabel: string;
            if (a.row.asset === zeroAddress) {
              payoutLabel = "no-win";
            } else if (a.row.isBpsOfPool) {
              payoutLabel = `${a.row.amountOrBps.toString()} bps → ${fmtToken(a.payoutAmount, decimals)} now`;
            } else {
              payoutLabel = `${fmtToken(a.row.amountOrBps, decimals)} fixed`;
            }
            return (
              <tr key={a.index}>
                <td className="mono">{a.index}</td>
                <td>
                  <strong>{symbol}</strong>{" "}
                  {a.row.asset !== zeroAddress && (
                    <span className="mono muted">{shortAddr(a.row.asset)}</span>
                  )}
                </td>
                <td>
                  {payoutLabel}
                  {a.exceedsTenPercentVault && (
                    <span className="danger"> · &gt;10% vault</span>
                  )}
                </td>
                <td>
                  {formatProbability(a.probability)}
                  <span className="muted"> · {formatOneInN(a.oneInN)}</span>
                </td>
                <td className="num">{fmtUsd(a.payoutUsd != null ? a.probability * a.payoutUsd : null)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted" style={{ marginTop: 8 }}>
        Implied per-ticket EV: <strong className="mono">{fmtUsd(ev)}</strong>
      </p>
    </>
  );
}

export function PrizeTablesPanel({
  prizeTables,
  vaultAssets,
  prices,
  pendingCount,
  onRefresh,
}: {
  prizeTables: PrizeTableSnapshot[] | null;
  vaultAssets: VaultAssetMeta[];
  prices: PriceMap;
  pendingCount: number;
  onRefresh: () => void;
}) {
  const [tier, setTier] = useState<TierId>(TIER_STANDARD);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editorRows, setEditorRows] = useState<EditorRow[]>([]);
  const [bigPayoutAck, setBigPayoutAck] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { address, isConnected } = useAccount();
  const { connect, isPending: connecting } = useConnect();
  const { writeContractAsync, data: txHash, isPending: writing, reset } = useWriteContract();
  const { isLoading: waiting, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const current = prizeTables?.find((t) => t.tier === tier)?.rows ?? [];
  const { balances, coverage } = useMemo(() => vaultMaps(vaultAssets), [vaultAssets]);

  const draft = useMemo(() => {
    const { prizeRows, issues: parseIssues } = editorToPrizeRows(editorRows);
    const valIssues = validatePrizeTable(prizeRows, coverage);
    const issues = [...parseIssues, ...valIssues];
    const annotated = annotateRows(prizeRows, balances, prices);
    const needsBigAck = annotated.some((a) => a.exceedsTenPercentVault);
    return { prizeRows, issues, annotated, needsBigAck };
  }, [editorRows, coverage, balances, prices]);

  const diff = useMemo(
    () => (confirming ? diffTables(current, draft.prizeRows, balances, prices) : null),
    [confirming, current, draft.prizeRows, balances, prices],
  );

  function startEdit() {
    setErr(null);
    setBigPayoutAck(false);
    setConfirming(false);
    setEditorRows(
      current.length > 0
        ? prizeRowsToEditor(current)
        : [
            newEditorRow({ probabilityPercent: "10.000", amountInput: "1" }),
            newEditorRow({
              asset: zeroAddress,
              probabilityPercent: "90.000",
              amountInput: "0",
              isBpsOfPool: false,
            }),
          ],
    );
    setEditing(true);
  }

  function updateRow(id: string, patch: Partial<EditorRow>) {
    setEditorRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRow(id: string) {
    setEditorRows((rows) => rows.filter((r) => r.id !== id));
  }

  function addRow() {
    setEditorRows((rows) => [...rows, newEditorRow({ probabilityPercent: "0.001" })]);
  }

  function goConfirm() {
    setErr(null);
    const blocking = blockingIssues(draft.issues);
    if (blocking.length) {
      setErr(blocking.map((i) => i.message).join("; "));
      return;
    }
    setBigPayoutAck(false);
    setConfirming(true);
  }

  async function submit() {
    setErr(null);
    if (!isConfigured(contracts.scratchGame.address)) {
      setErr("ScratchGame address not set");
      return;
    }
    const blocking = blockingIssues(draft.issues);
    if (blocking.length) {
      setErr(blocking.map((i) => i.message).join("; "));
      return;
    }
    if (draft.needsBigAck && !bigPayoutAck) {
      setErr("Check the confirmation for rows exceeding 10% of vault balance");
      return;
    }

    const summaryRows = draft.prizeRows
      .map((r, i) => {
        const { symbol } = assetLabel(r.asset);
        return `#${i} ${symbol} cumOdds=${r.cumOdds}`;
      })
      .join(", ");

    // Plain-english summary already shown on confirm screen; open wallet.
    reset();
    try {
      await writeContractAsync({
        address: contracts.scratchGame.address,
        abi: scratchGameAbiTyped,
        functionName: "setPrizeTable",
        args: [
          tier,
          draft.prizeRows.map((r) => ({
            asset: r.asset,
            amountOrBps: r.amountOrBps,
            isBpsOfPool: r.isBpsOfPool,
            cumOdds: r.cumOdds,
          })),
        ],
      });
      setConfirming(false);
      setEditing(false);
      onRefresh();
      void summaryRows;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "setPrizeTable failed");
    }
  }

  const configuredAssets = tokens.filter((t) => isConfigured(t.address));
  const probSum = editorRows.reduce((s, r) => {
    const d = r.probabilityPercent.trim();
    if (!d) return s;
    const n = Number(d);
    return Number.isFinite(n) ? s + n : s;
  }, 0);

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Prize Tables</h2>
        <div className="row" style={{ marginBottom: 0 }}>
          {([TIER_STANDARD, TIER_PREMIUM] as TierId[]).map((t) => (
            <button
              key={t}
              type="button"
              className={tier === t ? "btn" : "btn ghost"}
              onClick={() => {
                setTier(t);
                setEditing(false);
                setConfirming(false);
              }}
            >
              {TIER_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="banner-danger" role="alert">
          <strong>{pendingCount} Pending</strong> scratch request
          {pendingCount === 1 ? "" : "s"} on ScratchGame — pending scratches will settle on the{" "}
          <strong>NEW</strong> table. Wait for fulfillment or rescue first.
        </div>
      )}

      {!prizeTables ? (
        <p className="empty">ScratchGame address not set in addresses.ts</p>
      ) : !editing ? (
        <>
          <RowTable rows={current} prices={prices} vaultAssets={vaultAssets} />
          <div className="row" style={{ marginTop: 12 }}>
            {!isConnected ? (
              <button
                type="button"
                className="btn secondary"
                disabled={connecting}
                onClick={() => connect({ connector: injected() })}
              >
                {connecting ? "Connecting…" : "Connect to edit"}
              </button>
            ) : (
              <button type="button" className="btn secondary" onClick={startEdit}>
                Edit {TIER_LABELS[tier]}
              </button>
            )}
            {isConnected && address && (
              <span className="mono muted">{shortAddr(address)}</span>
            )}
          </div>
        </>
      ) : confirming && diff ? (
        <>
          <h3>Confirm setPrizeTable — {TIER_LABELS[tier]}</h3>
          <div className="summary">
            You will sign:{" "}
            <strong>
              ScratchGame.setPrizeTable(tier={tier}, {draft.prizeRows.length} rows) replacing the
              current table.
            </strong>
          </div>

          <p>
            EV before: <span className="mono">{fmtUsd(diff.oldEv)}</span>
            {" → "}
            after: <span className="mono">{fmtUsd(diff.newEv)}</span>
          </p>

          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Change</th>
                <th>Old</th>
                <th>New</th>
              </tr>
            </thead>
            <tbody>
              {diff.rows.map((d) => {
                const fmt = (r?: PrizeRow, a?: { probability: number; payoutAmount: bigint }) => {
                  if (!r) return "—";
                  const { symbol } = assetLabel(r.asset);
                  const token = tokens.find(
                    (t) => t.address.toLowerCase() === r.asset.toLowerCase(),
                  );
                  const dec = token?.decimals ?? 18;
                  const pay =
                    r.asset === zeroAddress
                      ? "no-win"
                      : r.isBpsOfPool
                        ? `${r.amountOrBps} bps`
                        : fmtToken(r.amountOrBps, dec);
                  return `${symbol} ${pay} @ ${a ? formatProbability(a.probability) : "?"}`;
                };
                return (
                  <tr key={d.index} className={d.kind !== "same" ? "diff-changed" : undefined}>
                    <td className="mono">{d.index}</td>
                    <td className={d.kind === "changed" || d.kind === "added" || d.kind === "removed" ? "warn" : "muted"}>
                      {d.kind}
                    </td>
                    <td>{fmt(d.oldRow, d.oldAnnotated)}</td>
                    <td>{fmt(d.newRow, d.newAnnotated)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {draft.needsBigAck && (
            <label className="check-danger">
              <input
                type="checkbox"
                checked={bigPayoutAck}
                onChange={(e) => setBigPayoutAck(e.target.checked)}
              />
              I confirm one or more rows pay out more than <strong>10%</strong> of that asset&apos;s
              current PrizeVault balance.
            </label>
          )}

          <div className="row" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn"
              disabled={writing || waiting || (draft.needsBigAck && !bigPayoutAck)}
              onClick={() => void submit()}
            >
              {writing || waiting ? "Signing…" : "Confirm & open wallet"}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={writing}
              onClick={() => setConfirming(false)}
            >
              Back to editor
            </button>
          </div>
        </>
      ) : (
        <>
          <h3>Edit {TIER_LABELS[tier]}</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Enter human probabilities (must sum to <span className="mono">100.000%</span>). UI
            computes <span className="mono">cumOdds</span> (up to 4 decimal places). Current sum:{" "}
            <span className={Math.abs(probSum - 100) < 0.0005 ? "ok" : "danger mono"}>
              {probSum.toFixed(3)}%
            </span>
          </p>

          {draft.issues.map((i, idx) => (
            <p key={idx} className={i.blocking ? "err" : "warn"} style={{ margin: "4px 0" }}>
              {i.blocking ? "✗" : "⚠"} {i.message}
            </p>
          ))}

          {editorRows.map((r, i) => (
            <div key={r.id} className="card-block editor-row">
              <div className="row" style={{ marginBottom: 0 }}>
                <div className="field" style={{ maxWidth: 60 }}>
                  <label>#</label>
                  <div className="mono">{i}</div>
                </div>
                <div className="field">
                  <label>Asset</label>
                  <select
                    value={r.asset}
                    onChange={(e) =>
                      updateRow(r.id, {
                        asset: e.target.value as Address,
                        isBpsOfPool:
                          e.target.value === zeroAddress ? false : r.isBpsOfPool,
                      })
                    }
                  >
                    <option value={zeroAddress}>NO-WIN (terminal)</option>
                    {configuredAssets.map((t) => (
                      <option key={t.address} value={t.address}>
                        {t.symbol}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ maxWidth: 100 }}>
                  <label>bps?</label>
                  <select
                    value={r.isBpsOfPool ? "1" : "0"}
                    disabled={r.asset === zeroAddress}
                    onChange={(e) =>
                      updateRow(r.id, { isBpsOfPool: e.target.value === "1" })
                    }
                  >
                    <option value="0">Fixed</option>
                    <option value="1">bps of pool</option>
                  </select>
                </div>
                <div className="field">
                  <label>{r.isBpsOfPool ? "bps (0–10000)" : "Amount"}</label>
                  <input
                    className="mono"
                    value={r.amountInput}
                    disabled={r.asset === zeroAddress}
                    onChange={(e) => updateRow(r.id, { amountInput: e.target.value })}
                  />
                </div>
                <div className="field" style={{ maxWidth: 120 }}>
                  <label>Probability %</label>
                  <input
                    className="mono"
                    value={r.probabilityPercent}
                    onChange={(e) =>
                      updateRow(r.id, { probabilityPercent: e.target.value })
                    }
                    placeholder="10.000"
                  />
                </div>
                <button type="button" className="btn ghost" onClick={() => removeRow(r.id)}>
                  Remove
                </button>
              </div>
            </div>
          ))}

          <div className="row">
            <button type="button" className="btn ghost" onClick={addRow}>
              Add row
            </button>
            <button
              type="button"
              className="btn"
              disabled={blockingIssues(draft.issues).length > 0}
              onClick={goConfirm}
            >
              Review diff &amp; confirm
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setEditing(false);
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </div>

          {draft.prizeRows.length > 0 && (
            <>
              <h3>Preview</h3>
              <RowTable rows={draft.prizeRows} prices={prices} vaultAssets={vaultAssets} />
            </>
          )}
        </>
      )}

      {err && <p className="err">{err}</p>}
      {(writing || waiting) && <p className="muted">Confirm in wallet…</p>}
      {isSuccess && txHash && <TxResult hash={txHash} />}
    </section>
  );
}
