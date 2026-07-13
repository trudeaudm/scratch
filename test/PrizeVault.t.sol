// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {PrizeVault} from "../src/PrizeVault.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev ERC-20 that can be toggled to revert on transfer (simulates KYC-gated stock tokens).
contract RevertingERC20 is ERC20 {
    bool public revertTransfers;

    constructor() ERC20("Bad", "BAD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setRevertTransfers(bool v) external {
        revertTransfers = v;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (revertTransfers) revert("transfer reverted");
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (revertTransfers) revert("transferFrom reverted");
        return super.transferFrom(from, to, amount);
    }
}

contract PrizeVaultTest is Test {
    MockERC20 internal scratch;
    MockERC20 internal usdg;
    RevertingERC20 internal bad;
    PrizeVault internal vault;

    address internal owner = makeAddr("owner");
    address internal game = makeAddr("game");
    address internal alice = makeAddr("alice");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");
    address internal treasury = makeAddr("treasury");

    /// @dev 2 SCRATCH per 1 asset token (1e18 wei asset → 2e18 SCRATCH).
    uint256 internal constant RATE = 2e18;

    function setUp() public {
        scratch = new MockERC20("SCRATCH", "SCRATCH");
        usdg = new MockERC20("USDG", "USDG");
        bad = new RevertingERC20();

        vm.prank(owner);
        vault = new PrizeVault(scratch);

        vm.prank(owner);
        vault.setGame(game);

        scratch.mint(address(vault), 1_000_000e18);
        // Track scratch already; fund usdg/bad via fund().
        usdg.mint(keeper, 1_000_000e18);
        bad.mint(keeper, 1_000_000e18);
        scratch.mint(keeper, 1_000_000e18);

        vm.startPrank(keeper);
        usdg.approve(address(vault), type(uint256).max);
        bad.approve(address(vault), type(uint256).max);
        scratch.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------
    // payout happy path
    // -------------------------------------------------------------------------

    function test_payout_happyPath() public {
        vm.prank(keeper);
        vault.fund(address(usdg), 1_000e18);

        vm.expectEmit(true, true, false, true, address(vault));
        emit PrizeVault.PrizePaid(alice, address(usdg), 100e18, false);

        vm.prank(game);
        vault.payout(alice, address(usdg), 100e18);

        assertEq(usdg.balanceOf(alice), 100e18);
        assertEq(usdg.balanceOf(address(vault)), 900e18);
    }

    // -------------------------------------------------------------------------
    // fallback paths
    // -------------------------------------------------------------------------

    function test_payout_fallback_onRevertingToken() public {
        vm.prank(keeper);
        vault.fund(address(bad), 500e18);

        vm.prank(owner);
        vault.setFallbackRate(address(bad), RATE);

        bad.setRevertTransfers(true);

        uint256 scratchBefore = scratch.balanceOf(alice);
        uint256 due = (50e18 * RATE) / 1e18; // 100e18

        vm.expectEmit(true, true, false, true, address(vault));
        emit PrizeVault.PrizePaid(alice, address(scratch), due, true);

        vm.prank(game);
        vault.payout(alice, address(bad), 50e18);

        assertEq(scratch.balanceOf(alice), scratchBefore + due);
        assertEq(bad.balanceOf(alice), 0);
        assertEq(bad.balanceOf(address(vault)), 500e18); // still held
    }

    function test_payout_fallback_onInsufficientBalance() public {
        vm.prank(keeper);
        vault.fund(address(usdg), 10e18);

        vm.prank(owner);
        vault.setFallbackRate(address(usdg), RATE);

        uint256 due = (100e18 * RATE) / 1e18; // vault only has 10 usdg

        vm.expectEmit(true, true, false, true, address(vault));
        emit PrizeVault.PrizePaid(alice, address(scratch), due, true);

        vm.prank(game);
        vault.payout(alice, address(usdg), 100e18);

        assertEq(usdg.balanceOf(alice), 0);
        assertEq(scratch.balanceOf(alice), due);
        assertEq(usdg.balanceOf(address(vault)), 10e18);
    }

    function test_payout_fallback_unsetRate_settlesWithoutRevert() public {
        vm.prank(keeper);
        vault.fund(address(usdg), 10e18);
        // no setFallbackRate

        uint256 scratchBefore = scratch.balanceOf(alice);
        uint256 usdgBefore = usdg.balanceOf(address(vault));

        vm.expectEmit(true, true, false, true, address(vault));
        emit PrizeVault.PrizePaid(alice, address(scratch), 0, true);

        vm.prank(game);
        vault.payout(alice, address(usdg), 100e18); // insufficient → fallback → unset rate

        assertEq(scratch.balanceOf(alice), scratchBefore);
        assertEq(usdg.balanceOf(address(vault)), usdgBefore);
    }

    // -------------------------------------------------------------------------
    // fund
    // -------------------------------------------------------------------------

    function test_fund_fromArbitraryCaller() public {
        address random = makeAddr("random");
        usdg.mint(random, 42e18);
        vm.startPrank(random);
        usdg.approve(address(vault), 42e18);
        vault.fund(address(usdg), 42e18);
        vm.stopPrank();

        assertEq(usdg.balanceOf(address(vault)), 42e18);

        (address[] memory assets, uint256[] memory balances) = vault.inventory();
        bool found;
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(usdg)) {
                found = true;
                assertEq(balances[i], 42e18);
            }
        }
        assertTrue(found);
    }

    // -------------------------------------------------------------------------
    // sweep timelock
    // -------------------------------------------------------------------------

    function test_sweep_executeBeforeDelay_reverts() public {
        vm.prank(keeper);
        vault.fund(address(usdg), 100e18);

        vm.prank(owner);
        uint256 id = vault.sweep(address(usdg), treasury);

        vm.prank(owner);
        vm.expectRevert(PrizeVault.SweepNotReady.selector);
        vault.executeSweep(id);
    }

    function test_sweep_executeAfterDelay_succeeds() public {
        vm.prank(keeper);
        vault.fund(address(usdg), 100e18);

        vm.prank(owner);
        uint256 id = vault.sweep(address(usdg), treasury);

        vm.warp(block.timestamp + vault.SWEEP_DELAY());

        vm.expectEmit(true, true, true, true, address(vault));
        emit PrizeVault.SweepExecuted(id, address(usdg), treasury, 100e18);

        vm.prank(owner);
        vault.executeSweep(id);

        assertEq(usdg.balanceOf(treasury), 100e18);
        assertEq(usdg.balanceOf(address(vault)), 0);

        (,,, bool pending) = vault.sweeps(id);
        assertFalse(pending);
    }

    function test_sweep_cancel_works() public {
        vm.prank(keeper);
        vault.fund(address(usdg), 100e18);

        vm.prank(owner);
        uint256 id = vault.sweep(address(usdg), treasury);

        vm.expectEmit(true, false, false, true, address(vault));
        emit PrizeVault.SweepCancelled(id);

        vm.prank(owner);
        vault.cancelSweep(id);

        vm.warp(block.timestamp + vault.SWEEP_DELAY());

        vm.prank(owner);
        vm.expectRevert(PrizeVault.SweepNotPending.selector);
        vault.executeSweep(id);

        assertEq(usdg.balanceOf(address(vault)), 100e18);
    }

    function test_sweep_executeInsideGrace_succeeds() public {
        vm.prank(keeper);
        vault.fund(address(usdg), 100e18);

        vm.prank(owner);
        uint256 id = vault.sweep(address(usdg), treasury);
        (,, uint64 eta,) = vault.sweeps(id);

        // Mid-window: after eta, before eta + SWEEP_GRACE.
        vm.warp(uint256(eta) + (uint256(vault.SWEEP_GRACE()) / 2));

        vm.prank(owner);
        vault.executeSweep(id);

        assertEq(usdg.balanceOf(treasury), 100e18);
        assertEq(usdg.balanceOf(address(vault)), 0);
    }

    function test_sweep_executeAfterGrace_revertsSweepExpired() public {
        vm.prank(keeper);
        vault.fund(address(usdg), 100e18);

        vm.prank(owner);
        uint256 id = vault.sweep(address(usdg), treasury);
        (,, uint64 eta,) = vault.sweeps(id);

        vm.warp(uint256(eta) + vault.SWEEP_GRACE() + 1);

        vm.prank(owner);
        vm.expectRevert(PrizeVault.SweepExpired.selector);
        vault.executeSweep(id);

        assertEq(usdg.balanceOf(address(vault)), 100e18);
        (,,, bool pending) = vault.sweeps(id);
        assertTrue(pending);
    }

    function test_sweep_requeueAfterExpiry_freshEta() public {
        vm.prank(keeper);
        vault.fund(address(usdg), 100e18);

        vm.prank(owner);
        uint256 id1 = vault.sweep(address(usdg), treasury);
        (,, uint64 eta1,) = vault.sweeps(id1);

        vm.warp(uint256(eta1) + vault.SWEEP_GRACE() + 1);

        vm.prank(owner);
        vm.expectRevert(PrizeVault.SweepExpired.selector);
        vault.executeSweep(id1);

        uint256 queueTime = block.timestamp;
        vm.prank(owner);
        uint256 id2 = vault.sweep(address(usdg), treasury);
        (,, uint64 eta2,) = vault.sweeps(id2);

        assertEq(eta2, uint64(queueTime) + vault.SWEEP_DELAY());
        assertGt(eta2, eta1);

        vm.warp(eta2);

        vm.prank(owner);
        vault.executeSweep(id2);

        assertEq(usdg.balanceOf(treasury), 100e18);
        assertEq(usdg.balanceOf(address(vault)), 0);
    }

    // -------------------------------------------------------------------------
    // payout auth
    // -------------------------------------------------------------------------

    function test_payout_reverts_notGame() public {
        vm.prank(keeper);
        vault.fund(address(usdg), 100e18);

        vm.prank(stranger);
        vm.expectRevert(PrizeVault.NotGame.selector);
        vault.payout(alice, address(usdg), 1e18);
    }
}
