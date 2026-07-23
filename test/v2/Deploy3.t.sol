// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {Deploy3} from "../../script/Deploy3.s.sol";
import {ScratchGameV2} from "../../src/v2/ScratchGameV2.sol";

contract MockScratch is ERC20 {
    constructor() ERC20("SCRATCH", "SCRATCH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Local forge-test deploy of Deploy3 with extended post-assert coverage.
contract Deploy3Test is Test {
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

        vm.setEnv("PRIVATE_KEY", vm.toString(DEPLOYER_PK));
        vm.setEnv("SCRATCH", vm.toString(address(scratch)));
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("EMISSION_RATE", vm.toString(uint256(1e18)));
        vm.setEnv("MIN_STAKE", vm.toString(uint256(1e18)));
        vm.setEnv("RESCUE_DELAY", vm.toString(uint256(600)));
        vm.setEnv("PROMO_DAILY_CAP", vm.toString(uint256(1000e18)));
        vm.setEnv("UNLOCK_NORMAL", vm.toString(uint256(172_800)));
        vm.setEnv("UNLOCK_ENHANCED", vm.toString(uint256(432_000)));
        vm.setEnv("BOOST_BPS", vm.toString(uint256(2000)));
        vm.setEnv("BURN_BPS", vm.toString(uint256(5000)));
        vm.setEnv("VRF_COORDINATOR", vm.toString(vrfCoordinator));
        vm.setEnv("VRF_KEYHASH", vm.toString(bytes32(uint256(0xabc123))));
        vm.setEnv("VRF_SUB_ID", vm.toString(uint256(1)));
        vm.setEnv("VRF_NATIVE_PAYMENT", "true");
        vm.setEnv("RANDOMNESS_PROVIDER", "chainlink");

        ScratchGameV2.PrizeRow[] memory premium = new ScratchGameV2.PrizeRow[](2);
        premium[0] = ScratchGameV2.PrizeRow({
            asset: address(scratch),
            amountOrBps: 100e18,
            isBpsOfPool: false,
            cumOdds: 100_000
        });
        premium[1] = ScratchGameV2.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });

        ScratchGameV2.PrizeRow[] memory standard = new ScratchGameV2.PrizeRow[](2);
        standard[0] = ScratchGameV2.PrizeRow({
            asset: address(scratch),
            amountOrBps: 1e18,
            isBpsOfPool: false,
            cumOdds: 50_000
        });
        standard[1] = ScratchGameV2.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });

        vm.setEnv("PREMIUM_PRIZE_TABLE", vm.toString(abi.encode(premium)));
        vm.setEnv("STANDARD_PRIZE_TABLE", vm.toString(abi.encode(standard)));
    }

    function test_deploy3_chainlink_and_selfEntropy_modes() public {
        vm.setEnv("RANDOMNESS_PROVIDER", "chainlink");
        Deploy3 script = new Deploy3();
        Deploy3.Deployed memory d = script.run();

        assertEq(d.stakingVault.game(), address(d.game));
        assertEq(d.standardSource.game(), address(d.game));
        assertEq(d.prizeVault.game(), address(d.game));
        assertEq(address(d.randomness), address(d.adapter));
        assertEq(address(d.adapter.callback()), address(d.game));
        assertEq(address(d.game.ticketSource(d.game.PREMIUM())), address(d.stakingVault));
        assertEq(address(d.game.ticketSource(d.game.STANDARD())), address(d.standardSource));
        assertEq(d.stakingVault.unlockNormal(), 172_800);
        assertEq(d.stakingVault.unlockEnhanced(), 432_000);
        assertEq(d.stakingVault.boostBps(), 2000);
        assertEq(d.stakingVault.burnBps(), 5000);
        assertEq(d.game.MAX_BATCH(), 20);
        assertEq(d.game.rescueDelay(), 600);
        assertEq(d.game.pendingOwner(), treasury);
        assertEq(d.prizeVault.pendingOwner(), treasury);
        assertEq(d.standardSource.pendingOwner(), treasury);
        assertEq(d.stakingVault.owner(), address(0));

        vm.prank(treasury);
        d.game.acceptOwnership();
        vm.prank(treasury);
        d.prizeVault.acceptOwnership();
        vm.prank(treasury);
        d.standardSource.acceptOwnership();
        assertEq(d.game.owner(), treasury);
        assertEq(d.prizeVault.owner(), treasury);
        assertEq(d.standardSource.owner(), treasury);

        address operator = makeAddr("operator");
        bytes32 commitment = keccak256("deploy3-self-commitment");
        vm.setEnv("RANDOMNESS_PROVIDER", "self");
        vm.setEnv("OPERATOR", vm.toString(operator));
        vm.setEnv("ENTROPY_COMMITMENT", vm.toString(commitment));

        Deploy3 scriptSelf = new Deploy3();
        Deploy3.Deployed memory s = scriptSelf.run();

        assertEq(address(s.randomness), address(s.selfEntropy));
        assertEq(address(s.adapter), address(0));
        assertEq(address(s.selfEntropy.callback()), address(s.game));
        assertEq(s.selfEntropy.operator(), operator);
        assertEq(s.selfEntropy.currentEpoch(), 1);
        assertTrue(s.selfEntropy.epochCursor(1) != bytes32(0));
        assertEq(s.selfEntropy.owner(), treasury); // Ownable handoff (v1 miss fixed)
        assertEq(s.stakingVault.owner(), address(0));
        assertEq(s.stakingVault.unlockNormal(), 172_800);
        assertEq(s.stakingVault.boostBps(), 2000);
        assertEq(s.game.MAX_BATCH(), 20);
    }
}
