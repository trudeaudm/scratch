// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IRandomness, IRandomnessCallback} from "../interfaces/IRandomness.sol";
import {IVRFCoordinatorV2Plus} from "./IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "./VRFV2PlusClient.sol";

/// @title ChainlinkVRFAdapter
/// @notice IRandomness adapter over Chainlink VRF v2.5. Coordinator address, keyHash,
///         and subscription id are constructor params (coordinator on 4663 is an open
///         gate — see GATES.md). Forwards entropy to a single IRandomnessCallback
///         (ScratchGame), set once. Never uses blockhash, prevrandao, or a trusted
///         signer fallback.
contract ChainlinkVRFAdapter is IRandomness, Ownable {
    /// @notice Confirmations requested from the coordinator (L2-safe default).
    uint16 public constant REQUEST_CONFIRMATIONS = 3;

    /// @notice Gas limit for the coordinator's callback into this adapter.
    uint32 public constant CALLBACK_GAS_LIMIT = 500_000;

    /// @notice One random word per scratch settlement.
    uint32 public constant NUM_WORDS = 1;

    /// @notice VRF v2.5 coordinator (constructor param — never hardcoded).
    IVRFCoordinatorV2Plus public immutable coordinator;

    /// @notice Key hash for the oracle job.
    bytes32 public immutable keyHash;

    /// @notice Funded VRF subscription id.
    uint256 public immutable subscriptionId;

    /// @notice Pay coordinator fees in native gas token (ETH on chain 4663).
    bool public immutable nativePayment;

    /// @notice Sole consumer of fulfilled randomness (ScratchGame), set once.
    IRandomnessCallback public callback;

    event CallbackSet(address indexed callback);
    event RandomnessRequested(uint256 indexed requestId, address indexed requester);
    event RandomnessFulfilled(uint256 indexed requestId, uint256 randomWord);

    error ZeroAddress();
    error CallbackAlreadySet();
    error CallbackNotSet();
    error NotCallback();
    error OnlyCoordinatorCanFulfill(address have, address want);
    error NoRandomWords();

    /// @param coordinator_ VRF v2.5 coordinator address (from env — see GATES.md).
    /// @param keyHash_ Oracle key hash (from env).
    /// @param subscriptionId_ Funded subscription id (from env).
    /// @param nativePayment_ If true, subscription pays in native token rather than LINK.
    constructor(address coordinator_, bytes32 keyHash_, uint256 subscriptionId_, bool nativePayment_)
        Ownable(msg.sender)
    {
        if (coordinator_ == address(0)) revert ZeroAddress();
        if (keyHash_ == bytes32(0)) revert ZeroAddress();
        coordinator = IVRFCoordinatorV2Plus(coordinator_);
        keyHash = keyHash_;
        subscriptionId = subscriptionId_;
        nativePayment = nativePayment_;
    }

    /// @notice One-shot wiring of the ScratchGame callback that receives fulfillments.
    function setCallback(address callback_) external onlyOwner {
        if (address(callback) != address(0)) revert CallbackAlreadySet();
        if (callback_ == address(0)) revert ZeroAddress();
        callback = IRandomnessCallback(callback_);
        emit CallbackSet(callback_);
    }

    /// @inheritdoc IRandomness
    /// @dev Only the configured callback (game) may request — request and fulfill stay paired.
    function requestRandom() external returns (uint256 id) {
        if (address(callback) == address(0)) revert CallbackNotSet();
        if (msg.sender != address(callback)) revert NotCallback();

        id = coordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: REQUEST_CONFIRMATIONS,
                callbackGasLimit: CALLBACK_GAS_LIMIT,
                numWords: NUM_WORDS,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );

        emit RandomnessRequested(id, msg.sender);
    }

    /// @notice VRF v2.5 coordinator entrypoint. Only the configured coordinator may call.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(coordinator)) {
            revert OnlyCoordinatorCanFulfill(msg.sender, address(coordinator));
        }
        if (randomWords.length == 0) revert NoRandomWords();

        uint256 word = randomWords[0];
        emit RandomnessFulfilled(requestId, word);
        callback.fulfill(requestId, word);
    }
}
