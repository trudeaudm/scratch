// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ITicketSource} from "../interfaces/ITicketSource.sol";

/// @title StakingVaultV2
/// @notice Holds staked SCRATCH and accrues premium-tier tickets at a fixed global
///         emission rate, pro-rata by eligible *weight* (staked × tier multiplier).
///         Two lock tiers: NORMAL (base weight) and ENHANCED (base + `boostBps`).
///
///         Principal is custodied by no one and exits only through the holder's own
///         timed unlock (`requestUnlock` → wait → `claimUnlocked`). There is no
///         instant-withdraw path and no owner function over deposits — ownership is
///         renounced at deploy after `setGame`. Unlock requests burn tickets
///         proportionally (`burnBps` × fraction unlocked); a completed full exit
///         (claim that leaves `staked == 0`) burns any remaining banked tickets.
///
/// @dev Weight leaves the active set on `requestUnlock` (no accrual while unlocking).
///      Remaining tickets stay fully spendable and expire on the normal bank-cap
///      schedule — "scratch your way out" during the unlock window is supported.
///      Repeated request/cancel cycles each pay the proportional burn on request,
///      so cycling is self-penalizing. ENHANCED→NORMAL requires a full exit and restake.
contract StakingVaultV2 is ITicketSource, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Banked tickets are capped at what the user would earn in this many
    ///         seconds at their current pro-rata emission rate (computed at touch).
    uint256 public constant BANK_CAP_SECONDS = 7 days;

    /// @notice Basis-points denominator.
    uint256 public constant BPS_DENOM = 10_000;

    /// @notice Lock tier: unset until first deposit; then NORMAL or ENHANCED.
    uint8 public constant TIER_UNSET = 0;
    uint8 public constant TIER_NORMAL = 1;
    uint8 public constant TIER_ENHANCED = 2;

    /// @notice SCRATCH token held by the vault.
    IERC20 public immutable scratch;

    /// @notice Ticket-wei emitted per second across the eligible weight pool.
    uint256 public immutable emissionRate;

    /// @notice Minimum stake (SCRATCH-wei) required for a wallet to accrue tickets.
    /// @dev Eligibility checks raw `staked`, not weight.
    uint256 public immutable minStake;

    /// @notice Unlock hold for NORMAL tier (seconds).
    uint64 public immutable unlockNormal;

    /// @notice Unlock hold for ENHANCED tier (seconds).
    uint64 public immutable unlockEnhanced;

    /// @notice Extra weight for ENHANCED as bps of base (e.g. 2000 = +20% → 1.2×).
    uint16 public immutable boostBps;

    /// @notice Fraction of banked tickets burned on each unlock request, in bps
    ///         (e.g. 5000 = 50%), scaled by `amount / stakedBefore`.
    uint16 public immutable burnBps;

    /// @notice Sum of eligible user weights (`staked * tierMult / 1e18` for
    ///         users with `staked >= minStake`).
    uint256 public totalWeight;

    /// @notice Sum of all unlocking amounts across users (solvency helper).
    uint256 public totalUnlocking;

    /// @notice MasterChef-style accumulator: ticket-wei per weight-share, 1e18-scaled.
    uint256 public accTicketsPerShare;

    /// @notice Timestamp of the last accumulator update.
    uint64 public lastUpdate;

    /// @notice Sole address allowed to `spendTickets` / `refundTicket` (set once).
    address public game;

    struct User {
        uint256 staked;
        uint256 debt;
        uint256 banked;
        uint8 tier;
    }

    /// @notice Per-user timed unlock slot. A second `requestUnlock` merges `amount`
    ///         and sets `releaseAt` to the later of the two deadlines.
    struct Unlock {
        uint256 amount;
        uint64 releaseAt;
    }

    mapping(address => User) public users;
    mapping(address => Unlock) public unlocking;

    event Deposited(address indexed user, uint256 amount, uint8 tier);
    event UnlockRequested(
        address indexed user, uint256 amount, uint256 ticketsBurned, uint64 releaseAt
    );
    event UnlockClaimed(address indexed user, uint256 amount, uint256 terminalTicketsBurned);
    event UnlockCancelled(address indexed user, uint256 amount);
    event TierUpgraded(address indexed user, uint8 fromTier, uint8 toTier);
    event TicketsSpent(address indexed user, uint256 amount);
    event TicketsRefunded(address indexed user, uint256 amount);
    event GameSet(address indexed game);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroPeriod();
    error InvalidTier();
    error TierMismatch();
    error TierUnset();
    error AlreadyEnhanced();
    error NotNormal();
    error GameAlreadySet();
    error NotGame();
    error InsufficientStake();
    error InsufficientTickets();
    error NothingUnlocking();
    error UnlockNotReady();
    error BurnBpsTooHigh();

    modifier onlyGame() {
        if (msg.sender != game) revert NotGame();
        _;
    }

    /// @param scratch_ SCRATCH ERC-20.
    /// @param emissionRate_ Ticket-wei per second for the vault pool.
    /// @param minStake_ Eligibility threshold in SCRATCH-wei (raw stake).
    /// @param unlockNormal_ NORMAL unlock period (seconds).
    /// @param unlockEnhanced_ ENHANCED unlock period (seconds).
    /// @param boostBps_ ENHANCED weight premium in bps of base (e.g. 2000 = +20%).
    /// @param burnBps_ Proportional ticket burn on unlock request (e.g. 5000 = 50%).
    constructor(
        IERC20 scratch_,
        uint256 emissionRate_,
        uint256 minStake_,
        uint64 unlockNormal_,
        uint64 unlockEnhanced_,
        uint16 boostBps_,
        uint16 burnBps_
    ) Ownable(msg.sender) {
        if (address(scratch_) == address(0)) revert ZeroAddress();
        if (unlockNormal_ == 0 || unlockEnhanced_ == 0) revert ZeroPeriod();
        if (burnBps_ > BPS_DENOM) revert BurnBpsTooHigh();
        scratch = scratch_;
        emissionRate = emissionRate_;
        minStake = minStake_;
        unlockNormal = unlockNormal_;
        unlockEnhanced = unlockEnhanced_;
        boostBps = boostBps_;
        burnBps = burnBps_;
        lastUpdate = uint64(block.timestamp);
    }

    /// @notice One-shot wiring of the ScratchGame address allowed to spend/refund tickets.
    /// @dev Ownership renounce is left to the deploy script after wiring.
    function setGame(address game_) external onlyOwner {
        if (game != address(0)) revert GameAlreadySet();
        if (game_ == address(0)) revert ZeroAddress();
        game = game_;
        emit GameSet(game_);
    }

    /// @notice Deposit SCRATCH into `tier`. First deposit sets the user's tier;
    ///         later deposits must match it. Stake above `minStake` begins accruing
    ///         at the tier's weight.
    /// @dev CEI: accounting is updated before `transferFrom`.
    function deposit(uint256 amount, uint8 tier) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (tier != TIER_NORMAL && tier != TIER_ENHANCED) revert InvalidTier();
        _update();

        User storage user = users[msg.sender];
        if (user.tier == TIER_UNSET) {
            user.tier = tier;
        } else if (user.tier != tier) {
            revert TierMismatch();
        }

        bool wasEligible = _isEligible(user.staked);
        if (wasEligible) {
            _settle(msg.sender);
        }

        uint256 oldStake = user.staked;
        uint256 oldWeight = wasEligible ? _weightOf(oldStake, user.tier) : 0;
        uint256 newStake = oldStake + amount;
        user.staked = newStake;

        bool nowEligible = _isEligible(newStake);
        uint256 newWeight = nowEligible ? _weightOf(newStake, user.tier) : 0;
        totalWeight = totalWeight - oldWeight + newWeight;

        user.debt = nowEligible ? (newWeight * accTicketsPerShare) / 1e18 : 0;

        scratch.safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, amount, user.tier);
    }

    /// @notice Upgrade from NORMAL to ENHANCED anytime. Instant; settles accrual first
    ///         then re-weights future accrual. ENHANCED→NORMAL only via full unlock
    ///         and restake.
    function upgradeTier() external nonReentrant {
        _update();

        User storage user = users[msg.sender];
        if (user.tier == TIER_UNSET) revert TierUnset();
        if (user.tier == TIER_ENHANCED) revert AlreadyEnhanced();
        if (user.tier != TIER_NORMAL) revert NotNormal();

        bool wasEligible = _isEligible(user.staked);
        if (wasEligible) {
            _settle(msg.sender);
        }

        uint256 oldWeight = wasEligible ? _weightOf(user.staked, TIER_NORMAL) : 0;
        user.tier = TIER_ENHANCED;
        uint256 newWeight = wasEligible ? _weightOf(user.staked, TIER_ENHANCED) : 0;
        totalWeight = totalWeight - oldWeight + newWeight;

        user.debt = wasEligible ? (newWeight * accTicketsPerShare) / 1e18 : 0;

        emit TierUpgraded(msg.sender, TIER_NORMAL, TIER_ENHANCED);
    }

    /// @notice Begin a timed unlock of `amount` SCRATCH. Settles pending into banked
    ///         first, then burns `banked * burnBps / 10_000 * amount / stakedBefore`
    ///         (floor). Moves `amount` into the per-user unlocking slot; a second
    ///         request merges amounts and sets `releaseAt` to the later of the two.
    ///         Unlocking amount leaves `totalWeight` immediately. Remaining tickets
    ///         stay spendable. Note: each request/cancel cycle pays this burn again.
    /// @param amount SCRATCH-wei to unlock (from active `staked` only).
    function requestUnlock(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _update();

        User storage user = users[msg.sender];
        if (user.staked < amount) revert InsufficientStake();

        bool wasEligible = _isEligible(user.staked);
        if (wasEligible) {
            _settle(msg.sender);
        }

        uint256 stakedBefore = user.staked;
        uint256 burn = (user.banked * uint256(burnBps) * amount) / (BPS_DENOM * stakedBefore);
        user.banked -= burn;

        uint256 oldWeight = wasEligible ? _weightOf(stakedBefore, user.tier) : 0;
        uint256 newStake = stakedBefore - amount;
        user.staked = newStake;

        bool nowEligible = _isEligible(newStake);
        uint256 newWeight = nowEligible ? _weightOf(newStake, user.tier) : 0;
        totalWeight = totalWeight - oldWeight + newWeight;
        user.debt = nowEligible ? (newWeight * accTicketsPerShare) / 1e18 : 0;

        Unlock storage slot = unlocking[msg.sender];
        uint64 period = user.tier == TIER_ENHANCED ? unlockEnhanced : unlockNormal;
        uint64 newRelease = uint64(block.timestamp) + period;
        if (slot.amount == 0) {
            slot.releaseAt = newRelease;
        } else if (newRelease > slot.releaseAt) {
            slot.releaseAt = newRelease;
        }
        slot.amount += amount;
        totalUnlocking += amount;

        emit UnlockRequested(msg.sender, amount, burn, slot.releaseAt);
    }

    /// @notice After `releaseAt`, transfer the unlocking slot to the caller and clear it.
    ///         If `staked == 0` after the claim (full exit), burn ALL remaining banked
    ///         tickets (terminal burn — no leaving with a ticket bag). A partial claim
    ///         with stake remaining does not terminal-burn.
    function claimUnlocked() external nonReentrant {
        Unlock storage slot = unlocking[msg.sender];
        uint256 amount = slot.amount;
        if (amount == 0) revert NothingUnlocking();
        if (block.timestamp < slot.releaseAt) revert UnlockNotReady();

        slot.amount = 0;
        slot.releaseAt = 0;
        totalUnlocking -= amount;

        uint256 terminalBurn = 0;
        User storage user = users[msg.sender];
        if (user.staked == 0) {
            // Full exit: terminal ticket burn + clear tier so restake may pick NORMAL or ENHANCED.
            terminalBurn = user.banked;
            user.banked = 0;
            user.tier = TIER_UNSET;
            user.debt = 0;
        }

        scratch.safeTransfer(msg.sender, amount);

        emit UnlockClaimed(msg.sender, amount, terminalBurn);
    }

    /// @notice Re-stake the entire unlocking slot at the user's current tier.
    ///         Tickets are NOT touched — whatever survived earlier burns remains.
    /// @dev Repeated request/cancel cycles each pay the proportional burn on
    ///      `requestUnlock`, so cycling is self-penalizing.
    function cancelUnlock() external nonReentrant {
        Unlock storage slot = unlocking[msg.sender];
        uint256 amount = slot.amount;
        if (amount == 0) revert NothingUnlocking();

        _update();

        User storage user = users[msg.sender];
        bool wasEligible = _isEligible(user.staked);
        if (wasEligible) {
            _settle(msg.sender);
        }

        uint256 oldWeight = wasEligible ? _weightOf(user.staked, user.tier) : 0;
        uint256 newStake = user.staked + amount;
        user.staked = newStake;

        slot.amount = 0;
        slot.releaseAt = 0;
        totalUnlocking -= amount;

        bool nowEligible = _isEligible(newStake);
        uint256 newWeight = nowEligible ? _weightOf(newStake, user.tier) : 0;
        totalWeight = totalWeight - oldWeight + newWeight;
        user.debt = nowEligible ? (newWeight * accTicketsPerShare) / 1e18 : 0;

        emit UnlockCancelled(msg.sender, amount);
    }

    /// @inheritdoc ITicketSource
    function spendTickets(address user, uint256 amount) external onlyGame {
        if (amount == 0) revert ZeroAmount();
        _update();

        User storage u = users[user];
        if (_isEligible(u.staked)) {
            _settle(user);
        }
        if (u.banked < amount) revert InsufficientTickets();

        u.banked -= amount;
        emit TicketsSpent(user, amount);
    }

    /// @inheritdoc ITicketSource
    /// @dev Rescue refunds MUST bypass the bank cap (same posture as v1).
    function refundTicket(address user, uint256 amount) external onlyGame {
        if (user == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        users[user].banked += amount;
        emit TicketsRefunded(user, amount);
    }

    /// @inheritdoc ITicketSource
    /// @dev Mirrors `_settle` headroom math over weight shares.
    function ticketsOf(address user) external view returns (uint256) {
        User storage u = users[user];
        uint256 pending = 0;
        if (_isEligible(u.staked) && totalWeight > 0) {
            uint256 w = _weightOf(u.staked, u.tier);
            uint256 acc = accTicketsPerShare;
            uint256 elapsed = block.timestamp - lastUpdate;
            if (elapsed > 0) {
                acc += (emissionRate * elapsed * 1e18) / totalWeight;
            }
            pending = (w * acc) / 1e18 - u.debt;

            uint256 cap = (w * emissionRate * BANK_CAP_SECONDS) / totalWeight;
            uint256 headroom = u.banked >= cap ? 0 : cap - u.banked;
            if (pending > headroom) pending = headroom;
        }
        return u.banked + pending;
    }

    /// @notice Tickets the user would earn over `BANK_CAP_SECONDS` at their current rate.
    function capFor(address user) public view returns (uint256) {
        User storage u = users[user];
        if (!_isEligible(u.staked) || totalWeight == 0) return 0;
        uint256 w = _weightOf(u.staked, u.tier);
        return (w * emissionRate * BANK_CAP_SECONDS) / totalWeight;
    }

    /// @notice Weight multiplier for `tier` (1e18-scaled). ENHANCED = 1e18 * (1 + boostBps/10_000).
    function tierMultiplier(uint8 tier) public view returns (uint256) {
        if (tier == TIER_ENHANCED) {
            return 1e18 + (1e18 * uint256(boostBps)) / BPS_DENOM;
        }
        if (tier == TIER_NORMAL) {
            return 1e18;
        }
        return 0;
    }

    /// @notice Unlock period for `tier`.
    function unlockPeriod(uint8 tier) public view returns (uint64) {
        if (tier == TIER_ENHANCED) return unlockEnhanced;
        if (tier == TIER_NORMAL) return unlockNormal;
        return 0;
    }

    function _update() internal {
        if (totalWeight > 0) {
            uint256 elapsed = block.timestamp - lastUpdate;
            if (elapsed > 0) {
                accTicketsPerShare += (emissionRate * elapsed * 1e18) / totalWeight;
            }
        }
        lastUpdate = uint64(block.timestamp);
    }

    /// @dev Bank pending into `banked` using headroom under the 7-day cap, then sync debt.
    ///      Caller must have already `_update()`'d and confirmed eligibility.
    function _settle(address account) internal {
        User storage u = users[account];
        uint256 w = _weightOf(u.staked, u.tier);
        uint256 pending = (w * accTicketsPerShare) / 1e18 - u.debt;
        uint256 cap = (w * emissionRate * BANK_CAP_SECONDS) / totalWeight;
        uint256 headroom = u.banked >= cap ? 0 : cap - u.banked;
        u.banked += pending > headroom ? headroom : pending;
        u.debt = (w * accTicketsPerShare) / 1e18;
    }

    function _isEligible(uint256 staked) internal view returns (bool) {
        return staked >= minStake && staked != 0;
    }

    function _weightOf(uint256 staked, uint8 tier) internal view returns (uint256) {
        return (staked * tierMultiplier(tier)) / 1e18;
    }
}
