// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {StakingVault} from "../../src/StakingVault.sol";
import {StandardTicketSource} from "../../src/StandardTicketSource.sol";
import {PrizeVault} from "../../src/PrizeVault.sol";
import {ScratchGame} from "../../src/ScratchGame.sol";
import {MockRandomness} from "../mocks/MockRandomness.sol";

contract MockScratch is ERC20 {
    constructor() ERC20("SCRATCH", "SCRATCH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Stateful fuzz handler for buildspec §6 invariants. Ghost counters cover ticket
///      conservation across StakingVault (premium) and StandardTicketSource (standard).
///      Every spend/refund path asserts no cross-source leakage; deposit/withdraw/scratch
///      assert other users' `banked` is unchanged.
contract ScratchHandler is Test {
    uint256 internal constant TICKET = 1e18;
    uint8 internal constant STANDARD = 0;
    uint8 internal constant PREMIUM = 1;

    MockScratch public immutable scratch;
    MockScratch public immutable prizeAsset;
    StakingVault public immutable staking;
    StandardTicketSource public immutable standard;
    PrizeVault public immutable prizes;
    /// @notice Separate vault used only to probe payout fallback (handler is `game`).
    PrizeVault public immutable prizeProbe;
    ScratchGame public immutable game;
    MockRandomness public immutable randomness;
    address public immutable crediter;

    address[] public actors;

    // --- Ghosts: premium (StakingVault emission) ---
    uint256 public ghostPremiumEmitted;
    uint256 public ghostPremiumSpent;
    uint256 public ghostPremiumRefunded;
    uint256 public ghostPremiumBurned;

    // --- Ghosts: standard (grant + credit) ---
    uint256 public ghostStandardGranted;
    uint256 public ghostStandardCredited;
    uint256 public ghostStandardSpent;
    uint256 public ghostStandardRefunded;
    uint256 public ghostStandardExpired;

    // --- Cross-source / isolation / prize ghosts ---
    uint256 public ghostCrossLeak;
    uint256 public ghostBankedIsolationBroken;
    uint256 public ghostInvalidPayout;
    uint256 public ghostCalls;

    uint256[] public pendingRequests;

    constructor(
        MockScratch scratch_,
        MockScratch prizeAsset_,
        StakingVault staking_,
        StandardTicketSource standard_,
        PrizeVault prizes_,
        PrizeVault prizeProbe_,
        ScratchGame game_,
        MockRandomness randomness_,
        address crediter_,
        address[] memory actors_
    ) {
        scratch = scratch_;
        prizeAsset = prizeAsset_;
        staking = staking_;
        standard = standard_;
        prizes = prizes_;
        prizeProbe = prizeProbe_;
        game = game_;
        randomness = randomness_;
        crediter = crediter_;
        for (uint256 i = 0; i < actors_.length; i++) {
            actors.push(actors_[i]);
        }
    }

    // -------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------

    /// @notice Advance time and accrue global premium emission into the ghost.
    function warp(uint256 secs) external {
        secs = bound(secs, 1, 3 days);
        if (staking.totalStaked() > 0) {
            ghostPremiumEmitted += staking.emissionRate() * secs;
        }
        for (uint256 i = 0; i < actors.length; i++) {
            uint64 exp = standard.expiryOf(actors[i]);
            uint256 bal = standard.ticketsOf(actors[i]);
            if (bal > 0 && exp != 0 && block.timestamp + secs > exp) {
                ghostStandardExpired += bal;
            }
        }
        vm.warp(block.timestamp + secs);
        ghostCalls++;
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        amount = bound(amount, 1, 50_000e18);

        uint256 bal = scratch.balanceOf(actor);
        if (bal < amount) {
            scratch.mint(actor, amount - bal);
        }

        uint256[] memory snap = _snapshotOthersBanked(actor);

        vm.startPrank(actor);
        scratch.approve(address(staking), amount);
        staking.deposit(amount);
        vm.stopPrank();

        _checkOthersBanked(actor, snap);
        ghostCalls++;
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        (uint256 staked,,) = staking.users(actor);
        if (staked == 0) return;
        amount = bound(amount, 1, staked);

        uint256 ticketsBefore = staking.ticketsOf(actor);
        uint256 standardBefore = standard.ticketsOf(actor);
        uint256[] memory snap = _snapshotOthersBanked(actor);

        vm.prank(actor);
        staking.withdraw(amount);

        ghostPremiumBurned += ticketsBefore;
        if (standard.ticketsOf(actor) != standardBefore) ghostCrossLeak++;
        _checkOthersBanked(actor, snap);
        ghostCalls++;
    }

    function grantTickets(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        amount = bound(amount, 1, 10e18);

        // Mirror StandardTicketSource day-bucket sync (public getters lag until a write).
        uint256 day = block.timestamp / 1 days;
        uint256 usedBefore = day == standard.grantDayBucket() ? standard.grantUsedToday() : 0;
        uint256 cap = standard.grantDailyCap();
        uint256 remaining = cap > usedBefore ? cap - usedBefore : 0;
        if (amount > remaining) amount = remaining;
        if (amount == 0) return;

        address[] memory users = new address[](1);
        users[0] = actor;

        vm.prank(standard.owner());
        standard.grant(users, amount);
        ghostStandardGranted += amount;
        ghostCalls++;
    }

    function creditTickets(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        amount = bound(amount, 1, 5e18);

        (bool auth, uint256 dailyCap, uint256 usedToday, uint256 dayBucket) = standard.crediters(crediter);
        if (!auth) return;
        uint256 day = block.timestamp / 1 days;
        uint256 used = day == dayBucket ? usedToday : 0;
        uint256 remaining = dailyCap > used ? dailyCap - used : 0;
        if (amount > remaining) amount = remaining;
        if (amount == 0) return;

        uint256 beforeBal = standard.ticketsOf(actor);
        vm.prank(crediter);
        standard.credit(actor, amount);
        uint256 afterBal = standard.ticketsOf(actor);
        if (afterBal > beforeBal) {
            ghostStandardCredited += afterBal - beforeBal;
        }
        ghostCalls++;
    }

    function scratchPremium(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        if (staking.ticketsOf(actor) < TICKET) return;

        uint256 premiumBefore = staking.ticketsOf(actor);
        uint256 standardBefore = standard.ticketsOf(actor);
        uint256[] memory snap = _snapshotOthersBanked(actor);

        vm.prank(actor);
        uint256 requestId = game.scratch(PREMIUM);

        ghostPremiumSpent += TICKET;
        pendingRequests.push(requestId);

        // ticketsOf includes pending headroom; settle+spend must drop by exactly TICKET.
        if (staking.ticketsOf(actor) != premiumBefore - TICKET) ghostCrossLeak++;
        if (standard.ticketsOf(actor) != standardBefore) ghostCrossLeak++;
        _checkOthersBanked(actor, snap);
        ghostCalls++;
    }

    function scratchStandard(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        if (standard.ticketsOf(actor) < TICKET) return;

        uint256 premiumBefore = staking.ticketsOf(actor);
        uint256 standardBefore = standard.ticketsOf(actor);
        (,, uint256 bankedBefore) = staking.users(actor);
        uint256[] memory snap = _snapshotOthersBanked(actor);

        vm.prank(actor);
        uint256 requestId = game.scratch(STANDARD);

        ghostStandardSpent += TICKET;
        pendingRequests.push(requestId);

        if (standard.ticketsOf(actor) + TICKET != standardBefore) ghostCrossLeak++;
        if (staking.ticketsOf(actor) != premiumBefore) ghostCrossLeak++;
        (,, uint256 bankedAfter) = staking.users(actor);
        if (bankedAfter != bankedBefore) ghostCrossLeak++;
        _checkOthersBanked(actor, snap);
        ghostCalls++;
    }

    function fulfill(uint256 requestSeed, uint256 word) external {
        if (pendingRequests.length == 0) return;
        uint256 idx = requestSeed % pendingRequests.length;
        uint256 requestId = pendingRequests[idx];

        (,,, ScratchGame.Status status) = game.requests(requestId);
        if (status != ScratchGame.Status.Pending) {
            _removePending(idx);
            return;
        }

        randomness.fulfill(requestId, word);
        _removePending(idx);
        ghostCalls++;
    }

    function rescue(uint256 requestSeed) external {
        if (pendingRequests.length == 0) return;
        uint256 idx = requestSeed % pendingRequests.length;
        uint256 requestId = pendingRequests[idx];

        (address user, uint8 tier, uint64 requestedAt, ScratchGame.Status status) = game.requests(requestId);
        if (status != ScratchGame.Status.Pending) {
            _removePending(idx);
            return;
        }
        if (block.timestamp < uint256(requestedAt) + game.rescueDelay()) return;

        // Use banked (not ticketsOf) for premium: a refund that fills the bank cap
        // clips pending headroom in the view, so ticketsOf may not rise by exactly TICKET.
        (,, uint256 premiumBankedBefore) = staking.users(user);
        uint256 premiumTicketsBefore = staking.ticketsOf(user);
        uint256 standardBefore = standard.ticketsOf(user);

        game.rescue(requestId);

        if (tier == PREMIUM) {
            ghostPremiumRefunded += TICKET;
            (,, uint256 premiumBankedAfter) = staking.users(user);
            if (premiumBankedAfter != premiumBankedBefore + TICKET) ghostCrossLeak++;
            if (standard.ticketsOf(user) != standardBefore) ghostCrossLeak++;
        } else {
            ghostStandardRefunded += TICKET;
            if (standard.ticketsOf(user) != standardBefore + TICKET) ghostCrossLeak++;
            if (staking.ticketsOf(user) != premiumTicketsBefore) ghostCrossLeak++;
        }

        _removePending(idx);
        ghostCalls++;
    }

    /// @notice Direct payout probe on `prizeProbe` (handler is game): cannot pay an
    ///         asset the vault does not hold without falling back.
    function probePayout(uint256 assetSeed, uint256 amount, uint256 toSeed) external {
        address to = _actor(toSeed);
        address asset = assetSeed % 2 == 0 ? address(prizeAsset) : address(scratch);
        amount = bound(amount, 1, 1_000_000e18);

        uint256 assetBefore = IERC20(asset).balanceOf(address(prizeProbe));
        uint256 scratchBefore = scratch.balanceOf(address(prizeProbe));

        prizeProbe.payout(to, asset, amount);

        uint256 assetAfter = IERC20(asset).balanceOf(address(prizeProbe));
        uint256 scratchAfter = scratch.balanceOf(address(prizeProbe));

        if (assetAfter > assetBefore || scratchAfter > scratchBefore) {
            ghostInvalidPayout++;
        }

        if (asset != address(scratch)) {
            if (assetBefore < amount) {
                // Must not have transferred the prize asset.
                if (assetAfter != assetBefore) ghostInvalidPayout++;
            } else {
                bool paidPrimary = (assetAfter + amount == assetBefore);
                bool fellBack = (assetAfter == assetBefore);
                if (!paidPrimary && !fellBack) ghostInvalidPayout++;
            }
        } else {
            // Paying SCRATCH: underfunded path must not invent balance.
            if (assetBefore < amount && assetAfter < assetBefore) {
                // Underfunded SCRATCH "success" transfer is impossible; fallback pays 0.
                ghostInvalidPayout++;
            }
        }

        ghostCalls++;
    }

    function fundProbe(uint256 amount) external {
        amount = bound(amount, 1, 10_000e18);
        prizeAsset.mint(address(this), amount);
        prizeAsset.approve(address(prizeProbe), amount);
        prizeProbe.fund(address(prizeAsset), amount);

        scratch.mint(address(this), amount);
        scratch.approve(address(prizeProbe), amount);
        prizeProbe.fund(address(scratch), amount);
        ghostCalls++;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _snapshotOthersBanked(address actor) internal view returns (uint256[] memory snap) {
        snap = new uint256[](actors.length);
        for (uint256 i = 0; i < actors.length; i++) {
            if (actors[i] == actor) continue;
            (,, snap[i]) = staking.users(actors[i]);
        }
    }

    function _checkOthersBanked(address actor, uint256[] memory snap) internal {
        for (uint256 i = 0; i < actors.length; i++) {
            if (actors[i] == actor) continue;
            (,, uint256 banked) = staking.users(actors[i]);
            if (banked != snap[i]) ghostBankedIsolationBroken++;
        }
    }

    function _removePending(uint256 idx) internal {
        uint256 last = pendingRequests.length - 1;
        pendingRequests[idx] = pendingRequests[last];
        pendingRequests.pop();
    }
}
