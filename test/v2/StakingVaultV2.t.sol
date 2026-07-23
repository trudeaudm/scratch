// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {StakingVaultV2} from "../../src/v2/StakingVaultV2.sol";

contract MockScratch is ERC20 {
    constructor() ERC20("SCRATCH", "SCRATCH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Ported v1 StakingVault suite against V2 + unlock/tier/burn cases.
contract StakingVaultV2Test is Test {
    uint256 internal constant EMISSION_RATE = 1e18;
    uint256 internal constant MIN_STAKE = 100e18;
    uint64 internal constant UNLOCK_NORMAL = 2 days;
    uint64 internal constant UNLOCK_ENHANCED = 5 days;
    uint16 internal constant BOOST_BPS = 2000; // +20%
    uint16 internal constant BURN_BPS = 5000; // 50%

    uint8 internal constant NORMAL = 1;
    uint8 internal constant ENHANCED = 2;

    MockScratch internal scratch;
    StakingVaultV2 internal vault;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal game = makeAddr("game");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        scratch = new MockScratch();
        vm.prank(owner);
        vault = new StakingVaultV2(
            scratch, EMISSION_RATE, MIN_STAKE, UNLOCK_NORMAL, UNLOCK_ENHANCED, BOOST_BPS, BURN_BPS
        );

        scratch.mint(alice, 1_000_000e18);
        scratch.mint(bob, 1_000_000e18);

        vm.prank(alice);
        scratch.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        scratch.approve(address(vault), type(uint256).max);

        vm.prank(owner);
        vault.setGame(game);
    }

    function _deposit(address user, uint256 amount, uint8 tier) internal {
        vm.prank(user);
        vault.deposit(amount, tier);
    }

    // -------------------------------------------------------------------------
    // Threshold crossings (ported)
    // -------------------------------------------------------------------------

    function test_threshold_crossing_up_into_eligibility() public {
        _deposit(alice, MIN_STAKE - 1, NORMAL);

        (uint256 staked,,,) = vault.users(alice);
        assertEq(staked, MIN_STAKE - 1);
        assertEq(vault.totalWeight(), 0);

        vm.warp(block.timestamp + 1 days);
        assertEq(vault.ticketsOf(alice), 0);

        _deposit(alice, 1, NORMAL);

        (staked,,,) = vault.users(alice);
        assertEq(staked, MIN_STAKE);
        assertEq(vault.totalWeight(), MIN_STAKE); // NORMAL mult = 1e18

        uint256 t0 = block.timestamp;
        vm.warp(t0 + 100);
        assertEq(vault.ticketsOf(alice), EMISSION_RATE * 100);
    }

    function test_threshold_crossing_down_out_of_eligibility() public {
        _deposit(alice, MIN_STAKE + 50e18, NORMAL);
        assertEq(vault.totalWeight(), MIN_STAKE + 50e18);

        vm.warp(block.timestamp + 10);

        uint256 drop = 50e18 + 1;
        vm.prank(alice);
        vault.requestUnlock(drop);

        (uint256 staked,, uint256 banked,) = vault.users(alice);
        assertEq(staked, MIN_STAKE - 1);
        assertEq(vault.totalWeight(), 0);
        // Settled then proportionally burned — not zeroed entirely (v2).
        assertLt(banked, EMISSION_RATE * 10);
        assertGt(banked, 0);

        uint256 tAfter = block.timestamp;
        vm.warp(tAfter + 1 days);
        assertEq(vault.ticketsOf(alice), banked); // no further accrual
    }

    // -------------------------------------------------------------------------
    // Accrual math (ported)
    // -------------------------------------------------------------------------

    function test_accrual_handComputed_threeTimestamps_soleStaker() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        uint256 t0 = block.timestamp;

        vm.warp(t0 + 10);
        assertEq(vault.ticketsOf(alice), EMISSION_RATE * 10, "t1");

        vm.warp(t0 + 3600);
        assertEq(vault.ticketsOf(alice), EMISSION_RATE * 3600, "t2");

        vm.warp(t0 + 86_400);
        assertEq(vault.ticketsOf(alice), EMISSION_RATE * 86_400, "t3");
    }

    function test_accrual_handComputed_threeTimestamps_twoStakers() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        _deposit(bob, MIN_STAKE, NORMAL);

        uint256 t0 = block.timestamp;
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
    // Weighted emission
    // -------------------------------------------------------------------------

    function test_weightedEmission_enhancedIsExactly1_2xNormal() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        _deposit(bob, MIN_STAKE, ENHANCED);

        // Weights: alice=MIN_STAKE, bob=MIN_STAKE*1.2 → total = MIN_STAKE*2.2
        assertEq(vault.totalWeight(), (MIN_STAKE * 22) / 10);

        vm.warp(block.timestamp + 100);

        uint256 aliceTickets = vault.ticketsOf(alice);
        uint256 bobTickets = vault.ticketsOf(bob);
        // bob / alice == 1.2 exactly (ratio); sum may lose ≤1 wei per share to floor dust
        assertEq(bobTickets * 10, aliceTickets * 12);
        assertApproxEqAbs(aliceTickets + bobTickets, EMISSION_RATE * 100, 100);
    }

    function testFuzz_totalWeight_conservation(uint128 aAmt, uint128 bAmt, uint8 tierPick) public {
        uint256 aliceAmt = bound(aAmt, 1, 500_000e18);
        uint256 bobAmt = bound(bAmt, 1, 500_000e18);
        uint8 tier = tierPick % 2 == 0 ? NORMAL : ENHANCED;

        _deposit(alice, aliceAmt, tier);
        _deposit(bob, bobAmt, tier);

        uint256 expected;
        if (aliceAmt >= MIN_STAKE) expected += (aliceAmt * vault.tierMultiplier(tier)) / 1e18;
        if (bobAmt >= MIN_STAKE) expected += (bobAmt * vault.tierMultiplier(tier)) / 1e18;
        assertEq(vault.totalWeight(), expected);

        if (aliceAmt >= MIN_STAKE / 2 && aliceAmt / 2 > 0) {
            uint256 unlockAmt = aliceAmt / 2;
            vm.prank(alice);
            vault.requestUnlock(unlockAmt);
            uint256 aliceLeft = aliceAmt - unlockAmt;
            expected = 0;
            if (aliceLeft >= MIN_STAKE) expected += (aliceLeft * vault.tierMultiplier(tier)) / 1e18;
            if (bobAmt >= MIN_STAKE) expected += (bobAmt * vault.tierMultiplier(tier)) / 1e18;
            assertEq(vault.totalWeight(), expected);

            vm.prank(alice);
            vault.cancelUnlock();
            expected = 0;
            if (aliceAmt >= MIN_STAKE) expected += (aliceAmt * vault.tierMultiplier(tier)) / 1e18;
            if (bobAmt >= MIN_STAKE) expected += (bobAmt * vault.tierMultiplier(tier)) / 1e18;
            assertEq(vault.totalWeight(), expected);
        }

        if (tier == NORMAL && aliceAmt >= MIN_STAKE) {
            vm.prank(alice);
            vault.upgradeTier();
            expected = 0;
            if (aliceAmt >= MIN_STAKE) {
                expected += (aliceAmt * vault.tierMultiplier(ENHANCED)) / 1e18;
            }
            if (bobAmt >= MIN_STAKE) expected += (bobAmt * vault.tierMultiplier(NORMAL)) / 1e18;
            // bob may still be NORMAL
            (,,, uint8 bobTier) = vault.users(bob);
            expected = 0;
            (uint256 aStaked,,,) = vault.users(alice);
            (uint256 bStaked,,,) = vault.users(bob);
            if (aStaked >= MIN_STAKE) expected += (aStaked * vault.tierMultiplier(ENHANCED)) / 1e18;
            if (bStaked >= MIN_STAKE) expected += (bStaked * vault.tierMultiplier(bobTier)) / 1e18;
            assertEq(vault.totalWeight(), expected);
        }
    }

    // -------------------------------------------------------------------------
    // Bank cap (ported)
    // -------------------------------------------------------------------------

    function test_bankCap_enforced_onSettle() public {
        _deposit(alice, MIN_STAKE, NORMAL);

        uint256 cap = EMISSION_RATE * vault.BANK_CAP_SECONDS();
        assertEq(vault.capFor(alice), cap);

        vm.warp(block.timestamp + 30 days);
        assertEq(vault.ticketsOf(alice), cap, "ticketsOf clips pending to headroom");

        scratch.mint(alice, 1);
        _deposit(alice, 1, NORMAL);

        (,, uint256 banked,) = vault.users(alice);
        assertEq(banked, cap);
        assertEq(vault.ticketsOf(alice), cap);
    }

    function test_refundAboveCap_survivesDepositAndSpend() public {
        _deposit(alice, MIN_STAKE, NORMAL);

        uint256 cap = vault.capFor(alice);
        vm.warp(block.timestamp + 30 days);
        scratch.mint(alice, 1);
        _deposit(alice, 1, NORMAL);
        (,, uint256 banked,) = vault.users(alice);
        assertEq(banked, cap);

        uint256 refund = 5e18;
        vm.prank(game);
        vault.refundTicket(alice, refund);

        uint256 bankedAfterRefund = cap + refund;
        (,, banked,) = vault.users(alice);
        assertEq(banked, bankedAfterRefund);
        assertEq(vault.ticketsOf(alice), bankedAfterRefund);

        scratch.mint(alice, 1);
        _deposit(alice, 1, NORMAL);
        (,, banked,) = vault.users(alice);
        assertEq(banked, bankedAfterRefund);
        assertEq(vault.ticketsOf(alice), bankedAfterRefund);

        uint256 spendable = vault.ticketsOf(alice);
        vm.prank(game);
        vault.spendTickets(alice, spendable);
        assertEq(vault.ticketsOf(alice), 0);
    }

    function test_bankCap_shrinkDoesNotReduceExistingBanked() public {
        _deposit(alice, MIN_STAKE, NORMAL);

        uint256 soleCap = vault.capFor(alice);
        vm.warp(block.timestamp + 30 days);
        scratch.mint(alice, 1);
        _deposit(alice, 1, NORMAL);
        (,, uint256 banked,) = vault.users(alice);
        assertEq(banked, soleCap);

        _deposit(bob, MIN_STAKE, NORMAL);
        uint256 shrunkCap = vault.capFor(alice);
        assertLt(shrunkCap, soleCap);

        scratch.mint(alice, 1);
        _deposit(alice, 1, NORMAL);
        (,, banked,) = vault.users(alice);
        assertEq(banked, soleCap);
        assertEq(vault.ticketsOf(alice), soleCap);
    }

    function test_ticketsOf_matchesSpendable_refundAndCapShrink() public {
        _deposit(alice, MIN_STAKE, NORMAL);

        uint256 soleCap = vault.capFor(alice);
        vm.warp(block.timestamp + 30 days);
        scratch.mint(alice, 1);
        _deposit(alice, 1, NORMAL);

        uint256 refund = 3e18;
        vm.prank(game);
        vault.refundTicket(alice, refund);

        _deposit(bob, MIN_STAKE, NORMAL);

        vm.warp(block.timestamp + 1 days);
        uint256 spendable = vault.ticketsOf(alice);
        assertEq(spendable, soleCap + refund);

        vm.prank(game);
        vault.spendTickets(alice, spendable);
        assertEq(vault.ticketsOf(alice), 0);

        vm.prank(game);
        vm.expectRevert(StakingVaultV2.InsufficientTickets.selector);
        vault.spendTickets(alice, 1);
    }

    // -------------------------------------------------------------------------
    // Proportional burn math
    // -------------------------------------------------------------------------

    function test_proportionalBurn_1000banked_unlock60pct_burns300() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        // Force exact banked = 1000 via refund after spending any accrued.
        vm.warp(block.timestamp + 1);
        uint256 accrued = vault.ticketsOf(alice);
        vm.prank(game);
        vault.spendTickets(alice, accrued);

        vm.prank(game);
        vault.refundTicket(alice, 1000);

        (,, uint256 banked,) = vault.users(alice);
        assertEq(banked, 1000);

        uint256 unlockAmt = (MIN_STAKE * 60) / 100;
        vm.prank(alice);
        vault.requestUnlock(unlockAmt);

        (,, banked,) = vault.users(alice);
        // burn = 1000 * 5000/10000 * 60/100 = 300
        assertEq(banked, 700);
    }

    function testFuzz_burnNeverExceedsBanked(uint128 stakeRaw, uint128 unlockRaw, uint128 bankedRaw) public {
        uint256 stakeAmt = bound(stakeRaw, MIN_STAKE, 1_000_000e18);
        uint256 unlockAmt = bound(unlockRaw, 1, stakeAmt);
        uint256 bankedAmt = bound(bankedRaw, 0, 1_000_000e18);

        _deposit(alice, stakeAmt, NORMAL);
        uint256 accrued = vault.ticketsOf(alice);
        if (accrued > 0) {
            vm.prank(game);
            vault.spendTickets(alice, accrued);
        }
        if (bankedAmt > 0) {
            vm.prank(game);
            vault.refundTicket(alice, bankedAmt);
        }

        (,, uint256 before,) = vault.users(alice);
        vm.prank(alice);
        vault.requestUnlock(unlockAmt);
        (,, uint256 afterBanked,) = vault.users(alice);

        uint256 burned = before - afterBanked;
        assertLe(burned, before);
        uint256 expected = (before * uint256(BURN_BPS) * unlockAmt) / (10_000 * stakeAmt);
        assertEq(burned, expected);
    }

    function test_sequentialPartialUnlocks_eachBurnOnCurrentBase() public {
        _deposit(alice, 200e18, NORMAL);
        uint256 accrued = vault.ticketsOf(alice);
        if (accrued > 0) {
            vm.prank(game);
            vault.spendTickets(alice, accrued);
        }
        vm.prank(game);
        vault.refundTicket(alice, 1000);

        // First: unlock 50 of 200 → burn = 1000 * 0.5 * 50/200 = 125 → banked 875
        vm.prank(alice);
        vault.requestUnlock(50e18);
        (uint256 staked,, uint256 banked,) = vault.users(alice);
        assertEq(staked, 150e18);
        assertEq(banked, 875);

        // Second: unlock 75 of 150 → burn = 875 * 0.5 * 75/150 = 218 (floor)
        vm.prank(alice);
        vault.requestUnlock(75e18);
        (staked,, banked,) = vault.users(alice);
        assertEq(staked, 75e18);
        assertEq(banked, 875 - 218);
    }

    function test_ticketsSpendableDuringUnlockWindow() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        vm.warp(block.timestamp + 10);
        uint256 tickets = vault.ticketsOf(alice);
        assertGt(tickets, 0);

        vm.prank(alice);
        vault.requestUnlock(MIN_STAKE / 2);

        uint256 afterBurn = vault.ticketsOf(alice);
        assertGt(afterBurn, 0);

        vm.prank(game);
        vault.spendTickets(alice, afterBurn);
        assertEq(vault.ticketsOf(alice), 0);
    }

    function test_terminalBurn_onlyOnFullExitClaim() public {
        _deposit(alice, MIN_STAKE * 2, NORMAL);
        vm.warp(block.timestamp + 10);
        // Bank via settle
        scratch.mint(alice, 1);
        _deposit(alice, 1, NORMAL);
        (,, uint256 bankedBefore,) = vault.users(alice);
        assertGt(bankedBefore, 0);

        // Partial unlock + claim — stake remains → NO terminal burn
        vm.prank(alice);
        vault.requestUnlock(MIN_STAKE);
        vm.warp(block.timestamp + UNLOCK_NORMAL);
        vm.prank(alice);
        vault.claimUnlocked();

        (uint256 staked,, uint256 banked,) = vault.users(alice);
        assertGt(staked, 0);
        assertGt(banked, 0); // survived (minus proportional burn on request)

        // Full exit of remainder
        vm.prank(alice);
        vault.requestUnlock(staked);
        (,, banked,) = vault.users(alice);
        uint256 remainingAfterRequest = banked;
        assertGt(remainingAfterRequest, 0);

        vm.warp(block.timestamp + UNLOCK_NORMAL);
        vm.prank(alice);
        vault.claimUnlocked();

        (staked,, banked,) = vault.users(alice);
        assertEq(staked, 0);
        assertEq(banked, 0);
        (,,, uint8 tier) = vault.users(alice);
        assertEq(tier, 0); // reset for restake
    }

    function test_cancelUnlock_keepsTickets_restoresWeight() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        vm.warp(block.timestamp + 100);
        scratch.mint(alice, 1);
        _deposit(alice, 1, NORMAL);
        (,, uint256 bankedBefore,) = vault.users(alice);

        uint256 weightBefore = vault.totalWeight();
        vm.prank(alice);
        vault.requestUnlock(MIN_STAKE / 2);
        (,, uint256 bankedAfterBurn,) = vault.users(alice);
        assertLt(bankedAfterBurn, bankedBefore);
        assertLt(vault.totalWeight(), weightBefore);

        vm.prank(alice);
        vault.cancelUnlock();

        (uint256 staked,, uint256 banked,) = vault.users(alice);
        assertEq(staked, MIN_STAKE + 1);
        assertEq(banked, bankedAfterBurn); // tickets untouched on cancel
        assertEq(vault.totalWeight(), weightBefore);
        (uint256 unlockAmt,) = vault.unlocking(alice);
        assertEq(unlockAmt, 0);
    }

    function test_mergeUnlock_resetsToLaterReleaseAt() public {
        _deposit(alice, MIN_STAKE * 2, ENHANCED);

        vm.prank(alice);
        vault.requestUnlock(MIN_STAKE);
        (, uint64 firstRelease) = vault.unlocking(alice);
        assertEq(firstRelease, uint64(block.timestamp) + UNLOCK_ENHANCED);

        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        vault.requestUnlock(MIN_STAKE / 2);
        (uint256 amt, uint64 secondRelease) = vault.unlocking(alice);
        assertEq(amt, MIN_STAKE + MIN_STAKE / 2);
        assertEq(secondRelease, uint64(block.timestamp) + UNLOCK_ENHANCED);
        assertGt(secondRelease, firstRelease);
    }

    function test_claimBeforeRelease_reverts() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        vm.prank(alice);
        vault.requestUnlock(MIN_STAKE);

        vm.prank(alice);
        vm.expectRevert(StakingVaultV2.UnlockNotReady.selector);
        vault.claimUnlocked();
    }

    function test_upgradeTier_settleCorrectness() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        vm.warp(block.timestamp + 50);
        uint256 ticketsBefore = vault.ticketsOf(alice);
        assertEq(ticketsBefore, EMISSION_RATE * 50);

        vm.prank(alice);
        vault.upgradeTier();

        (,,, uint8 tier) = vault.users(alice);
        assertEq(tier, ENHANCED);
        assertEq(vault.totalWeight(), (MIN_STAKE * 12) / 10);
        // Settled into banked; no loss of prior accrual
        assertEq(vault.ticketsOf(alice), ticketsBefore);

        vm.warp(block.timestamp + 50);
        // Sole staker still gets ~100% of emission; non-1.0 weight introduces floor dust
        assertApproxEqAbs(vault.ticketsOf(alice), ticketsBefore + EMISSION_RATE * 50, 100);
    }

    function test_deposit_tierMismatch_reverts() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        vm.prank(alice);
        vm.expectRevert(StakingVaultV2.TierMismatch.selector);
        vault.deposit(1, ENHANCED);
    }

    function test_noInstantWithdraw() public {
        // withdraw selector must not exist — encode and expect empty revert / fallback fail
        _deposit(alice, MIN_STAKE, NORMAL);
        vm.prank(alice);
        (bool ok,) = address(vault).call(abi.encodeWithSignature("withdraw(uint256)", uint256(1)));
        assertFalse(ok);
    }

    // -------------------------------------------------------------------------
    // spend / refund auth (ported)
    // -------------------------------------------------------------------------

    function test_spendTickets_reverts_notGame() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        vm.warp(block.timestamp + 10);
        vm.prank(stranger);
        vm.expectRevert(StakingVaultV2.NotGame.selector);
        vault.spendTickets(alice, 1);
    }

    function test_spendTickets_reverts_insufficientBalance() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        vm.warp(block.timestamp + 10);
        vm.prank(game);
        vm.expectRevert(StakingVaultV2.InsufficientTickets.selector);
        vault.spendTickets(alice, EMISSION_RATE * 10 + 1);
    }

    function test_spendTickets_success_settlesThenSpends() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        vm.warp(block.timestamp + 100);
        uint256 spend = EMISSION_RATE * 40;
        vm.prank(game);
        vault.spendTickets(alice, spend);
        assertEq(vault.ticketsOf(alice), EMISSION_RATE * 60);
    }

    function test_refundTicket_reverts_notGame() public {
        vm.prank(stranger);
        vm.expectRevert(StakingVaultV2.NotGame.selector);
        vault.refundTicket(alice, 1e18);
    }

    function test_refundTicket_bypassesBankCap() public {
        _deposit(alice, MIN_STAKE, NORMAL);
        uint256 cap = vault.capFor(alice);
        vm.warp(block.timestamp + 30 days);
        scratch.mint(alice, 1);
        _deposit(alice, 1, NORMAL);
        (,, uint256 banked,) = vault.users(alice);
        assertEq(banked, cap);

        uint256 refund = 5e18;
        vm.prank(game);
        vault.refundTicket(alice, refund);
        (,, banked,) = vault.users(alice);
        assertEq(banked, cap + refund);
    }

    function test_setGame_oneShot() public {
        vm.prank(owner);
        vm.expectRevert(StakingVaultV2.GameAlreadySet.selector);
        vault.setGame(makeAddr("otherGame"));
    }

    // -------------------------------------------------------------------------
    // Balance conservation invariant (unit-style)
    // -------------------------------------------------------------------------

    function test_invariant_stakedPlusUnlockingPlusExternal() public {
        uint256 supply = scratch.balanceOf(alice) + scratch.balanceOf(bob);
        _deposit(alice, MIN_STAKE * 3, NORMAL);
        _deposit(bob, MIN_STAKE * 2, ENHANCED);

        vm.prank(alice);
        vault.requestUnlock(MIN_STAKE);

        uint256 sumStaked;
        uint256 sumUnlocking;
        address[2] memory actors = [alice, bob];
        for (uint256 i = 0; i < 2; i++) {
            (uint256 s,,,) = vault.users(actors[i]);
            (uint256 u,) = vault.unlocking(actors[i]);
            sumStaked += s;
            sumUnlocking += u;
        }
        assertEq(sumStaked + sumUnlocking, scratch.balanceOf(address(vault)));
        assertEq(
            scratch.balanceOf(alice) + scratch.balanceOf(bob) + scratch.balanceOf(address(vault)), supply
        );

        vm.warp(block.timestamp + UNLOCK_NORMAL);
        uint256 aliceBalBefore = scratch.balanceOf(alice);
        vm.prank(alice);
        vault.claimUnlocked();
        assertEq(scratch.balanceOf(alice), aliceBalBefore + MIN_STAKE);

        sumStaked = 0;
        sumUnlocking = 0;
        for (uint256 i = 0; i < 2; i++) {
            (uint256 s,,,) = vault.users(actors[i]);
            (uint256 u,) = vault.unlocking(actors[i]);
            sumStaked += s;
            sumUnlocking += u;
        }
        assertEq(sumStaked + sumUnlocking, scratch.balanceOf(address(vault)));
        assertEq(
            scratch.balanceOf(alice) + scratch.balanceOf(bob) + scratch.balanceOf(address(vault)), supply
        );
    }
}
