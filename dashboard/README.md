# $SCRATCH Treasury Dashboard

Local-only ops UI for Phase-2 contracts on **Robinhood Chain (id 4663)**.

**Never deployed.** There is no production host, no auth, and no CI deploy step. Run it on localhost against a treasury-controlled wallet.

## Stack

- Next.js 14 (App Router) + TypeScript
- viem + wagmi (injected connector)
- Chain 4663 defined manually in `src/config/chain.ts` (RPC from `NEXT_PUBLIC_RPC_URL`, explorer `robinhoodchain.blockscout.com`)

## Setup

```bash
cd dashboard
cp .env.example .env.local   # set NEXT_PUBLIC_RPC_URL
npm install
npm test                     # prize-table validation unit tests
```

### Fill addresses

Edit `src/config/addresses.ts` after Deploy2 (+ ops VestingWallet deploy):

- Contract addresses: `prizeVault`, `stakingVault`, `standardTicketSource`, `scratchGame`, `vestingWallet`, `treasury`
- DexScreener pairs: `dexPairs.scratch` and `dexPairs.weth` (`chainId` slug + `pairAddress`) for USD pricing

Verified tokens live in **`src/config/tokens.json`** (imported by `addresses.ts`). Same shape as before (`symbol`, `address`, `decimals`, `price`, optional `kind` / `ticker` / `name` / `preferredPair`).

**`tokens.json` is committed state — review diffs before pushing.** Prefer the Read-panel **Verify & add** / **Remove from verified** flow (writes via a localhost-only API route); do not hand-edit production-looking symbols without checking the on-chain + Blockscout facts in the modal.

Zero addresses (`0x000…000`) skip on-chain reads for that row until filled.

**Holdings are discovery-based:** the read panel also queries Blockscout `account/tokenlist` for every tracked address, merges with config, and shows all nonzero ERC-20s. Tokens not in `tokens.json` get an **unverified** badge (scam airdrops must not look curated) and a **Verify & add** button. Write-panel fund/send dropdowns stay **config-only** and refresh immediately after promote/remove. If Blockscout fails, the UI falls back to config balances with a warning bar.


### Copy ABIs from Foundry `out/`

ABIs live in `dashboard/abi/` and are imported by the app. After `forge build` at the **repo root**:

```bash
cd dashboard
npm run copy-abis
```

That extracts:

| Artifact | → |
|----------|---|
| `out/PrizeVault.sol/PrizeVault.json` | `abi/PrizeVault.json` |
| `out/StakingVault.sol/StakingVault.json` | `abi/StakingVault.json` |
| `out/StandardTicketSource.sol/StandardTicketSource.json` | `abi/StandardTicketSource.json` |
| `out/ScratchGame.sol/ScratchGame.json` | `abi/ScratchGame.json` |

`abi/VestingWallet.json` and `abi/erc20.json` are minimal hand-maintained stubs (OpenZeppelin VestingWallet + IERC20).

Re-run `copy-abis` whenever contract ABIs change.

## Run (local only)

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Connect the treasury wallet via the injected connector (MetaMask / Rabby / etc. on chain 4663).

## Panels

### Read (auto-refresh 30s)

Balances for PrizeVault, StakingVault, StandardTicketSource, ops VestingWallet, and treasury EOA:

- Config ERC-20s + **Blockscout-discovered** tokens (nonzero only) + native ETH
- Config tokens: curated symbol + pair/peg pricing
- Discovered tokens: Blockscout symbol/decimals + **unverified** badge + **Verify & add** (modal reads on-chain metadata, Blockscout facts, DexScreener pairs; typed symbol confirm writes `tokens.json`)
- Verified rows: **Remove from verified** (typed confirm)
- **Stocks & RWAs** subsection for config tokens with `kind: "stock"` (shows underlying `ticker`) — screenshot source for “today’s vault” posts
- USD: SCRATCH and ETH from DexScreener pairs; USDG pegged at $1; stocks via `preferredPair` or best Dex pair

Vitals:

- **PrizeVault** — `inventory()` table + pending sweeps with ETA / expiry countdowns
- **StakingVault** — `totalStaked`, `emissionRate`, `accTicketsPerShare`
- **StandardTicketSource** — `grantDailyCap`, `grantUsedToday`, UTC day-bucket reset countdown
- **VestingWallet** — released / releasable / vested-to-date + progress bar (SCRATCH)
- **ScratchGame** — current randomness provider, pending swap + ETA, count of `Pending` requests older than `rescueDelay` (red when &gt; 0)

### Write (treasury wallet)

Every action shows a plain-English summary **before** the wallet popup (`Review` → `Confirm & open wallet`). Successful txs link to Blockscout.

| Action | Behavior |
|--------|----------|
| Fund PrizeVault | Token dropdown + amount → approve if needed → `fund(asset, amount)` with explicit approve/fund steps |
| Send | ETH or config token → labeled contract dropdown only (no free-text addresses) |
| Release | `VestingWallet.release(SCRATCH)` |
| Grant tickets | Address textarea (parse / dedupe / validate) + `amountEach` → `grant`; shows remaining daily allowance; refuses over-cap client-side |

### Prize Tables

Read (per tier Standard / Premium): current `ScratchGame` table with asset symbol, fixed amount or bps (bps also shows live payout = bps × vault balance), probability from `cumOdds` deltas (`%` and `1 in N`), and implied per-ticket EV in USD.

Edit: rows add/remove/edit via config token dropdown + amount + bps toggle + human probability (UI derives `cumOdds`). Client validation mirrors `_validateTable` (empty / monotonic / terminal no-win at `1_000_000`) plus exact `100.000%` sum; unbacked assets (no vault balance and no `fallbackRate`) block submit (zero-balance + fallback warns). Safety rails before `setPrizeTable`:

- Mandatory diff confirm (old vs new per row, EV before/after)
- Red banner when any `Pending` ScratchGame requests exist
- Hard checkbox if any row’s computed payout exceeds 10% of that asset’s vault balance

## Notes

- Pending / stale-pending ScratchGame counts scan `ScratchRequested` logs (~14d lookback). Some RPCs may truncate; treat as a best-effort ops flag.
- DexScreener `chainId` slug for Robinhood may need adjusting once the pair is listed — only the config field changes.
- Validation helpers live in `src/utils/prizeTable.ts` (`npm test`).
