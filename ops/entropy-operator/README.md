# Entropy operator (`SelfEntropyProvider`)

Small Node tooling for the interim self-operated hash-chain randomness provider.

**Trust model (same as the contract):** preimages are committed before any request exists, so the operator cannot choose or alter outcomes — it can only stall a reveal. A stalled reveal becomes a rescued (refunded) ticket via ScratchGame. Words are bound to `(preimage, requestId, scratcher)` on-chain — this script only submits preimages and does not compute settlement words. This provider is interim until an oracle (e.g. Pyth Entropy) deploys on chain 4663; then ScratchGame's timelocked randomness swap replaces it.

## Setup

```bash
cd ops/entropy-operator
npm install
```

Requires Node 18+.

## 1. Generate a chain + commitment

```bash
npm run generate
# or: node src/generate-chain.js --n 100000
```

Prints `ENTROPY_COMMITMENT=0x…` and writes `ops/entropy-operator/entropy-state.json` (gitignored locally — **treat as a secret**). Override path with `CHAIN_FILE=/path/to/state.json`.

Use that commitment in deploy:

```bash
export RANDOMNESS_PROVIDER=self
export OPERATOR=0xYourOperatorEOA
export ENTROPY_COMMITMENT=0x…   # from generate output
```

## 2. Watch requests and reveal

After `SelfEntropyProvider` is deployed and wired as ScratchGame's randomness:

```bash
export RPC_URL=https://…
export PRIVATE_KEY=0x…                 # must be OPERATOR
export SELF_ENTROPY_ADDRESS=0x…        # SelfEntropyProvider
# optional: CHAIN_FILE, POLL_MS, REVEAL_MAX_RETRIES, START_BLOCK

npm run watch
```

The watcher:

1. Polls `RandomnessRequested` logs
2. Reveals strictly in `nextFulfillSeq` order for the current epoch
3. Advances `nextRevealIndex` in the state file after each confirmed `reveal`
4. Retries failed txs with exponential backoff
5. After each confirmed reveal, parses `ScratchSettled` from the fulfill receipt and appends a row to `payout-ledger.csv` (gitignored). Price failures / IO errors are logged and skipped — they never fail the reveal.

## Payout ledger

CSV columns: `timestamp,requestId,user,tier,rowIndex,asset,symbol,raw_amount,human_amount,price_usd,usd_value,retro`.

- **Live append** (`npm run watch`): `retro=false`; `price_usd` from DexScreener (SCRATCH pair + token address for other assets); USDG pinned at `$1`; 60s in-process cache.
- **Backfill** missing settlements (e.g. before the ledger existed):

```bash
export RPC_URL=https://…
# optional: GAME_ADDRESS, GAME_DEPLOY_BLOCK (default 13138508), PAYOUT_LEDGER_PATH
npm run backfill-ledger
```

Backfill prices at *current* market and sets `retro=true` so those rows are distinguishable.

**VPS note:** When the operator moves to a VPS, the ledger file lives with the bot. The treasury dashboard’s quantity totals come from chain `ScratchSettled` logs and keep working without the CSV; the USD view syncs whenever you pull `payout-ledger.csv` onto the machine running the dashboard (`PAYOUT_LEDGER_PATH`).

**Do not** call `registerChain` while requests are still pending unless you intend to orphan them (ScratchGame `rescue` after `rescueDelay`).

## Chain math

```
chain[0] = secret
chain[i] = keccak256(abi.encodePacked(chain[i-1]))
commitment = chain[N]
```

First on-chain reveal uses `chain[N-1]`; each reveal sets the cursor to that preimage and walks toward `chain[0]`.
