/**
 * Prize symbol map — mirrors site/tokens.json (includes CASHCAT).
 * Unknown assets fall back to a short address prefix.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_JSON = path.resolve(__dirname, "../../../site/tokens.json");

const ZERO = "0x0000000000000000000000000000000000000000";

/** Seeded fallbacks if tokens.json is unavailable at boot. */
const FALLBACK = {
  "0xf5e5f4d3c34a14b2fdfd59584fe555cd5e21f196": {
    symbol: "SCRATCH",
    decimals: 18,
    kind: "crypto",
  },
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": {
    symbol: "USDG",
    decimals: 6,
    kind: "crypto",
  },
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": {
    symbol: "WETH",
    decimals: 18,
    kind: "crypto",
  },
  "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea": {
    symbol: "SPCX",
    decimals: 18,
    kind: "stock",
  },
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": {
    symbol: "NVDA",
    decimals: 18,
    kind: "stock",
  },
  "0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f": {
    symbol: "SLV",
    decimals: 18,
    kind: "stock",
  },
  "0x020bfc650a365f8bb26819deaabf3e21291018b4": {
    symbol: "CASHCAT",
    decimals: 18,
    kind: "crypto",
  },
  "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68": {
    symbol: "QQQ",
    decimals: 18,
    kind: "stock",
  },
};

function loadTokenMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKENS_JSON, "utf8"));
    if (!Array.isArray(raw)) return { ...FALLBACK };
    /** @type {Record<string, { symbol: string, decimals: number, kind: string }>} */
    const map = {};
    for (const t of raw) {
      if (!t?.address || !t?.symbol) continue;
      map[String(t.address).toLowerCase()] = {
        symbol: String(t.symbol),
        decimals: Number(t.decimals) || 18,
        kind: t.kind === "stock" ? "stock" : t.kind || "crypto",
      };
    }
    return Object.keys(map).length ? map : { ...FALLBACK };
  } catch {
    return { ...FALLBACK };
  }
}

export const TOKEN_MAP = loadTokenMap();
export { ZERO };

export function resolveToken(asset) {
  const key = (asset || "").toLowerCase();
  if (!key || key === ZERO) {
    return { symbol: "NO_WIN", decimals: 18, kind: "none", address: ZERO };
  }
  const hit = TOKEN_MAP[key];
  if (hit) return { ...hit, address: key };
  return {
    symbol: key.slice(0, 10),
    decimals: 18,
    kind: "other",
    address: key,
  };
}
