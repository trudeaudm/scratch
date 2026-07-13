// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SCRATCH} from "../src/SCRATCH.sol";

/*//////////////////////////////////////////////////////////////
                    MINIMAL EXTERNAL INTERFACES
    (inlined to avoid v3-periphery dependency/version friction)
//////////////////////////////////////////////////////////////*/

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool);

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
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

interface IWETH9 {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/*//////////////////////////////////////////////////////////////
                         DEPLOY SCRIPT
//////////////////////////////////////////////////////////////*/

/// @notice Atomic launch: deploy token -> create+initialize 1% pool ->
///         mint laddered single-sided LP (recipient = TREASURY) ->
///         optional small two-sided depth position -> transfer
///         non-LP allocations to TREASURY.
///
///         Everything happens inside one broadcast so nothing can be
///         sniped between steps. Run `forge script ... --slow` is NOT
///         needed; keep it as one tx sequence in one block where possible.
///
/// Required env vars (see README-deploy.md):
///   PRIVATE_KEY        deployer key (fresh, hardware-derived, never Permit2'd)
///   NPM                NonfungiblePositionManager address on chain 4663
///   WETH9              canonical WETH on chain 4663
///   TREASURY           Safe / hardware EOA that owns LP NFTs + allocations
///   SQRT_PRICE_X96     initial price, Q64.96 (compute per README)
///   DEPTH_ETH_WEI      optional two-sided depth ETH (0 to skip)
contract Deploy is Script {
    // ----- supply & allocations (edit here, keep BPS summing to 10_000) -----
    uint256 constant TOTAL_SUPPLY   = 1_000_000_000e18; // 1B
    uint16  constant LP_BPS         = 6_500;            // 65% -> the curve
    uint16  constant PRIZE_BPS      = 2_000;            // 20% -> prize vault seed (parked at treasury until vault ships)
    uint16  constant TREASURY_BPS   = 1_500;            // 15% -> ops/emissions reserve

    // ----- pool -----
    uint24 constant FEE          = 10_000; // 1% tier
    int24  constant TICK_SPACING = 200;    // spacing for the 1% tier
    int24  constant MAX_TICK     = 887_200; // MAX_TICK (887272) floored to spacing

    // ----- the ladder (edit to shape the curve) -----
    // Thin-at-launch profile: small share of LP tokens near spot (violent
    // early candles), the bulk stacked higher. Rung i puts RUNG_BPS[i] of the
    // LP tranche into [spot + GAP, spot + GAP + WIDTH] (direction handled
    // automatically for token ordering). All tick values must be multiples
    // of TICK_SPACING. Rough guide at 18-dec/18-dec pairs:
    // +6,932 ticks ~= 2x price, +13,863 ~= 4x, +23,027 ~= 10x, +46,054 ~= 100x.
    uint16[3] RUNG_BPS   = [uint16(1_000), 3_000, 6_000]; // 10% / 30% / 60% of LP tranche
    int24[3]  RUNG_GAP   = [int24(200),  14_000, 46_200]; // distance of rung start above spot
    int24[3]  RUNG_WIDTH = [int24(13_800), 32_200, 200_000]; // rung span

    function run() external {
        uint256 pk        = vm.envUint("PRIVATE_KEY");
        address npm       = vm.envAddress("NPM");
        address weth      = vm.envAddress("WETH9");
        address treasury  = vm.envAddress("TREASURY");
        uint160 sqrtPrice = uint160(vm.envUint("SQRT_PRICE_X96"));
        uint256 depthEth  = vm.envUint("DEPTH_ETH_WEI");

        require(LP_BPS + PRIZE_BPS + TREASURY_BPS == 10_000, "alloc != 100%");
        require(treasury != address(0), "no treasury");

        vm.startBroadcast(pk);

        // 1. token — full supply to this script's sender
        SCRATCH token = new SCRATCH(msg.sender, TOTAL_SUPPLY);
        console2.log("SCRATCH:", address(token));

        // 2. ordering — determines which side of spot is "token-only"
        bool scratchIsToken0 = address(token) < weth;
        (address token0, address token1) = scratchIsToken0
            ? (address(token), weth)
            : (weth, address(token));
        // NOTE: SQRT_PRICE_X96 encodes price as token1/token0 in raw units.
        // Compute it AFTER you know the ordering — see README. If you compute
        // it for the wrong ordering the pool initializes at 1/price. The
        // README includes a sanity assertion for this; do not skip it.

        // 3. create + initialize the 1% pool
        address pool = INonfungiblePositionManager(npm)
            .createAndInitializePoolIfNecessary(token0, token1, FEE, sqrtPrice);
        console2.log("Pool:", pool);

        (, int24 spot,,,,,) = IUniswapV3PoolState(pool).slot0();
        console2.log("Spot tick:", spot);

        // 4. approve LP tranche
        uint256 lpAmount = (TOTAL_SUPPLY * LP_BPS) / 10_000;
        IERC20Minimal(address(token)).approve(npm, lpAmount);

        // 5. mint the ladder, single-sided SCRATCH, direct to treasury
        for (uint256 i = 0; i < RUNG_BPS.length; i++) {
            uint256 amt = (lpAmount * RUNG_BPS[i]) / 10_000;
            (int24 lower, int24 upper) = _rungTicks(spot, RUNG_GAP[i], RUNG_WIDTH[i], scratchIsToken0);

            INonfungiblePositionManager.MintParams memory p = INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: FEE,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: scratchIsToken0 ? amt : 0,
                amount1Desired: scratchIsToken0 ? 0 : amt,
                amount0Min: 0, // safe: atomic with pool creation, nothing can trade before this
                amount1Min: 0,
                recipient: treasury,
                deadline: block.timestamp
            });
            (uint256 id,,,) = INonfungiblePositionManager(npm).mint(p);
            console2.log("Rung", i, "position id:", id);
        }

