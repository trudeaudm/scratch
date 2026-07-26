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
  /** Production Deploy3 PrizeVault (v2 stack, 2026-07-24). */
  prizeVaultV2: {
    key: "prizeVaultV2",
    label: "PrizeVault (v2)",
    address: "0xAfbEa86784f9DbD31573B74e68133C3B2b21247E",
  } satisfies ContractEntry,
  stakingVault: {
    key: "stakingVault",
    label: "StakingVault (v1)",
    address: "0x577Cecbe33d1B2F7f4DF7E0D8Bf03690C2b17eD6",
  } satisfies ContractEntry,
  /** Production Deploy3 StakingVaultV2. NOTE: no `totalStaked` getter (v2 uses totalWeight). */
  stakingVaultV2: {
    key: "stakingVaultV2",
    label: "StakingVaultV2",
    address: "0x3D8Ec3a0D98e2a5015C502b4D40a5167f378dB7c",
  } satisfies ContractEntry,
  standardTicketSource: {
    key: "standardTicketSource",
    label: "StandardTicketSource (v1)",
    address: "0xC94894Cd3986E2D0f85616a0Dc59914f1057f003",
  } satisfies ContractEntry,
  /** Production Deploy3 StandardTicketSource (v2). Crediter must be re-added here. */
  standardTicketSourceV2: {
    key: "standardTicketSourceV2",
    label: "StandardTicketSource (v2)",
    address: "0x6C7CC31d5eC5899c7f5019516cFA3629167B2fd8",
  } satisfies ContractEntry,
  scratchGame: {
    key: "scratchGame",
    label: "ScratchGame (v1)",
    address: "0xBeD604b5AB226134EdF154cc31881d8C93f4C9e6",
  } satisfies ContractEntry,
  /** Production Deploy3 ScratchGameV2 — game vitals + prize-table editor target. */
  scratchGameV2: {
    key: "scratchGameV2",
    label: "ScratchGameV2",
    address: "0xe6BA601710aFd1297114D738CA201D1D84eb3Da1",
  } satisfies ContractEntry,
  selfEntropyProvider: {
    key: "selfEntropyProvider",
    label: "SelfEntropyProvider (v1)",
    address: "0xd305290DaF2b14b60FE3aaE7281C4A001B973aB0",
  } satisfies ContractEntry,
  /** Production Deploy3 SelfEntropyProvider (v2) — Render operator swap target. */
  selfEntropyProviderV2: {
    key: "selfEntropyProviderV2",
    label: "SelfEntropyProvider (v2)",
    address: "0x5B765d373C97EedD52f9Bc8741B17F7167dEDd36",
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

/**
 * Active ScratchGame for ops panels that edit/read tables + game vitals.
 * Cutover point: flip this return to switch the dashboard game target.
 * Prize vault for that game is always resolved on-chain via `prizeVault()` —
 * never hardcode a vault address next to this.
 */
export function activeScratchGame(): ContractEntry {
  return contracts.scratchGameV2;
}

/**
 * STANDARD ticket source for the active game generation (v1 ↔ Deploy2, v2 ↔ Deploy3).
 * Grant / drop writes and ticket-cap vitals should use this — not a hard-coded v1 address.
 */
export function activeStandardTicketSource(): ContractEntry {
  return activeScratchGame().key === "scratchGameV2"
    ? contracts.standardTicketSourceV2
    : contracts.standardTicketSource;
}

/** Staking vault for the active game generation. */
export function activeStakingVault(): ContractEntry {
  return activeScratchGame().key === "scratchGameV2"
    ? contracts.stakingVaultV2
    : contracts.stakingVault;
}

/**
 * Deploy block for `activeScratchGame()` log scans (payouts, etc.).
 * v2 defaults to Deploy3 creation (~StakingVaultV2 block); override via GAME_V2_DEPLOY_BLOCK.
 */
export function activeGameDeployBlock(): bigint {
  if (activeScratchGame().key === "scratchGameV2") {
    return BigInt(
      process.env.GAME_V2_DEPLOY_BLOCK ||
        process.env.NEXT_PUBLIC_GAME_V2_DEPLOY_BLOCK ||
        process.env.NEXT_PUBLIC_STAKING_V2_DEPLOY_BLOCK ||
        "18171314",
    );
  }
  return BigInt(process.env.GAME_DEPLOY_BLOCK || "13138508");
}

/** v1 + v2 PrizeVault entries (configured or not). Same ABI; separate instances. */
export const prizeVaultConfigs: ContractEntry[] = [
  contracts.prizeVault,
  contracts.prizeVaultV2,
];

/** Configured PrizeVault instances only (v1 and/or v2 once Deploy3 is filled). */
export function configuredPrizeVaults(): ContractEntry[] {
  return prizeVaultConfigs.filter((v) => isConfigured(v.address));
}

/** Match a vault address to a labeled config entry when known. */
export function findPrizeVaultConfig(address: Address): ContractEntry | undefined {
  const key = address.toLowerCase();
  return prizeVaultConfigs.find((v) => v.address.toLowerCase() === key);
}

/** Labeled destinations for send / sweep (fat-finger protection — no free text). */
export const sendTargets: ContractEntry[] = [
  contracts.prizeVault,
  contracts.prizeVaultV2,
  contracts.stakingVault,
  contracts.stakingVaultV2,
  contracts.standardTicketSource,
  contracts.standardTicketSourceV2,
  contracts.scratchGame,
  contracts.scratchGameV2,
  contracts.vestingWallet,
  contracts.treasury,
];

/** Holders whose balances are shown in the read panel. */
export const balanceHolders: ContractEntry[] = [
  contracts.prizeVault,
  contracts.prizeVaultV2,
  contracts.stakingVault,
  contracts.stakingVaultV2,
  contracts.standardTicketSource,
  contracts.standardTicketSourceV2,
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

/** v1 / legacy Deploy2 contracts — de-emphasize vs Deploy3 (v2) in the UI. */
export function isLegacyContract(entry: ContractEntry): boolean {
  return /\(v1\)/i.test(entry.label);
}

/**
 * Production Deploy3 StakingVaultV2 creation block (chain 4663).
 * Override with NEXT_PUBLIC_STAKING_V2_DEPLOY_BLOCK when needed.
 */
export function stakingV2DeployBlock(): bigint {
  const raw = process.env.NEXT_PUBLIC_STAKING_V2_DEPLOY_BLOCK || "18171314";
  return BigInt(raw);
}

export function explorerTx(hash: string): string {
  return `${EXPLORER_BASE}/tx/${hash}`;
}

export function explorerAddress(addr: Address): string {
  return `${EXPLORER_BASE}/address/${addr}`;
}
