# MIGRATION-V2 — fast-path cutover runbook

Tonight’s parallel-stack cutover. v1 stays live (operator still settles stragglers; vault empties Saturday). New scratches / stakes flip with the site commit.

**Owners:** `David-manual` · `Cursor` · `automatic`

| Abbrev | Who |
|--------|-----|
| David-manual | David at keyboard (treasury wallet, Render dashboard/shell, social) |
| Cursor | Agent / laptop commit + scripts |
| automatic | Already-running Render operator / on-chain timelock — no action |

---

## Address blanks (fill at Deploy3)

Record production Deploy3 outputs here before step (1). **Never** paste rehearsal addresses.

| Slot | Address |
|------|---------|
| ScratchGameV2 | `0x…` |
| StakingVaultV2 | `0x…` |
| PrizeVault (v2) | `0x…` |
| StandardTicketSource (v2) | `0x…` |
| SelfEntropyProvider (v2) | `0x…` |
| Entropy state file (local) | e.g. `ops/entropy-operator/entropy-state-v2.json` |
| Crediter (v2 source) | `0x…` |

v1 (unchanged, reference):

| Contract | Address |
|----------|---------|
| ScratchGame | `0xBeD604b5AB226134EdF154cc31881d8C93f4C9e6` |
| StakingVault | `0x577Cecbe33d1B2F7f4DF7E0D8Bf03690C2b17eD6` |
| PrizeVault | `0x86Ade8b30D481bBd9D2897d20931b107e776Ba52` |
| StandardTicketSource | `0xC94894Cd3986E2D0f85616a0Dc59914f1057f003` |
| SelfEntropyProvider | `0xd305290DaF2b14b60FE3aaE7281C4A001B973aB0` |
| Treasury | `0x429A47560F348753E96Bbe0C9dDfD9bFF902eB85` |
| SCRATCH | `0xf5E5f4D3C34A14B2fDfD59584Fe555Cd5e21F196` |

---

## (0) Preconditions

Confirm **before** the site flip.

| Check | Owner | Done |
|-------|-------|------|
| Deploy3 broadcast succeeded; all five addresses recorded above | David-manual | ☐ |
| Treasury `acceptOwnership` on ScratchGameV2, PrizeVault v2, StandardTicketSource v2 (×3 Ownable2Step) + SelfEntropyProvider already treasury-owned from deploy (×4 treasury-controlled) | David-manual | ☐ |
| Real premium + standard prize tables set on ScratchGameV2 (not rehearsal stubs) | David-manual | ☐ |
| Starter inventory funded into PrizeVault v2 (enough for overnight scratches) | David-manual | ☐ |
| Crediter added on **v2** StandardTicketSource: `addCrediter(bot, 200e18)` + dust ETH for gas | David-manual | ☐ |
| Fresh entropy chain generated; commitment registered on v2 provider; state file on laptop (never commit the secret) | David-manual / Cursor | ☐ |
| **All eleven** v1 PrizeVault sweeps queued (table below) — dashboard Sweeps panel | David-manual | ☐ |

### Queued v1 sweeps (live read 2026-07-24)

Vault `0x86Ade8…Ba52` · `to` = treasury · `SWEEP_DELAY` 48h · `SWEEP_GRACE` 24h · all `pending=true`.

| ID | Symbol | Asset | Window opens (UTC) | Unix `eta` |
|----|--------|-------|--------------------|------------|
| 1 | USO | `0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344` | **2026-07-25 23:22:15** | 1785021735 |
| 2 | TENDIES | `0x45242320DBB855EeA8Fd36804C6487E10E97FCF9` | **2026-07-25 23:22:41** | 1785021761 |
| 3 | TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | **2026-07-25 23:22:50** | 1785021770 |
| 4 | QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | **2026-07-25 23:23:03** | 1785021783 |
| 5 | CASHCAT | `0x020bfC650A365f8BB26819deAAbF3E21291018b4` | **2026-07-25 23:23:13** | 1785021793 |
| 6 | SLV | `0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f` | **2026-07-25 23:23:23** | 1785021803 |
| 7 | NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | **2026-07-25 23:23:33** | 1785021813 |
| 8 | SPCX | `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` | **2026-07-25 23:23:41** | 1785021821 |
| 9 | WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | **2026-07-25 23:24:03** | 1785021843 |
| 10 | USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | **2026-07-25 23:24:13** | 1785021853 |
| 11 | SCRATCH | `0xf5E5f4D3C34A14B2fDfD59584Fe555Cd5e21F196` | **2026-07-25 23:24:23** | 1785021863 |

Earliest execute: **Sat 2026-07-25 23:22:15 UTC**. Grace ends ~24h later (~Sun 23:22 UTC). Re-confirm ids/etas on the dashboard immediately before Saturday refill — balances at execute are whatever remains.

