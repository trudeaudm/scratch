// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ChainlinkVRFAdapter
/// @notice IRandomness adapter over Chainlink VRF v2.5. Coordinator address, keyHash,
///         and subscription id are constructor/env params (coordinator on 4663 is an
///         open gate — see GATES.md). Never uses blockhash, prevrandao, or a trusted
///         signer fallback.
contract ChainlinkVRFAdapter {}
