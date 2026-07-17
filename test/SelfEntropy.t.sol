// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ScratchGame} from "../src/ScratchGame.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {PrizeVault} from "../src/PrizeVault.sol";
import {SelfEntropyProvider} from "../src/randomness/SelfEntropyProvider.sol";
import {ITicketSource} from "../src/interfaces/ITicketSource.sol";
import {IRandomnessCallback} from "../src/interfaces/IRandomness.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockEntropyCallback is IRandomnessCallback {
    uint256 public lastRequestId;
    uint256 public lastRandomWord;
    uint256 public fulfillCount;

    function fulfill(uint256 requestId, uint256 randomWord) external {
        lastRequestId = requestId;
        lastRandomWord = randomWord;
        fulfillCount += 1;
    }
}

/// @dev SelfEntropyProvider unit + ScratchGame integration (buildspec randomness path).
contract SelfEntropyProviderTest is Test {
    uint256 internal constant EMISSION_RATE = 1e18;
    uint256 internal constant MIN_STAKE = 100e18;
    uint64 internal constant RESCUE_DELAY = 24 hours;
    uint8 internal constant PREMIUM = 1;
    uint256 internal constant CHAIN_LEN = 16;

    MockERC20 internal scratch;
    MockERC20 internal usdg;
    StakingVault internal staking;
    PrizeVault internal prizes;
    SelfEntropyProvider internal entropy;
    ScratchGame internal game;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");

    /// @dev chain[0] = secret; chain[i] = keccak256(abi.encodePacked(chain[i-1])); tip = chain[N].
    bytes32[] internal chain;

    function setUp() public {
        scratch = new MockERC20("SCRATCH", "SCRATCH");
        usdg = new MockERC20("USDG", "USDG");

        _buildChain(keccak256("test-secret"), CHAIN_LEN);

        vm.startPrank(owner);
        staking = new StakingVault(scratch, EMISSION_RATE, MIN_STAKE);
        prizes = new PrizeVault(scratch);
        entropy = new SelfEntropyProvider(operator);
        game = new ScratchGame(prizes, entropy, RESCUE_DELAY);

        staking.setGame(address(game));
        prizes.setGame(address(game));
        game.setTicketSource(PREMIUM, ITicketSource(address(staking)));
        entropy.setCallback(address(game));
        entropy.registerChain(chain[CHAIN_LEN]);
        vm.stopPrank();

        scratch.mint(alice, 1_000_000e18);
        vm.prank(alice);
        scratch.approve(address(staking), type(uint256).max);
        vm.prank(alice);
        staking.deposit(MIN_STAKE);
        vm.warp(block.timestamp + 1);

        usdg.mint(address(prizes), 10_000e18);
        scratch.mint(address(prizes), 1_000_000e18);

        ScratchGame.PrizeRow[] memory table = new ScratchGame.PrizeRow[](2);
        table[0] = ScratchGame.PrizeRow({
            asset: address(usdg),
            amountOrBps: 100e18,
            isBpsOfPool: false,
            cumOdds: 100_000
        });
        table[1] = ScratchGame.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
        vm.prank(owner);
        game.setPrizeTable(PREMIUM, table);
    }

    function _buildChain(bytes32 secret, uint256 n) internal {
        delete chain;
        chain.push(secret);
        for (uint256 i = 1; i <= n; i++) {
            chain.push(keccak256(abi.encodePacked(chain[i - 1])));
        }
    }

    function _accrueOneTicket() internal {
        if (staking.ticketsOf(alice) >= 1e18) return;
        uint256 short = 1e18 - staking.ticketsOf(alice);
        uint256 secs = (short + EMISSION_RATE - 1) / EMISSION_RATE;
        vm.warp(block.timestamp + secs);
    }

    function _revealIndex() internal view returns (uint256) {
        // Cursor starts at chain[N]; first reveal uses chain[N-1], then N-2, ...
        bytes32 cursor = entropy.epochCursor(entropy.currentEpoch());
        for (uint256 i = chain.length; i > 0; i--) {
            if (chain[i - 1] == cursor) {
                require(i >= 2, "chain exhausted");
                return i - 2;
            }
        }
        revert("cursor not in chain");
    }

    // -------------------------------------------------------------------------
    // Happy path through ScratchGame
    // -------------------------------------------------------------------------

    function test_correctPreimage_advancesAndFulfillsThroughGame() public {
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        (,,, ScratchGame.Status statusBefore) = game.requests(id);
        assertEq(uint8(statusBefore), uint8(ScratchGame.Status.Pending));

        uint256 idx = _revealIndex();
        bytes32 preimage = chain[idx];

        vm.prank(operator);
        entropy.reveal(id, preimage);

        (,,, ScratchGame.Status statusAfter) = game.requests(id);
        assertEq(uint8(statusAfter), uint8(ScratchGame.Status.Settled));
        assertEq(entropy.epochCursor(1), preimage);
        (address requester,, bool pending) = entropy.requests(id);
        assertFalse(pending);
        assertEq(requester, alice);
    }

    function test_samePreimageAndSeq_differentRequesters_differentWords() public {
        MockEntropyCallback cb = new MockEntropyCallback();
        SelfEntropyProvider e2 = new SelfEntropyProvider(operator);
        e2.setCallback(address(cb));
        e2.registerChain(chain[CHAIN_LEN]);

        bytes32 preimage = chain[CHAIN_LEN - 1];
        address userA = makeAddr("userA");
        address userB = makeAddr("userB");

        vm.prank(address(cb));
        uint256 idA = e2.requestRandomFor(userA);
        // Fulfill A so we can reuse the same preimage against a fresh provider for B.
        vm.prank(operator);
        e2.reveal(idA, preimage);
        uint256 wordA = cb.lastRandomWord();

        SelfEntropyProvider e3 = new SelfEntropyProvider(operator);
        e3.setCallback(address(cb));
        e3.registerChain(chain[CHAIN_LEN]);
        vm.prank(address(cb));
        uint256 idB = e3.requestRandomFor(userB);
        assertEq(idB, idA); // same seq on a fresh provider
        vm.prank(operator);
        e3.reveal(idB, preimage);
        uint256 wordB = cb.lastRandomWord();

        assertEq(wordA, uint256(keccak256(abi.encode(preimage, idA, userA))));
        assertEq(wordB, uint256(keccak256(abi.encode(preimage, idB, userB))));
        assertTrue(wordA != wordB);
    }

    function test_gamePassesActualScratcher() public {
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);
        (address requester,,) = entropy.requests(id);
        assertEq(requester, alice);
        assertTrue(requester != address(game));
    }

    function test_requestRandom_revertsUnimplemented() public {
        vm.expectRevert(SelfEntropyProvider.Unimplemented.selector);
        entropy.requestRandom();
    }

    function test_twoSequentialReveals_walkTheChain() public {
        _accrueOneTicket();
        vm.prank(alice);
        uint256 id1 = game.scratch(PREMIUM);

        uint256 idx1 = _revealIndex();
        vm.prank(operator);
        entropy.reveal(id1, chain[idx1]);
        assertEq(entropy.epochCursor(1), chain[idx1]);

        _accrueOneTicket();
        vm.prank(alice);
        uint256 id2 = game.scratch(PREMIUM);

        uint256 idx2 = _revealIndex();
        assertEq(idx2, idx1 - 1);
        assertEq(keccak256(abi.encodePacked(chain[idx2])), chain[idx1]);

        vm.prank(operator);
        entropy.reveal(id2, chain[idx2]);

        assertEq(entropy.epochCursor(1), chain[idx2]);
        (,,, ScratchGame.Status s1) = game.requests(id1);
        (,,, ScratchGame.Status s2) = game.requests(id2);
        assertEq(uint8(s1), uint8(ScratchGame.Status.Settled));
        assertEq(uint8(s2), uint8(ScratchGame.Status.Settled));
        assertEq(id2, id1 + 1);
    }

    // -------------------------------------------------------------------------
    // Reverts
    // -------------------------------------------------------------------------

    function test_wrongPreimage_reverts() public {
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        vm.prank(operator);
        vm.expectRevert(SelfEntropyProvider.BadPreimage.selector);
        entropy.reveal(id, bytes32(uint256(0xdead)));
    }

    function test_outOfOrder_reverts() public {
        _accrueOneTicket();
        vm.prank(alice);
        uint256 id1 = game.scratch(PREMIUM);
        _accrueOneTicket();
        vm.prank(alice);
        uint256 id2 = game.scratch(PREMIUM);

        // Skip id1 — try to reveal id2 first with the correct tip preimage.
        uint256 idx = _revealIndex();
        vm.prank(operator);
        vm.expectRevert(SelfEntropyProvider.OutOfOrder.selector);
        entropy.reveal(id2, chain[idx]);

        // id1 still pending and revealable.
        vm.prank(operator);
        entropy.reveal(id1, chain[idx]);
        assertEq(id2, id1 + 1);
    }

    function test_orphanedPriorEpoch_cannotReveal_butCanRescue() public {
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);

        // Preimage that would have fulfilled epoch 1.
        bytes32 oldPreimage = chain[CHAIN_LEN - 1];
        assertEq(keccak256(abi.encodePacked(oldPreimage)), chain[CHAIN_LEN]);

        // New epoch orphans the pending request.
        bytes32 newTip = keccak256("fresh-chain-tip");
        vm.prank(owner);
        entropy.registerChain(newTip);
        assertEq(entropy.currentEpoch(), 2);

        vm.prank(operator);
        vm.expectRevert(SelfEntropyProvider.WrongEpoch.selector);
        entropy.reveal(id, oldPreimage);

        // Game rescue path refunds after delay.
        vm.warp(block.timestamp + RESCUE_DELAY);
        uint256 ticketsBefore = staking.ticketsOf(alice);
        vm.prank(stranger);
        game.rescue(id);
        assertEq(staking.ticketsOf(alice), ticketsBefore + 1e18);

        (,,, ScratchGame.Status status) = game.requests(id);
        assertEq(uint8(status), uint8(ScratchGame.Status.Rescued));
    }

    // -------------------------------------------------------------------------
    // Auth
    // -------------------------------------------------------------------------

    function test_onlyOperator_canReveal() public {
        vm.prank(alice);
        uint256 id = game.scratch(PREMIUM);
        uint256 idx = _revealIndex();

        vm.prank(stranger);
        vm.expectRevert(SelfEntropyProvider.NotOperator.selector);
        entropy.reveal(id, chain[idx]);
    }

    function test_onlyCallback_canRequest() public {
        vm.prank(stranger);
        vm.expectRevert(SelfEntropyProvider.NotCallback.selector);
        entropy.requestRandomFor(alice);
    }

    function test_setOperator_emitsAndUpdates() public {
        address nextOp = makeAddr("nextOp");
        vm.prank(owner);
        vm.expectEmit(true, true, false, false, address(entropy));
        emit SelfEntropyProvider.OperatorSet(operator, nextOp);
        entropy.setOperator(nextOp);
        assertEq(entropy.operator(), nextOp);
    }

    function test_request_beforeChain_reverts() public {
        SelfEntropyProvider bare = new SelfEntropyProvider(operator);
        MockEntropyCallback cb = new MockEntropyCallback();
        bare.setCallback(address(cb));

        vm.prank(address(cb));
        vm.expectRevert(SelfEntropyProvider.NoChainRegistered.selector);
        bare.requestRandomFor(alice);
    }
}
