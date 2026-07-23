/**
 * Known prize assets for ledger symbol / decimals.
 * Loaded from site/tokens.json (same source as the dashboard).
 * Unknown assets fall back to symbol=asset.slice(0,10) decimals=18.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_JSON = path.resolve(__dirname, "../../../site/tokens.json");

function loadTokenMap() {
  const raw = JSON.parse(fs.readFileSync(TOKENS_JSON, "utf8"));
  if (!Array.isArray(raw)) throw new Error("tokens.json must be an array");
  /** @type {Record<string, { symbol: string, decimals: number, price: string }>} */
  const map = {};
  for (const t of raw) {
    if (!t?.address || !t?.symbol) continue;
    const key = String(t.address).toLowerCase();
    map[key] = {
      // Stocks: prefer underlying ticker for brokerage-style ledger labels.
      symbol: (t.kind === "stock" && t.ticker ? t.ticker : t.symbol) || t.symbol,
      decimals: Number(t.decimals) || 18,
      price: t.price || "dex",
    };
  }
  return map;
}

export const TOKEN_MAP = loadTokenMap();

export const ZERO = "0x0000000000000000000000000000000000000000";

export function resolveToken(asset) {
  const key = (asset || "").toLowerCase();
  if (!key || key === ZERO) {
    return { symbol: "NO_WIN", decimals: 18, price: "none", address: ZERO };
  }
  const hit = TOKEN_MAP[key];
  if (hit) return { ...hit, address: key };
  return {
    symbol: key.slice(0, 10),
    decimals: 18,
    price: "dex",
    address: key,
  };
}

/** Scratch/ETH DexScreener pair (same as site + dashboard). */
export const SCRATCH_PAIR = {
  chainId: "robinhood",
  pairAddress: "0x3f66e1430c12a7a64839f43050165db6d1bf1ae5bd7df11e47a37a8e73bc00ef",
};
