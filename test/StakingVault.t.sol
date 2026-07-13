// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {StakingVault} from "../src/StakingVault.sol";

contract MockScratch is ERC20 {
    constructor() ERC20("SCRATCH", "SCRATCH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Covers every buildspec §6 StakingVault unit case.
contract StakingVaultTest is Test {
    uint256 internal constant EMISSION_RATE = 1e18; // 1 ticket-wei per second
    uint256 internal constant MIN_STAKE = 100e18;

    MockScratch internal scratch;
    StakingVault internal vault;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal game = makeAddr("game");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        scratch = new MockScratch();
        vm.prank(owner);
        vault = new StakingVault(scratch, EMISSION_RATE, MIN_STAKE);

        scratch.mint(alice, 1_000_000e18);
        scratch.mint(bob, 1_000_000e18);

        vm.prank(alice);
        scratch.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        scratch.approve(address(vault), type(uint256).max);

        vm.prank(owner);
        vault.setGame(game);
    }

    // -------------------------------------------------------------------------
    // Threshold crossings
    // -------------------------------------------------------------------------

    /// @notice Deposit below minStake is held but does not enter totalStaked / accrue.
    function test_threshold_crossing_up_into_eligibility() public {
        vm.prank(alice);
        vault.deposit(MIN_STAKE - 1);

        (uint256 staked,,) = vault.users(alice);
        assertEq(staked, MIN_STAKE - 1);
        assertEq(vault.totalStaked(), 0);

        vm.warp(block.timestamp + 1 days);
        assertEq(vault.ticketsOf(alice), 0);

        // Cross up to exactly minStake.
        vm.prank(alice);
        vault.deposit(1);

        (staked,,) = vault.users(alice);
        assertEq(staked, MIN_STAKE);
        assertEq(vault.totalStaked(), MIN_STAKE);

        uint256 t0 = block.timestamp;
        vm.warp(t0 + 100);
        // Sole eligible staker: tickets == emissionRate * elapsed.
        assertEq(vault.ticketsOf(alice), EMISSION_RATE * 100);
    }

    /// @notice Partial withdraw that drops below minStake removes full prior stake from
    ///         totalStaked and stops accrual (tickets burned separately tested).
    function test_threshold_crossing_down_out_of_eligibility() public {
        vm.prank(alice);
        vault.deposit(MIN_STAKE + 50e18);
        assertEq(vault.totalStaked(), MIN_STAKE + 50e18);

        vm.warp(block.timestamp + 10);

        // Withdraw enough to land at MIN_STAKE - 1.
        uint256 drop = 50e18 + 1;
        vm.prank(alice);
        vault.withdraw(drop);

        (uint256 staked, uint256 debt, uint256 banked) = vault.users(alice);
        assertEq(staked, MIN_STAKE - 1);
        assertEq(vault.totalStaked(), 0);
        assertEq(banked, 0);
        assertEq(debt, 0);

        uint256 tAfter = block.timestamp;
        vm.warp(tAfter + 1 days);
        assertEq(vault.ticketsOf(alice), 0);
    }

    // -------------------------------------------------------------------------
    // Accrual math — hand-computed at three timestamps
    // -------------------------------------------------------------------------

    /// @notice Sole staker: ticketsOf equals emissionRate * elapsed at t1, t2, t3.
    function test_accrual_handComputed_threeTimestamps_soleStaker() public {
        vm.prank(alice);
        vault.deposit(MIN_STAKE);

        uint256 t0 = block.timestamp;

        uint256 t1 = t0 + 10;
        vm.warp(t1);
        assertEq(vault.ticketsOf(alice), EMISSION_RATE * 10, "t1");

        uint256 t2 = t0 + 3600;
        vm.warp(t2);
        assertEq(vault.ticketsOf(alice), EMISSION_RATE * 3600, "t2");

        uint256 t3 = t0 + 86_400;
        vm.warp(t3);
        assertEq(vault.ticketsOf(alice), EMISSION_RATE * 86_400, "t3");
    }

    /// @notice Two equal stakers split emission 50/50 — hand-checked at three times.
    function test_accrual_handComputed_threeTimestamps_twoStakers() public {
        vm.prank(alice);
        vault.deposit(MIN_STAKE);
        vm.prank(bob);
        vault.deposit(MIN_STAKE);

        uint256 t0 = block.timestamp;
        // Each gets half of emissionRate per second.
        uint256 half = EMISSION_RATE / 2;

        vm.warp(t0 + 20);
        assertEq(vault.ticketsOf(alice), half * 20, "alice t1");
        assertEq(vault.ticketsOf(bob), half * 20, "bob t1");

        vm.warp(t0 + 500);
        assertEq(vault.ticketsOf(alice), half * 500, "alice t2");
        assertEq(vault.ticketsOf(bob), half * 500, "bob t2");

        vm.warp(t0 + 10_000);
        assertEq(vault.ticketsOf(alice), half * 10_000, "alice t3");
        assertEq(vault.ticketsOf(bob), half * 10_000, "bob t3");
    }

    // -------------------------------------------------------------------------
    // Bank cap
    // -------------------------------------------------------------------------

    /// @notice Accruing longer than BANK_CAP_SECONDS still banks at most 7 days of
    ///         earnings at the user's current rate (sole staker → emissionRate * 7 days).
    function test_bankCap_enforced_onSettle() public {
        vm.prank(alice);
        vault.deposit(MIN_STAKE);

        uint256 cap = EMISSION_RATE * vault.BANK_CAP_SECONDS();
        assertEq(vault.capFor(alice), cap);

        // Accrue well past the cap window.
        vm.warp(block.timestamp + 30 days);
        assertEq(vault.ticketsOf(alice), EMISSION_RATE * 30 days, "pending uncapped live");

        // Touch via spendTickets(0) is blocked; deposit 0 blocked; settle via spend of tiny
        // after warping: bank by calling spendTickets with game after a no-op path.
        // Settling happens on spendTickets — spend 0 reverts, so spend leaves banked=cap-1
        // if we spend 1 after settle... Settle first by depositing 1 wei more.
        scratch.mint(alice, 1);
        vm.prank(alice);
        vault.deposit(1);

        (,, uint256 banked) = vault.users(alice);
        assertEq(banked, cap, "banked clipped to cap");
        // Live ticketsOf after settle: banked (at cap) + fresh pending since settle (~0).
        assertEq(vault.ticketsOf(alice), cap);
    }

    // -------------------------------------------------------------------------
    // Withdraw burns pending + banked
    // -------------------------------------------------------------------------

    function test_withdraw_full_burnsPendingAndBanked() public {
        vm.prank(alice);
        vault.deposit(MIN_STAKE);

        vm.warp(block.timestamp + 1 hours);
        // Bank some via settle (deposit dust).
        scratch.mint(alice, 1);
        vm.prank(alice);
        vault.deposit(1);

        (uint256 staked,, uint256 bankedBefore) = vault.users(alice);
        assertGt(bankedBefore, 0);

        vm.warp(block.timestamp + 100);
        uint256 pendingLive = vault.ticketsOf(alice) - bankedBefore;
        assertGt(pendingLive, 0);
        uint256 expectedBurn = bankedBefore + pendingLive;

        vm.expectEmit(true, false, false, true, address(vault));
        emit StakingVault.Withdrawn(alice, staked, expectedBurn);

        vm.prank(alice);
        vault.withdraw(staked);

        (uint256 stakedAfter, uint256 debtAfter, uint256 bankedAfter) = vault.users(alice);
        assertEq(stakedAfter, 0);
        assertEq(bankedAfter, 0);
        assertEq(debtAfter, 0);
        assertEq(vault.ticketsOf(alice), 0);
        assertEq(vault.totalStaked(), 0);
        assertEq(scratch.balanceOf(alice), 1_000_000e18 + 1); // full return of deposited (+dust mint spent back)
    }

    function test_withdraw_partial_burnsPendingAndBanked() public {
        vm.prank(alice);
        vault.deposit(MIN_STAKE * 2);

        vm.warp(block.timestamp + 1 hours);
        scratch.mint(alice, 1);
        vm.prank(alice);
        vault.deposit(1);

        (,, uint256 bankedBefore) = vault.users(alice);
        assertGt(bankedBefore, 0);

        vm.warp(block.timestamp + 50);
        uint256 ticketsBefore = vault.ticketsOf(alice);
        uint256 pendingLive = ticketsBefore - bankedBefore;
        uint256 expectedBurn = bankedBefore + pendingLive;

        uint256 withdrawAmount = MIN_STAKE; // stay eligible
        vm.expectEmit(true, false, false, true, address(vault));
        emit StakingVault.Withdrawn(alice, withdrawAmount, expectedBurn);

        vm.prank(alice);
        vault.withdraw(withdrawAmount);

        (uint256 stakedAfter,, uint256 bankedAfter) = vault.users(alice);
        assertEq(stakedAfter, MIN_STAKE * 2 + 1 - withdrawAmount);
        assertEq(bankedAfter, 0);
        assertEq(vault.ticketsOf(alice), 0); // pending wiped via debt resync; banked burned
        assertEq(vault.totalStaked(), stakedAfter);
    }

    // -------------------------------------------------------------------------
    // spendTickets auth + insufficient
    // -------------------------------------------------------------------------

    function test_spendTickets_reverts_notGame() public {
        vm.prank(alice);
        vault.deposit(MIN_STAKE);
        vm.warp(block.timestamp + 10);

        vm.prank(stranger);
        vm.expectRevert(StakingVault.NotGame.selector);
        vault.spendTickets(alice, 1);
    }

    function test_spendTickets_reverts_insufficientBalance() public {
        vm.prank(alice);
        vault.deposit(MIN_STAKE);
        vm.warp(block.timestamp + 10);
        // alice has EMISSION_RATE * 10 tickets.

        vm.prank(game);
        vm.expectRevert(StakingVault.InsufficientTickets.selector);
        vault.spendTickets(alice, EMISSION_RATE * 10 + 1);
    }

    function test_spendTickets_success_settlesThenSpends() public {
        vm.prank(alice);
        vault.deposit(MIN_STAKE);
        vm.warp(block.timestamp + 100);

        uint256 spend = EMISSION_RATE * 40;
        vm.prank(game);
        vault.spendTickets(alice, spend);

        // Remaining: 100*rate - 40*rate = 60*rate (all in banked after settle).
        assertEq(vault.ticketsOf(alice), EMISSION_RATE * 60);
        (,, uint256 banked) = vault.users(alice);
        assertEq(banked, EMISSION_RATE * 60);
    }

    // -------------------------------------------------------------------------
    // refundTicket auth + cap bypass
    // -------------------------------------------------------------------------

    function test_refundTicket_reverts_notGame() public {
        vm.prank(stranger);
        vm.expectRevert(StakingVault.NotGame.selector);
        vault.refundTicket(alice, 1e18);
    }

    function test_refundTicket_bypassesBankCap() public {
        vm.prank(alice);
        vault.deposit(MIN_STAKE);

        uint256 cap = vault.capFor(alice);

        // Fill bank to cap.
        vm.warp(block.timestamp + 30 days);
        scratch.mint(alice, 1);
        vm.prank(alice);
        vault.deposit(1);
        (,, uint256 banked) = vault.users(alice);
        assertEq(banked, cap);

        // Rescue refund of 5e18 must land uncapped.
        uint256 refund = 5e18;
        vm.prank(game);
        vault.refundTicket(alice, refund);

        (,, banked) = vault.users(alice);
        assertEq(banked, cap + refund, "refund must not clip against bank cap");
        assertGt(banked, cap);
        assertEq(vault.ticketsOf(alice), cap + refund);
    }

    function test_setGame_oneShot() public {
        // Game already set in setUp.
        vm.prank(owner);
        vm.expectRevert(StakingVault.GameAlreadySet.selector);
        vault.setGame(makeAddr("otherGame"));
    }
}
