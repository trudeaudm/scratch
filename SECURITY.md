# Security — Slither gate & invariant checklist

Static-analysis gate for Phase 2 (`src/`). Re-run:

```bash
pip install slither-analyzer
# Foundry compile path (solc 0.8.24 via foundry.toml)
slither . --config-file slither.config.json
```

**Run recorded:** Slither 0.11.5 via Foundry (`forge build`, `solc = 0.8.24` in `foundry.toml`).  
**Scope:** `src/` (OZ / forge-std / tests / scripts filtered).  
**Result:** 15 findings — all triaged below. **Zero untriaged.**

---

## Slither findings (triaged)

| # | Detector | Location | Disposition | Justification |
|---|----------|----------|-------------|---------------|
| 1 | `calls-loop` | `PrizeVault.inventory` (`src/PrizeVault.sol`) | **ACCEPTED** | View-only inventory helper over the owner-curated `_assets` list; gas cost is borne by the caller and there is no state change or settlement path. |
| 2 | `reentrancy-benign` | `ScratchGame.scratch` (`src/ScratchGame.sol`) | **ACCEPTED** | `nonReentrant` guards the entrypoint; `requestId` is assigned by the randomness provider, so the `requests[requestId]` write must follow `requestRandomFor`. |
| 3 | `reentrancy-benign` | `ChainlinkVRFAdapter._request` (`src/randomness/ChainlinkVRFAdapter.sol`) | **ACCEPTED** | Coordinator returns the VRF request id; `requesters[id]` can only be bound after `requestRandomWords`. Coordinator is a trusted constructor param (see `GATES.md`). |
| 4 | `reentrancy-events` | `ChainlinkVRFAdapter._request` | **ACCEPTED** | `RandomnessRequested` must emit the coordinator-assigned id, so the event necessarily follows the external call. |
| 5 | `timestamp` | `StandardTicketSource.expiryOf` | **ACCEPTED** | Deliberate rolling TTL comparison (`expiresAt`), not miner-manipulable value transfer. |
| 6 | `timestamp` | `StandardTicketSource._syncCrediterBucket` | **ACCEPTED** | Deliberate UTC day-bucket (`block.timestamp / 1 days`) for crediter daily caps. |
| 7 | `timestamp` | `StandardTicketSource._syncGrantBucket` | **ACCEPTED** | Deliberate UTC day-bucket for the owner `grant` daily cap. |
| 8 | `timestamp` | `ScratchGame.rescue` | **ACCEPTED** | Deliberate `rescueDelay` timelock before ticket refund. |
| 9 | `timestamp` | `StakingVault._settle` | **FALSE-POSITIVE** | Flagged comparison is bank-cap headroom (`pending > headroom`), not a dangerous timestamp check; accrual uses wall-clock by design. |
| 10 | `timestamp` | `StakingVault.ticketsOf` | **ACCEPTED** | View accrual since `lastUpdate` and bank-cap headroom; emission is intentionally time-based. |
| 11 | `timestamp` | `StandardTicketSource.ticketsOf` | **ACCEPTED** | Deliberate TTL expiry in the balance view. |
| 12 | `timestamp` | `StandardTicketSource._lazyExpire` | **ACCEPTED** | Deliberate lazy TTL zeroing on touch. |
| 13 | `timestamp` | `PrizeVault.executeSweep` | **ACCEPTED** | Deliberate `SWEEP_DELAY` + `SWEEP_GRACE` timelock window. |
| 14 | `timestamp` | `ScratchGame.executeRandomnessSwap` | **ACCEPTED** | Deliberate `RANDOMNESS_SWAP_DELAY` + `RANDOMNESS_SWAP_GRACE` timelock window. |
| 15 | `timestamp` | `StakingVault._update` | **ACCEPTED** | MasterChef-style accumulator advances by elapsed seconds; intentional. |

### Fixes applied during this gate

Slither did not require contract patches for the 15 findings above. Separately, CEI ordering was tightened on token-moving pull paths (see checklist §7):

- `StakingVault.deposit` — stake / `totalStaked` / debt updated **before** `safeTransferFrom`.
- `PrizeVault.fund` — `_track(asset)` **before** `safeTransferFrom`.

---

## Manual invariant checklist

### 1. No function moves StakingVault principal except the staker's own `withdraw`

| | |
|--|--|
| **Code** | `StakingVault.withdraw` is the only path that `safeTransfer`s SCRATCH out; there is no pause, sweep, migrate, or admin withdraw. `deposit` only pulls in. Ownable surface is `setGame` (one-shot). |
| **Test** | `test/StakingVault.t.sol` — `test_withdraw_full_burnsPendingAndBanked`, `test_withdraw_partial_burnsPendingAndBanked`; fork `test/fork/ForkIntegration.t.sol` — `test_fork_vaultDepositWithdraw`. |

