/**
 * Alchemy Enhanced APIs (Transfers + token balances).
 *
 * Server: `ALCHEMY_RPC_URL` (never NEXT_PUBLIC_*).
 * Browser: proxies through `/api/alchemy/*` so the key stays off the client bundle.
 */
import { getAddress, type Address } from "viem";

export type AlchemyAssetTransfer = {
  from: string;
  to: string | null;
  hash: string;
  /** Hex raw amount (wei). */
  rawValue: bigint;
  contractAddress: Address | null;
  /** Unix seconds from Alchemy metadata (0 if missing). */
  blockTimestamp: number;
  /** Block number when known (0 if missing). */
  blockNumber: number;
};

export type AlchemyTokenBalance = {
  address: Address;
  balance: bigint;
};

type JsonRpcOk<T> = { jsonrpc: string; id: number; result: T; error?: undefined };
type JsonRpcErr = {
  jsonrpc: string;
  id: number;
  result?: undefined;
  error: { code: number; message: string };
};

function alchemyRpcUrl(): string {
  const url =
    process.env.ALCHEMY_RPC_URL?.trim() ||
    // Legacy alias: some ops shells still set RPC_URL to Alchemy.
    process.env.RPC_URL?.trim() ||
    "";
  if (!url) {
    throw new Error("ALCHEMY_RPC_URL is required for Alchemy Enhanced APIs");
  }
  return url;
}

