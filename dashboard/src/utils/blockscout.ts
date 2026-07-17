import { getAddress, type Address } from "viem";
import { BLOCKSCOUT_API } from "../config/addresses";

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
  const res = await fetch(url);
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