---

## (1) SITE FLIP commit — Cursor

From this commit onward: new scratches → ScratchGameV2, new stakes → StakingVaultV2.

1. `site/app.js`: set `GAME_GENERATION = 2`.
2. Fill `CONFIG.v2.addresses` with the Deploy3 addresses (GAME, STAKING_VAULT, PRIZE_VAULT, STANDARD_SOURCE; SCRATCH may stay `FILL_AT_MIGRATION` to reuse v1 token).
3. `site/win.js`: same `GAME_GENERATION = 2` + `gameV2` address.
4. Bump `ASSET_VERSION` and matching `?v=` in `site/index.html` / `win.html`.
5. Commit + push (site auto-deploys). Hard-refresh production; confirm UI shows timed-unlock copy / batch-20.

Do **not** point dashboard or Render env at v2 yet — those are steps (3) and (6).

---

## (2) DRAIN v1 — automatic (+ David if stuck)

Keep the **current** Render operator on the **v1** provider until the head is empty.

```bash
# cast / dashboard status — drained when equal:
cast call 0xd305290DaF2b14b60FE3aaE7281C4A001B973aB0 "nextSeq()(uint256)" --rpc-url $RPC_URL
cast call 0xd305290DaF2b14b60FE3aaE7281C4A001B973aB0 "nextFulfillSeq(uint64)(uint256)" 1 --rpc-url $RPC_URL
```

| Case | Owner | Action |
|------|-------|--------|
| `nextFulfillSeq == nextSeq` | automatic | Done — safe to proceed to operator swap when ready |
| Lag > 0 | automatic | Leave Render watcher running; it reveals stragglers |
| Request older than `rescueDelay` (v1 = **86400** s) still unsettled | David-manual | Anyone may `rescue(requestId)` on ScratchGame v1 → ticket refund |

Snapshot at runbook authoring: both seqs were **6333** (drained). Re-check after the site flip — organic v1 traffic can reopen lag until users migrate.

---

## (3) OPERATOR SWAP — David-manual (Render dashboard + shell)

Only after (2) is drained (or you accept orphan→rescue on any leftover).

### 3a. Env (Render → `scratch-operator-web` → Environment)

| Key | New value |
|-----|-----------|
| `SELF_ENTROPY_ADDRESS` | **v2** SelfEntropyProvider |
| `GAME_ADDRESS` | **v2** ScratchGameV2 |
| `GAME_V2` | `1` |

Leave `I_AM_THE_PRODUCTION_HOST=true`, `CHAIN_FILE=/data/entropy-state.json`, `LEDGER_FILE=/data/payout-ledger.csv`, keys, RPC/WSS unchanged. Save (do not restart yet).

### 3b. Shell — rename old chain file, paste new (never delete)

Open **Shell** on `scratch-operator-web`. On the laptop, print the **new** state file (the one whose commitment was registered on the v2 provider):

```powershell
Get-Content ops\entropy-operator\entropy-state-v2.json -Raw
# (or whatever path you used at Deploy3 — must match on-chain commitment)
```

In the Render shell:

```bash
# 1) Rename the live v1 chain file — NEVER rm
ts=$(date -u +%Y%m%dT%H%M%SZ)
mv /data/entropy-state.json /data/entropy-state.json.v1-retired-$ts
ls -la /data/entropy-state.json*

# 2) Paste the NEW v2 state (full JSON between EOF markers)
cat > /data/entropy-state.json <<'EOF'
PASTE_FULL_ENTROPY_STATE_V2_JSON_HERE
EOF

# 3) Verify — must be valid JSON and match laptop line/byte expectations
wc -c /data/entropy-state.json
python3 -c 'import json; json.load(open("/data/entropy-state.json")); print("ok")'
```

If JSON parse fails: `mv` the bad file aside, re-paste. Do **not** start the watcher on a truncated chain.

Optional: leave `/data/payout-ledger.csv` in place (continuous history). New v2 rows append with the v2 `ScratchSettled` shape once `GAME_V2=1`.

### 3c. Restart + verify banner

Manual Deploy / Restart. Logs must show:

1. `operator wallet: 0x…` = on-chain `operator()` of the **v2** provider  
2. `chain file: /data/entropy-state.json`  
3. `SELF_ENTROPY` / provider address = **v2** (not `0xd305…973aB0`)  
4. `nextFulfillSeq` / `nextSeq` consistent with a fresh epoch  

Then: one organic or manual scratch on the **live site** (already on gen 2) → reveal tx → first v2 `ScratchSettled` / ledger append.

Also set win-cards env when convenient (can be same window as 3a):

| Key | Value |
|-----|-------|
| `GAME` / `GAME_ADDRESS` | ScratchGameV2 |
| `GAME_V2` | `1` |

