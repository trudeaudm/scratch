import { type Address, zeroAddress } from "viem";

/**
 * Single source of truth for dashboard addresses and priced pairs.
 * Fill after Deploy2 (+ vesting deploy). Zero addresses disable that row until set.
 */
export type TokenConfig = {
  symbol: string;
  address: Address;
  decimals: number;
  /** How USD is derived. */
  price: "scratch" | "usdg" | "eth";
};

export type ContractEntry = {
  key: string;
  label: string;
  address: Address;
};

export type DexPair = {
  /** DexScreener chain slug in /latest/dex/pairs/{chainId}/{pairAddress}. */
  chainId: string;
  pairAddress: Address;
};

const Z = zeroAddress;

export const EXPLORER_BASE = "https://robinhoodchain.blockscout.com";

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

export function isConfigured(addr: Address): boolean {
  return addr !== zeroAddress;
}

export function explorerTx(hash: string): string {
  return `${EXPLORER_BASE}/tx/${hash}`;
}

export function explorerAddress(addr: Address): string {
  return `${EXPLORER_BASE}/address/${addr}`;
}
