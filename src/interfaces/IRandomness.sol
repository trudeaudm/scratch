// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IRandomness
/// @notice Provider-agnostic randomness request surface. Implementations (e.g.
///         ChainlinkVRFAdapter) must never fall back to blockhash, prevrandao, or
///         a trusted signer.
interface IRandomness {
    /// @notice Request a random word. Caller is the consumer that will receive fulfill.
    /// @return id Request id used to correlate the later callback.
    function requestRandom() external returns (uint256 id);
}

/// @title IRandomnessCallback
/// @notice Callback delivered by an IRandomness adapter once entropy is available.
interface IRandomnessCallback {
    /// @notice Settle a pending request with `randomWord`.
    /// @dev Only callable by the wired randomness adapter.
    function fulfill(uint256 requestId, uint256 randomWord) external;
}
