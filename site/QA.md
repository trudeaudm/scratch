# Site session QA matrix

Single authority: `sessionDispatch` + `state.session.phase`  
Phases: `IDLE` · `PICKED` · `PENDING` · `READY` · `REVEALED` · `MULTI` (per-card sub-phases)

## Delivery (BANKED / cache)

| Check | Expected | Result |
| --- | --- | --- |
| `site/index.html` has no BANKED / `walletBanked` | Gone | Pass — removed in `992a73a`; live HTML confirmed no BANKED |
| `site/app.js` has no `walletBanked` writes | Gone | Pass |
| Why live still showed BANKED after `992a73a` | CDN/`s-maxage=300` + unversioned `app.js` | Pass — root cause; fixed with `app.js?v=` + cache meta |
| Live `app.js` URL is versioned | `./app.js?v=<hash>` | Pass after this ship |

## Footer truth table

| Condition | Footer copy |
| --- | --- |
| tickets > 0 | `N tickets left on this tier` (never a countdown) |
| tickets = 0, staked tier, staked ≥ minStake, rate loaded | Live accrual countdown only |
| tickets = 0, staked tier, staked < minStake | Stake CTA (+ holding-enough line if wallet ≥ min) |
| tickets = 0, holder tier | Daily-drop copy |
| Rate still loading (eligible stake, no emission/total yet) | Show **nothing** (no `—` placeholder) |

## Multi-scratch

| Check | Expected |
| --- | --- |
| Entry | IDLE + ≥2 spendable on active tier → “Scratch multiple” (stage + wallet actions) |
| Cap | Presets 3/5/10 + free input; `min(spendable, 10)`; inline “max 10 per batch” |
| EIP-5792 | `wallet_getCapabilities` → `wallet_sendCalls` one confirmation; IDs via `wallet_getCallsStatus` + `ScratchRequested` |
| Fallback | Sequential txs; progress “Confirm i of n…”; abort mid-run keeps sent, cancels unsent; note before start |
| Board | N foil cards in grid (2/col mobile); per-card printing→ready→reveal; summary line; Share/Save per win |
| Rehydrate | ≥2 pending same tier → multi board; 1 → single; refresh never resets board |
| Optimistic | Delta += per confirmed submit; reconcile as chain tickets drop |

## State × action matrix

Legend: **OK** = allowed / expected UI · **no-op** = ignored · **dis** = control visibly disabled

| Action \\ State | IDLE | PICKED | PENDING | READY | REVEALED | MULTI |
| --- | --- | --- | --- | --- | --- | --- |
| Tier tab (other tier) | Switch tier, re-render fan/footer | **dis** / no-op | **dis** / no-op | **dis** / no-op | Reset→IDLE, switch tier, fan | **dis** / no-op |
| Tier tab (same tier) | Re-render | **dis** / no-op | **dis** / no-op | **dis** / no-op | Reset→IDLE, fan | **dis** / no-op |
| Quick “Scratch holder/staked” | Switch tier + auto-pick scratch | **dis** | **dis** | **dis** | Reset→IDLE then auto-pick | **dis** |
| Fan card click | Start scratch (if tickets>0) | no-op (fan picked) | no-op | no-op | no-op (must Scratch another / tab) | n/a (board) |
| Scratch multiple | Open picker if ≥2 tickets | **dis** | **dis** | **dis** | hidden | n/a |
| Scratch input (foil) | n/a | Shake / not scratchable | Shake / not scratchable | Scratch enabled | n/a (foil gone) | Per-card READY only |
| Scratch another / Done | hidden | hidden | hidden | hidden | →IDLE, fan + footer | →IDLE when all revealed |
| Stake / withdraw | Allowed (wallet panel) | Allowed | Allowed | Allowed | Allowed | Allowed |
| Wallet disconnect | Clear panel, IDLE footer | Abort session→IDLE, clear | Abort→IDLE, clear | Abort→IDLE, clear | Abort→IDLE, clear | Abort→IDLE, clear |
| Page refresh mid-PENDING | — | — | Rehydrate pending UI | — | — | Rehydrate multi if ≥2 pending |

## Walk checklist (deployed preview)

Run on `https://scratch4663.xyz` after deploy (hard refresh once for new `?v=`).

### IDLE
- [x] Tabs switch holder/staked; footer shows tickets-left or truth-table empty copy
- [x] Quick buttons enabled only with tickets + connected wallet; disabled at 0
- [x] Fan click with tickets → PICKED (printing overlay)
- [x] Fan locked + footer truth table when tickets = 0
- [x] Stake/withdraw pct fills work; disconnect clears panel
- [ ] ≥2 tickets → Scratch multiple entry; cap + presets; unsupported wallet shows per-ticket note

### PICKED
- [x] Tabs disabled
- [x] Quick buttons disabled (not silently dead)
- [x] Foil not scratchable; tap shakes; caption printing…
- [x] Disconnect resets to IDLE cleanly

### PENDING
- [x] Same control locks as PICKED
- [x] Printing overlay + rescue when due
- [x] Refresh mid-PENDING rehydrates pending request
- [x] Settlement refreshes position stats immediately (staked tickets X.XX)

### READY
- [x] Tabs + quick buttons disabled
- [x] Foil scratchable (grab); overlay gone; pop on ready
- [x] Footer hidden during in-flight (no “Next ticket in —”)
- [x] Reveal → REVEALED

### REVEALED
- [x] Footer: `N tickets left` when N>0; never countdown beside tickets
- [x] `Scratch another (N left)` → IDLE → fan; repeat scratch→reveal **3×** consecutive
- [x] Exhausted: countdown or daily-drop/stake CTA only (no em-dash placeholder)
- [x] Tabs reset to IDLE and switch
- [x] Quick button resets then auto-picks when tickets remain
- [x] Disconnect resets cleanly

### MULTI
- [ ] Batch wallet: one confirmation for N; cards print then unlock as settlements land
- [ ] Sequential: progress line; reject mid-run keeps sent cards
- [ ] Summary updates; Share/Save on each win; Done when all revealed
- [ ] Refresh mid-multi rehydrates pending set; ticket refresh does not wipe board
- [ ] Mobile: 2 cards per row; touch scratch works

### Footer impossibles
- [x] String `Next ticket in —` unreachable in UI
- [x] Countdown never shown while spendable tickets > 0
- [x] Loading rate → blank footer, not dashes
