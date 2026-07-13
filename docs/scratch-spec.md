# $SCRATCH — Design Spec v0.1

**Chain:** Robinhood Chain (ID 4663) · **DEX:** Uniswap V3 · **Status:** pre-build design consolidation
**Date:** July 13, 2026

## 1. Concept

$SCRATCH revives Robinhood's retired referral scratch-off ritual as an onchain daily game. Holders and stakers accrue raffle tickets over time; tickets are burned to scratch cards that pay prizes from a treasury-owned vault. The original hook — "pick a card, scratch it, maybe it's Apple" — is recreated literally, since Robinhood Chain hosts tokenized equities. The lore does the marketing: the feature regulators killed as "gamification" returns with the odds printed on the page and the prize vault verifiable onchain.

## 2. Token

Vanilla ERC-20, no transfer hooks, no fee-on-transfer. This was a deliberate decision: fee-on-transfer breaks V3 pool accounting, custom hooks enlarge the audit surface, and every aggregator handles a plain ERC-20 correctly. All game logic lives in peripheral contracts.

Liquidity is treasury-owned at the V3 1% fee tier (~1% of all volume to the treasury; this is the prize pool's income stream). **Decided structure (see launch-routes.md Route B + scratch-deploy/README §7):** a three-rung single-sided SCRATCH ladder minted manually via the Uniswap UI — thin near launch price for degen-grade price action, bulk stacked higher (~10%/30%/60% across ≈1–4×, 4–100×, 100×+) — plus an optional small two-sided full-range position for sell-side depth. Positions convert token → ETH inside the NFTs as price climbs. Fees accrue as uncollected tokensOwed in both assets: the $SCRATCH side is harvested into the prize vault; the WETH side is either swapped to $SCRATCH ("the house buys back" — buy pressure plus optics) or retained as operational treasury. A keeper harvests daily, timed just before the reward reset so the site can post "today's pool grew X."

## 3. Ticket emissions

Tickets are the eligibility currency. They are earned by holding or staking $SCRATCH above a minimum threshold, and burned when scratching. Emissions are a fixed global rate (tickets/second), distributed pro-rata by weight — MasterChef-style `accRewardPerShare` accounting, O(1) per user. Because the emission rate is fixed, total prize outflow is bounded at `emissions × EV per ticket` regardless of participation; growth dilutes individual earn rates, never the treasury.

Scaling is strictly linear above the threshold. Any sublinear curve or per-wallet cap makes wallet-splitting profitable and pays people to sybil; linear pro-rata is split-neutral. The threshold is the only floor, linearity is the sybil defense.

Emissions are split into two fixed, independent sub-pools:

| Pool | Share | Accounting | Prize tier |
|---|---|---|---|
| Staking vault | 65% | Fully onchain (vault has perfect balance/time info) | Premium: tokenized stocks, USDG, large-cap RH Chain memes, $SCRATCH |
| Wallet holders | 35% | Offchain indexer + signed vouchers | Standard: $SCRATCH, occasional USDG |

Each pool computes its own denominator independently, so no cross-domain weight sync is needed. Effective per-token rates float with crowding — if everyone piles into staking, the wallet pool quietly becomes the better rate, which self-balances participation.

**Non-fungibility rule (load-bearing, never relax):** wallet tickets scratch wallet-tier cards only; staked tickets scratch premium cards only. No conversion in either direction, ever. If wallet tickets could ever touch the premium table, everyone earns on the cheap path and redeems on the expensive one and the segmentation collapses.

**Caps and expiry:** bankable cap of 7 days' accrual per path; pending tickets burn on unstake; wallet-path vouchers carry a 48–72h signature expiry to prevent replay of stale eligibility. *(v1 implementation decision, per contracts buildspec §2: per-ticket 7-day rolling expiry is NOT implemented onchain — the bank cap alone bounds redemption spikes at 7 days' emissions. Rolling expiry can be revisited in v2 if hoarding behavior emerges.)* All tunable post-launch except non-fungibility.

## 4. Staking vault (premium path)

Users deposit $SCRATCH into the vault; the contract has exact amounts and timestamps, so accrual is trustless lazy-checkpoint math triggered by stake/unstake/scratch. Trust-minimal by construction and marketed that way: no lockup, no admin function that can touch user deposits (the user withdraw path is the only path that exists in the code), verified source, and only the threshold amount needs staking. Unstaking burns pending tickets — this is the anti-flicker rule; there is no partial-grace design.

Staked balances count toward the referral $100 requirement (wallet + vault are summed). Vault TVL doubles as a sell-pressure sink and a public stat.

The premium prize inventory is itself the staking incentive: "stake and you're scratching for Apple stock" answers deposit hesitancy better than any rate multiplier. Open design question: whether the vault still needs a rate advantage on top of prize-tier segmentation, or whether the 65/35 split plus premium prizes alone carries it.

## 5. Wallet path (standard)

A backend indexer watches Transfer logs (Alchemy live on Robinhood Chain) and maintains per-wallet balance/hold-time state — continuous accounting, no scheduled pushes, no airdropped accounting tokens. When a wallet requests a scratch, the backend signs a voucher ("wallet X may scratch N times, expires T"); the scratch contract verifies the signature and settles. The signer key is critical infrastructure and should live in a KMS/HSM with rotation capability designed into the contract (signer address updatable by multisig).

Optionally, ticket balances on both paths can be surfaced as a soulbound display-only ERC-20 (computed `balanceOf`, reverting `transfer`/`approve`) so wallets and explorers show "TICKETS: 3" — cosmetic, zero economic surface.

## 6. Scratch settlement

