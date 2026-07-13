# $SCRATCH — Launch Route Plan

> **DECISION (July 13, 2026): Route B — self-deploy on Uniswap V3**, using the manual-LP variant (`DeployTokenAndPool.s.sol` + hand-set ranges per scratch-deploy/README §7). Route A retained below for reference only.

**Chain target:** Robinhood Chain (ID 4663, Arbitrum Orbit, ETH gas) · **Date:** July 13, 2026
Companion to `scratch-spec.md`. Two routes, one decision gate, and the LP-seeding answer for each.

---

## The short answer on single-sided LP

**Bankr/Doppler route: single-sided by design.** Doppler's multicurve auction sells your token into the curve and bootstraps two-sided liquidity from buyer ETH. You provide zero ETH beyond gas.

**Self-deploy route: single-sided is possible and standard.** Uniswap V3 lets you mint a position whose range sits entirely *above* the current price — that position is 100% token, no ETH required. As buys push price up through your range, the position converts token → ETH, and that ETH (plus all fees) belongs to your treasury position. The constraints: the first trade must be a buy (there's no ETH depth below launch price until buys create it), and you must initialize the pool's starting price yourself. Optionally add a small two-sided position (0.5–2 ETH) at/below launch price for sell-side depth and a cleaner early chart — recommended but not required.

---

## Route A — Bankr (Doppler infrastructure)

### Gate checks (do these before anything else)
1. **Does Bankr launch tokens on chain 4663?** Their docs say launches deploy to Base by default. Ask directly (Bankr support ticket or X) and/or check `GET api.bankr.bot` recent-launches endpoint for any token with chainId 4663.
2. **Is Doppler deployed on Robinhood Chain?** Documented networks are Base, Ethereum, Monad (+ Solana devnet). Check docs.doppler.lol contract-addresses page for 4663.
3. **Current fee split.** Clanker-era default was 80% creator / 20% Bankr; under Doppler their API examples show different beneficiary shares, and Doppler protocol takes 5% of configured fees. Get the exact number in writing.
4. **Config surface through Bankr.** Confirm whether Bankr's launch flow exposes Doppler's vesting (DERC20 native), custom fee beneficiaries, and fee-rehypothecation options — or whether Bankr launches use a fixed template. If it's a fixed template without vesting/treasury allocation, this route can't deliver the 15% prize-vault allocation and you'd need Route B (or raw Doppler SDK — see fallback).

### Where you deploy from
No contract deployment on your side. Three interfaces, pick by control needed:
- **Bankr CLI** (`bankr launch` interactive wizard) — most control: metadata, image, website, fee recipients (`--fee` routing to collaborators/treasury). Recommended for this launch.
- **Tagging @bankrbot on X** — least control, most social proof. Fine for pure memes; wrong for a token with treasury/vesting requirements.
- **Bankr Terminal / API** (`POST /token-launches/deploy` with partner key, `feeRecipient` in the payload) — for programmatic launches.

### What you get
- DERC20 token: fixed supply, native vesting fields, ERC20Votes, Permit2, immutable no-op governance (no admin functions — good rug-check optics).
- DecayMulticurve pool on Uniswap V4: ~99% of liquidity spread across a wide market-cap range, anti-snipe fee decaying 80% → 1.2% over the first 10 seconds, liquidity locked forever, no external LPs.
- 1.2% swap fee routed to configured beneficiaries (you + Bankr + 5% of the take to Doppler).
- Fee claiming: "claim my token fees" via agent, `bankr fees` CLI, or the public `build-claim` endpoint for multisig/self-custody claiming. Fees accrue in both your token and WETH.
- Bankr distribution: launch post social proof, and buy-by-replying-on-X/Telegram through their Robinhood Chain trading integration.

### Steps
1. Clear gates 1–4.
2. Set up the treasury address that will receive fee share and vested allocation (see wallet section below — decide this *before* launch; beneficiary config is immutable-ish after).
3. Prepare assets: logo, site URL (the v2 mockup hardened), launch tweet drafted.
4. `bankr launch` via CLI with fee routing to treasury; configure vesting allocation if exposed (15% target, lockup + linear vest).
5. Immediately: verify token page renders on DexScreener/NOXA, publish CA from your official X, pin the allocations breakdown.
6. Set up the fee-claim keeper: daily `build-claim` → treasury → prize vault top-up (or pursue fee rehypothecation with Doppler so fees route to the vault at protocol level — ask them; it's a documented capability).

### Costs & tradeoffs
Zero ETH capital; give up ~Bankr share + 5% Doppler of fees forever; locked launch config; V4 semantics for your referral provenance checks (buys route through the PoolManager singleton); Permit2 baked in (site UX: exact-amount approvals only, never infinite — you know why).

### Fallback within this route
If Doppler is on 4663 but Bankr launches aren't: integrate the Doppler SDK directly (`@whetstone-research/doppler-sdk`, multicurve auction builder). You keep single-sided bootstrap, vesting, anti-snipe, and fee config, and skip Bankr's cut — but lose Bankr's distribution. That's effectively a third route sitting between A and B.

---

## Route B — Self-deploy on Uniswap V3

### Where you deploy from
- **Toolchain:** Foundry (RH Chain is standard EVM; Foundry/Hardhat work out of the box). Forge script for deterministic, atomic deploy steps.
- **RPC:** Alchemy (day-one provider on Robinhood Chain) or the public RPC from ChainList. Get an Alchemy key regardless — the indexer needs it later.
- **Explorer verification:** the chain's Blockscout-style explorer; `forge verify-contract` with the explorer's API. Verify within minutes of deploy — unverified contract is the #1 early FUD trigger.
- **Wallets:**
  - **Fresh deployer EOA**, hardware-backed, used for nothing else, funded with a small amount of bridged ETH (Relay or Across). Not any wallet that has ever signed a Permit2 approval. Given the A51 drain, treat deployer hygiene as a hard requirement, not a nicety.
  - **Treasury:** a Safe multisig if Safe is deployed on 4663 (verify — BitGo is the announced institutional custody partner, Safe availability unconfirmed). Fallback: a second hardware EOA. The LP NFT and prize vault ownership land here, not on the deployer.

### Token contract
Vanilla OpenZeppelin ERC-20: fixed supply minted at deploy to the allocation addresses (LP tranche, prize vault seed, emissions reserve, treasury), no owner, no mint, no pause, or `renounceOwnership()` in the deploy script if anything ownable slips in. The contract being boring is the feature.

### Pool creation & the single-sided mint
All via Uniswap V3 periphery in one Forge script (atomicity = snipers can't get between steps):

1. `factory.createPool(SCRATCH, WETH, 10000)` — the 1% fee tier.
2. `pool.initialize(sqrtPriceX96)` at your chosen launch price.
3. **Position A (primary, single-sided):** mint via NonfungiblePositionManager with `tickLower` = one tick spacing above the current tick, `tickUpper` = near max. 100% $SCRATCH, zero ETH. This is your fee engine and inventory ladder: as price climbs, it converts to ETH inside the position.
   - Optional refinement: ladder 2–3 positions with heavier token weight in the low range — a poor man's multicurve that concentrates depth where launch trading happens.
4. **Position B (optional, recommended):** small full-range two-sided mint with 0.5–2 ETH + matching tokens, for sell-side depth from block one.
5. Transfer both position NFTs to the treasury Safe/EOA in the same script.

ETH required: gas (trivial) + whatever you choose for Position B. Strictly, **you can launch with no ETH beyond gas.**

### Anti-snipe reality check
You don't get Doppler's fee decay. RH Chain's sequencer is first-come-first-served with no priority fees, so sniping is a latency race you can't out-bid. Mitigations: initialize at your intended price (no "free" underpriced curve to snipe), announce the CA only after LP is minted, and consider a modest dev-buy in the deploy script so the first candle is yours. Accept that some sniping happens; the ticket mechanics (hold-time gating) blunt snipers' endgame anyway.

### Post-deploy checklist
Verify contract → publish CA + allocation breakdown from official X → DexScreener Enhanced Token Info → seed prize vault contract and point the site's live stats at it → keeper for `collect()` on the LP NFT (daily, pre-reset) → Token Sniffer sanity check (vanilla ERC-20 should score clean — no repeat of the A51 fight).

### Costs & tradeoffs
You keep ~100% of the 1% fee and full config freedom (fee tier, ranges, future migrations); you pay with launch-day distribution (no Bankr feed, no graduation feed), your own anti-snipe exposure, and treasury ETH only if you want Position B.

---

## Decision rule

| | Route A (Bankr/Doppler) | Route B (Self-deploy V3) |
|---|---|---|
| ETH needed | Gas only | Gas only (+0.5–2 ETH optional depth) |
| Single-sided | Native | Yes, above-spot range |
| Fee capture | 1.2% minus Bankr share minus 5% Doppler | ~100% of 1.0% |
| Vesting/treasury | Native DERC20 (if exposed by Bankr) | You mint allocations at deploy |
| Anti-snipe | 80%→1.2% decay built in | DIY (atomic script + price init) |
| Distribution | Bankr social + reply-to-buy | None built in |
| Scanner risk | Low (Doppler ubiquitous) | Lowest (vanilla ERC-20) |
| Blocker | Bankr/Doppler on 4663 unconfirmed | None — works today |

**Rule:** Run Route A's four gate checks this week. If gates 1, 2, and 4 all pass → Route A. If Doppler is on-chain but Bankr isn't → the Doppler-SDK fallback. Otherwise → Route B, which requires nothing from anyone and can ship the moment the site and vault contracts are ready.
