// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {ScratchGame} from "../src/ScratchGame.sol";

/// @title SetRehearsalTables
/// @notice Post-deploy prize tables for §9 rehearsal drills (buildspec §9 + harness D1–D8).
///
/// Premium (tier 1):
///   0 — bps-of-pool on REHEARSAL token
///   1 — fixed-amount REHEARSAL (D2 target)
///   2 — fixed-amount asset the vault does NOT hold (D3 fallback target)
///   3 — terminal no-win
///
/// Standard (tier 0): REHEARSAL-token-only rows + terminal (Deploy2 scratch-only assert
/// already passed at deploy; this keeps the same invariant for the live game).
contract SetRehearsalTables is Script {
    uint8 internal constant STANDARD = 0;
    uint8 internal constant PREMIUM = 1;

    /// @notice Build the premium drill table (pure — unit-testable without broadcast).
    function buildPremium(address scratch, address unbacked)
        public
        pure
        returns (ScratchGame.PrizeRow[] memory table)
    {
        table = new ScratchGame.PrizeRow[](4);
        // 10% — 5% of pool (bps)
        table[0] = ScratchGame.PrizeRow({
            asset: scratch,
            amountOrBps: 500,
            isBpsOfPool: true,
            cumOdds: 100_000
        });
        // 30% — fixed 10 REHEARSAL (D2)
        table[1] = ScratchGame.PrizeRow({
            asset: scratch,
            amountOrBps: 10e18,
            isBpsOfPool: false,
            cumOdds: 400_000
        });
        // 30% — unbacked asset, fixed 1e18 (D3 fallback / zero-pay)
        table[2] = ScratchGame.PrizeRow({
            asset: unbacked,
            amountOrBps: 1e18,
            isBpsOfPool: false,
            cumOdds: 700_000
        });
        // 30% — terminal no-win
        table[3] = ScratchGame.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
    }

    /// @notice Build the standard REHEARSAL-only table (pure — unit-testable).
    function buildStandard(address scratch) public pure returns (ScratchGame.PrizeRow[] memory table) {
        table = new ScratchGame.PrizeRow[](2);
        table[0] = ScratchGame.PrizeRow({
            asset: scratch,
            amountOrBps: 1e18,
            isBpsOfPool: false,
            cumOdds: 500_000
        });
        table[1] = ScratchGame.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
    }

    /// @notice Owner broadcast: set both tier tables on the live ScratchGame.
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address gameAddr = vm.envAddress("GAME");
        address scratch = vm.envAddress("SCRATCH");
        address unbacked = vm.envAddress("UNBACKED_ASSET");

        ScratchGame.PrizeRow[] memory premium = buildPremium(scratch, unbacked);
        ScratchGame.PrizeRow[] memory standard = buildStandard(scratch);

        ScratchGame game = ScratchGame(gameAddr);

        vm.startBroadcast(pk);
        game.setPrizeTable(PREMIUM, premium);
        game.setPrizeTable(STANDARD, standard);
        vm.stopBroadcast();

        console2.log("SetRehearsalTables complete");
        console2.log("GAME=", gameAddr);
        console2.log("premium rows=", premium.length);
        console2.log("standard rows=", standard.length);
    }
}
