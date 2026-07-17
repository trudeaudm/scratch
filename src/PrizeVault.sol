// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPrizeVault} from "./interfaces/IPrizeVault.sol";

/// @title PrizeVault
/// @notice Custodies multi-asset prize inventory (SCRATCH, USDG, memecoins, stock
///         tokens) and pays winners for ScratchGame. `payout` never reverts a
///         settlement — failed, under-funded, or KYC-gated transfers fall back to
///         SCRATCH at a configured per-asset rate; an unset rate (or failed
///         fallback) pays zero and still emits `PrizePaid` so VRF fulfillment
///         cannot brick. Owner sweep is subject to a 48h timelock.
contract PrizeVault is IPrizeVault, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Delay between `sweep` queue and `executeSweep`.
    uint64 public constant SWEEP_DELAY = 48 hours;

    /// @notice Window after `eta` during which `executeSweep` may succeed; after
    ///         `eta + SWEEP_GRACE` the queued sweep expires and must be re-queued.
    uint64 public constant SWEEP_GRACE = 24 hours;

    /// @notice SCRATCH used for fallback payouts.
    IERC20 public immutable scratch;

    /// @notice Sole address allowed to call `payout` (set once).
    address public game;

    /// @notice SCRATCH-wei owed per 1e18 wei of `asset` when falling back.
    mapping(address => uint256) public fallbackRate;

    /// @dev Assets ever funded, for `inventory()` (balances may be zero).
    address[] private _assets;
    mapping(address => bool) private _tracked;

    struct SweepRequest {
        address asset;
        address to;
        uint64 eta;
        bool pending;
    }

    uint256 public sweepCount;
    mapping(uint256 => SweepRequest) public sweeps;

    event GameSet(address indexed game);
    event Funded(address indexed asset, uint256 amount, address indexed from);
    event FallbackRateSet(address indexed asset, uint256 scratchPerUnit);
    event PrizePaid(address indexed to, address indexed asset, uint256 amount, bool fellBack);
    event SweepQueued(uint256 indexed id, address indexed asset, address indexed to, uint64 eta);
    event SweepExecuted(uint256 indexed id, address indexed asset, address indexed to, uint256 amount);
    event SweepCancelled(uint256 indexed id);

    error ZeroAddress();
    error ZeroAmount();
    error GameAlreadySet();
    error NotGame();
    error NotSelf();
    error SweepNotPending();
    error SweepNotReady();
    error SweepExpired();
    error SweepUnknown();

    modifier onlyGame() {
        if (msg.sender != game) revert NotGame();
        _;
    }

    /// @param scratch_ SCRATCH ERC-20 used for fallback payouts.
    constructor(IERC20 scratch_) Ownable(msg.sender) {
        if (address(scratch_) == address(0)) revert ZeroAddress();
        scratch = scratch_;
        _track(address(scratch_));
    }

    /// @notice One-shot wiring of the ScratchGame allowed to call `payout`.
    function setGame(address game_) external onlyOwner {
        if (game != address(0)) revert GameAlreadySet();
        if (game_ == address(0)) revert ZeroAddress();
        game = game_;
        emit GameSet(game_);
    }

    /// @notice Set SCRATCH fallback equivalence for `asset`.
    /// @param scratchPerUnit SCRATCH-wei paid per 1e18 wei of `asset` on fallback.
    function setFallbackRate(address asset, uint256 scratchPerUnit) external onlyOwner {
        if (asset == address(0)) revert ZeroAddress();
        fallbackRate[asset] = scratchPerUnit;
        emit FallbackRateSet(asset, scratchPerUnit);
    }

    /// @notice Pull `amount` of `asset` into the vault. Callable by anyone.
    /// @dev CEI: track the asset before `transferFrom`; a failing pull reverts the
    ///      whole transaction, and `nonReentrant` blocks reentry.
    function fund(address asset, uint256 amount) external nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _track(asset);
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(asset, amount, msg.sender);
    }

    /// @inheritdoc IPrizeVault
    /// @dev Never reverts. Transfer failures, insufficient vault balance, unset
    ///      fallback rate, or failed SCRATCH fallback all settle (paying zero in
    ///      the last cases) and emit `PrizePaid` so a claim cannot brick VRF fulfillment.
    function payout(address to, address asset, uint256 amount) external onlyGame nonReentrant {
        if (to == address(0)) {
            emit PrizePaid(to, asset, 0, true);
            return;
        }

        if (asset != address(0) && amount > 0) {
            uint256 bal = IERC20(asset).balanceOf(address(this));
            if (bal >= amount) {
                try this.transferAsset(asset, to, amount) {
                    emit PrizePaid(to, asset, amount, false);
                    return;
                } catch {
                    // fall through to SCRATCH fallback
                }
            }
            _payFallback(to, asset, amount);
            return;
        }

        emit PrizePaid(to, asset, amount, false);
    }

    /// @dev External for try/catch. Only callable by this contract.
    /// @notice Prize assets are owner-curated. A malicious ERC-20 could gas-grief
    ///         the VRF callback path via unbounded work in `transfer`; curation of
    ///         allowlisted prize assets is the mitigation.
    function transferAsset(address asset, address to, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelf();
        IERC20(asset).safeTransfer(to, amount);
    }

    /// @notice Queue a full-balance sweep of `asset` to `to` after `SWEEP_DELAY`.
    function sweep(address asset, address to) external onlyOwner returns (uint256 id) {
        if (asset == address(0) || to == address(0)) revert ZeroAddress();
        id = ++sweepCount;
        uint64 eta = uint64(block.timestamp) + SWEEP_DELAY;
        sweeps[id] = SweepRequest({asset: asset, to: to, eta: eta, pending: true});
        emit SweepQueued(id, asset, to, eta);
    }

    /// @notice Execute a queued sweep in `[eta, eta + SWEEP_GRACE]`. Transfers the
    ///         vault's full balance of the asset. After the grace window the request
    ///         expires and must be re-queued (restarting `SWEEP_DELAY`).
    function executeSweep(uint256 id) external onlyOwner nonReentrant {
        SweepRequest storage req = sweeps[id];
        if (req.asset == address(0) && !req.pending) revert SweepUnknown();
        if (!req.pending) revert SweepNotPending();
        if (block.timestamp < req.eta) revert SweepNotReady();
        if (block.timestamp > uint256(req.eta) + SWEEP_GRACE) revert SweepExpired();

        req.pending = false;
        uint256 bal = IERC20(req.asset).balanceOf(address(this));
        if (bal > 0) {
            IERC20(req.asset).safeTransfer(req.to, bal);
        }
        emit SweepExecuted(id, req.asset, req.to, bal);
    }

    /// @notice Cancel a pending sweep.
    function cancelSweep(uint256 id) external onlyOwner {
        SweepRequest storage req = sweeps[id];
        if (!req.pending) revert SweepNotPending();
        req.pending = false;
        emit SweepCancelled(id);
    }

    /// @inheritdoc IPrizeVault
    function balanceOf(address asset) external view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    /// @inheritdoc IPrizeVault
    function inventory() external view returns (address[] memory assets, uint256[] memory balances) {
        uint256 n = _assets.length;
        assets = new address[](n);
        balances = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address a = _assets[i];
            assets[i] = a;
            balances[i] = IERC20(a).balanceOf(address(this));
        }
    }

    function _payFallback(address to, address asset, uint256 amount) internal {
        uint256 rate = fallbackRate[asset];
        if (rate == 0 || amount == 0) {
            emit PrizePaid(to, address(scratch), 0, true);
            return;
        }

        uint256 scratchDue = (amount * rate) / 1e18;
        if (scratchDue == 0) {
            emit PrizePaid(to, address(scratch), 0, true);
            return;
        }

        if (scratch.balanceOf(address(this)) < scratchDue) {
            emit PrizePaid(to, address(scratch), 0, true);
            return;
        }

        try this.transferAsset(address(scratch), to, scratchDue) {
            emit PrizePaid(to, address(scratch), scratchDue, true);
        } catch {
            emit PrizePaid(to, address(scratch), 0, true);
        }
    }

    function _track(address asset) internal {
        if (!_tracked[asset]) {
            _tracked[asset] = true;
            _assets.push(asset);
        }
    }
}
