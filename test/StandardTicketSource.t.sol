// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {StandardTicketSource} from "../src/StandardTicketSource.sol";

contract StandardTicketSourceTest is Test {
    StandardTicketSource internal source;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal game = makeAddr("game");
    address internal crediter = makeAddr("crediter");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant TICKET = 1e18;

    function setUp() public {
        // Fixed start so day-bucket math is deterministic across warps.
        vm.warp(1_700_000_000);
        vm.prank(owner);
        source = new StandardTicketSource();
        vm.prank(owner);
        source.setGame(game);
    }

    function _users(address a) internal pure returns (address[] memory users) {
        users = new address[](1);
        users[0] = a;
    }

    function _users2(address a, address b) internal pure returns (address[] memory users) {
        users = new address[](2);
        users[0] = a;
        users[1] = b;
    }

    // -------------------------------------------------------------------------
    // Grant + expiry basics
    // -------------------------------------------------------------------------

    function test_grant_batch_credits_and_sets_expiry() public {
        uint256 amount = 5 * TICKET;
        uint64 before = uint64(block.timestamp);

        vm.expectEmit(true, false, false, true);
        emit StandardTicketSource.TicketsGranted(alice, amount);
        vm.expectEmit(true, false, false, true);
        emit StandardTicketSource.TicketsGranted(bob, amount);

        vm.prank(owner);
        source.grant(_users2(alice, bob), amount);

        assertEq(source.ticketsOf(alice), amount);
        assertEq(source.ticketsOf(bob), amount);
        assertEq(source.expiryOf(alice), before + uint64(source.TTL()));
        assertEq(source.expiryOf(bob), before + uint64(source.TTL()));
        assertEq(source.grantUsedToday(), amount * 2);
    }

    function test_balance_spendable_at_expiresAt_minus_1_zero_at_plus_1() public {
        vm.prank(owner);
        source.grant(_users(alice), TICKET);

        uint64 expiry = source.expiryOf(alice);

        vm.warp(uint256(expiry) - 1);
        assertEq(source.ticketsOf(alice), TICKET);
        assertEq(source.expiryOf(alice), expiry);

        vm.prank(game);
        source.spendTickets(alice, TICKET);
        assertEq(source.ticketsOf(alice), 0);

        // Re-grant and check the +1 boundary without spending first.
        vm.prank(owner);
        source.grant(_users(alice), TICKET);
        expiry = source.expiryOf(alice);

        vm.warp(uint256(expiry) + 1);
        assertEq(source.ticketsOf(alice), 0);
        assertEq(source.expiryOf(alice), 0);
    }

    function test_ticketsOf_expiryOf_accurate_around_boundary() public {
        vm.prank(owner);
        source.grant(_users(alice), 3 * TICKET);
        uint64 expiry = source.expiryOf(alice);

        // Exactly at expiresAt: still valid (`timestamp > expiresAt` is the cut).
        vm.warp(expiry);
        assertEq(source.ticketsOf(alice), 3 * TICKET);
        assertEq(source.expiryOf(alice), expiry);

        vm.warp(uint256(expiry) + 1);
        assertEq(source.ticketsOf(alice), 0);
        assertEq(source.expiryOf(alice), 0);
    }

    function test_regrant_after_expiry_emits_TicketsExpired_then_credits() public {
        vm.prank(owner);
        source.grant(_users(alice), 2 * TICKET);
        uint64 oldExpiry = source.expiryOf(alice);

        vm.warp(uint256(oldExpiry) + 1);

        vm.expectEmit(true, false, false, true);
        emit StandardTicketSource.TicketsExpired(alice, 2 * TICKET);
        vm.expectEmit(true, false, false, true);
        emit StandardTicketSource.TicketsGranted(alice, TICKET);

        uint64 before = uint64(block.timestamp);
        vm.prank(owner);
        source.grant(_users(alice), TICKET);

        assertEq(source.ticketsOf(alice), TICKET);
        assertEq(source.expiryOf(alice), before + uint64(source.TTL()));
    }

    function test_grant_extends_existing_unexpired_balance_ttl() public {
        vm.prank(owner);
        source.grant(_users(alice), TICKET);
        uint64 firstExpiry = source.expiryOf(alice);

        vm.warp(block.timestamp + 1 days);
        uint64 before = uint64(block.timestamp);

        vm.prank(owner);
        source.grant(_users(alice), 2 * TICKET);

        assertEq(source.ticketsOf(alice), 3 * TICKET);
        uint64 secondExpiry = source.expiryOf(alice);
        assertEq(secondExpiry, before + uint64(source.TTL()));
        assertGt(secondExpiry, firstExpiry);
    }

    // -------------------------------------------------------------------------
    // Refund
    // -------------------------------------------------------------------------

    function test_refund_fresh_ttl_bypasses_caps() public {
        // Exhaust the owner grant cap.
        vm.prank(owner);
        source.lowerGrantCap(TICKET);
        vm.prank(owner);
        source.grant(_users(alice), TICKET);

        // Cap fully used — further grant reverts.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(StandardTicketSource.GrantDailyCapExceeded.selector, TICKET, uint256(0))
        );
        source.grant(_users(bob), TICKET);

        // Spend alice's ticket then refund — must succeed and refresh TTL despite caps.
        vm.prank(game);
        source.spendTickets(alice, TICKET);
        assertEq(source.ticketsOf(alice), 0);

        uint64 before = uint64(block.timestamp);
        vm.expectEmit(true, false, false, true);
        emit StandardTicketSource.TicketsRefunded(alice, TICKET);
        vm.prank(game);
        source.refundTicket(alice, TICKET);

        assertEq(source.ticketsOf(alice), TICKET);
        assertEq(source.expiryOf(alice), before + uint64(source.TTL()));
        // Refund did not consume grant allowance.
        assertEq(source.grantUsedToday(), TICKET);
    }

    function test_refund_revives_expired_balance_with_fresh_ttl() public {
        vm.prank(owner);
        source.grant(_users(alice), TICKET);
        vm.warp(uint256(source.expiryOf(alice)) + 1);
        assertEq(source.ticketsOf(alice), 0);

        uint64 before = uint64(block.timestamp);
        vm.expectEmit(true, false, false, true);
        emit StandardTicketSource.TicketsExpired(alice, TICKET);
        vm.prank(game);
        source.refundTicket(alice, 2 * TICKET);

        assertEq(source.ticketsOf(alice), 2 * TICKET);
        assertEq(source.expiryOf(alice), before + uint64(source.TTL()));
    }

    // -------------------------------------------------------------------------
    // Grant daily cap + day rollover
    // -------------------------------------------------------------------------

    function test_grant_cap_across_batch_boundary() public {
        vm.prank(owner);
        source.lowerGrantCap(3 * TICKET);

        // First batch uses 2.
        vm.prank(owner);
        source.grant(_users2(alice, bob), TICKET);
        assertEq(source.grantUsedToday(), 2 * TICKET);

        // Batch of 2 would need 2 more but only 1 remains.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(StandardTicketSource.GrantDailyCapExceeded.selector, 2 * TICKET, TICKET)
        );
        source.grant(_users2(alice, carol), TICKET);

        // Single grant of remaining works.
        vm.prank(owner);
        source.grant(_users(carol), TICKET);
        assertEq(source.grantUsedToday(), 3 * TICKET);
        assertEq(source.ticketsOf(carol), TICKET);
    }

    function test_grant_cap_day_rollover() public {
        vm.prank(owner);
        source.lowerGrantCap(TICKET);
        vm.prank(owner);
        source.grant(_users(alice), TICKET);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(StandardTicketSource.GrantDailyCapExceeded.selector, TICKET, uint256(0))
        );
        source.grant(_users(bob), TICKET);

        // Next UTC day bucket resets usage.
        uint256 nextDay = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(nextDay);

        vm.prank(owner);
        source.grant(_users(bob), TICKET);
        assertEq(source.ticketsOf(bob), TICKET);
        assertEq(source.grantUsedToday(), TICKET);
        assertEq(source.grantDayBucket(), block.timestamp / 1 days);
    }

    function test_lowerGrantCap_works_raise_reverts() public {
        uint256 old = source.grantDailyCap();
        uint256 neu = old / 2;

        vm.expectEmit(true, false, false, true);
        emit StandardTicketSource.CapLowered(address(0), old, neu);
        vm.prank(owner);
        source.lowerGrantCap(neu);
        assertEq(source.grantDailyCap(), neu);

        vm.prank(owner);
        vm.expectRevert(StandardTicketSource.CapIncreaseForbidden.selector);
        source.lowerGrantCap(neu + 1);

        vm.prank(owner);
        vm.expectRevert(StandardTicketSource.CapIncreaseForbidden.selector);
        source.lowerGrantCap(neu); // equal also forbidden
    }

    // -------------------------------------------------------------------------
    // Crediter auth + per-crediter cap
    // -------------------------------------------------------------------------

    function test_crediter_auth_and_per_crediter_cap() public {
        vm.prank(owner);
        source.addCrediter(crediter, 2 * TICKET);

        vm.expectEmit(true, true, false, true);
        emit StandardTicketSource.TicketsCredited(alice, crediter, TICKET);
        vm.prank(crediter);
        source.credit(alice, TICKET);
        assertEq(source.ticketsOf(alice), TICKET);

        vm.prank(crediter);
        source.credit(bob, TICKET);

        vm.prank(crediter);
        vm.expectRevert(
            abi.encodeWithSelector(StandardTicketSource.CrediterDailyCapExceeded.selector, TICKET, uint256(0))
        );
        source.credit(carol, TICKET);

        // Stranger cannot credit.
        vm.prank(stranger);
        vm.expectRevert(StandardTicketSource.NotCrediter.selector);
        source.credit(alice, TICKET);

        // Lower crediter cap; raise reverts.
        vm.expectEmit(true, false, false, true);
        emit StandardTicketSource.CapLowered(crediter, 2 * TICKET, TICKET);
        vm.prank(owner);
        source.lowerCrediterCap(crediter, TICKET);

        vm.prank(owner);
        vm.expectRevert(StandardTicketSource.CapIncreaseForbidden.selector);
        source.lowerCrediterCap(crediter, 2 * TICKET);

        // Day rollover resets crediter usage under the lowered cap.
        uint256 nextDay = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(nextDay);
        vm.prank(crediter);
        source.credit(carol, TICKET);
        assertEq(source.ticketsOf(carol), TICKET);

        vm.prank(crediter);
        vm.expectRevert(
            abi.encodeWithSelector(StandardTicketSource.CrediterDailyCapExceeded.selector, TICKET, uint256(0))
        );
        source.credit(carol, TICKET);
    }

    function test_addCrediter_duplicate_reverts() public {
        vm.prank(owner);
        source.addCrediter(crediter, TICKET);
        vm.prank(owner);
        vm.expectRevert(StandardTicketSource.CrediterAlreadyAdded.selector);
        source.addCrediter(crediter, 2 * TICKET);
    }

    // -------------------------------------------------------------------------
    // Spend / refund auth + insufficient
    // -------------------------------------------------------------------------

    function test_spend_refund_auth() public {
        vm.prank(owner);
        source.grant(_users(alice), TICKET);

        vm.prank(stranger);
        vm.expectRevert(StandardTicketSource.NotGame.selector);
        source.spendTickets(alice, TICKET);

        vm.prank(stranger);
        vm.expectRevert(StandardTicketSource.NotGame.selector);
        source.refundTicket(alice, TICKET);

        vm.prank(game);
        source.spendTickets(alice, TICKET);
        assertEq(source.ticketsOf(alice), 0);

        vm.prank(game);
        source.refundTicket(alice, TICKET);
        assertEq(source.ticketsOf(alice), TICKET);
    }

    function test_spend_insufficient_reverts() public {
        vm.prank(owner);
        source.grant(_users(alice), TICKET);

        vm.prank(game);
        vm.expectRevert(StandardTicketSource.InsufficientTickets.selector);
        source.spendTickets(alice, 2 * TICKET);
    }

    function test_spend_treats_expired_as_zero() public {
        vm.prank(owner);
        source.grant(_users(alice), TICKET);
        vm.warp(uint256(source.expiryOf(alice)) + 1);

        // Expired balance is treated as zero; spend reverts (and any lazy clear is rolled back).
        vm.prank(game);
        vm.expectRevert(StandardTicketSource.InsufficientTickets.selector);
        source.spendTickets(alice, TICKET);

        assertEq(source.ticketsOf(alice), 0);
        assertEq(source.expiryOf(alice), 0);
    }

    function test_setGame_oneShot() public {
        // Already set in setUp.
        vm.prank(owner);
        vm.expectRevert(StandardTicketSource.GameAlreadySet.selector);
        source.setGame(makeAddr("otherGame"));
    }
}