---

## (4) REGRANT — Cursor (+ David if overflow)

Script: [`ops/holder-drop/regrant-v1.js`](./holder-drop/regrant-v1.js)

Enumerates unexpired v1 standard tickets (grant/credit event recipients → `ticketsOf` / `expiryOf`), credits 1:1 on the **v2** source via the crediter wallet.

```bash
cd ops/holder-drop
# dry-run (default) — full recipient list + overflow preview
RPC_URL=… \
  V1_SOURCE=0xC94894Cd3986E2D0f85616a0Dc59914f1057f003 \
  V2_SOURCE=<v2 StandardTicketSource> \
  CREDITER_ADDRESS=<bot> \
  node regrant-v1.js

# live (after dry-run looks right)
RUN=true CREDITER_PRIVATE_KEY=… V2_SOURCE=… node regrant-v1.js
```

| Outcome | Owner | Action |
|---------|-------|--------|
| Total ≤ remaining crediter day cap (200e18) | Cursor | `RUN=true` credits all |
| Total > remaining | Cursor prints `OVERFLOW` list | David-manual: treasury `grant(users, amountEach)` batches on v2 source (owner path; mind `grantDailyCap`) |

DRY_RUN is default. Never put the treasury key in the script env.

---

## (5) NEW-TOKEN CONFIG — Cursor

Saturday’s refill must show named assets everywhere. Confirm `site/tokens.json` (dashboard imports it) has rows matching the sweep assets:

| Symbol | kind | ticker | Address (from sweeps) |
|--------|------|--------|------------------------|
| TSLA | stock | TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` |
| QQQ | stock | QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` |
| USO | stock | USO | `0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344` |
| TENDIES | crypto (meme) | — | `0x45242320DBB855EeA8Fd36804C6487E10E97FCF9` |
| WETH | crypto | — | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

(Already present in repo as of this runbook — re-verify decimals on-chain if anything was redeployed; `TokenKind` is only `crypto` \| `stock`.)

Commit with the flip or a fast follow so Saturday UI is named.

---

## (6) VERIFY

| Check | Owner | Done |
|-------|-------|------|
| `dashboard/src/config/addresses.ts`: fill `prizeVaultV2`, and point/label staking / game / source / entropy at the **v2** set (commit) | Cursor | ☐ |
| Payouts panel / `/api/payouts`: parse v2 `ScratchSettled` (`… requestId, uint8 cardIndex, uint8 tier, …`) when reading the v2 game | Cursor | ☐ |
| win-cards Render env `GAME` + `GAME_V2=1` (step 3) | David-manual | ☐ |
| One **live paid** single scratch end-to-end (site → reveal → settle → win card) | David-manual | ☐ |
| One **20-batch** (`scratchMany`) end-to-end — all cards READY together after one fulfill | David-manual | ☐ |

---

## (7) Launch-post slot — David-manual

Post that v2 is live: timed unlock / batch-20 / parallel vault. Keep it short; point at the site. Do **not** promise Saturday inventory numbers until after refill.

---

## (8) SATURDAY REFILL

Execute inside the 24h grace (opens **2026-07-25 23:22:15 UTC**).

| Step | Owner |
|------|-------|
| Dashboard → PrizeVault **v1** → execute sweeps **#1–#11** (USO … SCRATCH) while each window is open | David-manual |
| Fund remainder + stock inventory into **PrizeVault v2** (send targets in dashboard) | David-manual |
| Richen tables via the prize-table editor on ScratchGameV2 | David-manual |
| Second post: inventory / named prizes live | David-manual |

Prizes keep paying from v1 until each `executeSweep` lands; execute delivers **full remaining** balance at that moment.

---

## Rollback

v1 stack is untouched until its vault empties — rollback is a **site flag only**:

1. `GAME_GENERATION = 1` in `site/app.js` + `site/win.js`
2. Bump `?v=`
3. Commit + push

Users scratch/stake on v1 again. Do **not** delete v2 contracts or the retired `/data/entropy-state.json.v1-retired-*` file.

If the operator was already swapped to v2 and you must settle v1 stragglers: temporarily point Render back at v1 provider + v1 game, restore the retired chain file via `mv` (not a new paste), clear `GAME_V2`, restart — then re-apply step (3) when ready.

---

## Related

- Render operator paste/restart detail: [`DEPLOY-RENDER.md`](./DEPLOY-RENDER.md)
- Site copy / ABI checklist: [`../SITE-V2-COPY.md`](../SITE-V2-COPY.md)
- Holder-drop crediter setup: [`holder-drop/README.md`](./holder-drop/README.md)
- Generation plan: [`../docs/V2.md`](../docs/V2.md)
