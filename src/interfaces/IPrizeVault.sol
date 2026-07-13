// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IPrizeVault
/// @notice Multi-asset prize inventory used by ScratchGame. `payout` must never
///         revert a settlement — failed or gated transfers fall back to SCRATCH
///         at the configured per-asset rate.
interface IPrizeVault {
    /// @notice Pay `to` with `asset`/`amount`. On transfer failure or insufficient
    ///         balance, pay the configured SCRATCH fallback equivalent instead.
    /// @dev Only callable by the wired ScratchGame.
    function payout(address to, address asset, uint256 amount) external;

    /// @notice Vault balance of `asset` (for bps-of-pool prize sizing at settlement).
    function balanceOf(address asset) external view returns (uint256);

    /// @notice Full inventory snapshot for the site: assets and balances.
    function inventory() external view returns (address[] memory assets, uint256[] memory balances);
}
