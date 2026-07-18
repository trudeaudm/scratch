"use client";

import { useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useWriteContract,
  useSendTransaction,
  useWaitForTransactionReceipt,
} from "wagmi";
import { injected } from "@/utils/injected";
import { isAddress, parseEther, type Address, type Hash } from "viem";
import {
  contracts,
  explorerTx,
  isConfigured,
  sendTargets,
  tokens,
  writePanelTokens,
} from "@/config/addresses";
import {
  erc20AbiTyped,
  prizeVaultAbiTyped,
  standardTicketSourceAbiTyped,
  vestingWalletAbiTyped,
} from "@/config/abis";
import { fmtToken, parseAmount, shortAddr } from "@/utils/format";
import type { TicketSourceVitals } from "@/hooks/useTreasuryData";

type FundStep = "idle" | "approve" | "fund" | "done";

type PendingAction =
  | {
      kind: "fund";
      summary: string;
      token: (typeof tokens)[number];
      amount: bigint;
    }
  | {
      kind: "sendEth";
      summary: string;
      to: Address;
      value: bigint;
    }
  | {
      kind: "sendToken";
      summary: string;
      token: (typeof tokens)[number];
      to: Address;
      amount: bigint;
    }
  | {
      kind: "release";
      summary: string;
      token: Address;
    }
  | {
      kind: "grant";
      summary: string;
      users: Address[];
      amountEach: bigint;
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

function parseAddresses(raw: string): { addresses: Address[]; error: string | null } {
  const parts = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const addresses: Address[] = [];
  for (const p of parts) {
    if (!isAddress(p)) {
      return { addresses: [], error: `Invalid address: ${p}` };
    }
    const lower = p.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    addresses.push(p as Address);
  }
  if (addresses.length === 0) return { addresses: [], error: "Enter at least one address" };
  return { addresses, error: null };
}

export function WritePanel({ tickets }: { tickets: TicketSourceVitals | null }) {
  const { address, isConnected } = useAccount();
  const { connect, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const publicClient = usePublicClient();

  const { writeContractAsync, data: writeHash, isPending: writing, reset: resetWrite } =
    useWriteContract();
  const { sendTransactionAsync, data: sendHash, isPending: sending, reset: resetSend } =
    useSendTransaction();

  const lastHash = writeHash ?? sendHash;
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({
    hash: lastHash,
  });

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [fundStep, setFundStep] = useState<FundStep>("idle");

  const [fundToken, setFundToken] = useState(tokens[0]?.symbol ?? "SCRATCH");
  const [fundAmount, setFundAmount] = useState("");
  const [sendAsset, setSendAsset] = useState<"ETH" | string>("ETH");
  const [sendTargetKey, setSendTargetKey] = useState(sendTargets[0]?.key ?? "");
  const [sendAmount, setSendAmount] = useState("");
  const [grantAddrs, setGrantAddrs] = useState("");
  const [grantEach, setGrantEach] = useState("1");

  const configuredTokens = useMemo(() => writePanelTokens(), []);
  const configuredTargets = useMemo(
    () => sendTargets.filter((t) => isConfigured(t.address)),
    [],
  );

  const grantPreview = useMemo(() => {
    if (!grantAddrs.trim()) return { error: null as string | null, total: null as bigint | null, count: 0 };
    const { addresses, error } = parseAddresses(grantAddrs);
    const each = parseAmount(grantEach, 18);
    if (error) return { error, total: null, count: 0 };
    if (each === null) return { error: "Invalid amountEach", total: null, count: 0 };
    return { error: null, total: each * BigInt(addresses.length), count: addresses.length, addresses, each };
  }, [grantAddrs, grantEach]);

  /** Prefer on-chain ERC-20 decimals(); fall back to addresses.ts (never hardcode 18). */
  async function resolveTokenDecimals(token: (typeof tokens)[number]): Promise<number> {
    if (publicClient) {
      try {
        const onChain = (await publicClient.readContract({
          address: token.address,
          abi: erc20AbiTyped,
          functionName: "decimals",
        })) as number | bigint;
        const n = Number(onChain);
        if (Number.isInteger(n) && n >= 0 && n <= 36) return n;
      } catch {
        /* use config */
      }
    }
    return token.decimals;
  }

  function clearPending() {
    setPending(null);
    setActionErr(null);
  }

  async function prepareFund() {
    setActionErr(null);
    const token = configuredTokens.find((t) => t.symbol === fundToken);
    if (!token) {
      setActionErr("Configure the token in addresses.ts");
      return;
    }
    if (!isConfigured(contracts.prizeVault.address)) {
      setActionErr("PrizeVault address not set");
      return;
    }
    const decimals = await resolveTokenDecimals(token);
    const amount = parseAmount(fundAmount, decimals);
    if (amount === null || amount === 0n) {
      setActionErr(`Enter a valid amount (${decimals} decimals)`);
      return;
    }
    setPending({
      kind: "fund",
      token,
      amount,
      summary: `Approve ${fundAmount.trim()} ${token.symbol} (${decimals} dp → ${amount.toString()} raw) for PrizeVault (${shortAddr(contracts.prizeVault.address)}), then call fund(asset=${shortAddr(token.address)}, amount=${amount.toString()}).`,
    });
  }

  async function prepareSend() {
    setActionErr(null);
    const target = configuredTargets.find((t) => t.key === sendTargetKey);
    if (!target) {
      setActionErr("Pick a configured destination");
      return;
    }
    if (sendAsset === "ETH") {
      try {
        const value = parseEther(sendAmount.trim() || "0");
        if (value === 0n) {
          setActionErr("Enter a valid ETH amount");
          return;
        }
        setPending({
          kind: "sendEth",
          to: target.address,
          value,
          summary: `Send ${sendAmount.trim()} native ETH to ${target.label} (${shortAddr(target.address)}).`,
        });
      } catch {
        setActionErr("Invalid ETH amount");
      }
      return;
    }
    const token = configuredTokens.find((t) => t.symbol === sendAsset);
    if (!token) {
      setActionErr("Unknown token");
      return;
    }
    const decimals = await resolveTokenDecimals(token);
    const amount = parseAmount(sendAmount, decimals);
    if (amount === null || amount === 0n) {
      setActionErr(`Enter a valid amount (${decimals} decimals)`);
      return;
    }
    setPending({
      kind: "sendToken",
      token,
      to: target.address,
      amount,
      summary: `ERC-20 transfer ${sendAmount.trim()} ${token.symbol} (${decimals} dp → ${amount.toString()} raw) to ${target.label} (${shortAddr(target.address)}).`,
    });
  }

  function prepareRelease() {
    setActionErr(null);
    const scratch = tokens.find((t) => t.symbol === "SCRATCH");
    if (!scratch || !isConfigured(scratch.address) || !isConfigured(contracts.vestingWallet.address)) {
      setActionErr("VestingWallet / SCRATCH not configured");
      return;
    }
    setPending({
      kind: "release",
      token: scratch.address,
      summary: `Call VestingWallet.release(${scratch.symbol}) on ${shortAddr(contracts.vestingWallet.address)} — transfers currently releasable vested tokens to the wallet beneficiary.`,
    });
  }

  function prepareGrant() {
    setActionErr(null);
    if (!isConfigured(contracts.standardTicketSource.address)) {
      setActionErr("StandardTicketSource not configured");
      return;
    }
    const { addresses, error } = parseAddresses(grantAddrs);
    if (error) {
      setActionErr(error);
      return;
    }
    const each = parseAmount(grantEach, 18);
    if (each === null || each === 0n) {
      setActionErr("Invalid amountEach");
      return;
    }
    const total = each * BigInt(addresses.length);
    if (tickets && total > tickets.remaining) {
      setActionErr(
        `Over daily cap: need ${fmtToken(total, 18)}, remaining ${fmtToken(tickets.remaining, 18)}`,
      );
      return;
    }
    setPending({
      kind: "grant",
      users: addresses,
      amountEach: each,
      summary: `Call StandardTicketSource.grant with ${addresses.length} address(es) × ${fmtToken(each, 18)} tickets each (total ${fmtToken(total, 18)}). Remaining daily allowance after: ${tickets ? fmtToken(tickets.remaining - total, 18) : "unknown"}.`,
    });
  }

  async function confirmSign() {
    if (!pending || !address) return;
    setActionErr(null);
    resetWrite();
    resetSend();
    try {
      if (pending.kind === "fund") {
        if (!publicClient) throw new Error("No public client");
        setFundStep("approve");
        const allowance = (await publicClient.readContract({
          address: pending.token.address,
          abi: erc20AbiTyped,
          functionName: "allowance",
          args: [address, contracts.prizeVault.address],
        })) as bigint;
        if (allowance < pending.amount) {
          await writeContractAsync({
            address: pending.token.address,
            abi: erc20AbiTyped,
            functionName: "approve",
            args: [contracts.prizeVault.address, pending.amount],
          });
        }
        setFundStep("fund");
        await writeContractAsync({
          address: contracts.prizeVault.address,
          abi: prizeVaultAbiTyped,
          functionName: "fund",
          args: [pending.token.address, pending.amount],
        });
        setFundStep("done");
      } else if (pending.kind === "sendEth") {
        await sendTransactionAsync({ to: pending.to, value: pending.value });
      } else if (pending.kind === "sendToken") {
        await writeContractAsync({
          address: pending.token.address,
          abi: erc20AbiTyped,
          functionName: "transfer",
          args: [pending.to, pending.amount],
        });
      } else if (pending.kind === "release") {
        await writeContractAsync({
          address: contracts.vestingWallet.address,
          abi: vestingWalletAbiTyped,
          functionName: "release",
          args: [pending.token],
        });
      } else if (pending.kind === "grant") {
        await writeContractAsync({
          address: contracts.standardTicketSource.address,
          abi: standardTicketSourceAbiTyped,
          functionName: "grant",
          args: [pending.users, pending.amountEach],
        });
      }
      setPending(null);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "tx failed");
      setFundStep("idle");
    }
  }

  const busy = writing || sending || confirming;

  return (
    <section className="panel">
      <h2>Write</h2>

      <div className="row" style={{ marginBottom: 16 }}>
        {isConnected ? (
          <>
            <span className="mono muted">{address ? shortAddr(address) : ""}</span>
            <button type="button" className="btn secondary" onClick={() => disconnect()}>
              Disconnect
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={connecting}
            onClick={() => connect({ connector: injected() })}
          >
            {connecting ? "Connecting…" : "Connect treasury wallet"}
          </button>
        )}
      </div>

      {busy && (
        <p className="muted">{confirming ? "Waiting for confirmation…" : "Confirm in wallet…"}</p>
      )}
      {isSuccess && lastHash && <TxResult hash={lastHash} />}

      {pending && (
        <div className="summary">
          <div>
            You are about to sign: <strong>{pending.summary}</strong>
          </div>
          {pending.kind === "fund" && (
            <div className="steps" style={{ marginTop: 10 }}>
              <span className={fundStep === "approve" ? "active" : fundStep === "fund" || fundStep === "done" ? "done" : ""}>
                1. Approve
              </span>
              <span className={fundStep === "fund" ? "active" : fundStep === "done" ? "done" : ""}>
                2. Fund
              </span>
            </div>
          )}
          <div className="row" style={{ marginTop: 12, marginBottom: 0 }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void confirmSign()}>
              Confirm &amp; open wallet
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={clearPending}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {actionErr && <p className="err">{actionErr}</p>}

      <h3>Fund PrizeVault</h3>
      <div className="row">
        <div className="field">
          <label>Token</label>
          <select value={fundToken} onChange={(e) => setFundToken(e.target.value)}>
            {(configuredTokens.length ? configuredTokens : tokens).map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Amount</label>
          <input
            value={fundAmount}
            onChange={(e) => setFundAmount(e.target.value)}
            placeholder="0.0"
            className="mono"
          />
        </div>
        <button type="button" className="btn secondary" disabled={!isConnected || busy} onClick={prepareFund}>
          Review fund
        </button>
      </div>

      <h3>Send to contract</h3>
      <div className="row">
        <div className="field">
          <label>Asset</label>
          <select value={sendAsset} onChange={(e) => setSendAsset(e.target.value)}>
            <option value="ETH">ETH</option>
            {(configuredTokens.length ? configuredTokens : tokens).map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Destination</label>
          <select value={sendTargetKey} onChange={(e) => setSendTargetKey(e.target.value)}>
            {(configuredTargets.length ? configuredTargets : sendTargets).map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Amount</label>
          <input
            value={sendAmount}
            onChange={(e) => setSendAmount(e.target.value)}
            placeholder="0.0"
            className="mono"
          />
        </div>
        <button type="button" className="btn secondary" disabled={!isConnected || busy} onClick={prepareSend}>
          Review send
        </button>
      </div>

      <h3>Release vested tokens</h3>
      <div className="row">
        <button type="button" className="btn secondary" disabled={!isConnected || busy} onClick={prepareRelease}>
          Review release(SCRATCH)
        </button>
      </div>

      <h3>Grant tickets</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Remaining daily allowance:{" "}
        <span className="mono">
          {tickets ? fmtToken(tickets.remaining, 18) : "—"} /{" "}
          {tickets ? fmtToken(tickets.grantDailyCap, 18) : "—"}
        </span>
      </p>
      <div className="field" style={{ marginBottom: 10 }}>
        <label>Addresses (one per line, comma, or space — deduped)</label>
        <textarea
          value={grantAddrs}
          onChange={(e) => setGrantAddrs(e.target.value)}
          placeholder={"0xabc…\n0xdef…"}
        />
      </div>
      <div className="row">
        <div className="field">
          <label>amountEach (tickets)</label>
          <input value={grantEach} onChange={(e) => setGrantEach(e.target.value)} className="mono" />
        </div>
        <button
          type="button"
          className="btn secondary"
          disabled={
            !isConnected ||
            busy ||
            !!grantPreview.error ||
            !grantPreview.total ||
            (tickets != null &&
              grantPreview.total != null &&
              grantPreview.total > tickets.remaining)
          }
          onClick={prepareGrant}
        >
          Review grant
        </button>
      </div>
      {grantPreview.total != null && (
        <p className="muted">
          Batch total: <span className="mono">{fmtToken(grantPreview.total, 18)}</span> tickets to{" "}
          {grantPreview.count} wallets
          {tickets && grantPreview.total > tickets.remaining ? (
            <span className="danger"> — over remaining cap (blocked)</span>
          ) : null}
        </p>
      )}
      {grantPreview.error && <p className="err">{grantPreview.error}</p>}
    </section>
  );
}
