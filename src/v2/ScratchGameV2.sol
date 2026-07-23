// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPrizeVault} from "../interfaces/IPrizeVault.sol";
import {IRandomness, IRandomnessCallback} from "../interfaces/IRandomness.sol";
import {ITicketSource} from "../interfaces/ITicketSource.sol";

/// @title ScratchGameV2
/// @notice Burns ticket(s), requests randomness via IRandomness, maps outcomes onto
///         a cumulative-odds prize table, and instructs PrizeVault to pay.
///         `scratchMany` is batch-native: one spend, one randomness request, one
///         reveal → N card outcomes derived from the fulfilled word, with payouts
///         aggregated per asset.
/// @dev Each request is exactly one of PENDING → SETTLED or PENDING → RESCUED;
///      both transitions are terminal. Late VRF after rescue emits
///      `ScratchLateFulfillment` and returns without paying.
///
///      Trust: per-card words are `keccak256(abi.encode(word, cardIndex))` where
///      `word` is already bound on-chain to `(preimage, requestId, requester)` by
///      the randomness provider. The operator's commitment predates the request
///      exactly as for singles — batching changes latency, not the trust model.
contract ScratchGameV2 is IRandomnessCallback, Ownable2Step, ReentrancyGuard {
    /// @notice Ticket-wei spent per scratch card (1 full ticket).
    uint256 public constant TICKET_COST = 1e18;

    /// @notice Cumulative-odds denominator (rows validated to end at this value).
    uint32 public constant ODDS_DENOM = 1_000_000;

    /// @notice Phase-3 voucher tier slot (reserved; wire via `setTicketSource`).
    uint8 public constant STANDARD = 0;

    /// @notice Premium tier (StakingVaultV2).
    uint8 public constant PREMIUM = 1;

    /// @notice Number of tiers (indices 0..TIER_COUNT-1).
    uint8 public constant TIER_COUNT = 2;

    /// @notice Max cards per `scratchMany` (and max `Request.count`).
    uint8 public constant MAX_BATCH = 20;

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

    /// @notice Per-tier ticket source (one-shot). PREMIUM wired to StakingVaultV2.
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

    /// @notice Single-slot packed request (248 bits).
    ///         user(160) + tier(8) + requestedAt(64) + status(8) + count(8) = 248.
    struct Request {
        address user;
        uint8 tier;
        uint64 requestedAt;
        Status status;
        uint8 count;
    }

    mapping(uint256 => Request) public requests;

    event TicketSourceSet(uint8 indexed tier, address indexed source);
    event PrizeTableSet(uint8 indexed tier, PrizeRow[] table);
    event ScratchRequested(address indexed user, uint256 indexed requestId, uint8 tier);
    event ScratchBatch(address indexed user, uint8 tier, uint256 count, uint256 requestId);
    /// @notice Per-card settlement. Singles emit `cardIndex == 0`.
    event ScratchSettled(
        address indexed user,
        uint256 indexed requestId,
        uint8 cardIndex,
        uint8 tier,
        uint256 rowIndex,
        address asset,
        uint256 amount
    );
    event ScratchRescued(address indexed user, uint256 indexed requestId, uint8 tier);
    /// @notice VRF arrived after the request was already rescued; no prize paid.
    event ScratchLateFulfillment(address indexed user, uint256 indexed requestId, uint8 tier, uint8 count);
    event RandomnessSwapQueued(address indexed newProvider, uint64 eta);
    event RandomnessSwapCancelled(address indexed pendingProvider);
    event RandomnessSwapped(address indexed oldProvider, address indexed newProvider);

    error ZeroAddress();
    error ZeroDelay();
    error InvalidTier();
    error InvalidBatchCount();
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

    /// @notice Spend one ticket and request randomness (`Request.count = 1`).
    /// @param tier STANDARD (0) or PREMIUM (1).
    function scratch(uint8 tier) external nonReentrant returns (uint256 requestId) {
        requestId = _scratch(tier, 1);
    }

    /// @notice Spend `count` tickets and issue ONE randomness request for `count` cards.
    /// @dev `1 ≤ count ≤ MAX_BATCH`. One `spendTickets(TICKET_COST * count)`, one
    ///      `requestRandomFor`. Emits `ScratchRequested` plus `ScratchBatch`.
    /// @param tier STANDARD (0) or PREMIUM (1).
    /// @param count Number of cards (1..20).
    /// @return requestId The single batch request id.
    function scratchMany(uint8 tier, uint256 count) external nonReentrant returns (uint256 requestId) {
        if (count == 0 || count > MAX_BATCH) revert InvalidBatchCount();
        requestId = _scratch(tier, uint8(count));
        emit ScratchBatch(msg.sender, tier, count, requestId);
    }

    /// @inheritdoc IRandomnessCallback
    /// @dev Settles all cards in the request from one `randomWord`. Per-card word:
    ///      `uint256(keccak256(abi.encode(randomWord, cardIndex)))`. Bps-of-pool
    ///      rows all size against the pre-batch vault balance (snapshotted on first
    ///      touch of each asset during this fulfill — never mid-batch depleting).
    ///      Intended (asset, amount) per card are emitted, then amounts are aggregated
    ///      per distinct asset and `prizeVault.payout` is called once per asset
    ///      (vault-internal transfer fallback applies to the aggregate). An all-no-win
    ///      batch skips payout entirely. Only one status SSTORE (Pending → Settled).
    function fulfill(uint256 requestId, uint256 randomWord) external onlyRandomness nonReentrant {
        Request storage req = requests[requestId];
        if (req.status == Status.None) revert RequestUnknown();
        if (req.status == Status.Rescued) {
            emit ScratchLateFulfillment(req.user, requestId, req.tier, req.count);
            return;
        }
        if (req.status != Status.Pending) revert NotPending();

        // Single status write for the whole batch.
        req.status = Status.Settled;

        _settleBatch(requestId, req.user, req.tier, req.count, randomWord);
    }

    /// @dev Transient settle context — keeps `_settleOneCard` under the stack limit.
    struct BatchCtx {
        uint256 requestId;
        address user;
        uint8 tier;
        uint256 randomWord;
        uint256 tableLen;
    }

    /// @dev Resolve cards + aggregate payouts. Split from `fulfill` to stay under stack limit.
    ///      Bps-of-pool bases are snapshotted once per table row before any card is resolved
    ///      so every card sizes against the pre-batch vault balance.
    function _settleBatch(uint256 requestId, address user, uint8 tier, uint8 count, uint256 randomWord)
        internal
    {
        PrizeRow[] storage table = _tables[tier];
        BatchCtx memory ctx = BatchCtx({
            requestId: requestId,
            user: user,
            tier: tier,
            randomWord: randomWord,
            tableLen: table.length
        });

        uint256[] memory bpsBase = _snapshotBpsBases(table, ctx.tableLen);

        address[] memory payAssets = new address[](count);
        uint256[] memory payAmounts = new uint256[](count);
        uint256 nPay = 0;

        for (uint256 cardIndex = 0; cardIndex < count;) {
            nPay = _settleOneCard(ctx, table, bpsBase, payAssets, payAmounts, nPay, cardIndex);
            unchecked {
                ++cardIndex;
            }
        }

        _payoutAggregates(user, payAssets, payAmounts, nPay);
    }

    function _snapshotBpsBases(PrizeRow[] storage table, uint256 tableLen)
        internal
        view
        returns (uint256[] memory bpsBase)
    {
        bpsBase = new uint256[](tableLen);
        for (uint256 i = 0; i < tableLen;) {
            PrizeRow storage r = table[i];
            if (r.isBpsOfPool && r.asset != address(0)) {
                bpsBase[i] = prizeVault.balanceOf(r.asset);
            }
            unchecked {
                ++i;
            }
        }
    }

    function _settleOneCard(
        BatchCtx memory ctx,
        PrizeRow[] storage table,
        uint256[] memory bpsBase,
        address[] memory payAssets,
        uint256[] memory payAmounts,
        uint256 nPay,
        uint256 cardIndex
    ) internal returns (uint256) {
        uint256 rowIndex = _selectRow(
            table, ctx.tableLen, uint256(keccak256(abi.encode(ctx.randomWord, cardIndex))) % ODDS_DENOM
        );
        PrizeRow storage row = table[rowIndex];
        address asset = row.asset;
        uint256 amount = _rowAmount(row, bpsBase[rowIndex]);

        emit ScratchSettled(ctx.user, ctx.requestId, uint8(cardIndex), ctx.tier, rowIndex, asset, amount);

        if (asset != address(0) && amount != 0) {
            return _accumulate(payAssets, payAmounts, nPay, asset, amount);
        }
        return nPay;
    }

    function _rowAmount(PrizeRow storage row, uint256 bpsBase) internal view returns (uint256) {
        if (row.asset == address(0)) return 0;
        if (row.isBpsOfPool) return (uint256(row.amountOrBps) * bpsBase) / 10_000;
        return uint256(row.amountOrBps);
    }

    function _payoutAggregates(address user, address[] memory payAssets, uint256[] memory payAmounts, uint256 nPay)
        internal
    {
        for (uint256 i = 0; i < nPay;) {
            prizeVault.payout(user, payAssets[i], payAmounts[i]);
            unchecked {
                ++i;
            }
        }
    }

    /// @dev Append-or-add `amount` into the pay aggregate; returns new length.
    function _accumulate(
        address[] memory payAssets,
        uint256[] memory payAmounts,
        uint256 nPay,
        address asset,
        uint256 amount
    ) internal pure returns (uint256) {
        for (uint256 j = 0; j < nPay;) {
            if (payAssets[j] == asset) {
                payAmounts[j] += amount;
                return nPay;
            }
            unchecked {
                ++j;
            }
        }
        payAssets[nPay] = asset;
        payAmounts[nPay] = amount;
        unchecked {
            return nPay + 1;
        }
    }

    /// @notice After `rescueDelay`, anyone may refund `TICKET_COST * count` and mark
    ///         the request RESCUED. Reverts if already SETTLED (or not PENDING).
    function rescue(uint256 requestId) external nonReentrant {
        Request storage req = requests[requestId];
        if (req.status == Status.None) revert RequestUnknown();
        if (req.status == Status.Settled) revert AlreadySettled();
        if (req.status != Status.Pending) revert NotPending();
        if (block.timestamp < uint256(req.requestedAt) + rescueDelay) revert RescueTooEarly();

        uint8 count = req.count;
        address user = req.user;
        uint8 tier = req.tier;
        req.status = Status.Rescued;

        ITicketSource source = ticketSource[tier];
        source.refundTicket(user, TICKET_COST * uint256(count));

        emit ScratchRescued(user, requestId, tier);
    }

    /// @notice Number of prize rows for `tier`.
    function tableLength(uint8 tier) external view returns (uint256) {
        return _tables[tier].length;
    }

    /// @notice Prize row at `index` for `tier`.
    function getPrizeRow(uint8 tier, uint256 index) external view returns (PrizeRow memory) {
        return _tables[tier][index];
    }

    /// @dev One spend + one randomness request; stores `count` on the Request.
    function _scratch(uint8 tier, uint8 count) internal returns (uint256 requestId) {
        if (tier >= TIER_COUNT) revert InvalidTier();
        ITicketSource source = ticketSource[tier];
        if (address(source) == address(0)) revert TicketSourceNotSet();
        if (_tables[tier].length == 0) revert TableEmpty();

        source.spendTickets(msg.sender, TICKET_COST * uint256(count));

        requestId = randomness.requestRandomFor(msg.sender);
        requests[requestId] = Request({
            user: msg.sender,
            tier: tier,
            requestedAt: uint64(block.timestamp),
            status: Status.Pending,
            count: count
        });

        emit ScratchRequested(msg.sender, requestId, tier);
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

    /// @dev First row whose `cumOdds` is strictly greater than `roll`. `n` cached by caller.
    function _selectRow(PrizeRow[] storage table, uint256 n, uint256 roll) internal view returns (uint256) {
        for (uint256 i = 0; i < n;) {
            if (roll < table[i].cumOdds) return i;
            unchecked {
                ++i;
            }
        }
        return n - 1;
    }
}
