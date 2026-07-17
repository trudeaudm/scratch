# $SCRATCH — Tokenomics & CCA Auction Parameters v2 (wizard-final)

Mirrors the Uniswap CCA wizard configuration field-for-field. Numbers below are FINAL and price-invariant (verified: supply breakdown does not change with clearing price or range shape — the LP % slider sets size, ranges set shape). Remaining DECIDEs at bottom.

## Supply & allocation (locked)

Total supply: **1,000,000,000 SCRATCH** (fixed, 18 decimals, SCRATCH/SCRATCH).
Auction deposit: **700,000,000 (70%)**.

| Allocation | Tokens | % | Notes |
|---|---|---|---|
| Sold — proceeds to treasury | 77.8M | 7.8% | The pink bar; treasury's USDG take ≈ 20% of raise |
| Sold — proceeds fund USDG side of LP | 311.1M | 31.1% | The green bar |
| Reserved — SCRATCH side of LP | 311.1M | 31.1% | The purple bar; equals green by value-matching at clearing |
| Prize vault seed | 200M | 20% | Transfers to PrizeVault at game launch (T+12–24h), announced with tx |
| Treasury / ops / campaigns | 100M | 10% | Promo grants, listings, contingency |

Headline math for the announcement: **~39% publicly sold, ~31% locked in LP until July 2027, 20% in a public prize vault — team float is 10%, the smallest number on this page.**

## Wizard configuration (as set)

| Field | Value |
|---|---|
| Bid currency | USDG (prize inventory arrives pre-denominated; floor legible in USD) |
| Floor price | 0.0₅8 USD → **$8,000 FDV floor**, launch threshold ≈ $3.1k bid volume (refund if unmet) |
| USDG proceeds to LP | **80%** (treasury takes 20% of raise) |
| Pool fee tier | **1%** (treasury income engine) |
| Pool owner | **TREASURY address — set explicitly, not the connected wallet** |
| Liquidity timelock | **1 year** (Uniswap Timelock; shown to bidders pre-bid) |
| Fee claim address | **TREASURY** (fees harvestable while principal locked — keeper harvests to PrizeVault per approved design; fees accrue in USDG + SCRATCH, no swap step) |
| Buyback & burn | **OFF** (fees fund prizes, not burns) |
| Identity requirements | Off |
| Duration | **DECIDE — 24h vs 48h** (the last open field) |

## LP ranges (as set — "the wall" design)

| % of liquidity | Min (% from clearing) | Max | Role |
|---|---|---|---|
| 30 | −100 | +∞ | Backbone: thin USDG to zero below, thin SCRATCH tail above +800% (fills the post-breakout zone so the chart prints a path, not a teleport) |
| 70 | −10 | +800 | Dense shelf immediately under break-even (−10→0, USDG) + the wall (0→+800, SCRATCH) |

(Wizard constraint: range minimums cannot sit above clearing; the −10 start is the workaround and doubles as the break-even shelf.)

Personality of this configuration: ratchet, then breakout. Price grinds through the wall 1×–9×, and each conquered tick converts to USDG support behind the price at the same density — expensive to advance, expensive to reverse. Past +800% the wall exhausts and price action turns violent over 9× of accumulated support. The +800% cliff is visible on liquidity maps; expect positioning toward the breakout.

**Wall economics (rule of thumb, any scale):** net buying to traverse clearing→9× ≈ **0.85× clearing mcap** (geometric-mean fill at 3× clearing across ~218M wall tokens + ⅔ of the ~93M backbone tokens in-window). At $20k clearing ≈ $16.8k; at $50k ≈ $42k. Assumes no distribution — auction sellers extend the cost.

## Proceeds deployment (published in the announcement, receipts after)

Treasury's ~20% of raise: ~70% → prize inventory (USDG float + 1–2 tokenized stocks + one top RH-Chain meme), ~30% → ops runway. Publish actual purchases with tx links post-auction.

## Ticket economy (unchanged, restated)

Premium emissions ≈ 2,000 tickets/day at launch; EV target $0.30–0.50 standard; minStake set post-auction using the actual clearing price (constructor param on StakingVault, deploying T+12–24h — a benefit of token-first sequencing); promo grants ≤1,000/day lower-only; holder drops via manual pipeline sharing the grant cap until promoted to a dedicated crediter.

## Launch sequence

1. T−7→T−1: content plan days 1–5, site live in auction-soon mode
2. T−2/3: auction announced with exact UTC time (content day 6)
3. T0: auction opens; live commentary sells the vault, not the FDV
4. T0+duration: clear → migrate() → trading live on the wall → CA into the pin
5. T+12–24h: game contracts deploy (clearing-informed minStake) → 200M seed to vault (tx published) → prize purchases executed and published → site flips to scratch mode
6. Ongoing: daily keeper harvest, daily holder drops, campaign cadence

## Remaining DECIDEs

1. **Auction duration** — 24h (on-brand, punchy) vs 48h (more time zones, thin-follower hedge). The only unset wizard field.
2. **Prize shopping list** — which stocks, which meme, USDG float size (can wait until raise size is known).
3. Token creation path — import SCRATCH.sol vs wizard createToken; verify in the 4663 UI (ours preferred: known-clean bytecode).