### 2. `PrizeVault.payout` cannot revert for any input

| | |
|--|--|
| **Code** | `PrizeVault.payout` — zero `to` early-returns; primary transfer wrapped in `try/catch` via `transferAsset`; `_payFallback` never reverts (unset rate / zero due / underfunded / failed transfer all emit `PrizePaid` and return). |
| **Test** | `test/PrizeVault.t.sol` — `test_payout_happyPath`, `test_payout_fallback_onRevertingToken`, `test_payout_fallback_onInsufficientBalance`, `test_payout_fallback_unsetRate_settlesWithoutRevert`. |

### 3. Every request reaches exactly one terminal state; rescue/fulfill cannot both pay

| | |
|--|--|
| **Code** | `ScratchGame.fulfill` sets `Status.Settled` before payout; late fulfill after `Rescued` emits `ScratchLateFulfillment` and returns without paying. `rescue` sets `Status.Rescued` before `refundTicket` and reverts `AlreadySettled` if already settled. |
| **Test** | `test/ScratchGame.t.sol` — `test_rescue_afterDelay_refundsAndMarksRescued`, `test_fulfill_afterRescue_paysNothing_emitsLate_noRevert`, `test_rescue_afterSettle_reverts`. |

### 4. All caps are lower-only

| | |
|--|--|
| **Code** | `StandardTicketSource.lowerGrantCap` / `lowerCrediterCap` revert `CapIncreaseForbidden` when `newCap >= old`. No raise path exists. |
| **Test** | `test/StandardTicketSource.t.sol` — `test_lowerGrantCap_works_raise_reverts`, `test_crediter_auth_and_per_crediter_cap` (includes raise-revert on crediter cap). |

### 5. Refunds bypass caps/ceilings everywhere

| | |
|--|--|
| **Code** | `StakingVault.refundTicket` adds to `banked` with no cap clip; `_settle` / `ticketsOf` never reduce existing `banked`. `StandardTicketSource.refundTicket` → uncapped `_credit` (bypasses crediter ceiling and daily caps). |
| **Test** | `test/StakingVault.t.sol` — `test_refundTicket_bypassesBankCap`, `test_refundAboveCap_survivesDepositAndSpend`; `test/StandardTicketSource.t.sol` — `test_refund_fresh_ttl_bypasses_caps`, `test_refund_above_ceiling_survives`. |

### 6. Sweep and randomness-swap both have delay + expiry windows

| | |
|--|--|
| **Code** | `PrizeVault`: `SWEEP_DELAY` (48h) + `SWEEP_GRACE` (24h) in `executeSweep`. `ScratchGame`: `RANDOMNESS_SWAP_DELAY` (48h) + `RANDOMNESS_SWAP_GRACE` (24h) in `executeRandomnessSwap`. |
| **Test** | `test/PrizeVault.t.sol` — `test_sweep_executeBeforeDelay_reverts`, `test_sweep_executeAfterDelay_succeeds`, `test_sweep_executeInsideGrace_succeeds`, `test_sweep_executeAfterGrace_revertsSweepExpired`, `test_sweep_requeueAfterExpiry_freshEta`. `test/ScratchGame.t.sol` — `test_randomnessSwap_executeBeforeEta_reverts`, `test_randomnessSwap_executeAfterGrace_revertsExpired`, `test_randomnessSwap_queueExecute_newProviderCanFulfill`. |

### 7. No external call precedes its state change (CEI) in any token-moving function

| | |
|--|--|
| **Code** | `StakingVault.deposit` / `withdraw` — effects then `safeTransfer(From)`. `PrizeVault.fund` — `_track` then pull; `executeSweep` — `pending = false` then transfer; `payout` / `transferAsset` are balance-based with `try/catch` (no accounting to corrupt). `ScratchGame.fulfill` / `rescue` — status transition before vault/ticket external calls. `SelfEntropyProvider.reveal` — effects before `callback.fulfill`. |
| **Accepted exception** | `ChainlinkVRFAdapter._request` and `ScratchGame.scratch` must write id-keyed state after the provider returns `requestId` (findings #2–#4); both game paths that move value afterward are `nonReentrant`. |
| **Test** | Withdraw/rescue/fulfill ordering covered by `test_withdraw_*`, `test_rescue_afterDelay_refundsAndMarksRescued`, `test_fulfill_afterRescue_paysNothing_emitsLate_noRevert`; deposit/fund CEI covered indirectly by deposit/withdraw and `test_fund_fromArbitraryCaller` accounting tests. |
