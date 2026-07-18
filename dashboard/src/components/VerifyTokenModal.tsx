"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  http,
  type Address,
} from "viem";
import {
  explorerAddress,
  replaceVerifiedTokens,
  tokens,
  type TokenConfig,
  type TokenKind,
} from "@/config/addresses";
import { robinhoodChain } from "@/config/chain";
import { erc20AbiTyped } from "@/config/abis";
import { fetchBlockscoutTokenFacts, type BlockscoutTokenFacts } from "@/utils/blockscout";
import { fetchTokenDexPairs, type DexPairOption } from "@/utils/prices";
import { findSymbolConflicts, type SymbolConflict } from "@/utils/symbolConflict";
import { shortAddr } from "@/utils/format";

type OnChainMeta = {
  symbol: string;
  name: string;
  decimals: number;
};

function publicClient() {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(robinhoodChain.rpcUrls.default.http[0]),
  });
}

async function readOnChainMeta(address: Address): Promise<OnChainMeta> {
  const pc = publicClient();
  const [symbol, name, decimalsRaw] = await Promise.all([
    pc.readContract({ address, abi: erc20AbiTyped, functionName: "symbol" }) as Promise<string>,
    pc.readContract({ address, abi: erc20AbiTyped, functionName: "name" }) as Promise<string>,
    pc.readContract({ address, abi: erc20AbiTyped, functionName: "decimals" }) as Promise<
      number | bigint
    >,
  ]);
  const decimals = Number(decimalsRaw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Invalid decimals() from contract");
  }
  return { symbol: String(symbol), name: String(name), decimals };
}

