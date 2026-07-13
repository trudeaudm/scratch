// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ScratchGame
/// @notice Burns one ticket, requests randomness via IRandomness, maps the outcome
///         onto a cumulative-odds prize table, and instructs PrizeVault to pay.
///         Commit-then-reveal via VRF so settlement precedes any UI reveal. Stuck
///         requests past `rescueDelay` can be rescued (ticket refunded).
contract ScratchGame {}
