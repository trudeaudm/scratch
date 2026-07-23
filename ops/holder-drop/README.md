# Holder-drop — daily standard-tier granter

Grants `TICKETS_EACH` standard tickets to EOAs holding ≥ `THRESHOLD` `$SCRATCH`, excluding protocol addresses and any contract. Structured like `ops/entropy-operator`.

## Safety

- **Dry-run is the default.** Prints the full recipient list + counts and exits without sending.
- Live send requires `RUN=true` and must **not** set `DRY_RUN=true`.
- `GRANTER_PRIVATE_KEY` must be `StandardTicketSource.owner()` — **`grant` is `onlyOwner` (treasury)**. That key can also `setGrantDailyCap` / `addCrediter`. Treat it as hot-treasury; prefer a dedicated machine or one-shot unlock.

**Cap policy:** `grantDailyCap` is the lower-only owner promo path. To scale holder drops, **`addCrediter(dedicated, dailyCap)`** with a dedicated crediter key and use the crediter `credit` path — **never raise `grantDailyCap` just to push volume**.

## Setup

```bash
cd ops/holder-drop
npm install
cp .env.example .env   # RPC_URL + GRANTER_PRIVATE_KEY (for live runs)
npm test
```

## Run

```bash
# dry-run (default)
npm run drop

# live
RUN=true npm run drop
```

Env (see `.env.example`):

| Key | Default | Notes |
|-----|---------|-------|
| `RPC_URL` | required | HTTPS JSON-RPC |
| `GRANTER_PRIVATE_KEY` | required if `RUN=true` | Treasury / source owner |
| `STANDARD_SOURCE` | production | `0xC948…f003` |
| `SCRATCH` | production | `0xf5E5…F196` |
| `THRESHOLD` | `1000000e18` | Min SCRATCH balance (wei) |
| `TICKETS_EACH` | `1e18` | Tickets per recipient (wei) |
| `EXCLUDE` | (empty) | Extra comma-separated addresses |
| `RUN` | unset | `true` to broadcast |
| `DRY_RUN` | default on | Set `true` to force dry-run even if `RUN=true` |

Built-in exclusions: PrizeVault, StakingVault, StandardTicketSource, ScratchGame, SelfEntropyProvider, VestingWallet, Treasury (see `src/exclusions.js`). All contracts (`eth_getCode != 0x`) are also skipped — covers LP / periphery without a fixed address list.

## Cron (daily UTC)

```cron
# 16:05 UTC — after eth_getLogs quiet; dry-run first week, then RUN=true
5 16 * * * cd /path/to/scratch/ops/holder-drop && /usr/bin/npm run drop >> /var/log/holder-drop.log 2>&1
```

Live cron example (only after dry-runs look right):

```cron
5 16 * * * cd /path/to/scratch/ops/holder-drop && RUN=true /usr/bin/npm run drop >> /var/log/holder-drop.log 2>&1
```
