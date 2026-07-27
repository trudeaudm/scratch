# Holder-drop — daily standard-tier drop (crediter path)

Credits `TICKETS_EACH` standard tickets to EOAs holding ≥ `THRESHOLD` `$SCRATCH`, excluding protocol addresses and any contract.

**Generation:** credits land on the **v2** `StandardTicketSource` (`0x6C7C…2fd8`). The v1 source (`0xC948…f003`) is **retired** — do not point `STANDARD_SOURCE` at it for new drops. (One-shot migration of unexpired v1 balances used `npm run regrant-v1`.)

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

Already done for production Deploy3: crediter `0xbF8D…EE70` is authorized on v2 with `dailyCap = 200e18`.

If rotating the bot wallet, from treasury (`StandardTicketSource.owner()` = `0x429A…eB85`), call:

```text
Target:  StandardTicketSource  0x6C7CC31d5eC5899c7f5019516cFA3629167B2fd8
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
| `STANDARD_SOURCE` | **v2** production | `0x6C7C…2fd8` (v1 `0xC948…f003` retired) |
| `SCRATCH` | production | `0xf5E5…F196` (unchanged across generations) |
| `THRESHOLD` | `1000000e18` | Min SCRATCH balance (wei) |
| `TICKETS_EACH` | `1e18` | Tickets per recipient (wei) |
| `EXCLUDE` | (empty) | Extra comma-separated addresses |
| `RUN` | unset | `true` to broadcast |
| `DRY_RUN` | force dry | `true` forces dry-run even if `RUN=true` |

Built-in exclusions: PrizeVault / StakingVault / StandardTicketSource / ScratchGame / SelfEntropyProvider (v1 **and** v2), VestingWallet, Treasury (`src/exclusions.js`). Contracts (`eth_getCode != 0x`) are also skipped.

Holder eligibility still scans `$SCRATCH` balances via Blockscout (`SCRATCH` token address unchanged).

## Cron (daily UTC)

```cron
5 16 * * * cd /path/to/scratch/ops/holder-drop && /usr/bin/npm run drop >> /var/log/holder-drop.log 2>&1
```

Live (only after dry-runs + `addCrediter` look right):

```cron
5 16 * * * cd /path/to/scratch/ops/holder-drop && RUN=true /usr/bin/npm run drop >> /var/log/holder-drop.log 2>&1
```
