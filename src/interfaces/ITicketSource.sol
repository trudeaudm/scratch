// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ITicketSource
/// @notice Ticket accrual source for a single scratch tier. StakingVault implements
///         this for the premium tier; a Phase-3 voucher module will implement it for
///         the standard tier. Tiers are non-fungible — no conversion across sources.
interface ITicketSource {
    /// @notice Spend `amount` ticket-wei from `user`. Settles pending into banked first.
    /// @dev Only callable by the wired ScratchGame. Reverts on insufficient balance.
    function spendTickets(address user, uint256 amount) external;

    /// @notice Re-credit `amount` ticket-wei to `user` (stuck-request rescue path).
    /// @dev Only callable by the wired ScratchGame.
    function refundTicket(address user, uint256 amount) external;

    /// @notice Total spendable tickets for `user` (banked + pending), in ticket-wei.
    function ticketsOf(address user) external view returns (uint256);
}
