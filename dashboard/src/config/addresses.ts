import { type Address, zeroAddress } from "viem";

/**
 * Single source of truth for dashboard addresses and priced pairs.
 * Fill after Deploy2 (+ script/DeployOpsVesting.s.sol). Zero addresses disable that row until set.
 *
 * Config tokens are curated (verified symbols, pricing, write-panel dropdowns).
 * On-chain holdings also auto-discover via Blockscout — discovered-only tokens
 * render with an "unverified" badge and never enter write dropdowns.
 */
export type DexPair = {
  /** DexScreener chain slug in /latest/dex/pairs/{chainId}/{pairAddress}. */
  chainId: string;
  pairAddress: Address;
};

export type TokenKind = "crypto" | "stock";

export type TokenConfig = {
  symbol: string;
  address: Address;
  decimals: number;
  /**
   * How USD is derived for curated tokens.
   * - scratch / eth: DexScreener pairs in `dexPairs`
   * - usdg: pegged $1
   * - dex: use preferredPair if set, else best DexScreener token pair (liq > $1k)
   * - none: no USD
   */
  price: "scratch" | "usdg" | "eth" | "dex" | "none";
  /** Default crypto. Stocks/RWAs group under "Stocks & RWAs" in holdings. */
  kind?: TokenKind;
  /** Underlying ticker for stocks (e.g. "AAPL") — shown in brokerage-style view. */
  ticker?: string;
  /** Pin a preferred DexScreener pair (tokenized stocks / thin markets). */
  preferredPair?: DexPair;
};

export type ContractEntry = {
  key: string;
  label: string;
  address: Address;
};

const Z = zeroAddress;

export const EXPLORER_BASE = "https://robinhoodchain.blockscout.com";
export const BLOCKSCOUT_API = `${EXPLORER_BASE}/api`;

/** Min DexScreener pair liquidity (USD) to accept a discovered-token price. */
export const DEX_MIN_LIQUIDITY_USD = 1_000;

export const tokens: TokenConfig[] = [
  {
    symbol: "SCRATCH",
    address: Z, // fill post-deploy
    decimals: 18,
    price: "scratch",
  },
  {
    symbol: "USDG",
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    decimals: 18,
    price: "usdg",
  },
  {
    symbol: "WETH",
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    decimals: 18,
    price: "eth",
  },
  // Example stock/RWA entries (fill address + preferredPair after listing):
  // {
  //   symbol: "tAAPL",
  //   address: Z,
  //   decimals: 18,
  //   price: "dex",
  //   kind: "stock",
  //   ticker: "AAPL",
  //   preferredPair: { chainId: "robinhood", pairAddress: Z },
  // },
];

/** DexScreener pairs used for SCRATCH and ETH/USD. Update chainId slug if DexScreener differs. */
export const dexPairs = {
  scratch: {
    chainId: "robinhood",
    pairAddress: Z,
  } satisfies DexPair,
  /** WETH/USDG or WETH/stable used for native ETH USD. */
  weth: {
    chainId: "robinhood",
    pairAddress: Z,
  } satisfies DexPair,
};

export const contracts = {
  prizeVault: {
    key: "prizeVault",
    label: "PrizeVault",
    address: Z,
  } satisfies ContractEntry,
  stakingVault: {
    key: "stakingVault",
    label: "StakingVault",
    address: Z,
  } satisfies ContractEntry,
  standardTicketSource: {
    key: "standardTicketSource",
    label: "StandardTicketSource",
    address: Z,
  } satisfies ContractEntry,
  scratchGame: {
    key: "scratchGame",
    label: "ScratchGame",
    address: Z,
  } satisfies ContractEntry,
  /** Ops VestingWallet — fill after `forge script script/DeployOpsVesting.s.sol`. */
  vestingWallet: {
    key: "vestingWallet",
    label: "Ops VestingWallet",
    address: Z,
  } satisfies ContractEntry,
  treasury: {
    key: "treasury",
    label: "Treasury EOA",
    address: Z,
  } satisfies ContractEntry,
} as const;

/** Labeled destinations for the send panel (fat-finger protection — no free text). */
export const sendTargets: ContractEntry[] = [
  contracts.prizeVault,
  contracts.stakingVault,
  contracts.standardTicketSource,
  contracts.scratchGame,
  contracts.vestingWallet,
  contracts.treasury,
];

/** Holders whose balances are shown in the read panel. */
export const balanceHolders: ContractEntry[] = [
  contracts.prizeVault,
  contracts.stakingVault,
  contracts.standardTicketSource,
  contracts.vestingWallet,
  contracts.treasury,
];

/** Write-panel fund/send dropdowns — config tokens only (never auto-discovered). */
export function writePanelTokens(): TokenConfig[] {
  return tokens.filter((t) => isConfigured(t.address));
}

export function findTokenConfig(address: Address): TokenConfig | undefined {
  return tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
}

export function isConfigured(addr: Address): boolean {
  return addr !== zeroAddress;
}

export function explorerTx(hash: string): string {
  return `${EXPLORER_BASE}/tx/${hash}`;
}

export function explorerAddress(addr: Address): string {
  return `${EXPLORER_BASE}/address/${addr}`;
}
