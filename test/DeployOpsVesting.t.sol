// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";

import {DeployOpsVesting} from "../script/DeployOpsVesting.s.sol";

contract MockOpsToken is ERC20 {
    constructor() ERC20("OPS", "OPS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Local forge-test deploy of DeployOpsVesting + linear vest / third-party release checks.
contract DeployOpsVestingTest is Test {
    uint256 internal constant DEPLOYER_PK = 0xB0B;
    uint256 internal constant OPS_AMOUNT = 100_000_000e18;
    uint64 internal constant CLIFF = 0;
    uint64 internal constant VESTING = 365 days;

    address internal deployer;
    address internal treasury;
    address internal thirdParty;

    MockOpsToken internal token;

    function setUp() public {
        deployer = vm.addr(DEPLOYER_PK);
        treasury = makeAddr("treasury");
        thirdParty = makeAddr("thirdParty");
        token = new MockOpsToken();

        vm.deal(deployer, 100 ether);

        vm.setEnv("PRIVATE_KEY", vm.toString(DEPLOYER_PK));
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("OPS_CLIFF_SECONDS", vm.toString(uint256(CLIFF)));
        vm.setEnv("OPS_VESTING_SECONDS", vm.toString(uint256(VESTING)));
    }

    function test_deployOpsVesting_linearRelease_and_thirdPartyRelease() public {
        uint64 deployTs = uint64(block.timestamp);

        DeployOpsVesting script = new DeployOpsVesting();
        DeployOpsVesting.Deployed memory d = script.run();

        VestingWallet vesting = d.vesting;
        assertEq(vesting.owner(), treasury);
        assertEq(vesting.start(), uint256(deployTs + CLIFF));
        assertEq(vesting.duration(), uint256(VESTING));
        assertEq(d.treasury, treasury);
        assertEq(d.start, deployTs + CLIFF);
        assertEq(d.duration, VESTING);

        token.mint(address(vesting), OPS_AMOUNT);
        assertEq(token.balanceOf(address(vesting)), OPS_AMOUNT);

        // 25% of duration
        vm.warp(uint256(d.start) + (uint256(VESTING) * 25) / 100);
        uint256 expected25 = (OPS_AMOUNT * 25) / 100;
        assertEq(vesting.vestedAmount(address(token), uint64(block.timestamp)), expected25);
        assertEq(vesting.releasable(address(token)), expected25);

        // 50% of duration
        vm.warp(uint256(d.start) + (uint256(VESTING) * 50) / 100);
        uint256 expected50 = (OPS_AMOUNT * 50) / 100;
        assertEq(vesting.vestedAmount(address(token), uint64(block.timestamp)), expected50);
        assertEq(vesting.releasable(address(token)), expected50);

        // 100% of duration
        vm.warp(uint256(d.start) + uint256(VESTING));
        assertEq(vesting.vestedAmount(address(token), uint64(block.timestamp)), OPS_AMOUNT);
        assertEq(vesting.releasable(address(token)), OPS_AMOUNT);

        // Anyone may call release; funds always go to beneficiary (owner).
        vm.prank(thirdParty);
        vesting.release(address(token));

        assertEq(token.balanceOf(treasury), OPS_AMOUNT);
        assertEq(token.balanceOf(address(vesting)), 0);
        assertEq(token.balanceOf(thirdParty), 0);
        assertEq(vesting.releasable(address(token)), 0);
        assertEq(vesting.released(address(token)), OPS_AMOUNT);
    }
}
