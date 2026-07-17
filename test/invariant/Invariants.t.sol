// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {StakingVault} from "../../src/StakingVault.sol";
import {StandardTicketSource} from "../../src/StandardTicketSource.sol";
import {PrizeVault} from "../../src/PrizeVault.sol";
import {ScratchGame} from "../../src/ScratchGame.sol";
import {ITicketSource} from "../../src/interfaces/ITicketSource.sol";
import {MockRandomness} from "../mocks/MockRandomness.sol";
import {ScratchHandler, MockScratch} from "./ScratchHandler.sol";

/// @dev Buildspec §6 invariant/fuzz suite — four invariants, with StandardTicketSource
///      included in ticket conservation (spent ≤ emitted+granted+credited across BOTH
///      sources; no cross-source leakage).
contract InvariantsTest is StdInvariant, Test {
    uint256 internal constant EMISSION_RATE = 1e18;
    uint256 internal constant MIN_STAKE = 100e18;
    uint64 internal constant RESCUE_DELAY = 1 hours;
    uint256 internal constant PROMO_DAILY_CAP = 10_000e18;
    uint8 internal constant STANDARD = 0;
    uint8 internal constant PREMIUM = 1;

    MockScratch internal scratch;
    MockScratch internal prizeAsset;
    StakingVault internal staking;
    StandardTicketSource internal standard;
    PrizeVault internal prizes;
    PrizeVault internal prizeProbe;
    ScratchGame internal game;
    MockRandomness internal randomness;
    ScratchHandler internal handler;

    address internal owner = address(this);
    address internal crediter = makeAddr("crediter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        scratch = new MockScratch();
        prizeAsset = new MockScratch(); // reuse mintable ERC20 as stand-in prize asset

        staking = new StakingVault(scratch, EMISSION_RATE, MIN_STAKE);
        standard = new StandardTicketSource(PROMO_DAILY_CAP);
        prizes = new PrizeVault(scratch);
        prizeProbe = new PrizeVault(scratch);
        randomness = new MockRandomness();
        game = new ScratchGame(prizes, randomness, RESCUE_DELAY);

        staking.setGame(address(game));
        standard.setGame(address(game));
        prizes.setGame(address(game));
        game.setTicketSource(PREMIUM, ITicketSource(address(staking)));
        game.setTicketSource(STANDARD, ITicketSource(address(standard)));
        randomness.setCallback(address(game));

        _setTables();

        standard.addCrediter(crediter, 5_000e18);

        // Seed prize inventory for fulfill path.
        prizeAsset.mint(address(this), 1_000_000e18);
        prizeAsset.approve(address(prizes), type(uint256).max);
        prizes.fund(address(prizeAsset), 500_000e18);
        scratch.mint(address(this), 1_000_000e18);
        scratch.approve(address(prizes), type(uint256).max);
        prizes.fund(address(scratch), 500_000e18);
        prizes.setFallbackRate(address(prizeAsset), 1e18);

        address[] memory actors = new address[](3);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;

        handler = new ScratchHandler(
            scratch,
            prizeAsset,
            staking,
            standard,
            prizes,
            prizeProbe,
            game,
            randomness,
            crediter,
            actors
        );

        prizeProbe.setGame(address(handler));
        prizeProbe.setFallbackRate(address(prizeAsset), 1e18);
        randomness.setFulfiller(address(handler));

        // Seed actors with SCRATCH so deposit fuzz has fuel.
        scratch.mint(alice, 1_000_000e18);
        scratch.mint(bob, 1_000_000e18);
        scratch.mint(carol, 1_000_000e18);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = ScratchHandler.warp.selector;
        selectors[1] = ScratchHandler.deposit.selector;
        selectors[2] = ScratchHandler.withdraw.selector;
        selectors[3] = ScratchHandler.grantTickets.selector;
        selectors[4] = ScratchHandler.creditTickets.selector;
        selectors[5] = ScratchHandler.scratchPremium.selector;
        selectors[6] = ScratchHandler.scratchStandard.selector;
        selectors[7] = ScratchHandler.fulfill.selector;
        selectors[8] = ScratchHandler.rescue.selector;
        selectors[9] = ScratchHandler.probePayout.selector;
        selectors[10] = ScratchHandler.fundProbe.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // -------------------------------------------------------------------------
    // (1) Stake accounting + vault solvency
    // -------------------------------------------------------------------------

    /// @notice sum(eligible stakes) == totalStaked; vault SCRATCH ≥ totalStaked;
    ///         sum(all tracked stakes) == vault balance (handler never donates).
    function invariant_stakeAccounting() public view {
        uint256 sumAll;
        uint256 sumEligible;
        uint256 n = handler.actorCount();
        for (uint256 i = 0; i < n; i++) {
            address a = handler.actorAt(i);
            (uint256 staked,,) = staking.users(a);
            sumAll += staked;
            if (staked >= MIN_STAKE && staked != 0) {
                sumEligible += staked;
            }
        }
        assertEq(sumEligible, staking.totalStaked(), "eligible sum != totalStaked");
        assertGe(scratch.balanceOf(address(staking)), staking.totalStaked(), "vault insolvent vs totalStaked");
        assertEq(scratch.balanceOf(address(staking)), sumAll, "vault balance != sum stakes");
    }

    // -------------------------------------------------------------------------
    // (2) Ticket conservation across BOTH sources + no cross-source leakage
    // -------------------------------------------------------------------------

    /// @notice Premium: spent ≤ emitted + refunded.
    ///         Standard: spent ≤ granted + credited + refunded.
    ///         No cross-source leakage observed during handler actions.
    function invariant_ticketConservation() public view {
        assertLe(
            handler.ghostPremiumSpent(),
            handler.ghostPremiumEmitted() + handler.ghostPremiumRefunded(),
            "premium spent > emitted+refunded"
        );
        assertLe(
            handler.ghostStandardSpent(),
            handler.ghostStandardGranted() + handler.ghostStandardCredited() + handler.ghostStandardRefunded(),
            "standard spent > granted+credited+refunded"
        );
        assertEq(handler.ghostCrossLeak(), 0, "cross-source ticket leakage");
    }

    // -------------------------------------------------------------------------
    // (3) PrizeVault never pays an asset it does not hold without falling back
    // -------------------------------------------------------------------------

    function invariant_prizeVaultFallback() public view {
        assertEq(handler.ghostInvalidPayout(), 0, "payout without balance and without fallback");
        // Probe vault balances are never negative (ERC-20) and scratch/probe asset
        // holdings are consistent with fund - payout effects already gated above.
        assertGe(scratch.balanceOf(address(prizeProbe)), 0);
        assertGe(IERC20(address(prizeAsset)).balanceOf(address(prizeProbe)), 0);
    }

    // -------------------------------------------------------------------------
    // (4) No sequence changes another user's banked
    // -------------------------------------------------------------------------

    function invariant_bankedIsolation() public view {
        assertEq(handler.ghostBankedIsolationBroken(), 0, "other user's banked changed");
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _setTables() internal {
        ScratchGame.PrizeRow[] memory premium = new ScratchGame.PrizeRow[](3);
        premium[0] = ScratchGame.PrizeRow({
            asset: address(prizeAsset),
            amountOrBps: 10e18,
            isBpsOfPool: false,
            cumOdds: 100_000
        });
        premium[1] = ScratchGame.PrizeRow({
            asset: address(scratch),
            amountOrBps: 50e18,
            isBpsOfPool: false,
            cumOdds: 400_000
        });
        premium[2] = ScratchGame.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
        game.setPrizeTable(PREMIUM, premium);

        ScratchGame.PrizeRow[] memory stdTable = new ScratchGame.PrizeRow[](2);
        stdTable[0] = ScratchGame.PrizeRow({
            asset: address(scratch),
            amountOrBps: 1e18,
            isBpsOfPool: false,
            cumOdds: 100_000
        });
        stdTable[1] = ScratchGame.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
        game.setPrizeTable(STANDARD, stdTable);
    }
}
