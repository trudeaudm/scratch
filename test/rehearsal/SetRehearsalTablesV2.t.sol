// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {PrizeVault} from "../../src/PrizeVault.sol";
import {ScratchGameV2} from "../../src/v2/ScratchGameV2.sol";
import {IRandomness} from "../../src/interfaces/IRandomness.sol";
import {SetRehearsalTablesV2} from "../../rehearsal/SetRehearsalTablesV2.s.sol";
import {MockRandomness} from "../mocks/MockRandomness.sol";

contract MockScratchV2 is ERC20 {
    constructor() ERC20("REHEARSAL", "RHRSL") {
        _mint(msg.sender, 1_000_000e18);
    }
}

/// @dev Local coverage for rehearsal/SetRehearsalTablesV2.s.sol (bps row + terminal).
contract SetRehearsalTablesV2Test is Test {
    MockScratchV2 internal scratch;
    MockScratchV2 internal unbacked;
    PrizeVault internal prizes;
    ScratchGameV2 internal game;
    MockRandomness internal randomness;
    SetRehearsalTablesV2 internal tables;

    address internal owner = makeAddr("owner");

    function setUp() public {
        scratch = new MockScratchV2();
        unbacked = new MockScratchV2();

        vm.prank(owner);
        prizes = new PrizeVault(scratch);

        randomness = new MockRandomness();

        vm.prank(owner);
        game = new ScratchGameV2(prizes, IRandomness(address(randomness)), 600);

        vm.prank(owner);
        prizes.setGame(address(game));

        tables = new SetRehearsalTablesV2();
    }

    function test_buildPremium_includesBpsRow() public view {
        ScratchGameV2.PrizeRow[] memory premium = tables.buildPremium(address(scratch), address(unbacked));
        assertEq(premium.length, 4);

        assertTrue(premium[0].isBpsOfPool);
        assertEq(uint256(premium[0].amountOrBps), 500);
        assertEq(uint256(premium[0].cumOdds), 100_000);

        assertFalse(premium[1].isBpsOfPool);
        assertEq(uint256(premium[1].amountOrBps), 10e18);

        assertEq(premium[2].asset, address(unbacked));
        assertEq(premium[3].asset, address(0));
        assertEq(uint256(premium[3].cumOdds), 1_000_000);
    }

    function test_setPrizeTables_onAnvilGame() public {
        ScratchGameV2.PrizeRow[] memory premium = tables.buildPremium(address(scratch), address(unbacked));
        ScratchGameV2.PrizeRow[] memory standard = tables.buildStandard(address(scratch));

        vm.startPrank(owner);
        game.setPrizeTable(game.PREMIUM(), premium);
        game.setPrizeTable(game.STANDARD(), standard);
        vm.stopPrank();

        assertEq(game.tableLength(game.PREMIUM()), 4);
        assertEq(game.tableLength(game.STANDARD()), 2);
    }

    function test_scriptRun_broadcastsAgainstAnvil() public {
        uint256 pk = 0xB0B;
        address deployer = vm.addr(pk);
        vm.deal(deployer, 10 ether);

        vm.prank(deployer);
        PrizeVault p2 = new PrizeVault(scratch);
        MockRandomness r2 = new MockRandomness();
        vm.prank(deployer);
        ScratchGameV2 g2 = new ScratchGameV2(p2, IRandomness(address(r2)), 600);
        vm.prank(deployer);
        p2.setGame(address(g2));

        vm.setEnv("PRIVATE_KEY", vm.toString(pk));
        vm.setEnv("GAME", vm.toString(address(g2)));
        vm.setEnv("SCRATCH", vm.toString(address(scratch)));
        vm.setEnv("UNBACKED_ASSET", vm.toString(address(unbacked)));

        SetRehearsalTablesV2 script = new SetRehearsalTablesV2();
        script.run();

        assertEq(g2.tableLength(g2.PREMIUM()), 4);
        assertTrue(g2.getPrizeRow(g2.PREMIUM(), 0).isBpsOfPool);
    }
}
