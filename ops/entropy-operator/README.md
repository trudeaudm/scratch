# Entropy operator (`SelfEntropyProvider`)

Small Node tooling for the interim self-operated hash-chain randomness provider.

**Trust model (same as the contract):** preimages are committed before any request exists, so the operator cannot choose or alter outcomes — it can only stall a reveal. A stalled reveal becomes a rescued (refunded) ticket via ScratchGame. This provider is interim until an oracle (e.g. Pyth Entropy) deploys on chain 4663; then ScratchGame's timelocked randomness swap replaces it.

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

**Do not** call `registerChain` while requests are still pending unless you intend to orphan them (ScratchGame `rescue` after `rescueDelay`).

## Chain math

```
chain[0] = secret
chain[i] = keccak256(abi.encodePacked(chain[i-1]))
commitment = chain[N]
```

First on-chain reveal uses `chain[N-1]`; each reveal sets the cursor to that preimage and walks toward `chain[0]`.
