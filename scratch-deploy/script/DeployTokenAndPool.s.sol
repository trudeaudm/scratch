// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SCRATCH} from "../src/SCRATCH.sol";

interface INonfungiblePositionManager {
    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool);
}

interface IUniswapV3PoolState {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @notice Trimmed launch script: deploy token -> create + initialize the 1% pool
///         -> split allocations. NO liquidity is minted — you set your own ranges
///         by hand through the Uniswap UI afterward (see README, "Manual LP").
///
///         The LP tranche is sent to LP_MINTER (the wallet you'll connect to the
///         Uniswap UI — use the treasury itself so position NFTs are born there).
///
/// Env vars:
///   PRIVATE_KEY, NPM, WETH9, TREASURY, SQRT_PRICE_X96
///   LP_MINTER   wallet that will mint positions manually (recommend = TREASURY)
contract DeployTokenAndPool is Script {
    uint256 constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint16  constant LP_BPS       = 6_500; // stays liquid for manual minting
    // remaining 35% (prize seed + ops) goes to TREASURY

    uint24 constant FEE = 10_000; // 1% tier, tick spacing 200

    function run() external {
        uint256 pk        = vm.envUint("PRIVATE_KEY");
        address npm       = vm.envAddress("NPM");
        address weth      = vm.envAddress("WETH9");
        address treasury  = vm.envAddress("TREASURY");
        address lpMinter  = vm.envAddress("LP_MINTER");
        uint160 sqrtPrice = uint160(vm.envUint("SQRT_PRICE_X96"));

        require(treasury != address(0) && lpMinter != address(0), "missing addr");

        vm.startBroadcast(pk);

        // 1. token
        SCRATCH token = new SCRATCH(msg.sender, TOTAL_SUPPLY);
        console2.log("SCRATCH:", address(token));

        bool scratchIsToken0 = address(token) < weth;
        (address token0, address token1) = scratchIsToken0
            ? (address(token), weth)
            : (weth, address(token));
        console2.log("SCRATCH is token0:", scratchIsToken0);

        // 2. pool + price init
        address pool = INonfungiblePositionManager(npm)
            .createAndInitializePoolIfNecessary(token0, token1, FEE, sqrtPrice);
        (, int24 spot,,,,,) = IUniswapV3PoolState(pool).slot0();
        console2.log("Pool:", pool);
        console2.log("Spot tick:", spot);
        // SANITY: for a tiny launch price, expect a LARGE NEGATIVE tick when
        // SCRATCH is token0, LARGE POSITIVE when token1. Wrong sign = you
        // initialized at 1/price. Zero liquidity exists yet, so if this is
        // wrong you can abandon this pool, fix SQRT_PRICE_X96, and redeploy
        // a fresh token — nothing of value is at risk until LP is minted.

        // 3. allocations
        uint256 lpAmount = (TOTAL_SUPPLY * LP_BPS) / 10_000;
        IERC20Minimal(address(token)).transfer(lpMinter, lpAmount);
        uint256 rest = IERC20Minimal(address(token)).balanceOf(msg.sender);
        IERC20Minimal(address(token)).transfer(treasury, rest);
        console2.log("LP tranche to minter:", lpAmount);
        console2.log("Prize seed + ops to treasury:", rest);

        vm.stopBroadcast();
    }
}
