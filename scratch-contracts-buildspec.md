# $SCRATCH Contracts — Cursor Buildspec v1

Target: Robinhood Chain (4663). Stack: Solidity 0.8.24, Foundry, OpenZeppelin 5.x.
Companions: `scratch-spec.md` (product design), `launch-routes.md` + `scratch-deploy/` (token + LP, already built).
Scope here = **Phase 2**: staking vault + ticket accrual + prize vault + VRF scratch settlement. Wallet/voucher path and referrals are Phase 3 (stubs noted, don't build yet).

## 0. Repo layout

```
scratch-contracts/
├── src/
│   ├── StakingVault.sol      # deposits + premium-tier ticket accrual
│   ├── PrizeVault.sol        # multi-asset prize inventory + payout
│   ├── ScratchGame.sol       # ticket burn -> randomness -> prize
│   ├── interfaces/
│   │   ├── IRandomness.sol   # provider-agnostic randomness
│   │   ├── IPrizeVault.sol
│   │   └── ITicketSource.sol # StakingVault implements; Phase-3 voucher module will too
│   └── randomness/
│       └── ChainlinkVRFAdapter.sol
├── script/   (Deploy2.s.sol — vault, prize vault, game, wiring)
└── test/     (unit + invariant, see §6)
```

## 1. Global rules (apply to every contract)

- Solidity 0.8.24, custom errors, no `require` strings, events on every state transition.
- CEI ordering + `ReentrancyGuard` on every external state-mutating function that moves tokens.
- **No admin power over user deposits, ever.** The only path that moves a staker's principal is that staker's `withdraw`. No pause on withdrawals, no migration function that touches deposits, no upgradeable proxy on `StakingVault`. This is a marketed trust property; treat it as a hard invariant.
- Game and PrizeVault MAY be `Ownable2Step` (treasury multisig) for prize-table updates, inventory ops, and pausing *the game* (never the vault).
- SCRATCH is a vanilla ERC-20 (no FoT, no hooks) — safe to use plain `safeTransfer`/`safeTransferFrom` without balance-delta checks, but use OZ `SafeERC20` anyway for the prize assets (USDG/stock tokens may be nonstandard; assume permissioned transfers possible — see §4 fallback).
- Time in `uint64`, amounts `uint256`, ticket accounting in 1e18 fixed-point "ticket-wei" (tickets are fractional internally; UI rounds down).

## 2. StakingVault.sol

Purpose: hold staked SCRATCH; accrue premium-tier tickets at a fixed global emission rate, pro-rata by stake, linear above a minimum threshold.

### Storage
```solidity
IERC20 public immutable scratch;
uint256 public immutable emissionRate;      // ticket-wei per second, vault pool (65% share is set here at deploy)
uint256 public immutable minStake;          // threshold in SCRATCH-wei; below this a wallet accrues nothing
uint256 public immutable maxBank;           // cap = emissionRate-share equivalent of 7 days for a given user? NO — see cap note
uint256 public totalStaked;                 // sum of eligible stakes
uint256 public accTicketsPerShare;          // 1e18-scaled accumulator (MasterChef)
uint64  public lastUpdate;
struct User { uint256 staked; uint256 debt; uint256 banked; }
mapping(address => User) public users;
address public game;                        // sole address allowed to spend tickets (set once)
```

### Mechanics
- `_update()`: `accTicketsPerShare += emissionRate * (now - lastUpdate) * 1e18 / totalStaked` (skip if `totalStaked == 0`).
- Eligibility: a user's stake counts toward `totalStaked` only while `staked >= minStake`. Handle by adding/removing their full stake from `totalStaked` when crossing the threshold in `deposit`/`withdraw`.
- Pending: `pending = staked * accTicketsPerShare / 1e18 - debt` (only while eligible).
- **Bank cap (the 7-day rule):** on any user touch, `banked = min(banked + pending, capFor(user))` where `capFor(user) = user.staked * emissionRate * 7 days * 1e18 / totalStaked` — approximate is fine; simpler alternative (preferred): global constant `BANK_CAP_SECONDS = 7 days` and cap `banked` at the tickets the user would earn in 7 days at their *current* rate, computed at touch time. Document that per-ticket rolling expiry is intentionally NOT implemented onchain in v1 — the cap alone bounds redemption spikes at 7 days' emissions. (Deviation from scratch-spec.md §3, approved.)
- `withdraw(amount)`: **zeroes `banked` and pending** (the anti-flicker rule — any withdrawal, partial included, burns unclaimed tickets; document loudly in natspec + event).
- `spendTickets(address user, uint256 amount)`: `onlyGame`; settles pending into banked first, then decrements. Reverts on insufficient.
- Implements `ITicketSource { function spendTickets(address,uint256) external; function ticketsOf(address) external view returns (uint256); }`
- `game` is set once by owner then ownership renounced, OR `game` immutable via constructor if deploy order allows (preferred: deploy game first with predicted vault address? No — deploy vault, deploy game pointing at vault, `setGame` once with a `GameSet` event and a one-shot guard).

### Events
`Deposited`, `Withdrawn(user, amount, ticketsBurned)`, `TicketsSpent`, `GameSet`.

## 3. ScratchGame.sol

Purpose: burn 1 ticket → request randomness → map outcome to a prize row → instruct PrizeVault to pay. One-shot per ticket, commit-then-reveal via VRF so the outcome is settled before any UI reveal.

### Flow
1. `scratch(uint8 tier)` (v1: `tier` fixed to PREMIUM=1; STANDARD=0 reserved for Phase 3 voucher source):
   - `ticketSource[tier].spendTickets(msg.sender, 1e18)`
   - request randomness via `IRandomness.requestRandom()` → store `Request{user, tier, blockTime}` by requestId
   - emit `ScratchRequested(user, requestId, tier)`
2. `fulfill(requestId, random)` (only randomness adapter):
   - roll `random % 1_000_000` against the tier's cumulative-odds prize table
   - call `prizeVault.payout(user, tier, rowIndex)` — **never revert on prize problems**; PrizeVault handles fallback internally
   - emit `ScratchSettled(user, requestId, tier, rowIndex, asset, amount)`
3. Stuck-request escape hatch: if a request isn't fulfilled within `rescueDelay` (immutable, constructor param — **24h in production, 10min in the mainnet rehearsal deploy**), `rescue(requestId)` refunds the ticket (re-credit via a `refundTicket` function on the source, onlyGame). Prevents VRF outage from eating tickets.

### Prize table
```solidity
struct PrizeRow { address asset; uint96 amountOrBps; bool isBpsOfPool; uint32 cumOdds; } // cumOdds out of 1e6
PrizeRow[] public table[2]; // per tier
```
- Owner (treasury) can replace a tier's table; emit full new table in event. Changing odds is expected tuning — transparency comes from events + the site rendering current table from chain.
- `isBpsOfPool`: amount = `bps * prizeVault.balanceOf(asset) / 10_000` computed at settlement (the self-balancing prize sizing from the spec).
- Last row = "no win" (asset = address(0)); cumOdds must end at exactly 1e6 (validate on set).

### Randomness
- `IRandomness { function requestRandom() external returns (uint256 id); }` + callback interface. Build `ChainlinkVRFAdapter` against VRF v2.5 coordinator (address/keyhash/subscription via constructor; **coordinator address on 4663 is an open gate — build the adapter, leave config in env**).
- NEVER use blockhash/prevrandao — 100ms blocks, single FCFS sequencer. If VRF isn't live on 4663 at ship time, write `GelatoVRFAdapter` as alternate implementation behind the same interface; do not weaken the interface to accommodate a trusted signer.

## 4. PrizeVault.sol

Purpose: custody prize inventory (SCRATCH, USDG, memecoins, stock tokens), pay winners, never fail a claim.

- `payout(address to, uint8 tier, uint256 rowIndex)` `onlyGame`:
  - resolve asset+amount from game (passed in call, not re-read) — signature: `payout(address to, address asset, uint256 amount)`
  - **try/catch the transfer.** If the asset transfer fails OR balance is insufficient (stock tokens may be KYC-gated for `to`): fall back to paying `fallbackEquivalent` in SCRATCH — v1 rule: a fixed per-asset SCRATCH equivalence set by owner alongside inventory top-ups (`setFallbackRate(asset, scratchPerUnit)`); do NOT put an oracle in the payout path.
  - emit `PrizePaid(to, asset, amount, fellBack)`
- Inventory ops: `fund(asset, amount)` (anyone — LP fee keeper and treasury both use it), `sweep(asset, to)` onlyOwner **with 48h timelock** (rug-check optics: sweeping the prize pool must be slow and visible; emit `SweepQueued`).
- View helpers for the site: `inventory()` returns full asset/balance list.

## 5. Deployment (script/Deploy2.s.sol)

Order: PrizeVault → StakingVault(emissionRate = 65% of global rate, minStake, scratch addr) → ChainlinkVRFAdapter → ScratchGame(vault, prizeVault, adapter) → `vault.setGame(game)` → `prizeVault.setGame(game)` → set premium prize table → transfer PrizeVault + Game ownership to treasury → fund PrizeVault with the 20% seed from treasury (manual multisig tx, not in script).
Env: `SCRATCH`, `TREASURY`, `EMISSION_RATE`, `MIN_STAKE`, `RESCUE_DELAY`, `VRF_COORDINATOR`, `VRF_KEYHASH`, `VRF_SUB_ID`.
**One script, two configs:** the same `Deploy2.s.sol` serves the mainnet rehearsal (throwaway token address, tiny `MIN_STAKE`, high `EMISSION_RATE` for fast accrual, `RESCUE_DELAY=600`) and production (real SCRATCH, 24h rescue). No rehearsal-only code paths — the rehearsal must exercise the exact bytecode that ships.
Global emission rate starting value: size so that ~`targetDailyScratches ≈ emissionRate * 86400 / 1e18`; launch target 2,000 premium tickets/day → `emissionRate ≈ 2000e18/86400 ≈ 2.31e16`. Tune with real EV targets from spec §9 before mainnet.

## 6. Tests (Foundry) — minimum bar

Unit: deposit/withdraw accounting across threshold crossings; accrual math vs hand-computed values at 3 time points; bank cap enforcement; withdraw burns pending+banked; spendTickets auth + insufficient; prize table validation (cumOdds monotonic, ends 1e6); payout fallback on reverting mock token; rescue path refunds after 24h; sweep timelock.
Invariants (fuzz): (1) `sum(users.staked) == totalStaked-eligible + ineligible balances`, vault SCRATCH balance ≥ totalStaked always; (2) tickets spent ≤ tickets emitted (no inflation); (3) PrizeVault can never pay an asset it doesn't hold without falling back; (4) no sequence of deposit/withdraw/scratch changes another user's `banked`.
Fork tests (replace testnet entirely): run the integration suite against `anvil --fork-url <4663 RPC>` — real WETH, real Uniswap periphery, real chain state. Cover: vault deposit/withdraw with real WETH-paired context, PrizeVault funded with the real USDG address once known, full scratch flow with MockRandomness standing in for VRF. The only thing a fork cannot exercise is live VRF fulfillment (offchain Chainlink infra) — that is what the mainnet rehearsal (§9) is for.

## 7. Explicitly out of scope (Phase 3 — do not build yet)

Wallet-holder voucher path (EIP-712 signer + `VoucherTicketSource` implementing `ITicketSource`), referral registry, standard-tier prize table activation, indexer, fee-collect keeper (separate small repo), soulbound ticket display token. The `tier` plumbing above exists so Phase 3 slots in without touching deployed contracts.

## 8. Open gates (verify before mainnet, fine to build now)

1. Chainlink VRF coordinator on 4663 (else Gelato adapter).
2. USDG + stock token addresses and their transfer restrictions (drives fallback rates).
3. Legal review of the prize/chance/consideration structure — before funding PrizeVault, not after.
4. Audit or at minimum a second-model review pass + Slither/Aderyn clean run before the prize vault holds real value.

## 9. Mainnet rehearsal (replaces testnet — run after §6 is green and the review pass is done)

A quiet, disposable, full-fidelity deploy on mainnet 4663. Purpose: exercise the one thing forks can't (live VRF request→fulfill) and walk every unrecoverable production step once with nothing at stake. Nobody notices an unannounced deploy on this chain; do not post about it.

1. Deploy a throwaway vanilla ERC-20 (reuse `SCRATCH.sol`, different name) from a fresh burner EOA. No pool, no LP — the game suite doesn't need one.
2. Run `Deploy2.s.sol` with rehearsal env: throwaway token, `MIN_STAKE` tiny, `EMISSION_RATE` high (accrue a ticket in ~1 min), `RESCUE_DELAY=600`, real VRF coordinator + a funded subscription.
3. Walk the full loop from a second wallet: stake → wait → `scratch()` → confirm VRF fulfillment lands and `ScratchSettled` fires → confirm prize transfer (seed the PrizeVault with ~$20 of the throwaway token + a dust amount of real USDG to test a real-asset payout).
4. Failure drills: pause the VRF sub to force a stuck request and exercise `rescue()` after 10 min; call `payout` path for an asset the vault doesn't hold to confirm fallback fires; queue a `sweep` and confirm the timelock event/delay.
5. Withdraw mid-accrual and verify tickets burned; verify a below-threshold stake accrues nothing.
6. Record gas numbers for scratch/fulfill (feeds the site's UX copy), then abandon the deployment. Do not reuse the burner.
7. Only after every step behaves: production deploy per §5 with real params, treasury ownership, and the 20% seed.