async function alchemyRpc<T>(method: string, params: unknown[]): Promise<T> {
  if (typeof window !== "undefined") {
    throw new Error("Alchemy RPC must run on the server (use /api/alchemy/*)");
  }
  const res = await fetch(alchemyRpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Alchemy HTTP ${res.status}`);
  const data = (await res.json()) as JsonRpcOk<T> | JsonRpcErr;
  if (data.error) {
    throw new Error(`Alchemy ${method}: ${data.error.message}`);
  }
  return data.result;
}

function parseHexBigInt(hex: string | null | undefined): bigint {
  if (!hex || hex === "0x" || hex === "0x0") return 0n;
  try {
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

function parseHexNumber(hex: string | null | undefined): number {
  if (!hex) return 0;
  try {
    const n = Number(BigInt(hex));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function toHexBlock(block: string | number | undefined): string {
  if (block == null) return "0x0";
  if (typeof block === "string") {
    if (block.startsWith("0x") || block === "latest") return block;
    try {
      return `0x${BigInt(block).toString(16)}`;
    } catch {
      return "0x0";
    }
  }
  return `0x${BigInt(block).toString(16)}`;
}

type TransfersPage = {
  transfers: {
    from?: string;
    to?: string | null;
    hash?: string;
    blockNum?: string | null;
    rawContract?: { value?: string | null; address?: string | null };
    metadata?: { blockTimestamp?: string | null } | null;
  }[];
  pageKey?: string | null;
};

export type GetAssetTransfersOpts = {
  fromAddress?: Address;
  toAddress?: Address;
  contractAddresses?: Address[];
  /** Inclusive start block (hex or decimal). Default genesis. */
  fromBlock?: string | number;
  /** Max pages (1000 transfers each). Default 50. */
  maxPages?: number;
};

type TokenBalancesResult = {
  address?: string;
  tokenBalances?: {
    contractAddress?: string;
    tokenBalance?: string | null;
    error?: string | null;
  }[];
  pageKey?: string | null;
};

/** Soft TTL — avoid re-hitting Alchemy on every treasury poll. */
const TOKEN_BALANCES_TTL_MS = 300_000;
type BalCache = { at: number; tokens: AlchemyTokenBalance[] };
const tokenBalancesCache = new Map<string, BalCache>();

/** Server-only: paginated Transfers. */
export async function alchemyGetAssetTransfersDirect(
  opts: GetAssetTransfersOpts,
): Promise<AlchemyAssetTransfer[]> {
  const maxPages = opts.maxPages ?? 50;
  const out: AlchemyAssetTransfer[] = [];
  let pageKey: string | undefined;
  const fromBlock = toHexBlock(opts.fromBlock ?? "0x0");

  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, unknown> = {
      fromBlock,
      toBlock: "latest",
      category: ["erc20"],
      withMetadata: true,
      excludeZeroValue: true,
      maxCount: "0x3e8",
      order: "asc",
    };
    if (opts.fromAddress) params.fromAddress = opts.fromAddress;
    if (opts.toAddress) params.toAddress = opts.toAddress;
    if (opts.contractAddresses?.length) {
      params.contractAddresses = opts.contractAddresses;
    }
    if (pageKey) params.pageKey = pageKey;

    const result = await alchemyRpc<TransfersPage>("alchemy_getAssetTransfers", [params]);
    for (const t of result.transfers ?? []) {
      const raw = parseHexBigInt(t.rawContract?.value ?? undefined);
      if (raw === 0n) continue;
      let contractAddress: Address | null = null;
      if (t.rawContract?.address) {
        try {
          contractAddress = getAddress(t.rawContract.address);
        } catch {
          contractAddress = null;
        }
      }
      let blockTimestamp = 0;
      const iso = t.metadata?.blockTimestamp;
      if (iso) {
        const ms = Date.parse(iso);
        if (Number.isFinite(ms)) blockTimestamp = Math.floor(ms / 1000);
      }
      out.push({
        from: (t.from || "").toLowerCase(),
        to: t.to ? t.to.toLowerCase() : null,
        hash: t.hash || "",
        rawValue: raw,
        contractAddress,
        blockTimestamp,
        blockNumber: parseHexNumber(t.blockNum ?? undefined),
      });
    }

    if (!result.pageKey) break;
    pageKey = result.pageKey;
  }

  return out;
}

/** Server-only: nonzero ERC-20 balances. */
export async function alchemyGetTokenBalancesDirect(
  address: Address,
): Promise<AlchemyTokenBalance[]> {
  const key = address.toLowerCase();
  const cached = tokenBalancesCache.get(key);
  if (cached && Date.now() - cached.at < TOKEN_BALANCES_TTL_MS) {
    return cached.tokens;
  }

  const out: AlchemyTokenBalance[] = [];
  let pageKey: string | undefined;

  for (let page = 0; page < 20; page++) {
    const params: unknown[] = pageKey
      ? [address, "erc20", { pageKey }]
      : [address, "erc20"];
    const result = await alchemyRpc<TokenBalancesResult>("alchemy_getTokenBalances", params);

    for (const row of result.tokenBalances ?? []) {
      if (!row.contractAddress || row.error) continue;
      const balance = parseHexBigInt(row.tokenBalance ?? undefined);
      if (balance === 0n) continue;
      try {
        out.push({ address: getAddress(row.contractAddress), balance });
      } catch {
        /* skip bad address */
      }
    }

    if (!result.pageKey) break;
    pageKey = result.pageKey;
  }

  tokenBalancesCache.set(key, { at: Date.now(), tokens: out });
  return out;
}

function reviveTransfers(rows: unknown[]): AlchemyAssetTransfer[] {
  return rows.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      from: String(o.from || ""),
      to: o.to == null ? null : String(o.to),
      hash: String(o.hash || ""),
      rawValue: BigInt(String(o.rawValue ?? "0")),
      contractAddress: o.contractAddress
        ? (getAddress(String(o.contractAddress)) as Address)
        : null,
      blockTimestamp: Number(o.blockTimestamp) || 0,
      blockNumber: Number(o.blockNumber) || 0,
    };
  });
}

function reviveBalances(rows: unknown[]): AlchemyTokenBalance[] {
  return rows.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      address: getAddress(String(o.address)),
      balance: BigInt(String(o.balance ?? "0")),
    };
  });
}

/**
 * Paginated `alchemy_getAssetTransfers` (ERC-20). Pass either fromAddress or toAddress.
 * Browser calls go through `/api/alchemy/asset-transfers`.
 */
export async function alchemyGetAssetTransfers(
  opts: GetAssetTransfersOpts,
): Promise<AlchemyAssetTransfer[]> {
  if (typeof window !== "undefined") {
    const res = await fetch("/api/alchemy/asset-transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromAddress: opts.fromAddress,
        toAddress: opts.toAddress,
        contractAddresses: opts.contractAddresses,
        fromBlock: opts.fromBlock ?? "0x0",
        maxPages: opts.maxPages ?? 50,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `asset-transfers HTTP ${res.status}`);
    }
    const data = (await res.json()) as { transfers: unknown[] };
    return reviveTransfers(data.transfers ?? []);
  }
  return alchemyGetAssetTransfersDirect(opts);
}

/**
 * Non-zero ERC-20 balances via `alchemy_getTokenBalances`.
 * Cached ~5 min server-side. Browser calls go through `/api/alchemy/token-balances`.
 */
export async function alchemyGetTokenBalances(
  address: Address,
): Promise<AlchemyTokenBalance[]> {
  if (typeof window !== "undefined") {
    const res = await fetch("/api/alchemy/token-balances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `token-balances HTTP ${res.status}`);
    }
    const data = (await res.json()) as { tokens: unknown[] };
    return reviveBalances(data.tokens ?? []);
  }
  return alchemyGetTokenBalancesDirect(address);
}
