import type { Address } from "viem";
import { getAddress } from "viem";

/** Extract a human-readable message from viem/wagmi/wallet errors (never empty). */
export function formatWriteError(e: unknown): string {
  if (e == null) return "Unknown write error";
  if (typeof e === "string") return e.trim() || "Unknown write error";
  if (typeof e === "object") {
    const o = e as {
      shortMessage?: unknown;
      message?: unknown;
      details?: unknown;
      cause?: unknown;
      walk?: (cb: (err: unknown) => boolean) => unknown;
    };
    // viem BaseError.walk → deepest shortMessage
    if (typeof o.walk === "function") {
      try {
        let found: string | null = null;
        o.walk((err) => {
          if (err && typeof err === "object") {
            const sm = (err as { shortMessage?: unknown }).shortMessage;
            if (typeof sm === "string" && sm.trim()) {
              found = sm.trim();
              return true;
            }
          }
          return false;
        });
        if (found) return found;
      } catch {
        /* fall through */
      }
    }
    if (typeof o.shortMessage === "string" && o.shortMessage.trim()) {
      return o.shortMessage.trim();
    }
    if (typeof o.message === "string" && o.message.trim()) {
      return o.message.trim();
    }
    if (typeof o.details === "string" && o.details.trim()) {
      return o.details.trim();
    }
    if (o.cause != null && o.cause !== e) {
      const nested = formatWriteError(o.cause);
      if (nested !== "Unknown write error") return nested;
    }
  }
  if (e instanceof Error && e.message.trim()) return e.message.trim();
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function accountMismatchMessage(expectedRole: string): string {
  return `connected wallet changed — reconnect as ${expectedRole}`;
}

type EthProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

/** Live active account from window.ethereum (not wagmi cache). */
export async function readActiveAccount(): Promise<Address | null> {
  if (typeof window === "undefined") return null;
  const provider = (window as unknown as { ethereum?: EthProvider }).ethereum;
  if (!provider) return null;
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    if (!accounts?.length) return null;
    return getAddress(accounts[0] as Address);
  } catch {
    return null;
  }
}

/**
 * Compare the wallet's current active account to the session's captured account.
 * Returns an error string, or null when the write may proceed.
 */
export async function assertSessionAccount(opts: {
  expectedRole: string;
  sessionAccount: Address | null | undefined;
  /** Wagmi/react cached address, checked separately from the live provider. */
  wagmiAddress?: Address | null;
}): Promise<{ ok: true; account: Address } | { ok: false; error: string }> {
  const { expectedRole, sessionAccount, wagmiAddress } = opts;
  if (!sessionAccount) {
    return {
      ok: false,
      error: `Wallet session missing — reconnect as ${expectedRole}`,
    };
  }
  const active = await readActiveAccount();
  if (!active) {
    return {
      ok: false,
      error: `No active account — reconnect as ${expectedRole}`,
    };
  }
  if (active.toLowerCase() !== sessionAccount.toLowerCase()) {
    return { ok: false, error: accountMismatchMessage(expectedRole) };
  }
  if (wagmiAddress && wagmiAddress.toLowerCase() !== sessionAccount.toLowerCase()) {
    return { ok: false, error: accountMismatchMessage(expectedRole) };
  }
  return { ok: true, account: active };
}
