// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {RehearsalToken} from "./RehearsalToken.sol";

/// @title DeployRehearsalToken
/// @notice Deploys the §9 throwaway REHEARSAL/RHRSL ERC-20 plus a second
///         unbacked prize asset used only for the fallback drill (never funded).
contract DeployRehearsalToken is Script {
    /// @dev 1e9 tokens — enough for stake, prize seed, and grants; nothing real.
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function run() external returns (address token, address unbacked) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address recipient = vm.addr(pk);

        vm.startBroadcast(pk);
        RehearsalToken t = new RehearsalToken(recipient, SUPPLY);
        RehearsalToken u = new RehearsalToken(recipient, SUPPLY);
        vm.stopBroadcast();

        token = address(t);
        unbacked = address(u);

        console2.log("REHEARSAL_TOKEN=", token);
        console2.log("UNBACKED_ASSET=", unbacked);
        console2.log("recipient=", recipient);
        console2.log("supply=", SUPPLY);
    }
}
