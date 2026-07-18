/**
 * Known prize assets for ledger symbol / decimals.
 * Addresses lowercase. Unknown assets fall back to symbol=asset.slice(0,10) decimals=18.
 */
export const TOKEN_MAP = {
  "0xf5e5f4d3c34a14b2fdfd59584fe555cd5e21f196": {
    symbol: "SCRATCH",
    decimals: 18,
    price: "scratch",
  },
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": {
    symbol: "USDG",
    decimals: 6,
    price: "usdg",
  },
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": {
    symbol: "WETH",
    decimals: 18,
    price: "dex",
  },
  "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea": {
    symbol: "SPCX",
    decimals: 18,
    price: "dex",
  },
};

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
