// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {StakingVault} from "../../src/StakingVault.sol";
import {StandardTicketSource} from "../../src/StandardTicketSource.sol";
import {PrizeVault} from "../../src/PrizeVault.sol";
import {ScratchGame} from "../../src/ScratchGame.sol";
import {ITicketSource} from "../../src/interfaces/ITicketSource.sol";
import {MockRandomness} from "../mocks/MockRandomness.sol";

contract ForkScratch is ERC20 {
    constructor() ERC20("SCRATCH", "SCRATCH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

interface IERC20Metadata is IERC20 {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface IUniswapV3Factory {
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface INonfungiblePositionManager {
    function factory() external view returns (address);
    function WETH9() external view returns (address);
}

/// @dev Buildspec §6 fork integration suite against Robinhood Chain (4663).
///      Run via `anvil --fork-url $RPC_URL` then `--fork-url http://127.0.0.1:8545`,
///      or one-shot `forge test --match-path test/fork/* --fork-url $RPC_URL`.
///
///      Env (optional overrides; defaults = canonical 4663 addresses from GATES/docs):
///        RPC_URL, USDG, WETH9, UNISWAP_V3_FACTORY, NPM
contract ForkIntegrationTest is Test {
    uint256 internal constant CHAIN_ID = 4663;
    uint256 internal constant EMISSION_RATE = 1e18;
    uint256 internal constant MIN_STAKE = 1e18;
    uint64 internal constant RESCUE_DELAY = 600;
    uint256 internal constant PROMO_DAILY_CAP = 1000e18;
    uint8 internal constant STANDARD = 0;
    uint8 internal constant PREMIUM = 1;
    uint256 internal constant TICKET = 1e18;

    // Canonical Robinhood Chain (4663) addresses — overridable via env.
    address internal constant DEFAULT_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant DEFAULT_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant DEFAULT_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant DEFAULT_NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;

    bool internal forked;

    ForkScratch internal scratch;
    IERC20Metadata internal weth;
    IERC20Metadata internal usdg;
    address internal v3Factory;
    address internal npm;

    StakingVault internal staking;
    StandardTicketSource internal standard;
    PrizeVault internal prizes;
    ScratchGame internal game;
    MockRandomness internal randomness;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        if (block.chainid != CHAIN_ID) {
            string memory rpc = vm.envOr("RPC_URL", string(""));
            if (bytes(rpc).length == 0) {
                forked = false;
                return;
            }
            vm.createSelectFork(rpc);
        }
        require(block.chainid == CHAIN_ID, "not chain 4663");
        forked = true;

        weth = IERC20Metadata(vm.envOr("WETH9", DEFAULT_WETH));
        usdg = IERC20Metadata(vm.envOr("USDG", DEFAULT_USDG));
        v3Factory = vm.envOr("UNISWAP_V3_FACTORY", DEFAULT_V3_FACTORY);
        npm = vm.envOr("NPM", DEFAULT_NPM);

        scratch = new ForkScratch();
        staking = new StakingVault(scratch, EMISSION_RATE, MIN_STAKE);
        standard = new StandardTicketSource(PROMO_DAILY_CAP);
        prizes = new PrizeVault(scratch);
        randomness = new MockRandomness();
        game = new ScratchGame(prizes, randomness, RESCUE_DELAY);

        staking.setGame(address(game));
        standard.setGame(address(game));
        prizes.setGame(address(game));
        game.setTicketSource(PREMIUM, ITicketSource(address(staking)));
        game.setTicketSource(STANDARD, ITicketSource(address(standard)));
        randomness.setCallback(address(game));
        randomness.setFulfiller(address(this));

        _setTables();
        prizes.setFallbackRate(address(usdg), 1e18); // 1 SCRATCH per 1e18 USDG-wei unit scale
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
        }
        _;
    }

    // -------------------------------------------------------------------------
    // Real chain state / WETH-paired Uniswap periphery
    // -------------------------------------------------------------------------

    function test_fork_realChainAssetsAndUniswapPeriphery() public onlyFork {
        assertEq(block.chainid, CHAIN_ID);

        assertGt(address(weth).code.length, 0, "WETH missing");
        assertGt(address(usdg).code.length, 0, "USDG missing");
        assertEq(weth.symbol(), "WETH");
        assertEq(usdg.symbol(), "USDG");

        assertGt(npm.code.length, 0, "NPM missing");
        assertGt(v3Factory.code.length, 0, "V3 factory missing");
        assertEq(INonfungiblePositionManager(npm).WETH9(), address(weth), "NPM WETH9 mismatch");
        assertEq(INonfungiblePositionManager(npm).factory(), v3Factory, "NPM factory mismatch");
        // 1% fee tier used by launch route (scratch-deploy).
        assertEq(IUniswapV3Factory(v3Factory).feeAmountTickSpacing(10_000), int24(200));
    }

    // -------------------------------------------------------------------------
    // Vault flows with real chain state
    // -------------------------------------------------------------------------

    function test_fork_vaultDepositWithdraw() public onlyFork {
        scratch.mint(alice, 10_000e18);
        vm.startPrank(alice);
        scratch.approve(address(staking), type(uint256).max);
        staking.deposit(5_000e18);
        vm.stopPrank();

        assertEq(staking.totalStaked(), 5_000e18);
        assertEq(scratch.balanceOf(address(staking)), 5_000e18);

        vm.warp(block.timestamp + 10);
        uint256 tickets = staking.ticketsOf(alice);
        assertEq(tickets, EMISSION_RATE * 10);

        vm.prank(alice);
        staking.withdraw(2_000e18);

        (uint256 staked,, uint256 banked) = staking.users(alice);
        assertEq(staked, 3_000e18);
        assertEq(banked, 0); // anti-flicker burn
        assertEq(staking.ticketsOf(alice), 0);
        assertEq(scratch.balanceOf(alice), 7_000e18);
    }

    // -------------------------------------------------------------------------
    // PrizeVault funded with real USDG from env / canonical address
    // -------------------------------------------------------------------------

    function test_fork_prizeVaultFundedWithRealUsdg() public onlyFork {
        uint8 dec = usdg.decimals();
        uint256 fundAmount = 100 * (10 ** uint256(dec)); // 100 USDG

        deal(address(usdg), address(this), fundAmount);
        usdg.approve(address(prizes), fundAmount);
        prizes.fund(address(usdg), fundAmount);

        assertEq(prizes.balanceOf(address(usdg)), fundAmount);

        (address[] memory assets, uint256[] memory balances) = prizes.inventory();
        bool found;
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(usdg)) {
                assertEq(balances[i], fundAmount);
                found = true;
            }
        }
        assertTrue(found, "USDG not in inventory");
    }

    // -------------------------------------------------------------------------
    // Full scratch loop — both tiers — MockRandomness stands in for VRF
    // -------------------------------------------------------------------------

    function test_fork_fullScratchLoop_bothTiers() public onlyFork {
        // Fund prize vault: SCRATCH + real USDG.
        uint256 usdgAmount = 50 * (10 ** uint256(usdg.decimals()));
        deal(address(usdg), address(this), usdgAmount);
        usdg.approve(address(prizes), usdgAmount);
        prizes.fund(address(usdg), usdgAmount);

        scratch.mint(address(this), 100_000e18);
        scratch.approve(address(prizes), type(uint256).max);
        prizes.fund(address(scratch), 50_000e18);

        // --- PREMIUM path (StakingVault) ---
        scratch.mint(alice, 10_000e18);
        vm.startPrank(alice);
        scratch.approve(address(staking), type(uint256).max);
        staking.deposit(MIN_STAKE);
        vm.stopPrank();
        vm.warp(block.timestamp + 1); // 1 ticket at EMISSION_RATE=1e18

        assertGe(staking.ticketsOf(alice), TICKET);

        vm.prank(alice);
        uint256 premiumReq = game.scratch(PREMIUM);
        // Force USDG win: roll 0 → first row (cumOdds 100_000).
        randomness.fulfill(premiumReq, 0);

        (,,, ScratchGame.Status premStatus) = game.requests(premiumReq);
        assertEq(uint8(premStatus), uint8(ScratchGame.Status.Settled));
        assertGt(usdg.balanceOf(alice), 0, "premium winner should receive USDG");

        // --- STANDARD path (StandardTicketSource) ---
        address[] memory users = new address[](1);
        users[0] = bob;
        standard.grant(users, TICKET);
        assertEq(standard.ticketsOf(bob), TICKET);
        assertEq(staking.ticketsOf(bob), 0, "no cross-source premium tickets");

        uint256 bobScratchBefore = scratch.balanceOf(bob);
        vm.prank(bob);
        uint256 standardReq = game.scratch(STANDARD);
        // Force SCRATCH win on standard table.
        randomness.fulfill(standardReq, 0);

        (,,, ScratchGame.Status stdStatus) = game.requests(standardReq);
        assertEq(uint8(stdStatus), uint8(ScratchGame.Status.Settled));
        assertEq(scratch.balanceOf(bob), bobScratchBefore + 1e18, "standard SCRATCH prize");
        assertEq(standard.ticketsOf(bob), 0);
        // Premium source untouched for bob.
        (uint256 bobStaked,,) = staking.users(bob);
        assertEq(bobStaked, 0);
    }

    function test_fork_scratchFallbackWhenUsdgDrained() public onlyFork {
        // Seed only SCRATCH fallback inventory — no USDG.
        scratch.mint(address(this), 10_000e18);
        scratch.approve(address(prizes), type(uint256).max);
        prizes.fund(address(scratch), 10_000e18);

        scratch.mint(alice, MIN_STAKE);
        vm.startPrank(alice);
        scratch.approve(address(staking), type(uint256).max);
        staking.deposit(MIN_STAKE);
        vm.stopPrank();
        vm.warp(block.timestamp + 1);

        uint256 scratchBefore = scratch.balanceOf(alice);
        vm.prank(alice);
        uint256 req = game.scratch(PREMIUM);
        randomness.fulfill(req, 0); // would be USDG row, but vault has none → fallback

        // Fallback: amount = 10 * 10^decimals USDG-wei, rate 1e18 → same numeric SCRATCH-wei.
        uint256 expectedScratch = 10 * (10 ** uint256(usdg.decimals()));
        assertEq(scratch.balanceOf(alice), scratchBefore + expectedScratch);
        assertEq(usdg.balanceOf(alice), 0);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _setTables() internal {
        // Premium: 10% fixed 10 USDG (scaled to token decimals), 90% no-win.
        uint256 usdgPrize = 10 * (10 ** uint256(usdg.decimals()));
        ScratchGame.PrizeRow[] memory premium = new ScratchGame.PrizeRow[](2);
        premium[0] = ScratchGame.PrizeRow({
            asset: address(usdg),
            amountOrBps: uint96(usdgPrize),
            isBpsOfPool: false,
            cumOdds: 100_000
        });
        premium[1] = ScratchGame.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
        game.setPrizeTable(PREMIUM, premium);

        // Standard: $SCRATCH-only (GATES.md) — 10% win 1 SCRATCH.
        ScratchGame.PrizeRow[] memory stdTable = new ScratchGame.PrizeRow[](2);
        stdTable[0] = ScratchGame.PrizeRow({
            asset: address(scratch),
            amountOrBps: 1e18,
            isBpsOfPool: false,
            cumOdds: 100_000
        });
        stdTable[1] = ScratchGame.PrizeRow({
            asset: address(0),
            amountOrBps: 0,
            isBpsOfPool: false,
            cumOdds: 1_000_000
        });
        game.setPrizeTable(STANDARD, stdTable);
    }
}
