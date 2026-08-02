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

/** Soft TTL — avoid re-hitting Blockscout on every 30s dashboard poll. */
const TOKENLIST_TTL_MS = 120_000;
/** Minimum gap between Blockscout HTTP calls (shared queue). */
const MIN_GAP_MS = 400;
/** Retries after transient (non-429) failures. */
const MAX_RETRIES = 3;
/**
 * How long every Blockscout caller fails fast after a 429.
 * The public endpoint throttles per-IP, so per-request backoff just multiplies
 * the stall across holders — one shared cooldown is the only thing that helps.
 */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

type CacheEntry = { at: number; tokens: DiscoveredToken[] };
const tokenListCache = new Map<string, CacheEntry>();

let queue: Promise<void> = Promise.resolve();
let lastCallAt = 0;
let rateLimitedUntil = 0;

/** Thrown instead of issuing a request while the shared 429 cooldown is open. */
export class BlockscoutRateLimitError extends Error {
  constructor(msg = "Blockscout rate limited (HTTP 429)") {
    super(msg);
    this.name = "BlockscoutRateLimitError";
  }
}

/** True while Blockscout has us throttled and callers should skip the network. */
export function isBlockscoutRateLimited(): boolean {
  return Date.now() < rateLimitedUntil;
}

/** Seconds left on the shared cooldown, for surfacing in UI warnings. */
export function blockscoutCooldownSeconds(): number {
  return Math.max(0, Math.ceil((rateLimitedUntil - Date.now()) / 1000));
}

function tripRateLimit(): void {
  rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Blockscout accepts an optional API key that raises the per-IP limit. */
function withApiKey(url: string): string {
  const key = process.env.NEXT_PUBLIC_BLOCKSCOUT_API_KEY;
  if (!key) return url;
  return `${url}${url.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(key)}`;
}

/**
 * Serialize Blockscout HTTP so parallel holders / panels don't stampede into 429.
 * Throws {@link BlockscoutRateLimitError} without hitting the network while the
 * shared cooldown is open, and opens that cooldown whenever a 429 comes back.
 */
export async function blockscoutFetch(url: string, timeoutMs = 12_000): Promise<Response> {
  if (isBlockscoutRateLimited()) throw new BlockscoutRateLimitError();

  const run = queue.then(async () => {
    if (isBlockscoutRateLimited()) throw new BlockscoutRateLimitError();
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCallAt));
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const res = await fetch(withApiKey(url), { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) tripRateLimit();
    return res;
  });
  // Keep the queue alive even if this call rejects.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function parseTokenListPayload(data: {
  status?: string;
  message?: string;
  result?: BlockscoutTokenRow[] | string | null;
}): DiscoveredToken[] {
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

/**
 * Fetch all ERC-20 holdings for an address via Blockscout account/tokenlist.
 * Cached + rate-limited. On 429 after retries, returns last good cache when present
 * (throws only when there is nothing to fall back to).
 */
export async function fetchBlockscoutTokenList(address: Address): Promise<DiscoveredToken[]> {
  const key = address.toLowerCase();
  const cached = tokenListCache.get(key);
  if (cached && Date.now() - cached.at < TOKENLIST_TTL_MS) {
    return cached.tokens;
  }

  const url = `${BLOCKSCOUT_API}?module=account&action=tokenlist&address=${address}`;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await blockscoutFetch(url);
      if (res.status === 429) {
        // Cooldown is already open; retrying here only delays the caller.
        lastErr = new BlockscoutRateLimitError();
        break;
      }
      if (!res.ok) throw new Error(`Blockscout HTTP ${res.status}`);

      const data = (await res.json()) as {
        status?: string;
        message?: string;
        result?: BlockscoutTokenRow[] | string | null;
      };
      const tokens = parseTokenListPayload(data);
      tokenListCache.set(key, { at: Date.now(), tokens });
      return tokens;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error("Blockscout tokenlist failed");
      if (lastErr instanceof BlockscoutRateLimitError) break;
      if (attempt < MAX_RETRIES - 1) await sleep(1_000 * 2 ** attempt);
    }
  }

  // Stale cache is better than blank discovery after a rate-limit storm.
  if (cached) return cached.tokens;
  throw lastErr ?? new Error("Blockscout tokenlist failed");
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
    const res = await blockscoutFetch(`${EXPLORER_BASE}/api/v2/tokens/${addr}`);
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
    const res = await blockscoutFetch(`${EXPLORER_BASE}/api/v2/smart-contracts/${addr}`);
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
    const res = await blockscoutFetch(url);
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
