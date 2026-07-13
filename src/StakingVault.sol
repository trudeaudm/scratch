// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title StakingVault
/// @notice Holds staked SCRATCH and accrues premium-tier tickets at a fixed global
///         emission rate, pro-rata by eligible stake above `minStake`. Implements
///         ITicketSource for ScratchGame. No admin power over user deposits: the
///         only path that moves principal is the staker's own `withdraw`. Any
///         withdrawal (including partial) burns that user's pending and banked tickets.
contract StakingVault {}
