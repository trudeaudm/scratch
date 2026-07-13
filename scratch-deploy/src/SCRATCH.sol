// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  SCRATCH
/// @notice Vanilla fixed-supply ERC-20. No owner, no mint, no pause, no hooks,
///         no fee-on-transfer. The contract being boring is the feature:
///         nothing for scanners to misread, nothing for an admin key to abuse.
///         All game logic (tickets, vault, prizes, referrals) lives in
///         peripheral contracts deployed later.
contract SCRATCH is ERC20 {
    /// @param recipient Receives the entire fixed supply (the deploy script,
    ///        which immediately splits it into LP / prize / emissions / treasury).
    /// @param supply    Total supply in wei units (18 decimals). Minted once, forever.
    constructor(address recipient, uint256 supply) ERC20("Scratch", "SCRATCH") {
        _mint(recipient, supply);
    }
}
