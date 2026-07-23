# Holder-drop — daily standard-tier drop (crediter path)

Credits `TICKETS_EACH` standard tickets to EOAs holding ≥ `THRESHOLD` `$SCRATCH`, excluding protocol addresses and any contract.

**Does not hold the treasury key.** Signs as a dedicated **crediter** wallet via `credit(user, amount)`.

## Why not `grant()` / treasury key?

`grant()` is `onlyOwner`. Putting the treasury key in an automated broadcaster is the post-launch-night forbidden shape. Use the contract’s built-in blast-radius limit instead:

| Role | Function | Cap |
|------|----------|-----|
| Treasury (owner, manual) | `addCrediter(bot, dailyCap)` once; optional `lowerCrediterCap` | can only **lower** later |
| Bot (crediter) | `credit(user, amount)` per recipient | bot’s `dailyCap` (suggest **200e18**/day) |

Crediter credits also apply the **7× balance ceiling** (`CREDIT_CEILING_MULT`) — clipped credits still consume the daily allowance.

**Scale path:** raise volume by `addCrediter` with an appropriate cap (or a second crediter) — **never** raise `grantDailyCap` just to push holder drops.

## One-time treasury setup (manual)

1. Generate a fresh bot wallet offline (do not reuse treasury / operator keys).
2. From treasury (`StandardTicketSource.owner()` = `0x429A…6b85`), call:

```text
Target:  StandardTicketSource  0xC94894Cd3986E2D0f85616a0Dc59914f1057f003
Function: addCrediter(address crediter, uint256 dailyCap)
Args:
  crediter = <BOT_ADDRESS>
  dailyCap = 200000000000000000000   // 200e18 = 200 tickets/day
```

Dashboard write panel or Blockscout “Write contract” both work. Confirm `CrediterAdded` in the receipt.

3. Fund `<BOT_ADDRESS>` with dust ETH for gas (e.g. 0.002 ETH) from any funded wallet — not a contract permission, just gas.

4. Put `CREDITER_PRIVATE_KEY` in `ops/holder-drop/.env` (gitignored). Never put the treasury key here.

## Setup

```bash
cd ops/holder-drop
npm install
cp .env.example .env   # RPC_URL + CREDITER_PRIVATE_KEY (or CREDITER_ADDRESS for dry-run)
npm test
```

## Run

```bash
# dry-run (default) — lists recipients; reads on-chain crediter cap if address known
npm run drop

# live
RUN=true npm run drop
```

| Key | Default | Notes |
|-----|---------|-------|
| `RPC_URL` | required | HTTPS JSON-RPC |
| `CREDITER_PRIVATE_KEY` | required if `RUN=true` | Dedicated bot — not treasury |
| `CREDITER_ADDRESS` | optional | Dry-run without loading the key |
| `STANDARD_SOURCE` | production | `0xC948…f003` |
| `SCRATCH` | production | `0xf5E5…F196` |
| `THRESHOLD` | `1000000e18` | Min SCRATCH balance (wei) |
| `TICKETS_EACH` | `1e18` | Tickets per recipient (wei) |
| `EXCLUDE` | (empty) | Extra comma-separated addresses |
| `RUN` | unset | `true` to broadcast |
| `DRY_RUN` | force dry | `true` forces dry-run even if `RUN=true` |

Built-in exclusions: PrizeVault, StakingVault, StandardTicketSource, ScratchGame, SelfEntropyProvider, VestingWallet, Treasury (`src/exclusions.js`). Contracts (`eth_getCode != 0x`) are also skipped.

## Cron (daily UTC)

```cron
5 16 * * * cd /path/to/scratch/ops/holder-drop && /usr/bin/npm run drop >> /var/log/holder-drop.log 2>&1
```

Live (only after dry-runs + `addCrediter` look right):

```cron
5 16 * * * cd /path/to/scratch/ops/holder-drop && RUN=true /usr/bin/npm run drop >> /var/log/holder-drop.log 2>&1
```
