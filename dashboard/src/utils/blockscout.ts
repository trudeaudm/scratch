import { getAddress, type Address } from "viem";
import { BLOCKSCOUT_API, EXPLORER_BASE } from "../config/addresses";

export type DiscoveredToken = {
  address: Address;
  symbol: string;
  decimals: number;
  /** Raw balance string from Blockscout (integer wei). */
  balance: bigint;
};

type BlockscoutTokenRow = {
  contractAddress?: string;
  tokenName?: string;
  symbol?: string;
  decimals?: string | number;
  balance?: string;
};

/**
 * Fetch all ERC-20 holdings for an address via Blockscout account/tokenlist.
 * Throws on HTTP / API errors so callers can fall back to config-only.
 */
export async function fetchBlockscoutTokenList(address: Address): Promise<DiscoveredToken[]> {
  const url = `${BLOCKSCOUT_API}?module=account&action=tokenlist&address=${address}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Blockscout HTTP ${res.status}`);

  const data = (await res.json()) as {
    status?: string;
    message?: string;
    result?: BlockscoutTokenRow[] | string | null;
  };

  // Blockscout returns status "0" with message "No token transfers found" / empty — treat as empty list.
  if (!data.result || typeof data.result === "string") {
    if (data.status === "0") return [];
    throw new Error(data.message || "Blockscout tokenlist failed");
  }

  const out: DiscoveredToken[] = [];
  for (const row of data.result) {
    if (!row.contractAddress) continue;
    let addr: Address;
    try {
      addr = getAddress(row.contractAddress);
    } catch {
      continue;
    }
    const decimals = Number(row.decimals ?? 18);
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) continue;
    let balance = 0n;
    try {
      balance = BigInt(row.balance ?? "0");
    } catch {
      continue;
    }
    out.push({
      address: addr,
      symbol: (row.symbol || "???").slice(0, 32),
      decimals,
      balance,
    });
  }
  return out;
}

export type BlockscoutTokenFacts = {
  holdersCount: number | null;
  sourceVerified: boolean | null;
  /** ISO timestamp of contract creation when available. */
  createdAt: string | null;
  /** Human age label, e.g. "42d" — null when unknown. */
  ageLabel: string | null;
  warning: string | null;
};

function ageLabelFromUnix(sec: number): string {
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  const days = Math.floor(ageSec / 86_400);
  if (days >= 365) {
    const y = Math.floor(days / 365);
    const rem = days % 365;
    return rem > 30 ? `${y}y ${Math.floor(rem / 30)}mo` : `${y}y`;
  }
  if (days >= 30) return `${Math.floor(days / 30)}mo`;
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ageSec / 3600);
  return hours >= 1 ? `${hours}h` : "<1h";
}

/**
 * Holder count, source verification, and token age from Blockscout (best-effort).
 */
export async function fetchBlockscoutTokenFacts(address: Address): Promise<BlockscoutTokenFacts> {
  const addr = getAddress(address);
  let holdersCount: number | null = null;
  let sourceVerified: boolean | null = null;
  let createdAt: string | null = null;
  let ageLabel: string | null = null;
  const errors: string[] = [];

  try {
    const res = await fetch(`${EXPLORER_BASE}/api/v2/tokens/${addr}`);
    if (res.ok) {
      const data = (await res.json()) as { holders_count?: string | number };
      const n = Number(data.holders_count);
      if (Number.isFinite(n)) holdersCount = n;
    } else {
      errors.push(`tokens ${res.status}`);
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "tokens fetch failed");
  }

  try {
    const res = await fetch(`${EXPLORER_BASE}/api/v2/smart-contracts/${addr}`);
    if (res.ok) {
      const data = (await res.json()) as {
        is_verified?: boolean;
        verified_at?: string | null;
      };
      sourceVerified = Boolean(data.is_verified);
      if (!createdAt && data.verified_at) {
        createdAt = data.verified_at;
        const t = Date.parse(data.verified_at);
        if (Number.isFinite(t)) ageLabel = ageLabelFromUnix(Math.floor(t / 1000));
      }
    } else if (res.status === 404) {
      sourceVerified = false;
    } else {
      errors.push(`smart-contracts ${res.status}`);
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "smart-contracts fetch failed");
  }

  try {
    const url = `${BLOCKSCOUT_API}?module=contract&action=getcontractcreation&contractaddresses=${addr}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as {
        status?: string;
        result?: { timestamp?: string; txHash?: string }[] | string | null;
      };
      const row = Array.isArray(data.result) ? data.result[0] : null;
      if (row?.timestamp) {
        const sec = Number(row.timestamp);
        if (Number.isFinite(sec) && sec > 0) {
          createdAt = new Date(sec * 1000).toISOString();
          ageLabel = ageLabelFromUnix(sec);
        }
      }
    }
  } catch {
    /* age optional */
  }

  return {
    holdersCount,
    sourceVerified,
    createdAt,
    ageLabel,
    warning: errors.length ? errors.join("; ") : null,
  };
}