        // 6. optional two-sided full-range depth position
        if (depthEth > 0) {
            IWETH9(weth).deposit{value: depthEth}();
            IWETH9(weth).approve(npm, depthEth);
            // pair with a matching sliver of remaining SCRATCH; NPM takes what
            // the ratio allows and refunds nothing here (desired = max bounds).
            uint256 pairTokens = IERC20Minimal(address(token)).balanceOf(msg.sender) / 20; // <=5% of remainder
            IERC20Minimal(address(token)).approve(npm, pairTokens);

            INonfungiblePositionManager.MintParams memory d = INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: FEE,
                tickLower: -MAX_TICK,
                tickUpper: MAX_TICK,
                amount0Desired: scratchIsToken0 ? pairTokens : depthEth,
                amount1Desired: scratchIsToken0 ? depthEth : pairTokens,
                amount0Min: 0,
                amount1Min: 0,
                recipient: treasury,
                deadline: block.timestamp
            });
            (uint256 did,,,) = INonfungiblePositionManager(npm).mint(d);
            console2.log("Depth position id:", did);
        }

        // 7. ship remaining allocations to treasury (prize seed + ops).
        //    Split out to the prize vault contract when Phase 2 deploys.
        uint256 rest = IERC20Minimal(address(token)).balanceOf(msg.sender);
        IERC20Minimal(address(token)).transfer(treasury, rest);
        console2.log("Non-LP allocation to treasury:", rest);

        vm.stopBroadcast();
    }

    /// @dev Single-sided SCRATCH must sit on the side of spot the price moves
    ///      *through* as SCRATCH is bought:
    ///      - SCRATCH = token0: buys push tick UP  -> rung ABOVE spot
    ///      - SCRATCH = token1: buys push tick DOWN -> rung BELOW spot
    function _rungTicks(int24 spot, int24 gap, int24 width, bool scratchIsToken0)
        internal
        pure
        returns (int24 lower, int24 upper)
    {
        if (scratchIsToken0) {
            lower = _alignUp(spot + gap);
            upper = _align(lower + width);
        } else {
            upper = _alignDown(spot - gap);
            lower = _align(upper - width);
        }
        require(lower < upper, "bad rung");
        require(upper <= MAX_TICK && lower >= -MAX_TICK, "rung out of range");
    }

    function _align(int24 t) internal pure returns (int24) {
        return (t / TICK_SPACING) * TICK_SPACING;
    }

    function _alignUp(int24 t) internal pure returns (int24) {
        int24 a = _align(t);
        return a >= t ? a : a + TICK_SPACING;
    }

    function _alignDown(int24 t) internal pure returns (int24) {
        int24 a = _align(t);
        return a <= t ? a : a - TICK_SPACING;
    }
}
