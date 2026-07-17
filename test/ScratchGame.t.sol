// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ScratchGame} from "../src/ScratchGame.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {PrizeVault} from "../src/PrizeVault.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";
import {IPrizeVault} from "../src/interfaces/IPrizeVault.sol";
import {ITicketSource} from "../src/interfaces/ITicketSource.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Covers buildspec §6 ScratchGame unit cases + critical PENDING→SETTLED / PENDING→RESCUED
///      terminal state machine (double-spend guard).
contract ScratchGameTest is Test {
    uint256 internal constant EMISSION_RATE = 1e18;
    uint256 internal constant MIN_STAKE = 100e18;
    uint64 internal constant RESCUE_DELAY = 24 hours;
    uint8 internal constant STANDARD = 0;
    uint8 internal constant PREMIUM = 1;

    MockERC20 internal scratch;
    MockERC20 internal usdg;
    StakingVault internal staking;
    PrizeVault internal prizes;
    MockRandomness internal randomness;
    ScratchGame internal game;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        scratch = new MockERC20("SCRATCH", "SCRATCH");
        usdg = new MockERC20("USDG", "USDG");

        vm.startPrank(owner);
        staking = new StakingVault(scratch, EMISSION_RATE, MIN_STAKE);
        prizes = new PrizeVault(scratch);
        randomness = new MockRandomness();
        game = new ScratchGame(prizes, randomness, RESCUE_DELAY);

        staking.setGame(address(game));
        prizes.setGame(address(game));
        game.setTicketSource(PREMIUM, ITicketSource(address(staking)));
        randomness.setCallback(address(game));
        randomness.setFulfiller(address(this));
        vm.stopPrank();

        // Fund alice with stake + accrue exactly 1 ticket.
        scratch.mint(alice, 1_000_000e18);
        vm.prank(alice);
        scratch.approve(address(staking), type(uint256).max);
        vm.prank(alice);
        staking.deposit(MIN_STAKE);
        vm.warp(block.timestamp + 1); // 1 ticket-wei * EMISSION_RATE = 1e18 tickets

        // Seed prize inventory.
        usdg.mint(address(prizes), 10_000e18);
        scratch.mint(address(prizes), 1_000_000e18);

        // Default premium table: 10% fixed 100 USDG, 20% 500 bps of pool, 70% no-win.
        // cumOdds: 100_000 | 300_000 | 1_000_000
        _setDefaultPremiumTable();
    }

    function _setDefaultPremiumTable() internal {
        ScratchGame.PrizeRow[] memory table = new ScratchGame.PrizeRow[](3);
        table[0] = ScratchGame.PrizeRow({
            asset: address(usdg),
            amountOrBps: 100e18,
            isBpsOfPool: false,
            cumOdds: 100_000
        });
        table[1] = ScratchGame.PrizeRow({
            asset: address(usdg),
            amountOrBps: 500, // 5% of pool
            isBpsOfPool: true,
            cumOdds: 300_000
        });
        table[2] = ScratchGame.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
        vm.prank(owner);
        game.setPrizeTable(PREMIUM, table);
    }

    function _accrueOneTicket(address user) internal {
        // Ensure user has enough tickets (may need more stake-time).
        uint256 need = 1e18;
        if (staking.ticketsOf(user) >= need) return;
        uint256 short = need - staking.ticketsOf(user);
        // emissionRate tickets per second for sole staker → warp ceil(short / EMISSION_RATE)
        uint256 secs = (short + EMISSION_RATE - 1) / EMISSION_RATE;
        vm.warp(block.timestamp + secs);
    }

    // -------------------------------------------------------------------------
    // Prize table validation
    // -------------------------------------------------------------------------

    function test_setPrizeTable_rejects_nonMonotonic() public {
        ScratchGame.PrizeRow[] memory table = new ScratchGame.PrizeRow[](3);
        table[0] = ScratchGame.PrizeRow(address(usdg), 1e18, false, 100_000);
        table[1] = ScratchGame.PrizeRow(address(usdg), 1e18, false, 50_000); // not monotonic
        table[2] = ScratchGame.PrizeRow(address(0), 0, false, 1_000_000);

        vm.prank(owner);
        vm.expectRevert(ScratchGame.TableNotMonotonic.selector);
        game.setPrizeTable(PREMIUM, table);
    }

    function test_setPrizeTable_rejects_equalCumOdds() public {
        ScratchGame.PrizeRow[] memory table = new ScratchGame.PrizeRow[](2);
        table[0] = ScratchGame.PrizeRow(address(usdg), 1e18, false, 1_000_000);
        table[1] = ScratchGame.PrizeRow(address(0), 0, false, 1_000_000); // not strictly increasing

        vm.prank(owner);
        vm.expectRevert(ScratchGame.TableNotMonotonic.selector);
        game.setPrizeTable(PREMIUM, table);
    }

    function test_setPrizeTable_rejects_short_empty() public {
        ScratchGame.PrizeRow[] memory table = new ScratchGame.PrizeRow[](0);
        vm.prank(owner);
        vm.expectRevert(ScratchGame.TableEmpty.selector);
        game.setPrizeTable(PREMIUM, table);
    }

    function test_setPrizeTable_rejects_wrongTerminal_not1e6() public {
        ScratchGame.PrizeRow[] memory table = new ScratchGame.PrizeRow[](2);
        table[0] = ScratchGame.PrizeRow(address(usdg), 1e18, false, 100_000);
        table[1] = ScratchGame.PrizeRow(address(0), 0, false, 999_999);

        vm.prank(owner);
        vm.expectRevert(ScratchGame.TableBadTerminal.selector);
        game.setPrizeTable(PREMIUM, table);
    }

    function test_setPrizeTable_rejects_wrongTerminal_nonzeroAsset() public {
        ScratchGame.PrizeRow[] memory table = new ScratchGame.PrizeRow[](2);
        table[0] = ScratchGame.PrizeRow(address(usdg), 1e18, false, 100_000);
        table[1] = ScratchGame.PrizeRow(address(usdg), 0, false, 1_000_000);

        vm.prank(owner);
        vm.expectRevert(ScratchGame.TableBadTerminal.selector);
        game.setPrizeTable(PREMIUM, table);
    }

    function test_setPrizeTable_accepts_valid() public {
        assertEq(game.tableLength(PREMIUM), 3);
        ScratchGame.PrizeRow memory last = game.getPrizeRow(PREMIUM, 2);
        assertEq(last.asset, address(0));
        assertEq(last.cumOdds, 1_000_000);
    }

    // -------------------------------------------------------------------------
    // Settlement row selection (boundary rolls)
    // -------------------------------------------------------------------------

    function test_settlement_roll0_mapsToFirstRow() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, 0); // roll 0 → row 0 (fixed 100e18)

        assertEq(usdg.balanceOf(alice), balBefore + 100e18);
        (,,, ScratchGame.Status status) = game.requests(id);
        assertEq(uint8(status), uint8(ScratchGame.Status.Settled));
    }

    function test_settlement_exactCumOddsEdge_mapsToNextRow() public {
        // cumOdds[0]=100_000 → roll 99_999 is row 0; roll 100_000 is row 1.
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        uint256 pool = usdg.balanceOf(address(prizes));
        uint256 expectedBps = (500 * pool) / 10_000;

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, 100_000); // roll == first edge → row 1

        assertEq(usdg.balanceOf(alice), balBefore + expectedBps);
    }

    function test_settlement_rollJustBelowFirstEdge_staysInFirstRow() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, 99_999);

        assertEq(usdg.balanceOf(alice), balBefore + 100e18);
    }

    function test_settlement_roll999999_mapsToTerminalNoWin() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, 999_999);

        assertEq(usdg.balanceOf(alice), balBefore); // no-win
        (,,, ScratchGame.Status status) = game.requests(id);
        assertEq(uint8(status), uint8(ScratchGame.Status.Settled));
    }

    function test_settlement_secondEdge_mapsToNoWin() public {
        // roll == 300_000 → row 2 (no-win)
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, 300_000);
        assertEq(usdg.balanceOf(alice), balBefore);
    }

    // -------------------------------------------------------------------------
    // bps-of-pool amount at settlement time
    // -------------------------------------------------------------------------

    function test_bpsOfPool_computedAtSettlement() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        // Change pool after scratch, before fulfill — sizing must use settlement balance.
        usdg.mint(address(prizes), 10_000e18);
        uint256 poolAtSettle = usdg.balanceOf(address(prizes));
        uint256 expected = (500 * poolAtSettle) / 10_000;

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, 100_000); // row 1: 500 bps

        assertEq(usdg.balanceOf(alice), balBefore + expected);
        assertEq(expected, 1_000e18); // 5% of 20_000e18
    }

    // -------------------------------------------------------------------------
    // Rescue path + double-spend guards
    // -------------------------------------------------------------------------

    function test_rescue_beforeDelay_reverts() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        vm.warp(block.timestamp + RESCUE_DELAY - 1);
        vm.prank(stranger);
        vm.expectRevert(ScratchGame.RescueTooEarly.selector);
        game.rescue(id);
    }

    function test_rescue_afterDelay_refundsAndMarksRescued() public {
        _accrueOneTicket(alice);
        uint256 ticketsBefore = staking.ticketsOf(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);
        assertEq(staking.ticketsOf(alice), ticketsBefore - 1e18);

        vm.warp(block.timestamp + RESCUE_DELAY);
        // Accrual during the delay is expected; assert the refund delta only.
        uint256 beforeRescue = staking.ticketsOf(alice);

        vm.prank(stranger); // anyone may rescue
        vm.expectEmit(true, true, false, true, address(game));
        emit ScratchGame.ScratchRescued(alice, id, PREMIUM);
        game.rescue(id);

        assertEq(staking.ticketsOf(alice), beforeRescue + 1e18);
        (,,, ScratchGame.Status status) = game.requests(id);
        assertEq(uint8(status), uint8(ScratchGame.Status.Rescued));
    }

    function test_fulfill_afterRescue_paysNothing_emitsLate_noRevert() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        vm.warp(block.timestamp + RESCUE_DELAY);
        game.rescue(id);

        uint256 usdgBefore = usdg.balanceOf(alice);
        uint256 ticketsAfterRescue = staking.ticketsOf(alice);

        vm.expectEmit(true, true, false, true, address(game));
        emit ScratchGame.ScratchLateFulfillment(alice, id, PREMIUM);

        // Must not revert — coordinator callback safety.
        randomness.fulfill(id, 0); // would have been a 100e18 win

        assertEq(usdg.balanceOf(alice), usdgBefore);
        assertEq(staking.ticketsOf(alice), ticketsAfterRescue);
        (,,, ScratchGame.Status status) = game.requests(id);
        assertEq(uint8(status), uint8(ScratchGame.Status.Rescued)); // stays RESCUED
    }

    function test_rescue_afterSettle_reverts() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);
        randomness.fulfill(id, 999_999);

        vm.warp(block.timestamp + RESCUE_DELAY);
        vm.expectRevert(ScratchGame.AlreadySettled.selector);
        game.rescue(id);
    }

    // -------------------------------------------------------------------------
    // fulfill auth
    // -------------------------------------------------------------------------

    function test_fulfill_reverts_notRandomness() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        vm.prank(stranger);
        vm.expectRevert(ScratchGame.NotRandomness.selector);
        game.fulfill(id, 0);
    }

    function test_scratch_reverts_ticketSourceNotSet_forStandard() public {
        // STANDARD never wired in setUp.
        _accrueOneTicket(alice);
        vm.prank(alice);
        vm.expectRevert(ScratchGame.TicketSourceNotSet.selector);
        game.scratch(STANDARD);
    }

    function test_setTicketSource_oneShot() public {
        // Deploy a second vault just to prove re-set reverts.
        StakingVault other = new StakingVault(scratch, EMISSION_RATE, MIN_STAKE);
        vm.prank(owner);
        vm.expectRevert(ScratchGame.TicketSourceAlreadySet.selector);
        game.setTicketSource(PREMIUM, ITicketSource(address(other)));
    }

    function test_scratch_spendsOneTicketAndRequests() public {
        _accrueOneTicket(alice);
        uint256 before = staking.ticketsOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(game));
        emit ScratchGame.ScratchRequested(alice, 1, PREMIUM);
        uint256 id = game.scratch(PREMIUM);

        assertEq(id, 1);
        assertEq(staking.ticketsOf(alice), before - 1e18);
        (address user, uint8 tier, uint64 requestedAt, ScratchGame.Status status) = game.requests(id);
        assertEq(user, alice);
        assertEq(tier, PREMIUM);
        assertEq(requestedAt, uint64(block.timestamp));
        assertEq(uint8(status), uint8(ScratchGame.Status.Pending));
    }

    // -------------------------------------------------------------------------
    // Randomness provider swap (timelock + grace)
    // -------------------------------------------------------------------------

    function test_randomnessSwap_queueExecute_newProviderCanFulfill() public {
        MockRandomness next = new MockRandomness();
        next.setCallback(address(game));
        next.setFulfiller(address(this));

        uint64 eta = uint64(block.timestamp) + game.RANDOMNESS_SWAP_DELAY();
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(game));
        emit ScratchGame.RandomnessSwapQueued(address(next), eta);
        game.queueRandomnessSwap(address(next));

        assertEq(game.pendingRandomness(), address(next));
        assertEq(game.randomnessSwapEta(), eta);

        vm.warp(uint256(eta));
        address oldProvider = address(randomness);
        vm.prank(owner);
        vm.expectEmit(true, true, false, true, address(game));
        emit ScratchGame.RandomnessSwapped(oldProvider, address(next));
        game.executeRandomnessSwap();

        assertEq(address(game.randomness()), address(next));
        assertEq(game.pendingRandomness(), address(0));
        assertEq(game.randomnessSwapEta(), 0);

        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        uint256 balBefore = usdg.balanceOf(alice);
        next.fulfill(id, 0); // row 0: 100e18 USDG
        assertEq(usdg.balanceOf(alice), balBefore + 100e18);
    }

    function test_randomnessSwap_executeBeforeEta_reverts() public {
        MockRandomness next = new MockRandomness();
        vm.prank(owner);
        game.queueRandomnessSwap(address(next));

        vm.warp(block.timestamp + game.RANDOMNESS_SWAP_DELAY() - 1);
        vm.prank(owner);
        vm.expectRevert(ScratchGame.RandomnessSwapNotReady.selector);
        game.executeRandomnessSwap();
    }

    function test_randomnessSwap_executeAfterGrace_revertsExpired() public {
        MockRandomness next = new MockRandomness();
        vm.prank(owner);
        game.queueRandomnessSwap(address(next));
        uint64 eta = game.randomnessSwapEta();

        vm.warp(uint256(eta) + game.RANDOMNESS_SWAP_GRACE() + 1);
        vm.prank(owner);
        vm.expectRevert(ScratchGame.RandomnessSwapExpired.selector);
        game.executeRandomnessSwap();

        // Still queued — must re-queue to get a fresh eta.
        assertEq(game.pendingRandomness(), address(next));
    }

    function test_randomnessSwap_cancel_works() public {
        MockRandomness next = new MockRandomness();
        vm.prank(owner);
        game.queueRandomnessSwap(address(next));

        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(game));
        emit ScratchGame.RandomnessSwapCancelled(address(next));
        game.cancelRandomnessSwap();

        assertEq(game.pendingRandomness(), address(0));
        assertEq(game.randomnessSwapEta(), 0);
        assertEq(address(game.randomness()), address(randomness));

        vm.warp(block.timestamp + game.RANDOMNESS_SWAP_DELAY());
        vm.prank(owner);
        vm.expectRevert(ScratchGame.NoRandomnessSwapPending.selector);
        game.executeRandomnessSwap();
    }

    function test_randomnessSwap_oldProviderFulfill_revertsAfterSwap() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        MockRandomness next = new MockRandomness();
        next.setCallback(address(game));
        next.setFulfiller(address(this));

        vm.prank(owner);
        game.queueRandomnessSwap(address(next));
        vm.warp(block.timestamp + game.RANDOMNESS_SWAP_DELAY());
        vm.prank(owner);
        game.executeRandomnessSwap();

        // Old provider's in-flight fulfill hits onlyRandomness against the new address.
        vm.expectRevert(ScratchGame.NotRandomness.selector);
        randomness.fulfill(id, 0);
    }

    // -------------------------------------------------------------------------
    // No-win settlement skips PrizeVault.payout
    // -------------------------------------------------------------------------

    function test_settlement_noWin_skipsPrizeVaultPayout() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        // Terminal no-win must not call the vault at all.
        vm.expectCall(address(prizes), abi.encodeWithSelector(IPrizeVault.payout.selector), 0);

        vm.expectEmit(true, true, false, true, address(game));
        emit ScratchGame.ScratchSettled(alice, id, PREMIUM, 2, address(0), 0);
        randomness.fulfill(id, 999_999);

        (,,, ScratchGame.Status status) = game.requests(id);
        assertEq(uint8(status), uint8(ScratchGame.Status.Settled));
    }
}
