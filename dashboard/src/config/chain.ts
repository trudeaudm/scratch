import { type Chain } from "viem";

/** Public Robinhood RPC — all viem/wagmi eth_* reads. Alchemy is ALCHEMY_RPC_URL only. */
const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL?.trim() || PUBLIC_RPC;

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

/** Vitals poll — raised to cut eth_* volume; countdowns tick client-side. */
export const REFRESH_MS = 60_000;
