// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {ScratchGameV2} from "../src/v2/ScratchGameV2.sol";

/// @title SetRehearsalTablesV2
/// @notice Post-deploy prize tables for v2 rehearsal drills (mirrors SetRehearsalTables
///         against ScratchGameV2). Includes a bps-of-pool row for batch aggregation.
contract SetRehearsalTablesV2 is Script {
    uint8 internal constant STANDARD = 0;
    uint8 internal constant PREMIUM = 1;

    function buildPremium(address scratch, address unbacked)
        public
        pure
        returns (ScratchGameV2.PrizeRow[] memory table)
    {
        table = new ScratchGameV2.PrizeRow[](4);
        // 10% — 5% of pool (bps) — exercises pre-batch balance snapshot
        table[0] = ScratchGameV2.PrizeRow({
            asset: scratch,
            amountOrBps: 500,
            isBpsOfPool: true,
            cumOdds: 100_000
        });
        // 30% — fixed 10 REHEARSAL
        table[1] = ScratchGameV2.PrizeRow({
            asset: scratch,
            amountOrBps: 10e18,
            isBpsOfPool: false,
            cumOdds: 400_000
        });
        // 30% — unbacked asset (fallback path)
        table[2] = ScratchGameV2.PrizeRow({
            asset: unbacked,
            amountOrBps: 1e18,
            isBpsOfPool: false,
            cumOdds: 700_000
        });
        // 30% — terminal no-win
        table[3] = ScratchGameV2.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
    }

    function buildStandard(address scratch) public pure returns (ScratchGameV2.PrizeRow[] memory table) {
        table = new ScratchGameV2.PrizeRow[](2);
        table[0] = ScratchGameV2.PrizeRow({
            asset: scratch,
            amountOrBps: 1e18,
            isBpsOfPool: false,
            cumOdds: 500_000
        });
        table[1] = ScratchGameV2.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address gameAddr = vm.envAddress("GAME");
        address scratch = vm.envAddress("SCRATCH");
        address unbacked = vm.envAddress("UNBACKED_ASSET");

        ScratchGameV2.PrizeRow[] memory premium = buildPremium(scratch, unbacked);
        ScratchGameV2.PrizeRow[] memory standard = buildStandard(scratch);

        ScratchGameV2 game = ScratchGameV2(gameAddr);

        vm.startBroadcast(pk);
        game.setPrizeTable(PREMIUM, premium);
        game.setPrizeTable(STANDARD, standard);
        vm.stopBroadcast();

        console2.log("SetRehearsalTablesV2 complete");
        console2.log("GAME=", gameAddr);
        console2.log("premium rows=", premium.length);
        console2.log("standard rows=", standard.length);
    }
}