export function VerifyTokenModal({
  address,
  onClose,
  onDone,
}: {
  address: Address;
  onClose: () => void;
  onDone: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<OnChainMeta | null>(null);
  const [facts, setFacts] = useState<BlockscoutTokenFacts | null>(null);
  const [pairs, setPairs] = useState<DexPairOption[]>([]);
  const [kind, setKind] = useState<TokenKind | "">("");
  const [ticker, setTicker] = useState("");
  const [pairKey, setPairKey] = useState("");
  const [confirmSymbol, setConfirmSymbol] = useState("");

  const conflicts: SymbolConflict[] = useMemo(() => {
    if (!meta) return [];
    return findSymbolConflicts(meta.symbol, address, tokens);
  }, [meta, address]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [m, f, p] = await Promise.all([
          readOnChainMeta(address),
          fetchBlockscoutTokenFacts(address),
          fetchTokenDexPairs(address),
        ]);
        if (cancelled) return;
        setMeta(m);
        setFacts(f);
        setPairs(p);
        if (p[0]) setPairKey(`${p[0].chainId}:${p[0].pairAddress}`);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load token");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

  async function submit() {
    if (!meta) return;
    setSaving(true);
    setError(null);
    try {
      const selected = pairs.find((p) => `${p.chainId}:${p.pairAddress}` === pairKey);
      const token: TokenConfig = {
        symbol: meta.symbol,
        address,
        decimals: meta.decimals,
        price: "dex",
        name: meta.name,
      };
      if (kind === "stock") {
        token.kind = "stock";
        token.ticker = ticker.trim() || meta.symbol;
      } else if (kind === "crypto") {
        token.kind = "crypto";
      }
      if (selected) {
        token.preferredPair = {
          chainId: selected.chainId,
          pairAddress: selected.pairAddress,
        };
      }

      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, confirmSymbol }),
      });
      const data = (await res.json()) as { tokens?: TokenConfig[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.tokens) replaceVerifiedTokens(data.tokens);
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = !!meta && confirmSymbol === meta.symbol && !saving;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="verify-token-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3 id="verify-token-title">Verify &amp; add</h3>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <p className="muted" style={{ marginTop: 0 }}>
          Promote{" "}
          <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="mono">
            {shortAddr(address)}
          </a>{" "}
          into committed <span className="mono">tokens.json</span>.
        </p>

        {loading && <p className="muted">Reading contract + Blockscout…</p>}
        {error && <p className="err">{error}</p>}

        {meta && (
          <>
            <dl className="kv">
              <dt>symbol</dt>
              <dd className="mono">{meta.symbol}</dd>
              <dt>name</dt>
              <dd>{meta.name}</dd>
              <dt>decimals</dt>
              <dd className="mono">{meta.decimals}</dd>
              <dt>address</dt>
              <dd className="mono" style={{ wordBreak: "break-all" }}>
                {address}
              </dd>
            </dl>
            <p className="muted" style={{ fontSize: "0.8rem" }}>
              On-chain fields are read-only — never typed by hand.
            </p>
          </>
        )}

        {facts && (
          <div className="summary" style={{ marginTop: 12 }}>
            <strong>Blockscout</strong>
            <dl className="kv" style={{ marginTop: 8, marginBottom: 0 }}>
              <dt>holders</dt>
              <dd>{facts.holdersCount != null ? facts.holdersCount.toLocaleString() : "—"}</dd>
              <dt>source verified</dt>
              <dd className={facts.sourceVerified ? "ok" : facts.sourceVerified === false ? "danger" : undefined}>
                {facts.sourceVerified == null ? "—" : facts.sourceVerified ? "yes" : "no"}
              </dd>
              <dt>token age</dt>
              <dd>
                {facts.ageLabel ?? "—"}
                {facts.createdAt ? (
                  <span className="muted" style={{ marginLeft: 6, fontSize: "0.75rem" }}>
                    ({new Date(facts.createdAt).toLocaleDateString()})
                  </span>
                ) : null}
              </dd>
            </dl>
            {facts.warning && (
              <p className="muted" style={{ marginBottom: 0, fontSize: "0.75rem" }}>
                Partial: {facts.warning}
              </p>
            )}
          </div>
        )}

        {conflicts.length > 0 && (
          <div className="banner-danger" role="alert">
            <strong>Duplicate / similar symbol</strong>
            <p style={{ margin: "8px 0 0" }}>
              A verified token already uses a same or confusingly similar symbol. Confirm you are not
              promoting a lookalike.
            </p>
            <table className="table" style={{ marginTop: 10, marginBottom: 0 }}>
              <thead>
                <tr>
                  <th>Existing</th>
                  <th>New</th>
                  <th>Match</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c) => (
                  <tr key={c.existing.address}>
                    <td>
                      <span className="token-sym">{c.existing.symbol}</span>
                      <div className="mono muted" style={{ fontSize: "0.75rem" }}>
                        {c.existing.address}
                      </div>
                    </td>
                    <td>
                      <span className="token-sym">{meta?.symbol}</span>
                      <div className="mono muted" style={{ fontSize: "0.75rem" }}>
                        {address}
                      </div>
                    </td>
                    <td>{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="row" style={{ marginTop: 14, flexWrap: "wrap", gap: 12 }}>
          <label>
            Kind (optional)
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as TokenKind | "")}
              style={{ display: "block", marginTop: 4, minWidth: 140 }}
            >
              <option value="">crypto (default)</option>
              <option value="crypto">crypto</option>
              <option value="stock">stock</option>
            </select>
          </label>
          {kind === "stock" && (
            <label>
              Ticker
              <input
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                placeholder={meta?.symbol ?? "AAPL"}
                style={{ display: "block", marginTop: 4, minWidth: 120 }}
              />
            </label>
          )}
        </div>

        <label style={{ display: "block", marginTop: 12 }}>
          Preferred DexScreener pair (optional)
          <select
            value={pairKey}
            onChange={(e) => setPairKey(e.target.value)}
            style={{ display: "block", marginTop: 4, width: "100%" }}
          >
            <option value="">None — best pair at price time</option>
            {pairs.map((p) => (
              <option key={`${p.chainId}:${p.pairAddress}`} value={`${p.chainId}:${p.pairAddress}`}>
                {p.label}
              </option>
            ))}
          </select>
          {pairs.length === 0 && !loading && (
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              No DexScreener pairs found for this address.
            </span>
          )}
        </label>

        <label style={{ display: "block", marginTop: 14 }}>
          Type <span className="mono">{meta?.symbol ?? "…"}</span> to confirm
          <input
            value={confirmSymbol}
            onChange={(e) => setConfirmSymbol(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            style={{ display: "block", marginTop: 4, width: "100%" }}
            disabled={!meta}
          />
        </label>

        <div className="row" style={{ marginTop: 16, marginBottom: 0 }}>
          <button type="button" className="btn" disabled={!canSubmit} onClick={() => void submit()}>
            {saving ? "Saving…" : "Add to verified"}
          </button>
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function RemoveVerifiedModal({
  token,
  onClose,
  onDone,
}: {
  token: { symbol: string; address: Address };
  onClose: () => void;
  onDone: () => void;
}) {
  const [confirmSymbol, setConfirmSymbol] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: token.address, confirmSymbol }),
      });
      const data = (await res.json()) as { tokens?: TokenConfig[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.tokens) replaceVerifiedTokens(data.tokens);
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-token-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3 id="remove-token-title">Remove from verified</h3>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p>
          Remove <strong>{token.symbol}</strong> (
          <span className="mono">{shortAddr(token.address)}</span>) from{" "}
          <span className="mono">tokens.json</span>. It will show as unverified if still held.
        </p>
        {error && <p className="err">{error}</p>}
        <label style={{ display: "block", marginTop: 12 }}>
          Type <span className="mono">{token.symbol}</span> to confirm
          <input
            value={confirmSymbol}
            onChange={(e) => setConfirmSymbol(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            style={{ display: "block", marginTop: 4, width: "100%" }}
          />
        </label>
        <div className="row" style={{ marginTop: 16, marginBottom: 0 }}>
          <button
            type="button"
            className="btn danger"
            disabled={confirmSymbol !== token.symbol || saving}
            onClick={() => void submit()}
          >
            {saving ? "Removing…" : "Remove"}
          </button>
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
