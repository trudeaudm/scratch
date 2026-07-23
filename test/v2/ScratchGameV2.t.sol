// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ScratchGameV2} from "../../src/v2/ScratchGameV2.sol";
import {StakingVaultV2} from "../../src/v2/StakingVaultV2.sol";
import {PrizeVault} from "../../src/PrizeVault.sol";
import {MockRandomness} from "../mocks/MockRandomness.sol";
import {IPrizeVault} from "../../src/interfaces/IPrizeVault.sol";
import {ITicketSource} from "../../src/interfaces/ITicketSource.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Ported v1 ScratchGame suite against V2 + batch-native scratchMany.
contract ScratchGameV2Test is Test {

    uint256 internal constant EMISSION_RATE = 1e18;
    uint256 internal constant MIN_STAKE = 100e18;
    uint64 internal constant RESCUE_DELAY = 24 hours;
    uint64 internal constant UNLOCK_NORMAL = 2 days;
    uint64 internal constant UNLOCK_ENHANCED = 5 days;
    uint16 internal constant BOOST_BPS = 2000;
    uint16 internal constant BURN_BPS = 5000;
    uint32 internal constant ODDS = 1_000_000;
    uint8 internal constant STANDARD = 0;
    uint8 internal constant PREMIUM = 1;
    uint8 internal constant TIER_NORMAL = 1;

    MockERC20 internal scratch;
    MockERC20 internal usdg;
    StakingVaultV2 internal staking;
    PrizeVault internal prizes;
    MockRandomness internal randomness;
    ScratchGameV2 internal game;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        scratch = new MockERC20("SCRATCH", "SCRATCH");
        usdg = new MockERC20("USDG", "USDG");

        vm.startPrank(owner);
        staking = new StakingVaultV2(
            scratch, EMISSION_RATE, MIN_STAKE, UNLOCK_NORMAL, UNLOCK_ENHANCED, BOOST_BPS, BURN_BPS
        );
        prizes = new PrizeVault(scratch);
        randomness = new MockRandomness();
        game = new ScratchGameV2(prizes, randomness, RESCUE_DELAY);

        staking.setGame(address(game));
        prizes.setGame(address(game));
        game.setTicketSource(PREMIUM, ITicketSource(address(staking)));
        randomness.setCallback(address(game));
        randomness.setFulfiller(address(this));
        vm.stopPrank();

        scratch.mint(alice, 1_000_000e18);
        vm.prank(alice);
        scratch.approve(address(staking), type(uint256).max);
        vm.prank(alice);
        staking.deposit(MIN_STAKE, TIER_NORMAL);
        vm.warp(block.timestamp + 1);

        usdg.mint(address(prizes), 10_000e18);
        scratch.mint(address(prizes), 1_000_000e18);

        _setDefaultPremiumTable();
    }

    function _setDefaultPremiumTable() internal {
        ScratchGameV2.PrizeRow[] memory table = new ScratchGameV2.PrizeRow[](3);
        table[0] = ScratchGameV2.PrizeRow({
            asset: address(usdg),
            amountOrBps: 100e18,
            isBpsOfPool: false,
            cumOdds: 100_000
        });
        table[1] = ScratchGameV2.PrizeRow({
            asset: address(usdg),
            amountOrBps: 500,
            isBpsOfPool: true,
            cumOdds: 300_000
        });
        table[2] = ScratchGameV2.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
        vm.prank(owner);
        game.setPrizeTable(PREMIUM, table);
    }

    function _setAllNoWinTable() internal {
        ScratchGameV2.PrizeRow[] memory table = new ScratchGameV2.PrizeRow[](1);
        table[0] = ScratchGameV2.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
        vm.prank(owner);
        game.setPrizeTable(PREMIUM, table);
    }

    function _accrueOneTicket(address user) internal {
        _accrueTickets(user, 1);
    }

    function _accrueTickets(address user, uint256 count) internal {
        uint256 need = count * 1e18;
        if (staking.ticketsOf(user) >= need) return;
        uint256 short = need - staking.ticketsOf(user);
        uint256 secs = (short + EMISSION_RATE - 1) / EMISSION_RATE;
        vm.warp(block.timestamp + secs);
    }

    /// @dev Find `word` s.t. keccak256(abi.encode(word, cardIndex)) % ODDS == targetRoll.
    ///      Uses scratch space (no per-iter memory growth).
    function _wordForRoll(uint256 cardIndex, uint256 targetRoll) internal pure returns (uint256) {
        for (uint256 w = 0; w < 3_000_000; ++w) {
            bytes32 h;
            assembly {
                mstore(0x00, w)
                mstore(0x20, cardIndex)
                h := keccak256(0x00, 0x40)
            }
            if (uint256(h) % ODDS == targetRoll) return w;
        }
        revert("word search failed");
    }

    function _cardRoll(uint256 word, uint256 cardIndex) internal pure returns (uint256) {
        bytes32 h;
        assembly {
            mstore(0x00, word)
            mstore(0x20, cardIndex)
            h := keccak256(0x00, 0x40)
        }
        return uint256(h) % ODDS;
    }

    function _status(uint256 id) internal view returns (ScratchGameV2.Status) {
        (,,, ScratchGameV2.Status status,) = game.requests(id);
        return status;
    }

    function _count(uint256 id) internal view returns (uint8) {
        (,,,, uint8 count) = game.requests(id);
        return count;
    }

    // -------------------------------------------------------------------------
    // Prize table validation
    // -------------------------------------------------------------------------

    function test_setPrizeTable_rejects_nonMonotonic() public {
        ScratchGameV2.PrizeRow[] memory table = new ScratchGameV2.PrizeRow[](3);
        table[0] = ScratchGameV2.PrizeRow(address(usdg), 1e18, false, 100_000);
        table[1] = ScratchGameV2.PrizeRow(address(usdg), 1e18, false, 50_000);
        table[2] = ScratchGameV2.PrizeRow(address(0), 0, false, 1_000_000);
        vm.prank(owner);
        vm.expectRevert(ScratchGameV2.TableNotMonotonic.selector);
        game.setPrizeTable(PREMIUM, table);
    }

    function test_setPrizeTable_rejects_equalCumOdds() public {
        ScratchGameV2.PrizeRow[] memory table = new ScratchGameV2.PrizeRow[](2);
        table[0] = ScratchGameV2.PrizeRow(address(usdg), 1e18, false, 1_000_000);
        table[1] = ScratchGameV2.PrizeRow(address(0), 0, false, 1_000_000);
        vm.prank(owner);
        vm.expectRevert(ScratchGameV2.TableNotMonotonic.selector);
        game.setPrizeTable(PREMIUM, table);
    }

    function test_setPrizeTable_rejects_short_empty() public {
        ScratchGameV2.PrizeRow[] memory table = new ScratchGameV2.PrizeRow[](0);
        vm.prank(owner);
        vm.expectRevert(ScratchGameV2.TableEmpty.selector);
        game.setPrizeTable(PREMIUM, table);
    }

    function test_setPrizeTable_rejects_wrongTerminal_not1e6() public {
        ScratchGameV2.PrizeRow[] memory table = new ScratchGameV2.PrizeRow[](2);
        table[0] = ScratchGameV2.PrizeRow(address(usdg), 1e18, false, 100_000);
        table[1] = ScratchGameV2.PrizeRow(address(0), 0, false, 999_999);
        vm.prank(owner);
        vm.expectRevert(ScratchGameV2.TableBadTerminal.selector);
        game.setPrizeTable(PREMIUM, table);
    }

    function test_setPrizeTable_rejects_wrongTerminal_nonzeroAsset() public {
        ScratchGameV2.PrizeRow[] memory table = new ScratchGameV2.PrizeRow[](2);
        table[0] = ScratchGameV2.PrizeRow(address(usdg), 1e18, false, 100_000);
        table[1] = ScratchGameV2.PrizeRow(address(usdg), 0, false, 1_000_000);
        vm.prank(owner);
        vm.expectRevert(ScratchGameV2.TableBadTerminal.selector);
        game.setPrizeTable(PREMIUM, table);
    }

    function test_setPrizeTable_accepts_valid() public view {
        assertEq(game.tableLength(PREMIUM), 3);
        ScratchGameV2.PrizeRow memory last = game.getPrizeRow(PREMIUM, 2);
        assertEq(last.asset, address(0));
        assertEq(last.cumOdds, 1_000_000);
    }

    // -------------------------------------------------------------------------
    // Settlement (derived word for cardIndex 0)
    // -------------------------------------------------------------------------

    function test_settlement_roll0_mapsToFirstRow() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, _wordForRoll(0, 0));

        assertEq(usdg.balanceOf(alice), balBefore + 100e18);
        assertEq(uint8(_status(id)), uint8(ScratchGameV2.Status.Settled));
    }

    function test_settlement_exactCumOddsEdge_mapsToNextRow() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        uint256 pool = usdg.balanceOf(address(prizes));
        uint256 expectedBps = (500 * pool) / 10_000;

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, _wordForRoll(0, 100_000));

        assertEq(usdg.balanceOf(alice), balBefore + expectedBps);
    }

    function test_settlement_rollJustBelowFirstEdge_staysInFirstRow() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, _wordForRoll(0, 99_999));

        assertEq(usdg.balanceOf(alice), balBefore + 100e18);
    }

    function test_settlement_roll999999_mapsToTerminalNoWin() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, _wordForRoll(0, 999_999));

        assertEq(usdg.balanceOf(alice), balBefore);
        assertEq(uint8(_status(id)), uint8(ScratchGameV2.Status.Settled));
    }

    function test_settlement_secondEdge_mapsToNoWin() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, _wordForRoll(0, 300_000));
        assertEq(usdg.balanceOf(alice), balBefore);
    }

    function test_bpsOfPool_computedAtSettlement() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        usdg.mint(address(prizes), 10_000e18);
        uint256 poolAtSettle = usdg.balanceOf(address(prizes));
        uint256 expected = (500 * poolAtSettle) / 10_000;

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, _wordForRoll(0, 100_000));

        assertEq(usdg.balanceOf(alice), balBefore + expected);
        assertEq(expected, 1_000e18);
    }

    function test_singleScratch_emitsCardIndex0() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        vm.expectEmit(true, true, false, true, address(game));
        emit ScratchGameV2.ScratchSettled(alice, id, 0, PREMIUM, 0, address(usdg), 100e18);
        randomness.fulfill(id, _wordForRoll(0, 0));
    }

    // -------------------------------------------------------------------------
    // Rescue
    // -------------------------------------------------------------------------

    function test_rescue_beforeDelay_reverts() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        vm.warp(block.timestamp + RESCUE_DELAY - 1);
        vm.prank(stranger);
        vm.expectRevert(ScratchGameV2.RescueTooEarly.selector);
        game.rescue(id);
    }

    function test_rescue_afterDelay_refundsAndMarksRescued() public {
        _accrueOneTicket(alice);
        uint256 ticketsBefore = staking.ticketsOf(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);
        assertEq(staking.ticketsOf(alice), ticketsBefore - 1e18);

        vm.warp(block.timestamp + RESCUE_DELAY);
        uint256 beforeRescue = staking.ticketsOf(alice);

        vm.prank(stranger);
        vm.expectEmit(true, true, false, true, address(game));
        emit ScratchGameV2.ScratchRescued(alice, id, PREMIUM);
        game.rescue(id);

        assertEq(staking.ticketsOf(alice), beforeRescue + 1e18);
        assertEq(uint8(_status(id)), uint8(ScratchGameV2.Status.Rescued));
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
        emit ScratchGameV2.ScratchLateFulfillment(alice, id, PREMIUM, 1);
        randomness.fulfill(id, _wordForRoll(0, 0));

        assertEq(usdg.balanceOf(alice), usdgBefore);
        assertEq(staking.ticketsOf(alice), ticketsAfterRescue);
        assertEq(uint8(_status(id)), uint8(ScratchGameV2.Status.Rescued));
    }

    function test_rescue_afterSettle_reverts() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);
        randomness.fulfill(id, _wordForRoll(0, 999_999));

        vm.warp(block.timestamp + RESCUE_DELAY);
        vm.expectRevert(ScratchGameV2.AlreadySettled.selector);
        game.rescue(id);
    }

    function test_fulfill_reverts_notRandomness() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        vm.prank(stranger);
        vm.expectRevert(ScratchGameV2.NotRandomness.selector);
        game.fulfill(id, 0);
    }

    function test_scratch_reverts_ticketSourceNotSet_forStandard() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        vm.expectRevert(ScratchGameV2.TicketSourceNotSet.selector);
        game.scratch(STANDARD);
    }

    function test_setTicketSource_oneShot() public {
        StakingVaultV2 other = new StakingVaultV2(
            scratch, EMISSION_RATE, MIN_STAKE, UNLOCK_NORMAL, UNLOCK_ENHANCED, BOOST_BPS, BURN_BPS
        );
        vm.prank(owner);
        vm.expectRevert(ScratchGameV2.TicketSourceAlreadySet.selector);
        game.setTicketSource(PREMIUM, ITicketSource(address(other)));
    }

    function test_scratch_spendsOneTicketAndRequests() public {
        _accrueOneTicket(alice);
        uint256 before = staking.ticketsOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(game));
        emit ScratchGameV2.ScratchRequested(alice, 1, PREMIUM);
        uint256 id = game.scratch(PREMIUM);

        assertEq(id, 1);
        assertEq(staking.ticketsOf(alice), before - 1e18);
        (address user, uint8 tier, uint64 requestedAt, ScratchGameV2.Status status, uint8 count) =
            game.requests(id);
        assertEq(user, alice);
        assertEq(tier, PREMIUM);
        assertEq(requestedAt, uint64(block.timestamp));
        assertEq(uint8(status), uint8(ScratchGameV2.Status.Pending));
        assertEq(count, 1);
    }

    // -------------------------------------------------------------------------
    // Randomness swap
    // -------------------------------------------------------------------------

    function test_randomnessSwap_queueExecute_newProviderCanFulfill() public {
        MockRandomness next = new MockRandomness();
        next.setCallback(address(game));
        next.setFulfiller(address(this));

        uint64 eta = uint64(block.timestamp) + game.RANDOMNESS_SWAP_DELAY();
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(game));
        emit ScratchGameV2.RandomnessSwapQueued(address(next), eta);
        game.queueRandomnessSwap(address(next));

        vm.warp(uint256(eta));
        address oldProvider = address(randomness);
        vm.prank(owner);
        vm.expectEmit(true, true, false, true, address(game));
        emit ScratchGameV2.RandomnessSwapped(oldProvider, address(next));
        game.executeRandomnessSwap();

        assertEq(address(game.randomness()), address(next));

        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        uint256 balBefore = usdg.balanceOf(alice);
        next.fulfill(id, _wordForRoll(0, 0));
        assertEq(usdg.balanceOf(alice), balBefore + 100e18);
    }

    function test_randomnessSwap_executeBeforeEta_reverts() public {
        MockRandomness next = new MockRandomness();
        vm.prank(owner);
        game.queueRandomnessSwap(address(next));

        vm.warp(block.timestamp + game.RANDOMNESS_SWAP_DELAY() - 1);
        vm.prank(owner);
        vm.expectRevert(ScratchGameV2.RandomnessSwapNotReady.selector);
        game.executeRandomnessSwap();
    }

    function test_randomnessSwap_executeAfterGrace_revertsExpired() public {
        MockRandomness next = new MockRandomness();
        vm.prank(owner);
        game.queueRandomnessSwap(address(next));
        uint64 eta = game.randomnessSwapEta();

        vm.warp(uint256(eta) + game.RANDOMNESS_SWAP_GRACE() + 1);
        vm.prank(owner);
        vm.expectRevert(ScratchGameV2.RandomnessSwapExpired.selector);
        game.executeRandomnessSwap();

        assertEq(game.pendingRandomness(), address(next));
    }

    function test_randomnessSwap_cancel_works() public {
        MockRandomness next = new MockRandomness();
        vm.prank(owner);
        game.queueRandomnessSwap(address(next));

        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(game));
        emit ScratchGameV2.RandomnessSwapCancelled(address(next));
        game.cancelRandomnessSwap();

        assertEq(game.pendingRandomness(), address(0));
        assertEq(address(game.randomness()), address(randomness));

        vm.warp(block.timestamp + game.RANDOMNESS_SWAP_DELAY());
        vm.prank(owner);
        vm.expectRevert(ScratchGameV2.NoRandomnessSwapPending.selector);
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

        vm.expectRevert(ScratchGameV2.NotRandomness.selector);
        randomness.fulfill(id, 0);
    }

    function test_settlement_noWin_skipsPrizeVaultPayout() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        vm.expectCall(address(prizes), abi.encodeWithSelector(IPrizeVault.payout.selector), 0);

        vm.expectEmit(true, true, false, true, address(game));
        emit ScratchGameV2.ScratchSettled(alice, id, 0, PREMIUM, 2, address(0), 0);
        randomness.fulfill(id, _wordForRoll(0, 999_999));

        assertEq(uint8(_status(id)), uint8(ScratchGameV2.Status.Settled));
    }

    // -------------------------------------------------------------------------
    // Batch-native scratchMany
    // -------------------------------------------------------------------------

    function test_scratchMany_count1() public {
        _accrueTickets(alice, 1);
        uint256 before = staking.ticketsOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true, address(game));
        emit ScratchGameV2.ScratchBatch(alice, PREMIUM, 1, 1);
        uint256 id = game.scratchMany(PREMIUM, 1);

        assertEq(id, 1);
        assertEq(staking.ticketsOf(alice), before - 1e18);
        assertEq(_count(id), 1);
        assertEq(uint8(_status(id)), uint8(ScratchGameV2.Status.Pending));
    }

    function test_scratchMany_count20_oneRequest() public {
        _accrueTickets(alice, 20);
        uint256 before = staking.ticketsOf(alice);

        vm.prank(alice);
        uint256 id = game.scratchMany(PREMIUM, 20);

        assertEq(id, 1);
        assertEq(staking.ticketsOf(alice), before - 20e18);
        assertEq(_count(id), 20);
        // Only one request issued — next single gets id 2
        _accrueTickets(alice, 1);
        vm.prank(alice);
        assertEq(game.scratch(PREMIUM), 2);
    }

    function test_scratchMany_count21_reverts() public {
        _accrueTickets(alice, 21);
        vm.prank(alice);
        vm.expectRevert(ScratchGameV2.InvalidBatchCount.selector);
        game.scratchMany(PREMIUM, 21);
    }

    function test_scratchMany_count0_reverts() public {
        vm.prank(alice);
        vm.expectRevert(ScratchGameV2.InvalidBatchCount.selector);
        game.scratchMany(PREMIUM, 0);
    }

    function test_scratchMany_insufficient_reverts() public {
        _accrueTickets(alice, 2);
        assertLt(staking.ticketsOf(alice), 5e18);
        vm.prank(alice);
        vm.expectRevert(StakingVaultV2.InsufficientTickets.selector);
        game.scratchMany(PREMIUM, 5);
    }

    function test_scratchMany_20cards_settleInOneFulfill() public {
        _accrueTickets(alice, 20);
        vm.prank(alice);
        uint256 id = game.scratchMany(PREMIUM, 20);

        uint256 word = 42;
        // Derived words must differ across cards.
        assertTrue(_cardRoll(word, 0) != _cardRoll(word, 1));

        randomness.fulfill(id, word);
        assertEq(uint8(_status(id)), uint8(ScratchGameV2.Status.Settled));
        // No second pending request was created.
        (,,, ScratchGameV2.Status s2,) = game.requests(2);
        assertEq(uint8(s2), uint8(ScratchGameV2.Status.None));
    }

    function test_scratchMany_perCardDerivedWordsDiffer() public pure {
        uint256 word = 12345;
        uint256 a = _cardRoll(word, 0);
        uint256 distinct = 1;
        for (uint256 i = 1; i < 8; i++) {
            if (_cardRoll(word, i) != a) distinct++;
        }
        assertGe(distinct, 2);
    }

    function test_scratchMany_aggregationPaysExactSumPerAsset() public {
        _accrueTickets(alice, 5);
        vm.prank(alice);
        uint256 id = game.scratchMany(PREMIUM, 5);

        uint256 word = 7;
        uint256 pool = usdg.balanceOf(address(prizes));
        uint256 expected;
        for (uint256 i = 0; i < 5; i++) {
            uint256 roll = _cardRoll(word, i);
            if (roll < 100_000) expected += 100e18;
            else if (roll < 300_000) expected += (500 * pool) / 10_000;
        }

        uint256 balBefore = usdg.balanceOf(alice);
        // Exactly one payout call for USDG if expected > 0
        if (expected > 0) {
            vm.expectCall(
                address(prizes),
                abi.encodeWithSelector(IPrizeVault.payout.selector, alice, address(usdg), expected),
                1
            );
        } else {
            vm.expectCall(address(prizes), abi.encodeWithSelector(IPrizeVault.payout.selector), 0);
        }
        randomness.fulfill(id, word);
        assertEq(usdg.balanceOf(alice), balBefore + expected);
    }

    function testFuzz_scratchMany_aggregationMatchesPerCardSum(uint256 word, uint8 countRaw) public {
        uint8 count = uint8(bound(countRaw, 1, 20));
        _accrueTickets(alice, count);
        vm.prank(alice);
        uint256 id = game.scratchMany(PREMIUM, count);

        uint256 pool = usdg.balanceOf(address(prizes));
        uint256 expected;
        for (uint256 i = 0; i < count; i++) {
            uint256 roll = _cardRoll(word, i);
            if (roll < 100_000) expected += 100e18;
            else if (roll < 300_000) expected += (500 * pool) / 10_000;
        }

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, word);
        assertEq(usdg.balanceOf(alice), balBefore + expected);
    }

    function test_scratchMany_allNoWin_zeroVaultCalls() public {
        _setAllNoWinTable();
        _accrueTickets(alice, 10);
        vm.prank(alice);
        uint256 id = game.scratchMany(PREMIUM, 10);

        vm.expectCall(address(prizes), abi.encodeWithSelector(IPrizeVault.payout.selector), 0);
        randomness.fulfill(id, 1);
        assertEq(uint8(_status(id)), uint8(ScratchGameV2.Status.Settled));
    }

    function test_scratchMany_rescueRefundsCountTickets() public {
        _accrueTickets(alice, 7);
        uint256 before = staking.ticketsOf(alice);
        vm.prank(alice);
        uint256 id = game.scratchMany(PREMIUM, 7);
        assertEq(staking.ticketsOf(alice), before - 7e18);

        vm.warp(block.timestamp + RESCUE_DELAY);
        uint256 mid = staking.ticketsOf(alice);
        game.rescue(id);
        assertEq(staking.ticketsOf(alice), mid + 7e18);
        assertEq(uint8(_status(id)), uint8(ScratchGameV2.Status.Rescued));
    }

    function test_scratchMany_lateFulfill_notesCount() public {
        _accrueTickets(alice, 4);
        vm.prank(alice);
        uint256 id = game.scratchMany(PREMIUM, 4);
        vm.warp(block.timestamp + RESCUE_DELAY);
        game.rescue(id);

        vm.expectEmit(true, true, false, true, address(game));
        emit ScratchGameV2.ScratchLateFulfillment(alice, id, PREMIUM, 4);
        randomness.fulfill(id, 0);
    }

    function test_requestStruct_packedSingleSlot() public {
        _accrueOneTicket(alice);
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        // `requests` mapping lives at slot 7 (forge inspect: numberOfBytes=32 for Request).
        bytes32 slot = keccak256(abi.encode(id, uint256(7)));
        bytes32 raw = vm.load(address(game), slot);
        assertTrue(uint256(raw) != 0);

        // Reconstruct fields from the public getter and confirm they round-trip.
        (address user, uint8 tier, uint64 requestedAt, ScratchGameV2.Status status, uint8 count) =
            game.requests(id);
        assertEq(user, alice);
        assertEq(tier, PREMIUM);
        assertEq(uint8(status), uint8(ScratchGameV2.Status.Pending));
        assertEq(count, 1);
        assertEq(requestedAt, uint64(block.timestamp));

        // Request is 248 bits in one slot — no spill into slot+1.
        bytes32 spill = vm.load(address(game), bytes32(uint256(slot) + 1));
        assertEq(uint256(spill), 0);
    }

    function test_bpsOfPool_usesPreBatchBalanceAcrossCards() public {
        // Table: 100% bps-of-pool so every card hits the same snapshot.
        ScratchGameV2.PrizeRow[] memory table = new ScratchGameV2.PrizeRow[](2);
        table[0] = ScratchGameV2.PrizeRow({
            asset: address(usdg),
            amountOrBps: 100, // 1% of pool
            isBpsOfPool: true,
            cumOdds: 1_000_000 - 1
        });
        table[1] = ScratchGameV2.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
        vm.prank(owner);
        game.setPrizeTable(PREMIUM, table);

        _accrueTickets(alice, 3);
        vm.prank(alice);
        uint256 id = game.scratchMany(PREMIUM, 3);

        uint256 pool = usdg.balanceOf(address(prizes));
        uint256 perCard = (100 * pool) / 10_000;

        // Find a word where all 3 cards land in the bps row (roll < 999999).
        uint256 word;
        for (uint256 w = 0; w < 100_000; w++) {
            bool ok = true;
            for (uint256 i = 0; i < 3; i++) {
                if (_cardRoll(w, i) >= 999_999) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                word = w;
                break;
            }
        }

        uint256 balBefore = usdg.balanceOf(alice);
        randomness.fulfill(id, word);
        // 3 × 1% of the SAME pre-batch pool (not depleting between cards).
        assertEq(usdg.balanceOf(alice), balBefore + perCard * 3);
    }
}
