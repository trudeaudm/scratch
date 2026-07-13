# $SCRATCH Self-Deploy Runbook

Atomic Foundry deployment to Robinhood Chain (4663): token → 1% pool → laddered single-sided LP → allocations. Companion to `launch-routes.md` (Route B) and `scratch-spec.md`.

## 0. What this deploys

- `SCRATCH.sol` — fixed-supply vanilla ERC-20 (1B, 18 decimals). No owner, no mint, no hooks.
- One Uniswap V3 pool at the **1% fee tier** (tick spacing 200), initialized at your chosen price.
- **Three single-sided SCRATCH positions** (the ladder), minted **directly to the treasury** — the deployer never holds LP NFTs.
- Optional small **two-sided full-range depth position** if `DEPTH_ETH_WEI > 0`.
- Remaining supply (prize seed + ops) transferred to treasury in the same broadcast.

Default allocation: 65% LP ladder / 20% prize-vault seed / 15% treasury-ops. Edit the BPS constants in `Deploy.s.sol`.

## 1. Prerequisites

1. **Foundry** installed (`foundryup`), plus `npm i -g` nothing — the script has zero JS deps. Solidity deps: `forge install OpenZeppelin/openzeppelin-contracts foundry-rs/forge-std`, remapping `@openzeppelin/=lib/openzeppelin-contracts/`.
2. **RPC**: Alchemy app for Robinhood Chain (you want the key for the indexer later anyway) or the public RPC from ChainList for chain 4663.
3. **Uniswap addresses on 4663** — pull `NonfungiblePositionManager` and canonical `WETH9` from Uniswap's official deployments page (docs.uniswap.org → deployments). Do **not** reuse addresses from Base/Arbitrum One; sanity-check by reading `factory()` on the NPM via `cast call`.
4. **Wallets**:
   - Deployer: fresh hardware-derived EOA, funded with a little bridged ETH (Relay/Across), **never used for anything else, never signed a Permit2 approval**.
   - `TREASURY`: Safe multisig if Safe is live on 4663 (verify), else a second hardware EOA. Receives all LP NFTs and token allocations.
