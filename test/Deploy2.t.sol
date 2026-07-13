// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {Deploy2} from "../script/Deploy2.s.sol";
import {ScratchGame} from "../src/ScratchGame.sol";

contract MockScratch is ERC20 {
    constructor() ERC20("SCRATCH", "SCRATCH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Local anvil / forge-test deploy of Deploy2 with full post-assert coverage.
contract Deploy2Test is Test {
    uint256 internal constant DEPLOYER_PK = 0xA11CE;
    address internal deployer;
    address internal treasury;
    address internal vrfCoordinator;

    MockScratch internal scratch;

    function setUp() public {
        deployer = vm.addr(DEPLOYER_PK);
        treasury = makeAddr("treasury");
        vrfCoordinator = makeAddr("vrfCoordinator");
        scratch = new MockScratch();

        vm.deal(deployer, 100 ether);

        // Side-by-side style rehearsal values (fast accrual, short rescue).
        vm.setEnv("PRIVATE_KEY", vm.toString(DEPLOYER_PK));
        vm.setEnv("SCRATCH", vm.toString(address(scratch)));
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("EMISSION_RATE", vm.toString(uint256(1e18)));
        vm.setEnv("MIN_STAKE", vm.toString(uint256(1e18)));
        vm.setEnv("RESCUE_DELAY", vm.toString(uint256(600)));
        vm.setEnv("PROMO_DAILY_CAP", vm.toString(uint256(1000e18)));
        vm.setEnv("VRF_COORDINATOR", vm.toString(vrfCoordinator));
        vm.setEnv(
            "VRF_KEYHASH",
            vm.toString(bytes32(uint256(0xabc123)))
        );
        vm.setEnv("VRF_SUB_ID", vm.toString(uint256(1)));
        vm.setEnv("VRF_NATIVE_PAYMENT", "true");

        // PREMIUM: 10% 100 SCRATCH fixed, 90% no-win.
        ScratchGame.PrizeRow[] memory premium = new ScratchGame.PrizeRow[](2);
        premium[0] = ScratchGame.PrizeRow({
            asset: address(scratch),
            amountOrBps: 100e18,
            isBpsOfPool: false,
            cumOdds: 100_000
        });
        premium[1] = ScratchGame.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });

        // STANDARD: $SCRATCH-only per GATES — 5% 1 SCRATCH, 95% no-win.
        ScratchGame.PrizeRow[] memory standard = new ScratchGame.PrizeRow[](2);
        standard[0] = ScratchGame.PrizeRow({
            asset: address(scratch),
            amountOrBps: 1e18,
            isBpsOfPool: false,
            cumOdds: 50_000
        });
        standard[1] = ScratchGame.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });

        vm.setEnv("PREMIUM_PRIZE_TABLE", vm.toString(abi.encode(premium)));
        vm.setEnv("STANDARD_PRIZE_TABLE", vm.toString(abi.encode(standard)));
    }

    function test_deploy2_run_and_assertWiring() public {
        Deploy2 script = new Deploy2();
        Deploy2.Deployed memory d = script.run();

        // Explicit checks beyond script assertions (readability / regression anchors).
        assertEq(d.stakingVault.game(), address(d.game));
        assertEq(d.standardSource.game(), address(d.game));
        assertEq(d.prizeVault.game(), address(d.game));
        assertEq(address(d.adapter.callback()), address(d.game));
        assertEq(address(d.game.ticketSource(d.game.PREMIUM())), address(d.stakingVault));
        assertEq(address(d.game.ticketSource(d.game.STANDARD())), address(d.standardSource));
        assertGt(d.game.tableLength(d.game.PREMIUM()), 0);
        assertGt(d.game.tableLength(d.game.STANDARD()), 0);
        assertEq(d.standardSource.grantDailyCap(), 1000e18);
        assertEq(d.game.rescueDelay(), 600);
        assertEq(d.game.pendingOwner(), treasury);
        assertEq(d.prizeVault.pendingOwner(), treasury);
        assertEq(d.standardSource.pendingOwner(), treasury);
        assertEq(d.stakingVault.owner(), address(0));

        // Treasury can finish Ownable2Step handoff.
        vm.prank(treasury);
        d.game.acceptOwnership();
        vm.prank(treasury);
        d.prizeVault.acceptOwnership();
        vm.prank(treasury);
        d.standardSource.acceptOwnership();
        assertEq(d.game.owner(), treasury);
        assertEq(d.prizeVault.owner(), treasury);
        assertEq(d.standardSource.owner(), treasury);
    }
}
