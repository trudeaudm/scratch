// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title RehearsalToken
/// @notice Throwaway ERC-20 for buildspec §9 mainnet rehearsal. Same boring
///         shape as production SCRATCH (fixed supply, no owner/mint/pause) with
///         name/symbol REHEARSAL / RHRSL so it cannot be confused with live $SCRATCH.
contract RehearsalToken is ERC20 {
    /// @param recipient Receives the entire fixed supply.
    /// @param supply    Total supply in wei (18 decimals). Minted once.
    constructor(address recipient, uint256 supply) ERC20("REHEARSAL", "RHRSL") {
        _mint(recipient, supply);
    }
}
