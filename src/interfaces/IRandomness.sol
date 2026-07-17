// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IRandomness
/// @notice Provider-agnostic randomness request surface. Implementations (e.g.
///         ChainlinkVRFAdapter, SelfEntropyProvider) must never fall back to
///         blockhash, prevrandao, or a trusted signer.
interface IRandomness {
    /// @notice Request a random word without binding a user.
    /// @dev Prefer `requestRandomFor` from ScratchGame. Some providers (e.g.
    ///      SelfEntropyProvider) revert `Unimplemented` so the unbound path cannot
    ///      be used by mistake.
    /// @return id Request id used to correlate the later callback.
    function requestRandom() external returns (uint256 id);

    /// @notice Request a random word bound to `user` (the scratcher).
    /// @dev ScratchGame must pass `msg.sender` here. Binding the derived word to
    ///      the requester prevents an operator who knows upcoming preimages from
    ///      sniping favorable sequence slots with its own scratches.
    /// @param user Address whose scratch initiated this request.
    /// @return id Request id used to correlate the later callback.
    function requestRandomFor(address user) external returns (uint256 id);
}

/// @title IRandomnessCallback
/// @notice Callback delivered by an IRandomness adapter once entropy is available.
interface IRandomnessCallback {
    /// @notice Settle a pending request with `randomWord`.
    /// @dev Only callable by the wired randomness adapter.
    function fulfill(uint256 requestId, uint256 randomWord) external;
}
