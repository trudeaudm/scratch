# Site session QA matrix

Single authority: `sessionDispatch` + `state.session.phase`  
Phases: `IDLE` · `PICKED` · `PENDING` · `READY` · `REVEALED`

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

## State × action matrix

Legend: **OK** = allowed / expected UI · **no-op** = ignored · **dis** = control visibly disabled

| Action \\ State | IDLE | PICKED | PENDING | READY | REVEALED |
| --- | --- | --- | --- | --- | --- |
| Tier tab (other tier) | Switch tier, re-render fan/footer | **dis** / no-op | **dis** / no-op | **dis** / no-op | Reset→IDLE, switch tier, fan |
| Tier tab (same tier) | Re-render | **dis** / no-op | **dis** / no-op | **dis** / no-op | Reset→IDLE, fan |
| Quick “Scratch holder/staked” | Switch tier + auto-pick scratch | **dis** | **dis** | **dis** | Reset→IDLE then auto-pick |
| Fan card click | Start scratch (if tickets>0) | no-op (fan picked) | no-op | no-op | no-op (must Scratch another / tab) |
| Scratch input (foil) | n/a | Shake / not scratchable | Shake / not scratchable | Scratch enabled | n/a (foil gone) |
| Scratch another | hidden | hidden | hidden | hidden | →IDLE, fan + footer; or exhausted footer only |
| Stake / withdraw | Allowed (wallet panel) | Allowed | Allowed | Allowed | Allowed |
| Wallet disconnect | Clear panel, IDLE footer | Abort session→IDLE, clear | Abort→IDLE, clear | Abort→IDLE, clear | Abort→IDLE, clear |
| Page refresh mid-PENDING | — | — | Rehydrate pending UI | — | — |

## Walk checklist (deployed preview)

Run on `https://scratch4663.xyz` after deploy (hard refresh once for new `?v=`).

### IDLE
- [x] Tabs switch holder/staked; footer shows tickets-left or truth-table empty copy
- [x] Quick buttons enabled only with tickets + connected wallet; disabled at 0
- [x] Fan click with tickets → PICKED (printing overlay)
- [x] Fan locked + footer truth table when tickets = 0
- [x] Stake/withdraw pct fills work; disconnect clears panel

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

### Footer impossibles
- [x] String `Next ticket in —` unreachable in UI
- [x] Countdown never shown while spendable tickets > 0
- [x] Loading rate → blank footer, not dashes
