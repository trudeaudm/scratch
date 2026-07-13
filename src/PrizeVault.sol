// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title PrizeVault
/// @notice Custodies multi-asset prize inventory (SCRATCH, USDG, memecoins, stock
///         tokens) and pays winners for ScratchGame. `payout` never reverts a
///         settlement — failed or KYC-gated transfers fall back to SCRATCH at a
///         configured per-asset rate. Owner sweep is subject to a 48h timelock.
contract PrizeVault {}
