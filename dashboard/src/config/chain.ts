import { type Chain } from "viem";

const rpcUrl =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.robinhoodchain.com";

/** Robinhood Chain (Arbitrum Orbit L2) — not in viem defaults; defined manually. */
export const robinhoodChain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [rpcUrl] },
    public: { http: [rpcUrl] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
} as const satisfies Chain;

export const REFRESH_MS = 30_000;
