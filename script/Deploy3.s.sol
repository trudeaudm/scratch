// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PrizeVault} from "../src/PrizeVault.sol";
import {StandardTicketSource} from "../src/StandardTicketSource.sol";
import {ChainlinkVRFAdapter} from "../src/randomness/ChainlinkVRFAdapter.sol";
import {SelfEntropyProvider} from "../src/randomness/SelfEntropyProvider.sol";
import {StakingVaultV2} from "../src/v2/StakingVaultV2.sol";
import {ScratchGameV2} from "../src/v2/ScratchGameV2.sol";
import {IRandomness} from "../src/interfaces/IRandomness.sol";
import {ITicketSource} from "../src/interfaces/ITicketSource.sol";

/// @dev Minimal view surface shared by both adapters for post-deploy checks.
interface IHasCallback {
    function callback() external view returns (address);
}

/// @title Deploy3
/// @notice Env-driven v2 full-stack deploy. Deploys a FRESH parallel stack
///         (PrizeVault, StandardTicketSource, SelfEntropyProvider / Chainlink
///         reused as source files — fresh instances) plus StakingVaultV2 and
///         ScratchGameV2. Same freeze-on-first-set wiring posture as Deploy2.
///
/// Extra env vs Deploy2: UNLOCK_NORMAL, UNLOCK_ENHANCED, BOOST_BPS, BURN_BPS.
/// SCRATCH token address is unchanged (same Phase-1 token).
///
/// Deploy order: PrizeVault → StakingVaultV2 → StandardTicketSource → randomness
/// → ScratchGameV2 → wire → transfer Ownable2Step ownership of ScratchGameV2,
/// PrizeVault, StandardTicketSource (+ SelfEntropyProvider Ownable transfer) to
/// TREASURY → renounce StakingVaultV2 ownership after `setGame`.
contract Deploy3 is Script {
    struct Deployed {
        PrizeVault prizeVault;
        StakingVaultV2 stakingVault;
        StandardTicketSource standardSource;
        IRandomness randomness;
        ChainlinkVRFAdapter adapter;
        SelfEntropyProvider selfEntropy;
        ScratchGameV2 game;
        address scratch;
        address treasury;
    }

    error WiringFailed(string what);
    error StandardTableNotScratchOnly(address asset);
    error UnknownRandomnessProvider(string provider);
    error BadUnlockPeriod();
    error BadBoostBps();
    error BadBurnBps();
    error BadMaxBatch();

    /// @notice Full deploy + wiring + ownership handoff + post-deploy assertions.
    function run() external returns (Deployed memory d) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        d.scratch = vm.envAddress("SCRATCH");
        d.treasury = vm.envAddress("TREASURY");
        uint64 rescueDelay = uint64(vm.envUint("RESCUE_DELAY"));
        string memory providerMode = vm.envString("RANDOMNESS_PROVIDER");

        ScratchGameV2.PrizeRow[] memory premiumTable =
            abi.decode(vm.envBytes("PREMIUM_PRIZE_TABLE"), (ScratchGameV2.PrizeRow[]));
        ScratchGameV2.PrizeRow[] memory standardTable =
            abi.decode(vm.envBytes("STANDARD_PRIZE_TABLE"), (ScratchGameV2.PrizeRow[]));

        vm.startBroadcast(deployerKey);

        d.prizeVault = new PrizeVault(IERC20(d.scratch));
        d.stakingVault = _deployStaking(IERC20(d.scratch));
        d.standardSource = new StandardTicketSource(vm.envUint("PROMO_DAILY_CAP"));
        _deployRandomness(d, providerMode);

        d.game = new ScratchGameV2(d.prizeVault, d.randomness, rescueDelay);

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

        // SelfEntropyProvider is Ownable (not 2Step) — transfer completes this tx.
        // v1 Deploy2 missed this handoff; include it here.
        if (address(d.selfEntropy) != address(0)) {
            d.selfEntropy.transferOwnership(d.treasury);
        }

        // StakingVaultV2: renounce after setGame (no admin path over deposits).
        d.stakingVault.renounceOwnership();

        vm.stopBroadcast();

        assertWiring(d);

        console2.log("=== Deploy3 complete ===");
        console2.log("PrizeVault:           ", address(d.prizeVault));
        console2.log("StakingVaultV2:       ", address(d.stakingVault));
        console2.log("StandardTicketSource: ", address(d.standardSource));
        console2.log("Randomness provider:  ", address(d.randomness));
        if (address(d.adapter) != address(0)) {
            console2.log("  mode: chainlink (ChainlinkVRFAdapter)");
        } else {
            console2.log("  mode: self (SelfEntropyProvider)");
            console2.log("  operator:           ", d.selfEntropy.operator());
            console2.log("  currentEpoch:       ", d.selfEntropy.currentEpoch());
        }
        console2.log("ScratchGameV2:        ", address(d.game));
        console2.log("UNLOCK_NORMAL:        ", d.stakingVault.unlockNormal());
        console2.log("UNLOCK_ENHANCED:      ", d.stakingVault.unlockEnhanced());
        console2.log("BOOST_BPS:            ", d.stakingVault.boostBps());
        console2.log("BURN_BPS:             ", d.stakingVault.burnBps());
        console2.log("MAX_BATCH:            ", d.game.MAX_BATCH());
        console2.log("");
        console2.log("TREASURY acceptOwnership checklist (Ownable2Step pendingOwner):");
        console2.log("  1. ScratchGameV2        ", address(d.game));
        console2.log("  2. PrizeVault           ", address(d.prizeVault));
        console2.log("  3. StandardTicketSource ", address(d.standardSource));
        if (address(d.selfEntropy) != address(0)) {
            console2.log("  4. SelfEntropyProvider  ", address(d.selfEntropy), "(Ownable - already transferred this tx)");
        }
        console2.log("StakingVaultV2 ownership renounced.");
        console2.log("");
        console2.log("Reminder: re-add holder-drop crediter on the new StandardTicketSource: addCrediter(<bot>, 200e18)");
    }

    function _deployStaking(IERC20 scratch_) internal returns (StakingVaultV2) {
        return new StakingVaultV2(
            scratch_,
            vm.envUint("EMISSION_RATE"),
            vm.envUint("MIN_STAKE"),
            uint64(vm.envUint("UNLOCK_NORMAL")),
            uint64(vm.envUint("UNLOCK_ENHANCED")),
            uint16(vm.envUint("BOOST_BPS")),
            uint16(vm.envUint("BURN_BPS"))
        );
    }

    function _deployRandomness(Deployed memory d, string memory providerMode) internal {
        if (_eq(providerMode, "chainlink")) {
            d.adapter = new ChainlinkVRFAdapter(
                vm.envAddress("VRF_COORDINATOR"),
                vm.envBytes32("VRF_KEYHASH"),
                vm.envUint("VRF_SUB_ID"),
                vm.envBool("VRF_NATIVE_PAYMENT")
            );
            d.randomness = d.adapter;
        } else if (_eq(providerMode, "self")) {
            d.selfEntropy = new SelfEntropyProvider(vm.envAddress("OPERATOR"));
            d.selfEntropy.registerChain(vm.envBytes32("ENTROPY_COMMITMENT"));
            d.randomness = d.selfEntropy;
        } else {
            revert UnknownRandomnessProvider(providerMode);
        }
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

        if (d.stakingVault.unlockNormal() == 0) revert BadUnlockPeriod();
        if (d.stakingVault.unlockEnhanced() == 0) revert BadUnlockPeriod();
        // boost may be 0 (no premium); burn may be 0 (no exit burn) — still assert immutables match env by non-zero periods + MAX_BATCH.
        if (d.stakingVault.burnBps() > 10_000) revert BadBurnBps();
        if (d.game.MAX_BATCH() != 20) revert BadMaxBatch();
        // Silence unused-error for boost when zero is valid — still surface via log; assert boost fits uint16 path.
        if (uint256(d.stakingVault.boostBps()) > 10_000) revert BadBoostBps();

        if (address(d.selfEntropy) != address(0)) {
            if (d.selfEntropy.currentEpoch() == 0) revert WiringFailed("selfEntropy.epoch");
            if (d.selfEntropy.operator() == address(0)) revert WiringFailed("selfEntropy.operator");
            if (d.selfEntropy.epochCursor(d.selfEntropy.currentEpoch()) == bytes32(0)) {
                revert WiringFailed("selfEntropy.commitment");
            }
            if (d.selfEntropy.owner() != d.treasury) revert WiringFailed("selfEntropy.owner");
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
            ScratchGameV2.PrizeRow memory row = d.game.getPrizeRow(d.game.STANDARD(), i);
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