5. **Explorer API key** for verification (chain's Blockscout instance).

## 2. Compute `SQRT_PRICE_X96`

The pool encodes price as **token1 per token0 in raw (wei) units**. Token ordering is by address, so you can't know direction until the token address exists. Two options:

**Option A (recommended): vanity-mine or just simulate first.** Run the script with `forge script --sig "run()" ... ` *without* `--broadcast` once; it prints the token address and ordering via CREATE nonce determinism (same deployer + same nonce = same address on the real run, as long as you don't send any other tx from the deployer in between). Then compute the price for the printed ordering and do the real broadcast.

**Option B: compute both directions and pick after simulation.**

Formula, for target price P = WETH per SCRATCH (e.g. launch FDV $50k at ETH=$3,000 → P = 50,000/3,000/1e9 = 1.6667e-8 WETH per SCRATCH):

- If SCRATCH is token0: `price = P`, `sqrtPriceX96 = sqrt(P) * 2^96`
- If SCRATCH is token1: `price = 1/P`, `sqrtPriceX96 = sqrt(1/P) * 2^96`

Node one-liner (both 18-dec tokens, so raw ratio = human ratio):

```js
const P = 1.6667e-8;                       // WETH per SCRATCH — EDIT
const forToken0 = (p) => BigInt(Math.floor(Math.sqrt(p) * 2**96));
console.log("SCRATCH=token0:", forToken0(P).toString());
console.log("SCRATCH=token1:", forToken0(1/P).toString());
```

(Float precision is fine at launch scale — the tick you land on is within a spacing of target. If you want exactness, use `@uniswap/sdk-core` `encodeSqrtRatioX96`.)

**Sanity assertion — do not skip:** after pool init the script logs the spot tick. For SCRATCH=token0 at a tiny launch price the tick is a **large negative** number (~-179,000 for the example above); for SCRATCH=token1 it's the mirror **large positive**. If the sign is wrong, you initialized at 1/price — kill the run before LP mints. (This is exactly the class of mistake that's unrecoverable after liquidity is in.)

## 3. Tune the ladder

In `Deploy.s.sol`: `RUNG_BPS` (share of LP tranche per rung), `RUNG_GAP` (ticks above spot the rung starts), `RUNG_WIDTH` (span). All multiples of 200. Tick↔price intuition: **+6,932 ticks ≈ 2×, +13,863 ≈ 4×, +23,027 ≈ 10×, +46,054 ≈ 100×** (1.0001^ticks).

Shipped default = thin-at-launch degen profile:

| Rung | Share of LP | Covers (approx) |
|---|---|---|
| 1 | 10% | launch → ~4× |
| 2 | 30% | ~4× → ~100× |
| 3 | 60% | ~100× → ~5,000× |

Thinner rung 1 = wilder candles + more slippage; remember the treasury eats 1% of volume, and volume dies when slippage is obscene. Don't go below ~5% in rung 1.

The script auto-handles direction: rungs go above spot if SCRATCH is token0, below if token1 — same economics either way (positions are 100% SCRATCH and convert to ETH as buys move price through them).

## 4. Launch sequence

```bash
# .env
PRIVATE_KEY=0x...
RPC_URL=https://...4663...
NPM=0x...          # from Uniswap deployments for chain 4663
WETH9=0x...        # canonical WETH on 4663
TREASURY=0x...     # Safe or hardware EOA
SQRT_PRICE_X96=... # from step 2, for the correct ordering
DEPTH_ETH_WEI=0    # or e.g. 1000000000000000000 for 1 ETH of sell-side depth
```

```bash
# 1. dry run — check token address, ordering, spot tick sign, rung ids
forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL

# 2. real run
forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast

# 3. verify immediately
forge verify-contract <TOKEN_ADDR> src/SCRATCH.sol:SCRATCH \
  --chain-id 4663 --verifier blockscout \
  --verifier-url <EXPLORER_API_URL> \
  --constructor-args $(cast abi-encode "constructor(address,uint256)" <DEPLOYER> 1000000000000000000000000000)
```

Do not send any other transaction from the deployer between dry run and broadcast (keeps the CREATE address identical). Announce the CA from the official X account only after step 3.

## 5. Post-deploy checklist

1. Contract verified; Token Sniffer score sanity check (vanilla ERC-20 should be clean).
2. Publish allocation breakdown + LP position IDs + treasury address. The pitch: "LP is treasury-owned and fee income funds the prize pool — watch it onchain."
3. DexScreener Enhanced Token Info; site live with the CA.
4. Confirm the deployer address is **empty** — no tokens, no NFTs, dust ETH only — and retire it.
5. Stand up the fee-collect keeper (daily `collect()` on each position ID from treasury, pre-reward-reset). I can write this next.
6. Phase 2: deploy prize vault + staking vault, move the 20% prize seed from treasury into the vault, point the site's pool-health stats at real addresses.

## 6. Known judgment calls (documented so future-you doesn't re-litigate)

- `amount0Min/amount1Min = 0` in mints: safe **only because** pool creation and mint are in one broadcast — nothing can front-run a pool that didn't exist. Don't reuse this script to add liquidity to a live pool.
- No dev-buy step: on a FCFS sequencer a dev-buy in the same broadcast mostly buys from your own rung 1 at your own price — fine to add if you want the first candle, but it's optics, not protection.
- Prize seed parks at treasury until the vault contract exists: one less unaudited contract at launch, at the cost of "team holds 35%" FUD for a few days. Pre-empt it in the allocation post: "20% is the prize vault seed, moving to the vault contract at Phase 2 — watch for the transfer."

## 7. Manual-LP variant (`DeployTokenAndPool.s.sol`)

Use this if you're setting LP ranges by hand in the Uniswap UI. The script does token → pool → price init (with the spot-tick assertion) → allocations, and stops. The LP tranche goes to `LP_MINTER` — **set this to the treasury address and connect the treasury wallet to the Uniswap UI**, so position NFTs are born in the treasury and never need a transfer.

Manual minting workflow:

1. Run the script (dry run first, same as section 4). Note the pool address and whether SCRATCH is token0 — the UI will show prices either as WETH-per-SCRATCH or SCRATCH-per-WETH depending on ordering; use the UI's flip-denomination toggle until numbers look sane.
2. In the Uniswap UI: New Position → select SCRATCH/WETH → **1% fee tier** (it must match, or you're creating a second empty pool) → custom range → deposit SCRATCH only. A range entirely above spot will show the ETH deposit field as zero/greyed — that's the confirmation you're single-sided.
3. Mint your rungs **back-to-back in one sitting, before any announcement.** This is the tradeoff you're accepting versus the atomic script: bots watch `PoolCreated`/`Mint` events, not announcements, so the window between your first and last mint is real exposure. Ten minutes of exposure is fine; "finish rung 2 tomorrow" is not.
4. Rung order: mint **top-down (rung 3 → 2 → 1)**. Until rung 1 exists there's no liquidity near spot, so any sniper buy gaps the price up into your higher rungs and pays 4×–100× launch price — the gap itself is your anti-snipe. Minting rung 1 is the moment the pool is "live" at launch price; announce after that.
5. Price-range cheat sheet for the UI (enter as price multiples of launch, not ticks): rung 1 ≈ 1.0×–4×, rung 2 ≈ 4×–100×, rung 3 ≈ 100×–5,000×, token amounts 10% / 30% / 60% of the LP tranche. Round freely — hand-set ranges don't need tick precision, the UI aligns to spacing for you.
6. Then rejoin section 5 (verify, publish position IDs, lock, keeper).

One repeated warning from section 6 now applies to you: the UI's slippage protection on mints is your only guard since these are no longer atomic with pool creation. Leave the UI's defaults on; don't zero them.
