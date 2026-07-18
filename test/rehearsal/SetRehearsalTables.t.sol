// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {PrizeVault} from "../../src/PrizeVault.sol";
import {ScratchGame} from "../../src/ScratchGame.sol";
import {IRandomness} from "../../src/interfaces/IRandomness.sol";
import {SetRehearsalTables} from "../../rehearsal/SetRehearsalTables.s.sol";
import {MockRandomness} from "../mocks/MockRandomness.sol";

contract MockScratch is ERC20 {
    constructor() ERC20("REHEARSAL", "RHRSL") {
        _mint(msg.sender, 1_000_000e18);
    }
}

/// @dev Local anvil/forge coverage for rehearsal/SetRehearsalTables.s.sol table builders + set.
contract SetRehearsalTablesTest is Test {
    MockScratch internal scratch;
    MockScratch internal unbacked;
    PrizeVault internal prizes;
    ScratchGame internal game;
    MockRandomness internal randomness;
    SetRehearsalTables internal tables;

    address internal owner = makeAddr("owner");

    function setUp() public {
        scratch = new MockScratch();
        unbacked = new MockScratch();

        vm.prank(owner);
        prizes = new PrizeVault(scratch);

        randomness = new MockRandomness();

        vm.prank(owner);
        game = new ScratchGame(prizes, IRandomness(address(randomness)), 600);

        vm.prank(owner);
        prizes.setGame(address(game));

        tables = new SetRehearsalTables();
    }

    function test_buildPremium_hasRequiredRows() public view {
        ScratchGame.PrizeRow[] memory premium = tables.buildPremium(address(scratch), address(unbacked));
        assertEq(premium.length, 4);

        assertEq(premium[0].asset, address(scratch));
        assertTrue(premium[0].isBpsOfPool);
        assertEq(uint256(premium[0].cumOdds), 100_000);

        assertEq(premium[1].asset, address(scratch));
        assertFalse(premium[1].isBpsOfPool);
        assertEq(uint256(premium[1].amountOrBps), 10e18);
        assertEq(uint256(premium[1].cumOdds), 400_000);

        assertEq(premium[2].asset, address(unbacked));
        assertFalse(premium[2].isBpsOfPool);
        assertEq(uint256(premium[2].cumOdds), 700_000);

        assertEq(premium[3].asset, address(0));
        assertEq(uint256(premium[3].cumOdds), 1_000_000);
    }

    function test_buildStandard_scratchOnlyPlusTerminal() public view {
        ScratchGame.PrizeRow[] memory standard = tables.buildStandard(address(scratch));
        assertEq(standard.length, 2);
        assertEq(standard[0].asset, address(scratch));
        assertEq(standard[1].asset, address(0));
        assertEq(uint256(standard[1].cumOdds), 1_000_000);
    }

    function test_setPrizeTables_onAnvilGame() public {
        ScratchGame.PrizeRow[] memory premium = tables.buildPremium(address(scratch), address(unbacked));
        ScratchGame.PrizeRow[] memory standard = tables.buildStandard(address(scratch));

        vm.startPrank(owner);
        game.setPrizeTable(game.PREMIUM(), premium);
        game.setPrizeTable(game.STANDARD(), standard);
        vm.stopPrank();

        assertEq(game.tableLength(game.PREMIUM()), 4);
        assertEq(game.tableLength(game.STANDARD()), 2);

        ScratchGame.PrizeRow memory row2 = game.getPrizeRow(game.PREMIUM(), 2);
        assertEq(row2.asset, address(unbacked));

        ScratchGame.PrizeRow memory term = game.getPrizeRow(game.PREMIUM(), 3);
        assertEq(term.asset, address(0));
        assertEq(uint256(term.cumOdds), 1_000_000);
    }

    function test_scriptRun_broadcastsAgainstAnvil() public {
        uint256 pk = 0xB0B;
        address deployer = vm.addr(pk);
        vm.deal(deployer, 10 ether);

        vm.prank(deployer);
        PrizeVault p2 = new PrizeVault(scratch);
        MockRandomness r2 = new MockRandomness();
        vm.prank(deployer);
        ScratchGame g2 = new ScratchGame(p2, IRandomness(address(r2)), 600);
        vm.prank(deployer);
        p2.setGame(address(g2));

        vm.setEnv("PRIVATE_KEY", vm.toString(pk));
        vm.setEnv("GAME", vm.toString(address(g2)));
        vm.setEnv("SCRATCH", vm.toString(address(scratch)));
        vm.setEnv("UNBACKED_ASSET", vm.toString(address(unbacked)));

        SetRehearsalTables script = new SetRehearsalTables();
        script.run();

        assertEq(g2.tableLength(g2.PREMIUM()), 4);
        assertEq(g2.tableLength(g2.STANDARD()), 2);
        assertEq(g2.getPrizeRow(g2.PREMIUM(), 2).asset, address(unbacked));
    }
}
