# $SCRATCH — Project Root

Daily onchain scratch-offs on Robinhood Chain (4663). Robinhood retired the scratch card for being too fun; we brought it back — daily, onchain. Could be TSLA. Probably $5.

## Layout

| Path | What it is |
|---|---|
| `scratch-contracts-buildspec.md` | **Source of truth for the Phase 2 contract build** (staking vault, prize vault, VRF scratch game). Cursor builds from this. |
| `AGENTS.md` | Standing rules for Cursor sessions: invariants, style, workflow. Read alongside the buildspec. |
| `scratch-deploy/` | **Phase 1 launch package** (already written, not Cursor's job): the SCRATCH token, the token+pool deploy scripts, and the launch runbook including the manual-LP workflow (§7). |
| `docs/scratch-spec.md` | Product/tokenomics design: emissions, two-tier tickets, referrals, anti-farm economics, open legal questions. |
| `docs/launch-routes.md` | Launch route analysis. **Decision made: Route B self-deploy, manual LP.** Kept for the gate-check details. |
| `site/mockup-v2.html` | The full site mockup (two-tier scratch UI, referral flow, pool health). Starting point for the real frontend; placeholder stats and the demo-reset button are intentional. |
| `brand/` | X profile assets (pfp + banner). Handle @scratch4663 · domain scratch4663.xyz · location "Chain 4663". |
| `rehearsal/` | Buildspec §9 mainnet rehearsal harness (`run.mjs` / `run.sh`). Throwaway burners + SelfEntropy; see `rehearsal/.env.rehearsal.example`. |

## Tests (Foundry)

Unit tests live under `test/*.t.sol`. Buildspec §6 invariant/fuzz and fork suites:

| Suite | Path | What it covers |
|---|---|---|
| Invariant / fuzz | `test/invariant/` | (1) stake accounting + vault solvency; (2) ticket conservation across **both** `StakingVault` and `StandardTicketSource` (spent ≤ emitted+granted+credited, no cross-source leakage); (3) PrizeVault fallback when underfunded; (4) banked isolation across users |
| Fork integration | `test/fork/` | Chain 4663: real WETH + Uniswap V3 periphery, vault deposit/withdraw, PrizeVault funded with real USDG (env), full scratch loop on **both** tiers with `MockRandomness` |

### Local (unit + invariant)

```bash
forge test
# invariant suite only
forge test --match-path "test/invariant/*" -vv
```

Invariant settings (`foundry.toml` `[invariant]`): 128 runs × depth 32, `fail_on_revert = false` (handler clamps inputs).

### Fork integration (chain 4663)

Requires an RPC for Robinhood Chain. Fork tests **skip** when `RPC_URL` is unset and you are not already on chain id 4663 (so plain `forge test` stays green offline).

**Option A — anvil fork (matches buildspec):**

```bash
# terminal 1
anvil --fork-url "$RPC_URL" --chain-id 4663

# terminal 2
forge test --match-path "test/fork/*" --fork-url http://127.0.0.1:8545 -vv
```

**Option B — one-shot forge fork:**

```bash
export RPC_URL=https://rpc.mainnet.chain.robinhood.com   # or your Alchemy/etc endpoint
forge test --match-path "test/fork/*" --fork-url "$RPC_URL" -vv
```

Optional env overrides (defaults = canonical 4663 addresses):

| Var | Default |
|---|---|
| `USDG` | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| `WETH9` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| `UNISWAP_V3_FACTORY` | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| `NPM` | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |

Live VRF fulfillment is **not** covered here — that is buildspec §9 mainnet rehearsal.

## Status / order of operations

1. ☐ Cursor prompts 1–7 per the prompt sequence (build Phase 2 contracts + tests, fork suite included)
2. ☐ Human read of StakingVault diff after prompt 2
3. ☐ `forge coverage` + external adversarial review pass after prompt 7
4. ☐ Gates: VRF coordinator on 4663 (Chainlink), Safe on 4663 (treasury) — ask in parallel with the build
5. ☐ Mainnet rehearsal per buildspec §9 — `rehearsal/run.sh all` (throwaway deploy, live SelfEntropy loop, failure drills D1–D8) — no testnet stage
6. ☐ Legal read of prize/chance/consideration structure before the vault holds value
7. ☐ Production token + LP launch per `scratch-deploy/README-deploy.md`
8. ☐ Production game deploy, treasury ownership, 20% prize seed in, prize table set
9. ☐ Site live on scratch4663.xyz, CA in pinned post only

Foundry project files (foundry.toml, src/, test/, lib/) live at this root.
