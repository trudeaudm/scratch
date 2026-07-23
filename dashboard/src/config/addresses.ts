import { type Address, zeroAddress } from "viem";
/** Shared with the public site — see `site/tokens.json` (repo root). */
import tokensJson from "../../../site/tokens.json";

/**
 * Single source of truth for dashboard addresses and priced pairs.
 * Production Deploy2 + DeployOpsVesting (chain 4663).
 *
 * Verified tokens live in `../site/tokens.json` (committed state — review diffs
 * before pushing). Same file the public site fetches at load. This module imports
 * that list into a mutable `tokens` array so promote/remove can hot-update
 * fund/send dropdowns without a full reload.
 *
 * On-chain holdings also auto-discover via Blockscout — discovered-only tokens
 * render with an "unverified" badge and never enter write dropdowns.
 */
export type DexPair = {
  /** DexScreener chain slug in /latest/dex/pairs/{chainId}/{pairAddress}. */
  chainId: string;
  /** Pair id (EOA-style address or Uniswap v4 pool id — DexScreener path segment). */
  pairAddress: `0x${string}`;
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
  /** Display name (e.g. stock product title). */
  name?: string;
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

/** Mutable verified token list — seeded from `tokens.json`, updated by promote/remove. */
export const tokens: TokenConfig[] = structuredClone(tokensJson) as TokenConfig[];

let tokensEpoch = 0;
const tokensListeners = new Set<() => void>();

/** Bumps when `tokens` is replaced after a promote/remove (or HMR). */
export function getTokensEpoch(): number {
  return tokensEpoch;
}

export function subscribeTokens(listener: () => void): () => void {
  tokensListeners.add(listener);
  return () => tokensListeners.delete(listener);
}

/** Replace in-memory verified list (keeps same array reference for importers). */
export function replaceVerifiedTokens(next: TokenConfig[]): void {
  tokens.splice(0, tokens.length, ...next);
  tokensEpoch += 1;
  for (const l of tokensListeners) l();
}

/** DexScreener pairs used for SCRATCH and ETH/USD. Update chainId slug if DexScreener differs. */
export const dexPairs = {
  /** Production SCRATCH/ETH Uniswap v4 pool (site chart + DexScreener). */
  scratch: {
    chainId: "robinhood",
    pairAddress: "0x3f66e1430c12a7a64839f43050165db6d1bf1ae5bd7df11e47a37a8e73bc00ef",
  } satisfies DexPair,
  /** WETH/USDG or WETH/stable used for native ETH USD — unset until a stable pair is pinned. */
  weth: {
    chainId: "robinhood",
    pairAddress: Z,
  } satisfies DexPair,
};

export const contracts = {
  /** Production Deploy2 PrizeVault (v1 stack). */
  prizeVault: {
    key: "prizeVault",
    label: "PrizeVault (v1)",
    address: "0x86Ade8b30D481bBd9D2897d20931b107e776Ba52",
  } satisfies ContractEntry,
  /**
   * Fresh PrizeVault from Deploy3 (v2 stack). Zero until cutover — fill after
   * Deploy3; never commit rehearsal addresses as production.
   */
  prizeVaultV2: {
    key: "prizeVaultV2",
    label: "PrizeVault (v2)",
    address: Z,
  } satisfies ContractEntry,
  stakingVault: {
    key: "stakingVault",
    label: "StakingVault",
    address: "0x577Cecbe33d1B2F7f4DF7E0D8Bf03690C2b17eD6",
  } satisfies ContractEntry,
  standardTicketSource: {
    key: "standardTicketSource",
    label: "StandardTicketSource",
    address: "0xC94894Cd3986E2D0f85616a0Dc59914f1057f003",
  } satisfies ContractEntry,
  scratchGame: {
    key: "scratchGame",
    label: "ScratchGame",
    address: "0xBeD604b5AB226134EdF154cc31881d8C93f4C9e6",
  } satisfies ContractEntry,
  selfEntropyProvider: {
    key: "selfEntropyProvider",
    label: "SelfEntropyProvider",
    address: "0xd305290DaF2b14b60FE3aaE7281C4A001B973aB0",
  } satisfies ContractEntry,
  /** Ops VestingWallet — DeployOpsVesting.s.sol. */
  vestingWallet: {
    key: "vestingWallet",
    label: "Ops VestingWallet",
    address: "0xf2c4bfe47E8B24A526F1584b86810EeEd495cbde",
  } satisfies ContractEntry,
  treasury: {
    key: "treasury",
    label: "Treasury EOA",
    address: "0x429A47560F348753E96Bbe0C9dDfD9bFF902eB85",
  } satisfies ContractEntry,
} as const;

/** v1 + v2 PrizeVault entries (configured or not). Same ABI; separate instances. */
export const prizeVaultConfigs: ContractEntry[] = [
  contracts.prizeVault,
  contracts.prizeVaultV2,
];

/** Configured PrizeVault instances only (v1 and/or v2 once Deploy3 is filled). */
export function configuredPrizeVaults(): ContractEntry[] {
  return prizeVaultConfigs.filter((v) => isConfigured(v.address));
}

/** Labeled destinations for send / sweep (fat-finger protection — no free text). */
export const sendTargets: ContractEntry[] = [
  contracts.prizeVault,
  contracts.prizeVaultV2,
  contracts.stakingVault,
  contracts.standardTicketSource,
  contracts.scratchGame,
  contracts.vestingWallet,
  contracts.treasury,
];

/** Holders whose balances are shown in the read panel. */
export const balanceHolders: ContractEntry[] = [
  contracts.prizeVault,
  contracts.prizeVaultV2,
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
