# Site copy changes — v2 migration

Every user-visible string that must change when the site flips to the v2 stack
(`StakingVaultV2` + `ScratchGameV2`). Source anchors are current v1 paths; replace
in place at cutover (do not ship these strings against the v1 vault).

Suggested unlock params (match Deploy3 env defaults): **NORMAL 48h** (`172800`),
**ENHANCED 120h** (`432000`) with **+20%** weight (`BOOST_BPS=2000`), exit burn
**50%** of banked × fraction unlocked (`BURN_BPS=5000`).

---

## 1. Staked path header — drop “no lockup”

| Where | v1 | v2 |
|-------|----|----|
| `site/index.html` `#minStakeRate` | `… · your share of **65%** of emissions · **no lockup**` | `… · your share of **65%** of emissions · timed unlock (48h / 120h)` |
| `site/app.js` `renderMinStake` (~1297) | same dynamic HTML with `<b>no lockup</b>` | same, replace `<b>no lockup</b>` with `<b>timed unlock</b>` (or “48h / 120h unlock”) |

---

## 2. Staked tickets tip — burn-on-withdraw → unlock burn

| Where | v1 | v2 |
|-------|----|----|
| `site/app.js` `updateStakedTicketsTip` (~476) | `All staking tickets are burned if you withdraw any stake.` | `Unlocking burns a share of your banked tickets now; the rest stay scratchable until a full exit.` |

Suggested full tip:

> Tickets accrue continuously while you stake {min}+. Whole tickets are scratchable. Requesting an unlock burns tickets in proportion to the amount unlocked; remaining tickets stay scratchable during the unlock window. A completed full exit burns any tickets left.

---

## 3. Deposit — tier picker (new)

v1 stake controls are amount-only (`#stakeAmount` / `#stakeAmountPath` + Stake).
v2 `deposit(amount, tier)` needs a tier choice on first deposit (and shows locked tier after).

**UI (wallet panel + path mini-stake):**

- Tier picker (radio or segmented control), default **NORMAL**:
  - **NORMAL** — 48h unlock · 1.0× emissions
  - **ENHANCED** — 120h unlock · **+20%** emissions weight
- After first deposit: disable picker; show “Your tier: NORMAL” / “ENHANCED” with upgrade CTA if NORMAL (`upgradeTier()`).
- Upgrade copy: `Upgrade to ENHANCED (+20% weight, 120h unlock). Instant; does not move principal.`

---

## 4. Withdraw form → unlock request / claim / cancel

Replace the instant `withdraw` flow (`doWithdraw`, `#withdrawAmount`, `#withdrawWarn`, pct row).

| Surface | v1 | v2 |
|---------|----|----|
| Primary action | Withdraw | **Request unlock** |
| Confirm dialog (`doWithdraw` ~4757) | `Any withdrawal burns ALL your staking tickets — pending and banked. This cannot be undone. Continue?` | `Unlocking {X}% of your stake will burn ~{Y} tickets now; the rest stay scratchable. Principal unlocks after {48h\|120h}. Continue?` |
| Static warn (`#withdrawWarn` ~4964) | `Warning: any withdrawal burns all staking tickets (pending and banked).` | `Warning: each unlock request burns tickets proportionally (currently 50% × fraction unlocked). Canceling re-stakes principal but does not restore burned tickets.` |
| Button labels | Withdraw | **Request unlock** / **Claim unlocked** / **Cancel unlock** |
| Claim (after `releaseAt`) | — | `Claim {amount} $SCRATCH` — enabled when `block.timestamp >= releaseAt` |
| Cancel | — | `Cancel unlock` — re-stakes the full unlocking slot; tickets untouched |
| Full-exit note | — | `Full exit: claiming when no stake remains burns any tickets you still hold.` |

**Burn preview** (compute client-side from banked + `BURN_BPS` + amount/staked, floor):

> Unlocking **X%** will burn **Y tickets** now; the rest stay scratchable.

Show Y from: `floor(banked * burnBps / 10000 * amount / staked)` (pending should be settled in the tx first — preview can approximate with `ticketsOf` as banked+pending, labeled “up to”).

---

## 5. Multi-scratch batch cap 10 → 20

| Where | v1 | v2 |
|-------|----|----|
| `site/app.js` `MULTI_MAX_BATCH` (~283) | `10` | `20` |
| QA / picker copy (`site/QA.md`, presets) | `max 10 per batch` / presets 3/5/10 | `max 20 per batch` / presets 3/5/10/20 |
| `site/_qa_walk.mjs` | asserts max 10 / `MULTI_MAX_BATCH` | assert 20 |
| On-chain | sequential / EIP-5792 batch of `scratch` | prefer `scratchMany(tier, count)` when available (1..20); keep sequential fallback |

---

## 6. Optional microcopy (if present elsewhere)

Search/replace any remaining “no lockup”, “instant withdraw”, or “any withdrawal burns ALL”:

- Marketing / FAQ blurb → timed unlock + proportional burn + scratch-during-unlock.
- Dashboard stake widgets → same tier + unlock vocabulary as the site.

---

## Checklist at cutover

- [ ] Point `addr.staking` / `addr.game` at v2 deployments from Deploy3
- [ ] ABI: `deposit(uint256,uint8)`, `requestUnlock`, `claimUnlocked`, `cancelUnlock`, `upgradeTier`, `scratchMany`
- [ ] Read `unlockNormal`, `unlockEnhanced`, `boostBps`, `burnBps`, `MAX_BATCH` from chain for live copy (don’t hardcode 48h/120h/20 if env differs)
- [ ] Remove v1 `withdraw` calls from the client
