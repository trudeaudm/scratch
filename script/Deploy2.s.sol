// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";

/// @title Deploy2
/// @notice Env-driven Phase-2 deploy: PrizeVault → StakingVault → ChainlinkVRFAdapter
///         → ScratchGame → wire setGame → set premium prize table → transfer ownership
///         to treasury. Same script for §9 mainnet rehearsal and production; params
///         (including RESCUE_DELAY) come from env — no rehearsal-only code paths.
contract Deploy2 is Script {}
