// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PrizeVault} from "../src/PrizeVault.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {StandardTicketSource} from "../src/StandardTicketSource.sol";
import {ChainlinkVRFAdapter} from "../src/randomness/ChainlinkVRFAdapter.sol";
import {SelfEntropyProvider} from "../src/randomness/SelfEntropyProvider.sol";
import {ScratchGame} from "../src/ScratchGame.sol";
import {IRandomness} from "../src/interfaces/IRandomness.sol";
import {ITicketSource} from "../src/interfaces/ITicketSource.sol";

/// @dev Minimal view surface shared by both adapters for post-deploy checks.
interface IHasCallback {
    function callback() external view returns (address);
}

/// @title Deploy2
/// @notice Env-driven Phase-2 deploy (buildspec §5 + STANDARD tier). Same bytecode path for
///         §9 mainnet rehearsal and production — every param (including `RESCUE_DELAY` and
///         `PROMO_DAILY_CAP`) comes from env; no rehearsal-only branches.
///
/// Deploy order: PrizeVault → StakingVault → StandardTicketSource → randomness provider
/// (`RANDOMNESS_PROVIDER` = `chainlink` | `self`) → ScratchGame → wire callback/setGame/
/// ticket sources/prize tables → transfer Ownable2Step ownership of ScratchGame, PrizeVault,
/// StandardTicketSource to TREASURY (treasury must `acceptOwnership` for each) → renounce
/// StakingVault ownership after `setGame`.
contract Deploy2 is Script {
    struct Deployed {
        PrizeVault prizeVault;
        StakingVault stakingVault;
        StandardTicketSource standardSource;
        IRandomness randomness;
        ChainlinkVRFAdapter adapter;
        SelfEntropyProvider selfEntropy;
        ScratchGame game;
        address scratch;
        address treasury;
    }

    error WiringFailed(string what);
    error StandardTableNotScratchOnly(address asset);
    error UnknownRandomnessProvider(string provider);

    /// @notice Full deploy + wiring + ownership handoff + post-deploy assertions.
    function run() external returns (Deployed memory d) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        d.scratch = vm.envAddress("SCRATCH");
        d.treasury = vm.envAddress("TREASURY");
        uint256 emissionRate = vm.envUint("EMISSION_RATE");
        uint256 minStake = vm.envUint("MIN_STAKE");
        uint64 rescueDelay = uint64(vm.envUint("RESCUE_DELAY"));
        uint256 promoDailyCap = vm.envUint("PROMO_DAILY_CAP");
        string memory providerMode = vm.envString("RANDOMNESS_PROVIDER");

        ScratchGame.PrizeRow[] memory premiumTable =
            abi.decode(vm.envBytes("PREMIUM_PRIZE_TABLE"), (ScratchGame.PrizeRow[]));
        ScratchGame.PrizeRow[] memory standardTable =
            abi.decode(vm.envBytes("STANDARD_PRIZE_TABLE"), (ScratchGame.PrizeRow[]));

        vm.startBroadcast(deployerKey);

        d.prizeVault = new PrizeVault(IERC20(d.scratch));
        d.stakingVault = new StakingVault(IERC20(d.scratch), emissionRate, minStake);
        d.standardSource = new StandardTicketSource(promoDailyCap);

        if (_eq(providerMode, "chainlink")) {
            address vrfCoordinator = vm.envAddress("VRF_COORDINATOR");
            bytes32 vrfKeyHash = vm.envBytes32("VRF_KEYHASH");
            uint256 vrfSubId = vm.envUint("VRF_SUB_ID");
            bool vrfNativePayment = vm.envBool("VRF_NATIVE_PAYMENT");
            d.adapter = new ChainlinkVRFAdapter(vrfCoordinator, vrfKeyHash, vrfSubId, vrfNativePayment);
            d.randomness = d.adapter;
        } else if (_eq(providerMode, "self")) {
            address operator = vm.envAddress("OPERATOR");
            bytes32 commitment = vm.envBytes32("ENTROPY_COMMITMENT");
            d.selfEntropy = new SelfEntropyProvider(operator);
            d.selfEntropy.registerChain(commitment);
            d.randomness = d.selfEntropy;
        } else {
            revert UnknownRandomnessProvider(providerMode);
        }

        d.game = new ScratchGame(d.prizeVault, d.randomness, rescueDelay);

        if (address(d.adapter) != address(0)) {
            d.adapter.setCallback(address(d.game));
        } else {
            d.selfEntropy.setCallback(address(d.game));
        }

        d.stakingVault.setGame(address(d.game));
        d.standardSource.setGame(address(d.game));
        d.prizeVault.setGame(address(d.game));
        d.game.setTicketSource(d.game.PREMIUM(), ITicketSource(address(d.stakingVault)));
        d.game.setTicketSource(d.game.STANDARD(), ITicketSource(address(d.standardSource)));
        d.game.setPrizeTable(d.game.PREMIUM(), premiumTable);
        d.game.setPrizeTable(d.game.STANDARD(), standardTable);

        // Ownable2Step: pending until treasury calls acceptOwnership on each.
        d.game.transferOwnership(d.treasury);
        d.prizeVault.transferOwnership(d.treasury);
        d.standardSource.transferOwnership(d.treasury);

        // StakingVault: renounce after setGame (no admin path over deposits — natspec / buildspec).
        d.stakingVault.renounceOwnership();

        vm.stopBroadcast();

        assertWiring(d);

        console2.log("=== Deploy2 complete ===");
        console2.log("PrizeVault:           ", address(d.prizeVault));
        console2.log("StakingVault:         ", address(d.stakingVault));
        console2.log("StandardTicketSource: ", address(d.standardSource));
        console2.log("Randomness provider:  ", address(d.randomness));
        if (address(d.adapter) != address(0)) {
            console2.log("  mode: chainlink (ChainlinkVRFAdapter)");
        } else {
            console2.log("  mode: self (SelfEntropyProvider)");
            console2.log("  operator:           ", d.selfEntropy.operator());
            console2.log("  currentEpoch:       ", d.selfEntropy.currentEpoch());
        }
        console2.log("ScratchGame:          ", address(d.game));
        console2.log("");
        console2.log("TREASURY acceptOwnership checklist (Ownable2Step pendingOwner):");
        console2.log("  1. ScratchGame          ", address(d.game));
        console2.log("  2. PrizeVault           ", address(d.prizeVault));
        console2.log("  3. StandardTicketSource ", address(d.standardSource));
        console2.log("StakingVault ownership renounced.");
    }

    /// @notice Reverts if any post-deploy wiring invariant fails.
    function assertWiring(Deployed memory d) public view {
        if (d.stakingVault.game() != address(d.game)) revert WiringFailed("stakingVault.game");
        if (d.standardSource.game() != address(d.game)) revert WiringFailed("standardSource.game");
        if (d.prizeVault.game() != address(d.game)) revert WiringFailed("prizeVault.game");
        if (IHasCallback(address(d.randomness)).callback() != address(d.game)) {
            revert WiringFailed("randomness.callback");
        }

        if (address(d.game.ticketSource(d.game.PREMIUM())) != address(d.stakingVault)) {
            revert WiringFailed("ticketSource.PREMIUM");
        }
        if (address(d.game.ticketSource(d.game.STANDARD())) != address(d.standardSource)) {
            revert WiringFailed("ticketSource.STANDARD");
        }

        if (d.game.tableLength(d.game.PREMIUM()) == 0) revert WiringFailed("premium table empty");
        if (d.game.tableLength(d.game.STANDARD()) == 0) revert WiringFailed("standard table empty");

        _assertStandardScratchOnly(d);

        if (address(d.selfEntropy) != address(0)) {
            if (d.selfEntropy.currentEpoch() == 0) revert WiringFailed("selfEntropy.epoch");
            if (d.selfEntropy.operator() == address(0)) revert WiringFailed("selfEntropy.operator");
            if (d.selfEntropy.epochCursor(d.selfEntropy.currentEpoch()) == bytes32(0)) {
                revert WiringFailed("selfEntropy.commitment");
            }
        }

        if (d.game.pendingOwner() != d.treasury) revert WiringFailed("game.pendingOwner");
        if (d.prizeVault.pendingOwner() != d.treasury) revert WiringFailed("prizeVault.pendingOwner");
        if (d.standardSource.pendingOwner() != d.treasury) revert WiringFailed("standardSource.pendingOwner");

        if (d.stakingVault.owner() != address(0)) revert WiringFailed("stakingVault not renounced");
    }

    /// @dev GATES.md: standard table is $SCRATCH-only initially (terminal no-win may be address(0)).
    function _assertStandardScratchOnly(Deployed memory d) internal view {
        uint256 n = d.game.tableLength(d.game.STANDARD());
        for (uint256 i = 0; i < n; ++i) {
            ScratchGame.PrizeRow memory row = d.game.getPrizeRow(d.game.STANDARD(), i);
            bool terminal = (i == n - 1);
            if (terminal) {
                if (row.asset != address(0)) revert StandardTableNotScratchOnly(row.asset);
            } else if (row.asset != d.scratch) {
                revert StandardTableNotScratchOnly(row.asset);
            }
        }
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
