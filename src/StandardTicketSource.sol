// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ITicketSource} from "./interfaces/ITicketSource.sol";

/// @title StandardTicketSource
/// @notice Promo / grant ticket source for the STANDARD (tier 0) scratch path.
///         Balances are per-user with a rolling TTL: any credit refreshes expiry to
///         `block.timestamp + TTL`. Expired balances are lazily zeroed on the next
///         touch (grant / credit / refund / spend).
/// @dev Rescue `refundTicket` restores already-spent tickets and must never be
///      clipped by daily caps or blocked from refreshing an expired balance.
contract StandardTicketSource is ITicketSource, Ownable {
    /// @notice Ticket TTL after each grant / credit / refund.
    uint256 public constant TTL = 7 days;

    /// @notice Starting owner `grant` daily cap (ticket-wei). Lowerable only.
    uint256 public constant INITIAL_GRANT_DAILY_CAP = 1000e18;

    /// @notice Sole address allowed to `spendTickets` / `refundTicket` (set once).
    address public game;

    /// @notice Owner `grant` daily allowance (ticket-wei). Adjustable only downward.
    uint256 public grantDailyCap = INITIAL_GRANT_DAILY_CAP;

    /// @notice Ticket-wei granted by owner in the current UTC day bucket.
    uint256 public grantUsedToday;

    /// @notice UTC day bucket (`block.timestamp / 1 days`) for `grantUsedToday`.
    uint256 public grantDayBucket;

    struct Account {
        uint256 balance;
        uint64 expiresAt;
    }

    struct Crediter {
        bool authorized;
        uint256 dailyCap;
        uint256 usedToday;
        uint256 dayBucket;
    }

    mapping(address => Account) internal _accounts;
    mapping(address => Crediter) public crediters;

    event TicketsGranted(address indexed user, uint256 amount);
    event TicketsCredited(address indexed user, address indexed crediter, uint256 amount);
    event TicketsSpent(address indexed user, uint256 amount);
    event TicketsRefunded(address indexed user, uint256 amount);
    event TicketsExpired(address indexed user, uint256 amount);
    /// @notice `account == address(0)` means the owner grant daily cap; otherwise a crediter.
    event CapLowered(address indexed account, uint256 oldCap, uint256 newCap);
    event CrediterAdded(address indexed crediter, uint256 dailyCap);
    event GameSet(address indexed game);

    error ZeroAddress();
    error ZeroAmount();
    error EmptyUsers();
    error GameAlreadySet();
    error NotGame();
    error InsufficientTickets();
    error CapIncreaseForbidden();
    error NotCrediter();
    error CrediterAlreadyAdded();
    error GrantDailyCapExceeded(uint256 requested, uint256 remaining);
    error CrediterDailyCapExceeded(uint256 requested, uint256 remaining);

    modifier onlyGame() {
        if (msg.sender != game) revert NotGame();
        _;
    }

    constructor() Ownable(msg.sender) {
        grantDayBucket = block.timestamp / 1 days;
    }

    /// @notice One-shot wiring of the ScratchGame address allowed to spend/refund tickets.
    function setGame(address game_) external onlyOwner {
        if (game != address(0)) revert GameAlreadySet();
        if (game_ == address(0)) revert ZeroAddress();
        game = game_;
        emit GameSet(game_);
    }

    /// @notice Owner batch-grant of `amountEach` ticket-wei to each user in `users`.
    /// @dev Consumes against the shared owner daily cap. Counts the full batch atomically.
    function grant(address[] calldata users, uint256 amountEach) external onlyOwner {
        if (users.length == 0) revert EmptyUsers();
        if (amountEach == 0) revert ZeroAmount();

        uint256 total = amountEach * users.length;
        _syncGrantBucket();
        uint256 remaining = grantDailyCap > grantUsedToday ? grantDailyCap - grantUsedToday : 0;
        if (total > remaining) revert GrantDailyCapExceeded(total, remaining);

        grantUsedToday += total;

        for (uint256 i = 0; i < users.length; ++i) {
            address user = users[i];
            if (user == address(0)) revert ZeroAddress();
            _credit(user, amountEach);
            emit TicketsGranted(user, amountEach);
        }
    }

    /// @notice Crediter path: credit `amount` ticket-wei to `user` under the caller's daily cap.
    function credit(address user, uint256 amount) external {
        if (user == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        Crediter storage c = crediters[msg.sender];
        if (!c.authorized) revert NotCrediter();

        _syncCrediterBucket(c);
        uint256 remaining = c.dailyCap > c.usedToday ? c.dailyCap - c.usedToday : 0;
        if (amount > remaining) revert CrediterDailyCapExceeded(amount, remaining);

        c.usedToday += amount;
        _credit(user, amount);
        emit TicketsCredited(user, msg.sender, amount);
    }

    /// @notice Authorize `crediter` with a per-day ticket-wei cap. Cap can only be lowered later.
    function addCrediter(address crediter, uint256 dailyCap) external onlyOwner {
        if (crediter == address(0)) revert ZeroAddress();
        if (dailyCap == 0) revert ZeroAmount();
        if (crediters[crediter].authorized) revert CrediterAlreadyAdded();

        crediters[crediter] = Crediter({
            authorized: true,
            dailyCap: dailyCap,
            usedToday: 0,
            dayBucket: block.timestamp / 1 days
        });
        emit CrediterAdded(crediter, dailyCap);
    }

    /// @notice Lower the owner `grant` daily cap. Raising reverts (compromised owner cannot expand blast radius).
    function lowerGrantCap(uint256 newCap) external onlyOwner {
        uint256 old = grantDailyCap;
        if (newCap >= old) revert CapIncreaseForbidden();
        grantDailyCap = newCap;
        emit CapLowered(address(0), old, newCap);
    }

    /// @notice Lower a crediter's daily cap. Raising reverts.
    function lowerCrediterCap(address crediter, uint256 newCap) external onlyOwner {
        Crediter storage c = crediters[crediter];
        if (!c.authorized) revert NotCrediter();
        uint256 old = c.dailyCap;
        if (newCap >= old) revert CapIncreaseForbidden();
        c.dailyCap = newCap;
        emit CapLowered(crediter, old, newCap);
    }

    /// @inheritdoc ITicketSource
    function spendTickets(address user, uint256 amount) external onlyGame {
        if (amount == 0) revert ZeroAmount();
        _lazyExpire(user);
        Account storage a = _accounts[user];
        if (a.balance < amount) revert InsufficientTickets();
        a.balance -= amount;
        emit TicketsSpent(user, amount);
    }

    /// @inheritdoc ITicketSource
    /// @dev Rescue refunds restore already-spent tickets and must never be clipped by
    ///      daily caps or blocked from reviving an expired balance. Always applies a fresh TTL.
    function refundTicket(address user, uint256 amount) external onlyGame {
        if (user == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _credit(user, amount);
        emit TicketsRefunded(user, amount);
    }

    /// @inheritdoc ITicketSource
    function ticketsOf(address user) external view returns (uint256) {
        Account storage a = _accounts[user];
        if (a.balance == 0 || block.timestamp > a.expiresAt) return 0;
        return a.balance;
    }

    /// @notice Absolute expiry timestamp for `user`'s current balance, or 0 if none / expired.
    function expiryOf(address user) external view returns (uint64) {
        Account storage a = _accounts[user];
        if (a.balance == 0 || block.timestamp > a.expiresAt) return 0;
        return a.expiresAt;
    }

    /// @dev Lazily expire, then add `amount` and set a fresh TTL.
    function _credit(address user, uint256 amount) internal {
        _lazyExpire(user);
        Account storage a = _accounts[user];
        a.balance += amount;
        a.expiresAt = uint64(block.timestamp + TTL);
    }

    function _lazyExpire(address user) internal {
        Account storage a = _accounts[user];
        if (a.balance > 0 && block.timestamp > a.expiresAt) {
            uint256 expired = a.balance;
            a.balance = 0;
            emit TicketsExpired(user, expired);
        }
    }

    function _syncGrantBucket() internal {
        uint256 day = block.timestamp / 1 days;
        if (day != grantDayBucket) {
            grantDayBucket = day;
            grantUsedToday = 0;
        }
    }

    function _syncCrediterBucket(Crediter storage c) internal {
        uint256 day = block.timestamp / 1 days;
        if (day != c.dayBucket) {
            c.dayBucket = day;
            c.usedToday = 0;
        }
    }
}
