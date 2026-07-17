// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {IRandomnessCallback} from "../src/interfaces/IRandomness.sol";
import {ChainlinkVRFAdapter} from "../src/randomness/ChainlinkVRFAdapter.sol";
import {IVRFCoordinatorV2Plus} from "../src/randomness/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "../src/randomness/VRFV2PlusClient.sol";
import {MockRandomness} from "./mocks/MockRandomness.sol";

contract MockCallback is IRandomnessCallback {
    uint256 public lastRequestId;
    uint256 public lastRandomWord;
    uint256 public fulfillCount;

    function fulfill(uint256 requestId, uint256 randomWord) external {
        lastRequestId = requestId;
        lastRandomWord = randomWord;
        fulfillCount += 1;
    }
}

/// @dev Minimal coordinator that returns incrementing ids and can push fulfillments.
contract MockVRFCoordinator is IVRFCoordinatorV2Plus {
    uint256 public nextRequestId = 1;

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata)
        external
        returns (uint256 requestId)
    {
        requestId = nextRequestId++;
    }

    function pushFulfill(address consumer, uint256 requestId, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        ChainlinkVRFAdapter(consumer).rawFulfillRandomWords(requestId, words);
    }
}

contract RandomnessTest is Test {
    bytes32 internal constant KEY_HASH = keccak256("keyhash");
    uint256 internal constant SUB_ID = 42;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal harness = makeAddr("harness");

    MockCallback internal callback;
    MockVRFCoordinator internal coordinator;
    ChainlinkVRFAdapter internal adapter;
    MockRandomness internal mock;

    function setUp() public {
        callback = new MockCallback();
        coordinator = new MockVRFCoordinator();

        vm.prank(owner);
        adapter = new ChainlinkVRFAdapter(address(coordinator), KEY_HASH, SUB_ID, true);

        vm.prank(owner);
        adapter.setCallback(address(callback));

        mock = new MockRandomness();
        mock.setCallback(address(callback));
        mock.setFulfiller(harness);
    }

    // -------------------------------------------------------------------------
    // MockRandomness
    // -------------------------------------------------------------------------

    function test_mock_request_returnsIncrementingIds() public {
        uint256 id1 = mock.requestRandom();
        uint256 id2 = mock.requestRandom();
        uint256 id3 = mock.requestRandom();
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(id3, 3);
        assertTrue(mock.pending(id1));
        assertTrue(mock.pending(id2));
        assertTrue(mock.pending(id3));
    }

    function test_mock_fulfill_routesToCallback() public {
        uint256 id = mock.requestRandom();
        uint256 word = 0xdeadbeef;

        vm.prank(harness);
        mock.fulfill(id, word);

        assertEq(callback.lastRequestId(), id);
        assertEq(callback.lastRandomWord(), word);
        assertEq(callback.fulfillCount(), 1);
        assertFalse(mock.pending(id));
    }

    function test_mock_fulfill_reverts_notFulfiller() public {
        uint256 id = mock.requestRandom();

        vm.prank(stranger);
        vm.expectRevert(MockRandomness.NotFulfiller.selector);
        mock.fulfill(id, 123);
    }

    function test_mock_callback_setOnce() public {
        vm.expectRevert(MockRandomness.CallbackAlreadySet.selector);
        mock.setCallback(makeAddr("other"));
    }

    function test_mock_fulfiller_setOnce() public {
        vm.expectRevert(MockRandomness.FulfillerAlreadySet.selector);
        mock.setFulfiller(makeAddr("other"));
    }

    // -------------------------------------------------------------------------
    // ChainlinkVRFAdapter
    // -------------------------------------------------------------------------

    function test_adapter_request_returnsIncrementingIds() public {
        vm.prank(address(callback));
        uint256 id1 = adapter.requestRandom();
        vm.prank(address(callback));
        uint256 id2 = adapter.requestRandomFor(makeAddr("u2"));
        vm.prank(address(callback));
        uint256 id3 = adapter.requestRandomFor(makeAddr("u3"));
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(id3, 3);
    }

    function test_adapter_fulfill_routesToCallback() public {
        address user = makeAddr("scratcher");
        vm.prank(address(callback));
        uint256 id = adapter.requestRandomFor(user);
        uint256 vrfWord = 999_888_777;
        uint256 expected = uint256(keccak256(abi.encode(vrfWord, id, user)));

        coordinator.pushFulfill(address(adapter), id, vrfWord);

        assertEq(callback.lastRequestId(), id);
        assertEq(callback.lastRandomWord(), expected);
        assertEq(callback.fulfillCount(), 1);
        assertEq(adapter.requesters(id), user);
    }

    function test_adapter_fulfill_requestRandom_bindsZeroRequester() public {
        vm.prank(address(callback));
        uint256 id = adapter.requestRandom();
        uint256 vrfWord = 42;
        uint256 expected = uint256(keccak256(abi.encode(vrfWord, id, address(0))));

        coordinator.pushFulfill(address(adapter), id, vrfWord);

        assertEq(callback.lastRandomWord(), expected);
        assertEq(adapter.requesters(id), address(0));
    }

    function test_adapter_fulfill_reverts_notCoordinator() public {
        uint256[] memory words = new uint256[](1);
        words[0] = 1;

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                ChainlinkVRFAdapter.OnlyCoordinatorCanFulfill.selector, stranger, address(coordinator)
            )
        );
        adapter.rawFulfillRandomWords(1, words);
    }

    function test_adapter_request_reverts_notCallback() public {
        vm.prank(stranger);
        vm.expectRevert(ChainlinkVRFAdapter.NotCallback.selector);
        adapter.requestRandom();
    }

    function test_adapter_requestFor_reverts_notCallback() public {
        vm.prank(stranger);
        vm.expectRevert(ChainlinkVRFAdapter.NotCallback.selector);
        adapter.requestRandomFor(stranger);
    }

    function test_adapter_callback_setOnce() public {
        vm.prank(owner);
        vm.expectRevert(ChainlinkVRFAdapter.CallbackAlreadySet.selector);
        adapter.setCallback(makeAddr("other"));
    }
}
