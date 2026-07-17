// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IRandomness, IRandomnessCallback} from "../../src/interfaces/IRandomness.sol";

/// @title MockRandomness
/// @notice Test/fork stand-in for an IRandomness adapter. Issues incrementing request ids
///         and allows a designated harness to fulfill with a chosen random word.
contract MockRandomness is IRandomness {
    /// @notice Sole consumer of fulfilled randomness, set once.
    IRandomnessCallback public callback;

    /// @notice Address allowed to call `fulfill` (test harness), set once.
    address public fulfiller;

    /// @notice Next request id to issue (starts at 1).
    uint256 public nextRequestId = 1;

    /// @notice Whether a request id is still awaiting fulfillment.
    mapping(uint256 => bool) public pending;

    /// @notice Scratcher bound via `requestRandomFor` (zero for legacy `requestRandom`).
    mapping(uint256 => address) public requesters;

    event CallbackSet(address indexed callback);
    event FulfillerSet(address indexed fulfiller);
    event RandomnessRequested(uint256 indexed requestId, address indexed requester);
    event RandomnessFulfilled(uint256 indexed requestId, uint256 randomWord);

    error ZeroAddress();
    error CallbackAlreadySet();
    error CallbackNotSet();
    error FulfillerAlreadySet();
    error FulfillerNotSet();
    error NotFulfiller();
    error UnknownRequest();

    /// @notice One-shot wiring of the ScratchGame (or test) callback.
    function setCallback(address callback_) external {
        if (address(callback) != address(0)) revert CallbackAlreadySet();
        if (callback_ == address(0)) revert ZeroAddress();
        callback = IRandomnessCallback(callback_);
        emit CallbackSet(callback_);
    }

    /// @notice One-shot wiring of the address allowed to fulfill (test harness).
    function setFulfiller(address fulfiller_) external {
        if (fulfiller != address(0)) revert FulfillerAlreadySet();
        if (fulfiller_ == address(0)) revert ZeroAddress();
        fulfiller = fulfiller_;
        emit FulfillerSet(fulfiller_);
    }

    /// @inheritdoc IRandomness
    function requestRandom() external returns (uint256 id) {
        return _request(address(0));
    }

    /// @inheritdoc IRandomness
    function requestRandomFor(address user) external returns (uint256 id) {
        if (user == address(0)) revert ZeroAddress();
        return _request(user);
    }

    /// @notice Deliver `randomWord` for `requestId` to the configured callback.
    /// @dev Only the designated test harness (`fulfiller`) may call. Passes `randomWord`
    ///      through unchanged (tests choose the settlement roll directly).
    function fulfill(uint256 requestId, uint256 randomWord) external {
        if (fulfiller == address(0)) revert FulfillerNotSet();
        if (msg.sender != fulfiller) revert NotFulfiller();
        if (!pending[requestId]) revert UnknownRequest();

        pending[requestId] = false;
        emit RandomnessFulfilled(requestId, randomWord);
        callback.fulfill(requestId, randomWord);
    }

    function _request(address user) internal returns (uint256 id) {
        if (address(callback) == address(0)) revert CallbackNotSet();
        id = nextRequestId++;
        pending[id] = true;
        requesters[id] = user;
        emit RandomnessRequested(id, user == address(0) ? msg.sender : user);
    }
}
