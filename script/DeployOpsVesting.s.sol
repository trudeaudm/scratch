// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";

/// @title DeployOpsVesting
/// @notice Env-driven deploy of OpenZeppelin `VestingWallet` for the 100M ops allocation.
///         Beneficiary = `TREASURY`; vesting start = `block.timestamp + OPS_CLIFF_SECONDS`;
///         duration = `OPS_VESTING_SECONDS`. No hardcoded addresses.
///
/// Usage:
///   set -a && source .env && set +a
///   forge script script/DeployOpsVesting.s.sol:DeployOpsVesting --rpc-url $RPC_URL --broadcast --slow
contract DeployOpsVesting is Script {
    struct Deployed {
        VestingWallet vesting;
        address treasury;
        uint64 start;
        uint64 duration;
    }

    /// @notice Deploy VestingWallet and print funding checklist.
    function run() external returns (Deployed memory d) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        d.treasury = vm.envAddress("TREASURY");
        uint64 cliffSeconds = uint64(vm.envUint("OPS_CLIFF_SECONDS"));
        d.duration = uint64(vm.envUint("OPS_VESTING_SECONDS"));
        d.start = uint64(block.timestamp) + cliffSeconds;

        vm.startBroadcast(deployerKey);
        d.vesting = new VestingWallet(d.treasury, d.start, d.duration);
        vm.stopBroadcast();

        console2.log("=== DeployOpsVesting complete ===");
        console2.log("VestingWallet: ", address(d.vesting));
        console2.log("beneficiary:   ", d.treasury);
        console2.log("start:         ", d.start);
        console2.log("duration:      ", d.duration);
        console2.log("");
        console2.log(
            "MANUAL: transfer 100,000,000e18 SCRATCH from treasury to this address; tokens vest linearly from start; anyone may call release(token), funds always go to beneficiary."
        );
    }
}
