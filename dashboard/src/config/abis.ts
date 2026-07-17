import prizeVaultAbi from "../../abi/PrizeVault.json";
import stakingVaultAbi from "../../abi/StakingVault.json";
import standardTicketSourceAbi from "../../abi/StandardTicketSource.json";
import scratchGameAbi from "../../abi/ScratchGame.json";
import vestingWalletAbi from "../../abi/VestingWallet.json";
import erc20Abi from "../../abi/erc20.json";
import type { Abi } from "viem";

export const prizeVaultAbiTyped = prizeVaultAbi as Abi;
export const stakingVaultAbiTyped = stakingVaultAbi as Abi;
export const standardTicketSourceAbiTyped = standardTicketSourceAbi as Abi;
export const scratchGameAbiTyped = scratchGameAbi as Abi;
export const vestingWalletAbiTyped = vestingWalletAbi as Abi;
export const erc20AbiTyped = erc20Abi as Abi;
