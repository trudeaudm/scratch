// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IRandomness, IRandomnessCallback} from "../interfaces/IRandomness.sol";

/// @title SelfEntropyProvider
/// @notice Interim `IRandomness` provider: a Pyth-Entropy-style committed hash chain,
///         self-operated (no external oracle). Preimages are committed before any
///         request exists, so the operator cannot choose or alter outcomes — it can
///         only stall a reveal, and a stalled reveal becomes a rescued (refunded)
///         ticket; this provider is interim until an oracle (e.g. Pyth Entropy)
///         deploys on this chain, at which point ScratchGame's timelocked randomness
///         swap replaces it.
/// @dev Registering a new epoch via `registerChain` orphans any pending requests from
///      prior epochs — they become unfulfillable by design and the game's rescue path
///      refunds them. Do not register a fresh chain while in-flight requests still need
///      reveals unless that orphaning (and subsequent rescue) is intentional.
contract SelfEntropyProvider is IRandomness, Ownable, ReentrancyGuard {
    /// @notice Sole consumer of fulfilled randomness (ScratchGame), set once.
    IRandomnessCallback public callback;

    /// @notice Address authorized to submit `reveal` (settable by owner).
    address public operator;

    /// @notice Latest registered epoch (0 = none). Increments on each `registerChain`.
    uint64 public currentEpoch;

    /// @notice Next request id to issue (starts at 1).
    uint256 public nextSeq = 1;

    /// @notice Current hash-chain cursor per epoch (commitment, then successive preimages).
    mapping(uint64 => bytes32) public epochCursor;

    /// @notice Next request id that must be revealed for this epoch (strict sequence).
    mapping(uint64 => uint256) public nextFulfillSeq;

    struct Request {
        uint64 epoch;
        bool pending;
    }

    mapping(uint256 => Request) public requests;

    event CallbackSet(address indexed callback);
    event OperatorSet(address indexed previous, address indexed current);
    event ChainRegistered(uint64 indexed epoch, bytes32 commitment);
    event RandomnessRequested(uint256 indexed requestId, address indexed requester);
    event RandomnessFulfilled(uint256 indexed requestId, uint256 randomWord);

    error ZeroAddress();
    error ZeroCommitment();
    error CallbackAlreadySet();
    error CallbackNotSet();
    error NotCallback();
    error NotOperator();
    error NoChainRegistered();
    error UnknownRequest();
    error NotPending();
    error WrongEpoch();
    error OutOfOrder();
    error BadPreimage();

    /// @param operator_ Initial reveal operator (may be rotated via `setOperator`).
    constructor(address operator_) Ownable(msg.sender) {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(address(0), operator_);
    }

    /// @notice One-shot wiring of the ScratchGame callback that receives fulfillments.
    function setCallback(address callback_) external onlyOwner {
        if (address(callback) != address(0)) revert CallbackAlreadySet();
        if (callback_ == address(0)) revert ZeroAddress();
        callback = IRandomnessCallback(callback_);
        emit CallbackSet(callback_);
    }

    /// @notice Rotate the reveal operator.
    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        address previous = operator;
        operator = operator_;
        emit OperatorSet(previous, operator_);
    }

    /// @notice Commit a new hash-chain tip and open a fresh epoch.
    /// @dev Increments `currentEpoch` and stores `commitment` as that epoch's cursor.
    ///      **Orphans** any still-pending requests from prior epochs — they can no longer
    ///      be revealed; ScratchGame's rescue path refunds those tickets after `rescueDelay`.
    /// @param commitment Tip of the preimage chain (`keccak256(abi.encodePacked(preimage))`
    ///        of the first revealable value).
    function registerChain(bytes32 commitment) external onlyOwner {
        if (commitment == bytes32(0)) revert ZeroCommitment();

        uint64 epoch = currentEpoch + 1;
        currentEpoch = epoch;
        epochCursor[epoch] = commitment;
        nextFulfillSeq[epoch] = nextSeq;

        emit ChainRegistered(epoch, commitment);
    }

    /// @inheritdoc IRandomness
    /// @dev Only the configured callback (game) may request — request and fulfill stay paired.
    ///      Requires an epoch registered via `registerChain`.
    function requestRandom() external returns (uint256 id) {
        if (address(callback) == address(0)) revert CallbackNotSet();
        if (msg.sender != address(callback)) revert NotCallback();
        if (currentEpoch == 0) revert NoChainRegistered();

        id = nextSeq++;
        requests[id] = Request({epoch: currentEpoch, pending: true});

        emit RandomnessRequested(id, msg.sender);
    }

    /// @notice Reveal the next preimage in the committed chain and fulfill `requestId`.
    /// @dev Only the operator. Request must be pending, belong to `currentEpoch`, and be
    ///      the next in-sequence id for that epoch. Advances `epochCursor` to `preimage`.
    ///      Word = `uint256(keccak256(abi.encode(preimage, requestId)))`.
    /// @param requestId Pending request to fulfill.
    /// @param preimage Value such that `keccak256(abi.encodePacked(preimage)) == epochCursor`.
    function reveal(uint256 requestId, bytes32 preimage) external nonReentrant {
        if (msg.sender != operator) revert NotOperator();

        Request storage req = requests[requestId];
        if (req.epoch == 0) revert UnknownRequest();
        if (!req.pending) revert NotPending();
        if (req.epoch != currentEpoch) revert WrongEpoch();
        if (requestId != nextFulfillSeq[currentEpoch]) revert OutOfOrder();
        if (keccak256(abi.encodePacked(preimage)) != epochCursor[currentEpoch]) revert BadPreimage();

        // Effects before interaction (callback may move prizes via ScratchGame).
        req.pending = false;
        epochCursor[currentEpoch] = preimage;
        nextFulfillSeq[currentEpoch] = requestId + 1;

        uint256 word = uint256(keccak256(abi.encode(preimage, requestId)));
        emit RandomnessFulfilled(requestId, word);

        callback.fulfill(requestId, word);
    }
}