One transaction burns tickets and requests randomness; the outcome is settled by verifiable randomness before any card is revealed. The pick-a-card and scratch interactions are pure theater over a determined result — exactly like the original, where the stock was assigned before the user touched a card. The UI is one shot per ticket: no re-picks; after scratching, the locked state shows the countdown to the next accrual milestone.

**Randomness:** confirm Chainlink VRF availability on Robinhood Chain (Chainlink was a day-one ecosystem partner; verify VRF specifically, not just price feeds). Do not use blockhash or commit-reveal — 100ms blocks and a single sequencer make both gameable. If VRF is unavailable at launch, fallback options in order of preference: a VRF-equivalent from another provider (e.g. Gelato VRF / drand-based), or a short-lived audited oracle commit with a published migration commitment to VRF.

## 7. Prize vault

A peripheral contract holding whitelisted ERC-20s, topped up manually by treasury (and continuously by LP fee harvest). The prize table maps VRF outcomes to (asset, amount) per tier. Rules:

- Per-asset inventory checks with automatic fallback: if the vault lacks the won asset, pay equivalent value in $SCRATCH. A claim must never fail.
- Common outcomes pay $SCRATCH (recycles the token); external-value prizes (USDG, stocks, majors) are rare tiers (~1-in-500 or rarer).
- Prizes denominated as basis points of current pool where possible, so the pool mathematically cannot be drained and payouts scale with project growth ("prizes just doubled" as a growth event). Seed the pool so launch-week prizes land in the intended $0.50–$10 feel.
- Tokenized-equity prizes: verify whether Robinhood's onchain stocks are freely transferable to arbitrary wallets or permissioned/KYC-gated at the contract level. If gated, the prize becomes "claimable by eligible wallets" with the $SCRATCH-equivalent fallback for ineligible winners.

Transparency is a feature: prize vault address, LP position, fees earned, and prizes paid are all public — the site displays live solvency stats.

## 8. Referral system

Referrer gets +1 scratch and referee gets +1 scratch when a referred wallet qualifies. Qualification requires all of:

1. Referee holds ≥ $100 of $SCRATCH (wallet + vault summed).
2. Referee's tokens were **bought, not transferred in**: cumulative purchases via the whitelisted pool (Transfer events where `from` = pool address), tracked cumulatively so a $5 buy plus a $95 transfer doesn't pass. Aggregator/executor-delivered tokens don't count unless the route is explicitly whitelisted.
3. Referrer still holds ≥ $100 under the same bought-not-transferred rule.

Additional rules: a 6-hour hold period on both sides before the referral scratches unlock; eligibility revoked if either side drops below threshold before claiming; soft cap of 5 referral scratches per referrer per day. Dollar threshold is measured at purchase time (USD value at buy), then the requirement is to keep holding that token amount — avoids eligibility flickering with price.

Referral-code mapping lives offchain on the site. Preferred long-term provenance mechanism: a buy-through-the-site wrapper contract that executes the swap via the router and records purchase + referral code atomically (provenance by construction). Launch mechanism: the indexer, which is needed anyway.

## 9. Anti-farm economics

The canonical loop — buy $100, accrue, scratch, sell, rebuy on a fresh wallet — costs ~$2 in round-trip LP fees (which the treasury earns, since treasury owns the LP) plus slippage plus 6h+ of price risk, against roughly 2× scratch EV (referrer + farmed wallet). Safety condition: **EV per scratch < ~$1.** With a $0.50–$10 non-guaranteed payout range, tune odds toward $0.30–0.50 EV per standard ticket. Under that condition, farming is strictly -EV and "farmers" are just customers paying the treasury for lottery tickets. Because prizes are bps-of-pool, if farming ever turned +EV the pool would deplete, prizes would shrink, and equilibrium restores automatically.

## 10. Open questions (resolve before mainnet)

1. **Legal structure.** Buy/hold requirement + chance + prizes is the prize/chance/consideration lottery triad; equity prizes add a securities dimension. Real counsel review before launch — this shapes the design, not just the disclaimers.
2. **Chainlink VRF on Robinhood Chain** — confirm deployment status.
3. **Tokenized stock transferability** — permissioned or free.
4. **Whether staking keeps a rate multiplier** on top of prize-tier segmentation.
5. **WETH-side fee policy** — buyback vs. operational treasury (can be a published schedule, e.g. 50/50).

## 11. Build order

Phase 1: token + full-range LP + basic site with lore, live pool stats, and the mock scratch game (no prizes yet). Phase 2: staking vault + onchain ticket accrual + VRF scratch with $SCRATCH-only prizes. Phase 3: indexer, wallet path, vouchers, referral system. Phase 4: premium prize vault with USDG/majors/stocks, transparency dashboard. Each phase is independently shippable; the meme can launch on Phase 1 while 2–4 are audited.

## 12. Launch parameters (initial values, all tunable)

| Parameter | Value |
|---|---|
| Minimum holding threshold | TBD (denominate in tokens, sized ≈ $25–50 at launch) |
| Emission split | 65% vault / 35% wallet |
| Ticket cap | 7 days' accrual per path (no rolling expiry in v1) |
| Unstake | burns pending tickets, no lockup |
| Voucher expiry | 48–72h |
| Referral hold period | 6h both sides |
| Referral cap | 5/referrer/day |
| Referral threshold | $100 at purchase, bought-via-pool only |
| Standard ticket EV target | $0.30–0.50 |
| Prize range | $0.50–$10 common band; rare tiers above |
| LP | Treasury-owned, 3-rung single-sided ladder + optional depth, 1% tier, manual mint |
| Harvest | Daily keeper, pre-reset |
