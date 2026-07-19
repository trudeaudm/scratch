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
cp .env.example .env   # fill OPERATOR_PRIVATE_KEY + RPC_URL
# or export the same vars in the shell (shell wins over .env)

npm run watch

# one-shot drain (exits when nextFulfillSeq catches nextSeq):
# FROM_BLOCK=13390000 CATCH_UP_ONCE=1 npm run catch-up
```

`OPERATOR_PRIVATE_KEY` must match on-chain `SelfEntropyProvider.operator()` — mismatch hard-exits at startup. Optional: `WSS_URL`, `FROM_BLOCK`, `CHAIN_FILE`, `POLL_MS` (default 2500), `HEAD_CHECK_MS` (default 60000), `REVEAL_MAX_RETRIES`, `GAME_ADDRESS`, `LEDGER_FILE` (alias `PAYOUT_LEDGER_PATH`). `PRIVATE_KEY` remains a fallback if `OPERATOR_PRIVATE_KEY` is unset.

**Render:** see [`../DEPLOY-RENDER.md`](../DEPLOY-RENDER.md) for the background-worker migration (`CHAIN_FILE=/data/entropy-state.json`, `LEDGER_FILE=/data/payout-ledger.csv`).

If the wallet does not match on-chain `operator()`, the watcher **exits immediately** (reveals would revert). Prefer `OPERATOR_PRIVATE_KEY`.

Lookback is gap-proof: `lastProcessedBlock` advances only after a successful scan; startup/resync uses `min(lastProcessed, head-request block)`. Prefer websocket (`WSS_URL`, or inferred from Alchemy HTTPS `RPC_URL`) for low latency; HTTP poll is the automatic fallback.

The watcher:

1. Subscribes to `RandomnessRequested` over websocket when available; otherwise polls getLogs every `POLL_MS`
2. Reveals by reading on-chain `nextFulfillSeq` each time (never assumes event order)
3. Every ~`HEAD_CHECK_MS`, checks fulfill lag independently and force-resyncs a stuck head
4. Logs request-block→confirm latency per reveal; retries failed txs with backoff
5. After each confirmed reveal, parses `ScratchSettled` from the fulfill receipt and appends a row to `payout-ledger.csv` (gitignored). Price failures / IO errors are logged and skipped — they never fail the reveal.

## Payout ledger

CSV columns: `timestamp,requestId,user,tier,rowIndex,asset,symbol,raw_amount,human_amount,price_usd,usd_value,retro`.

- **Live append** (`npm run watch`): `retro=false`; `price_usd` from DexScreener (SCRATCH pair + token address for other assets); USDG pinned at `$1`; 60s in-process cache.
- **Backfill** missing settlements (e.g. before the ledger existed):

```bash
export RPC_URL=https://…
# optional: GAME_ADDRESS, GAME_DEPLOY_BLOCK (default 13138508), LEDGER_FILE
npm run backfill-ledger
```

`backfill-ledger` and `reconcile` load `.env` via dotenv (same as `watch`). Backfill prices at *current* market and sets `retro=true` so those rows are distinguishable. Backfill is **strictly additive** (skips requestIds already in the CSV; never rewrites rows).

Reconcile chain vs CSV:

```bash
npm run reconcile
```

Live-append failures log to console as `LEDGER ERROR:` and append to `ledger-errors.log` (gitignored) without failing the reveal. **Restart `npm run watch` after pulling ledger code** — a watcher started before the hook will keep revealing without writing the CSV.

**VPS note:** When the operator moves to a VPS, the ledger file lives with the bot. The treasury dashboard’s quantity totals come from chain `ScratchSettled` logs and keep working without the CSV; the USD view syncs whenever you pull `payout-ledger.csv` onto the machine running the dashboard (`PAYOUT_LEDGER_PATH`).

**Do not** call `registerChain` while requests are still pending unless you intend to orphan them (ScratchGame `rescue` after `rescueDelay`).

## Chain math

```
chain[0] = secret
chain[i] = keccak256(abi.encodePacked(chain[i-1]))
commitment = chain[N]
```

First on-chain reveal uses `chain[N-1]`; each reveal sets the cursor to that preimage and walks toward `chain[0]`.
