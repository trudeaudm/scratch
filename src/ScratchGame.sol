// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPrizeVault} from "./interfaces/IPrizeVault.sol";
import {IRandomness, IRandomnessCallback} from "./interfaces/IRandomness.sol";
import {ITicketSource} from "./interfaces/ITicketSource.sol";

/// @title ScratchGame
/// @notice Burns one ticket, requests randomness via IRandomness, maps the outcome
///         onto a cumulative-odds prize table, and instructs PrizeVault to pay.
///         Commit-then-reveal via VRF so settlement precedes any UI reveal. Stuck
///         requests past `rescueDelay` can be rescued (ticket refunded).
/// @dev Each request is exactly one of PENDING → SETTLED or PENDING → RESCUED;
///      both transitions are terminal. Late VRF after rescue emits
///      `ScratchLateFulfillment` and returns without paying (must not revert the
///      coordinator callback). Rescue after settle reverts (blocks double-spend).
///
///      Randomness provider swap runbook: `queueRandomnessSwap` → wait until every
///      in-flight request under the old provider is SETTLED or RESCUED →
///      `executeRandomnessSwap`. In-flight fulfills from the old provider after a
///      swap revert at `onlyRandomness`. Because `rescueDelay` < `RANDOMNESS_SWAP_DELAY`,
///      that drain window always exists before the swap becomes executable.
contract ScratchGame is IRandomnessCallback, Ownable2Step, ReentrancyGuard {
    /// @notice Ticket-wei spent per scratch (1 full ticket).
    uint256 public constant TICKET_COST = 1e18;

    /// @notice Cumulative-odds denominator (rows validated to end at this value).
    uint32 public constant ODDS_DENOM = 1_000_000;

    /// @notice Phase-3 voucher tier slot (reserved; wire via `setTicketSource`).
    uint8 public constant STANDARD = 0;

    /// @notice Premium tier (v1: StakingVault).
    uint8 public constant PREMIUM = 1;

    /// @notice Number of tiers (indices 0..TIER_COUNT-1).
    uint8 public constant TIER_COUNT = 2;

    /// @notice Delay between `queueRandomnessSwap` and `executeRandomnessSwap`.
    uint64 public constant RANDOMNESS_SWAP_DELAY = 48 hours;

    /// @notice Window after `randomnessSwapEta` during which `executeRandomnessSwap`
    ///         may succeed; after `eta + RANDOMNESS_SWAP_GRACE` the queued swap
    ///         expires and must be re-queued.
    uint64 public constant RANDOMNESS_SWAP_GRACE = 24 hours;

    /// @notice Prize vault that pays winners.
    IPrizeVault public immutable prizeVault;

    /// @notice Randomness provider; sole authorized `fulfill` caller (swappable
    ///         behind `RANDOMNESS_SWAP_DELAY`).
    IRandomness public randomness;

    /// @notice Seconds after request before anyone may `rescue`.
    uint64 public immutable rescueDelay;

    /// @notice Pending randomness provider from `queueRandomnessSwap` (zero if none).
    address public pendingRandomness;

    /// @notice Earliest timestamp at which `executeRandomnessSwap` may succeed.
    uint64 public randomnessSwapEta;

    /// @notice Per-tier ticket source (one-shot). PREMIUM wired to StakingVault in v1.
    mapping(uint8 => ITicketSource) public ticketSource;

    /// @notice Cumulative-odds prize table per tier.
    mapping(uint8 => PrizeRow[]) private _tables;

    enum Status {
        None,
        Pending,
        Settled,
        Rescued
    }

    /// @notice Prize row. `cumOdds` is cumulative out of `ODDS_DENOM`.
    ///         Last row must be no-win (`asset == address(0)`, `cumOdds == ODDS_DENOM`).
    struct PrizeRow {
        address asset;
        uint96 amountOrBps;
        bool isBpsOfPool;
        uint32 cumOdds;
    }

    struct Request {
        address user;
        uint8 tier;
        uint64 requestedAt;
        Status status;
    }

    mapping(uint256 => Request) public requests;

    event TicketSourceSet(uint8 indexed tier, address indexed source);
    event PrizeTableSet(uint8 indexed tier, PrizeRow[] table);
    event ScratchRequested(address indexed user, uint256 indexed requestId, uint8 tier);
    event ScratchSettled(
        address indexed user,
        uint256 indexed requestId,
        uint8 tier,
        uint256 rowIndex,
        address asset,
        uint256 amount
    );
    event ScratchRescued(address indexed user, uint256 indexed requestId, uint8 tier);
    /// @notice VRF arrived after the request was already rescued; no prize paid.
    event ScratchLateFulfillment(address indexed user, uint256 indexed requestId, uint8 tier);
    event RandomnessSwapQueued(address indexed newProvider, uint64 eta);
    event RandomnessSwapCancelled(address indexed pendingProvider);
    event RandomnessSwapped(address indexed oldProvider, address indexed newProvider);

    error ZeroAddress();
    error ZeroDelay();
    error InvalidTier();
    error TicketSourceAlreadySet();
    error TicketSourceNotSet();
    error TableEmpty();
    error TableNotMonotonic();
    error TableBadTerminal();
    error RequestUnknown();
    error NotPending();
    error AlreadySettled();
    error RescueTooEarly();
    error NotRandomness();
    error NoRandomnessSwapPending();
    error RandomnessSwapNotReady();
    error RandomnessSwapExpired();

    modifier onlyRandomness() {
        if (msg.sender != address(randomness)) revert NotRandomness();
        _;
    }

    /// @param prizeVault_ Multi-asset prize inventory.
    /// @param randomness_ IRandomness adapter (constructor-set; swappable via timelock).
    /// @param rescueDelay_ Stuck-request escape delay (e.g. 24h prod / 600 rehearsal).
    constructor(IPrizeVault prizeVault_, IRandomness randomness_, uint64 rescueDelay_) Ownable(msg.sender) {
        if (address(prizeVault_) == address(0) || address(randomness_) == address(0)) revert ZeroAddress();
        if (rescueDelay_ == 0) revert ZeroDelay();
        prizeVault = prizeVault_;
        randomness = randomness_;
        rescueDelay = rescueDelay_;
    }

    /// @notice One-shot wiring of the ticket source for `tier` (0 = STANDARD, 1 = PREMIUM).
    function setTicketSource(uint8 tier, ITicketSource source) external onlyOwner {
        if (tier >= TIER_COUNT) revert InvalidTier();
        if (address(source) == address(0)) revert ZeroAddress();
        if (address(ticketSource[tier]) != address(0)) revert TicketSourceAlreadySet();
        ticketSource[tier] = source;
        emit TicketSourceSet(tier, address(source));
    }

    /// @notice Replace the prize table for `tier`. Validates monotonic strictly-increasing
    ///         `cumOdds` ending at exactly `ODDS_DENOM` with a terminal no-win row
    ///         (`asset == address(0)`).
    function setPrizeTable(uint8 tier, PrizeRow[] calldata table) external onlyOwner {
        if (tier >= TIER_COUNT) revert InvalidTier();
        _validateTable(table);

        delete _tables[tier];
        PrizeRow[] storage dest = _tables[tier];
        for (uint256 i = 0; i < table.length; i++) {
            dest.push(table[i]);
        }

        emit PrizeTableSet(tier, table);
    }

    /// @notice Queue a randomness-provider swap after `RANDOMNESS_SWAP_DELAY`.
    /// @dev Runbook: queue → drain all old-provider pendings (settle or rescue) →
    ///      execute. `rescueDelay` < `RANDOMNESS_SWAP_DELAY` guarantees that window.
    function queueRandomnessSwap(address newProvider) external onlyOwner {
        if (newProvider == address(0)) revert ZeroAddress();
        pendingRandomness = newProvider;
        uint64 eta = uint64(block.timestamp) + RANDOMNESS_SWAP_DELAY;
        randomnessSwapEta = eta;
        emit RandomnessSwapQueued(newProvider, eta);
    }

    /// @notice Cancel a queued randomness-provider swap.
    function cancelRandomnessSwap() external onlyOwner {
        address pending = pendingRandomness;
        if (pending == address(0)) revert NoRandomnessSwapPending();
        pendingRandomness = address(0);
        randomnessSwapEta = 0;
        emit RandomnessSwapCancelled(pending);
    }

    /// @notice Execute a queued swap in `[eta, eta + RANDOMNESS_SWAP_GRACE]`.
    /// @dev After the grace window the queue expires (`RandomnessSwapExpired`) and
    ///      must be re-queued. Execute only after all old-provider requests are
    ///      SETTLED or RESCUED — late fulfills from the old provider revert at
    ///      `onlyRandomness`.
    function executeRandomnessSwap() external onlyOwner {
        address pending = pendingRandomness;
        if (pending == address(0)) revert NoRandomnessSwapPending();
        uint64 eta = randomnessSwapEta;
        if (block.timestamp < eta) revert RandomnessSwapNotReady();
        if (block.timestamp > uint256(eta) + RANDOMNESS_SWAP_GRACE) revert RandomnessSwapExpired();

        address oldProvider = address(randomness);
        randomness = IRandomness(pending);
        pendingRandomness = address(0);
        randomnessSwapEta = 0;
        emit RandomnessSwapped(oldProvider, pending);
    }

    /// @notice Spend one ticket from `tier`'s source and request randomness.
    /// @param tier STANDARD (0) or PREMIUM (1).
    function scratch(uint8 tier) external nonReentrant returns (uint256 requestId) {
        if (tier >= TIER_COUNT) revert InvalidTier();
        ITicketSource source = ticketSource[tier];
        if (address(source) == address(0)) revert TicketSourceNotSet();
        if (_tables[tier].length == 0) revert TableEmpty();

        source.spendTickets(msg.sender, TICKET_COST);

        requestId = randomness.requestRandomFor(msg.sender);
        requests[requestId] = Request({
            user: msg.sender,
            tier: tier,
            requestedAt: uint64(block.timestamp),
            status: Status.Pending
        });

        emit ScratchRequested(msg.sender, requestId, tier);
    }

    /// @inheritdoc IRandomnessCallback
    /// @dev Late fulfillment after rescue: emit `ScratchLateFulfillment` and return —
    ///      must not revert (breaks the coordinator callback) and must not pay a prize.
    ///      Terminal no-win (`asset == address(0)`) skips `prizeVault.payout` and emits
    ///      `ScratchSettled` with `amount == 0`.
    function fulfill(uint256 requestId, uint256 randomWord) external onlyRandomness nonReentrant {
        Request storage req = requests[requestId];
        if (req.status == Status.None) revert RequestUnknown();
        if (req.status == Status.Rescued) {
            emit ScratchLateFulfillment(req.user, requestId, req.tier);
            return;
        }
        if (req.status != Status.Pending) revert NotPending();

        req.status = Status.Settled;

        PrizeRow[] storage table = _tables[req.tier];
        uint256 roll = randomWord % ODDS_DENOM;
        uint256 rowIndex = _selectRow(table, roll);
        PrizeRow storage row = table[rowIndex];

        address asset = row.asset;
        uint256 amount;
        if (asset == address(0)) {
            // Terminal no-win: skip vault call (gas + PrizePaid noise).
            emit ScratchSettled(req.user, requestId, req.tier, rowIndex, asset, 0);
            return;
        } else if (row.isBpsOfPool) {
            amount = (uint256(row.amountOrBps) * prizeVault.balanceOf(asset)) / 10_000;
        } else {
            amount = uint256(row.amountOrBps);
        }

        prizeVault.payout(req.user, asset, amount);
        emit ScratchSettled(req.user, requestId, req.tier, rowIndex, asset, amount);
    }

    /// @notice After `rescueDelay`, anyone may refund the spent ticket and mark
    ///         the request RESCUED. Reverts if already SETTLED (or not PENDING).
    function rescue(uint256 requestId) external nonReentrant {
        Request storage req = requests[requestId];
        if (req.status == Status.None) revert RequestUnknown();
        if (req.status == Status.Settled) revert AlreadySettled();
        if (req.status != Status.Pending) revert NotPending();
        if (block.timestamp < uint256(req.requestedAt) + rescueDelay) revert RescueTooEarly();

        req.status = Status.Rescued;

        ITicketSource source = ticketSource[req.tier];
        source.refundTicket(req.user, TICKET_COST);

        emit ScratchRescued(req.user, requestId, req.tier);
    }

    /// @notice Number of prize rows for `tier`.
    function tableLength(uint8 tier) external view returns (uint256) {
        return _tables[tier].length;
    }

    /// @notice Prize row at `index` for `tier`.
    function getPrizeRow(uint8 tier, uint256 index) external view returns (PrizeRow memory) {
        return _tables[tier][index];
    }

    function _validateTable(PrizeRow[] calldata table) internal pure {
        uint256 n = table.length;
        if (n == 0) revert TableEmpty();

        uint32 prev = 0;
        for (uint256 i = 0; i < n; i++) {
            uint32 c = table[i].cumOdds;
            if (c <= prev) revert TableNotMonotonic();
            prev = c;
        }

        PrizeRow calldata last = table[n - 1];
        if (last.cumOdds != ODDS_DENOM || last.asset != address(0)) revert TableBadTerminal();
    }

    /// @dev First row whose `cumOdds` is strictly greater than `roll`.
    function _selectRow(PrizeRow[] storage table, uint256 roll) internal view returns (uint256) {
        uint256 n = table.length;
        for (uint256 i = 0; i < n; i++) {
            if (roll < table[i].cumOdds) return i;
        }
        // Unreachable when table ends at ODDS_DENOM and roll < ODDS_DENOM.
        return n - 1;
    }
}
