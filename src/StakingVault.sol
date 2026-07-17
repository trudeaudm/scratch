// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ITicketSource} from "./interfaces/ITicketSource.sol";

/// @title StakingVault
/// @notice Holds staked SCRATCH and accrues premium-tier tickets at a fixed global
///         emission rate, pro-rata by eligible stake above `minStake`. Implements
///         ITicketSource for ScratchGame. No admin power over user deposits: the
///         only path that moves principal is the staker's own `withdraw`. Any
///         withdrawal (including partial) burns that user's pending and banked tickets.
/// @dev Per-ticket rolling expiry is intentionally NOT implemented onchain in v1.
///      The bank cap (`BANK_CAP_SECONDS` of earnings at the user's current rate) limits
///      only newly banked accrual via headroom — existing `banked` is never reduced
///      (approved deviation from scratch-spec.md §3).
contract StakingVault is ITicketSource, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Banked tickets are capped at what the user would earn in this many
    ///         seconds at their current pro-rata emission rate (computed at touch).
    uint256 public constant BANK_CAP_SECONDS = 7 days;

    /// @notice SCRATCH token held by the vault.
    IERC20 public immutable scratch;

    /// @notice Ticket-wei emitted per second across the eligible staking pool.
    uint256 public immutable emissionRate;

    /// @notice Minimum stake (SCRATCH-wei) required for a wallet to accrue tickets.
    uint256 public immutable minStake;

    /// @notice Sum of stakes belonging to eligible users (`staked >= minStake`).
    uint256 public totalStaked;

    /// @notice MasterChef-style accumulator: ticket-wei per share, 1e18-scaled.
    uint256 public accTicketsPerShare;

    /// @notice Timestamp of the last accumulator update.
    uint64 public lastUpdate;

    /// @notice Sole address allowed to `spendTickets` / `refundTicket` (set once).
    address public game;

    struct User {
        uint256 staked;
        uint256 debt;
        uint256 banked;
    }

    mapping(address => User) public users;

    event Deposited(address indexed user, uint256 amount);
    /// @notice Emitted on any withdrawal. `ticketsBurned` is pending + banked (anti-flicker).
    event Withdrawn(address indexed user, uint256 amount, uint256 ticketsBurned);
    event TicketsSpent(address indexed user, uint256 amount);
    event TicketsRefunded(address indexed user, uint256 amount);
    event GameSet(address indexed game);

    error ZeroAddress();
    error ZeroAmount();
    error GameAlreadySet();
    error NotGame();
    error InsufficientStake();
    error InsufficientTickets();

    modifier onlyGame() {
        if (msg.sender != game) revert NotGame();
        _;
    }

    /// @param scratch_ SCRATCH ERC-20.
    /// @param emissionRate_ Ticket-wei per second for the vault pool.
    /// @param minStake_ Eligibility threshold in SCRATCH-wei.
    constructor(IERC20 scratch_, uint256 emissionRate_, uint256 minStake_) Ownable(msg.sender) {
        if (address(scratch_) == address(0)) revert ZeroAddress();
        scratch = scratch_;
        emissionRate = emissionRate_;
        minStake = minStake_;
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

    /// @notice Deposit SCRATCH. Stake above `minStake` begins accruing tickets.
    /// @dev CEI: accounting is updated before `transferFrom`; a failing pull reverts the
    ///      whole transaction (including stake), and `nonReentrant` blocks reentry.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _update();

        User storage user = users[msg.sender];
        // Stake of 0 is never eligible even if `minStake == 0` (avoids totalStaked=0 settle).
        bool wasEligible = user.staked >= minStake && user.staked != 0;
        if (wasEligible) {
            _settle(msg.sender);
        }

        uint256 oldStake = user.staked;
        uint256 newStake = oldStake + amount;
        user.staked = newStake;

        bool nowEligible = newStake >= minStake && newStake != 0;
        if (!wasEligible && nowEligible) {
            totalStaked += newStake;
        } else if (wasEligible && nowEligible) {
            totalStaked += amount;
        }

        user.debt = nowEligible ? (newStake * accTicketsPerShare) / 1e18 : 0;

        scratch.safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw SCRATCH. ANY withdrawal — full or partial — burns this user's
    ///         pending and banked tickets (anti-flicker). There is no pause and no
    ///         admin path that can block or redirect this call.
    /// @param amount SCRATCH-wei to withdraw.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _update();

        User storage user = users[msg.sender];
        if (user.staked < amount) revert InsufficientStake();

        bool wasEligible = user.staked >= minStake && user.staked != 0;
        uint256 pending = wasEligible ? _pending(user) : 0;
        uint256 ticketsBurned = user.banked + pending;

        user.banked = 0;

        uint256 oldStake = user.staked;
        uint256 newStake = oldStake - amount;
        user.staked = newStake;

        bool nowEligible = newStake >= minStake && newStake != 0;
        if (wasEligible && nowEligible) {
            totalStaked -= amount;
        } else if (wasEligible && !nowEligible) {
            totalStaked -= oldStake;
        }

        user.debt = nowEligible ? (newStake * accTicketsPerShare) / 1e18 : 0;

        scratch.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount, ticketsBurned);
    }

    /// @inheritdoc ITicketSource
    function spendTickets(address user, uint256 amount) external onlyGame {
        if (amount == 0) revert ZeroAmount();
        _update();

        User storage u = users[user];
        if (u.staked >= minStake && u.staked != 0) {
            _settle(user);
        }
        if (u.banked < amount) revert InsufficientTickets();

        u.banked -= amount;
        emit TicketsSpent(user, amount);
    }

    /// @inheritdoc ITicketSource
    /// @dev Rescue refunds MUST bypass the bank cap. A refund restores tickets the user
    ///      already spent into a stuck ScratchGame request; those tickets were earned
    ///      under the normal capped accrual path. Clipping a rescue would permanently
    ///      destroy value the user already paid for with stake-time, turning a VRF
    ///      outage into a silent ticket burn. Cap enforcement on deposit/spend settle
    ///      uses headroom only — it never reduces existing `banked`, so refunds survive.
    function refundTicket(address user, uint256 amount) external onlyGame {
        if (user == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        users[user].banked += amount;
        emit TicketsRefunded(user, amount);
    }

    /// @inheritdoc ITicketSource
    /// @dev Mirrors `_settle` headroom math: existing `banked` is never clipped in the
    ///      view (refunds / prior banks stay visible); only freshly accrued pending is
    ///      limited to headroom so the result equals what `spendTickets` can take.
    function ticketsOf(address user) external view returns (uint256) {
        User storage u = users[user];
        uint256 pending = 0;
        if (u.staked >= minStake && u.staked != 0 && totalStaked > 0) {
            uint256 acc = accTicketsPerShare;
            uint256 elapsed = block.timestamp - lastUpdate;
            if (elapsed > 0) {
                acc += (emissionRate * elapsed * 1e18) / totalStaked;
            }
            pending = (u.staked * acc) / 1e18 - u.debt;

            uint256 cap = (u.staked * emissionRate * BANK_CAP_SECONDS) / totalStaked;
            uint256 headroom = u.banked >= cap ? 0 : cap - u.banked;
            if (pending > headroom) pending = headroom;
        }
        return u.banked + pending;
    }

    /// @notice Tickets the user would earn over `BANK_CAP_SECONDS` at their current rate.
    /// @dev Returns 0 when ineligible or when `totalStaked` is 0.
    function capFor(address user) public view returns (uint256) {
        User storage u = users[user];
        if (u.staked < minStake || u.staked == 0 || totalStaked == 0) return 0;
        return (u.staked * emissionRate * BANK_CAP_SECONDS) / totalStaked;
    }

    function _update() internal {
        if (totalStaked > 0) {
            uint256 elapsed = block.timestamp - lastUpdate;
            if (elapsed > 0) {
                accTicketsPerShare += (emissionRate * elapsed * 1e18) / totalStaked;
            }
        }
        lastUpdate = uint64(block.timestamp);
    }

    /// @dev Bank pending into `banked` using headroom under the 7-day cap, then sync debt.
    ///      The cap limits only newly banked accrual — it never reduces existing `banked`
    ///      (rescue refunds above cap and prior banks survive settle / cap shrinkage).
    ///      Caller must have already `_update()`'d and confirmed eligibility.
    function _settle(address account) internal {
        User storage u = users[account];
        uint256 pending = _pending(u);
        uint256 cap = (u.staked * emissionRate * BANK_CAP_SECONDS) / totalStaked;
        uint256 headroom = u.banked >= cap ? 0 : cap - u.banked;
        u.banked += pending > headroom ? headroom : pending;
        u.debt = (u.staked * accTicketsPerShare) / 1e18;
    }

    function _pending(User storage u) internal view returns (uint256) {
        return (u.staked * accTicketsPerShare) / 1e18 - u.debt;
    }
}
