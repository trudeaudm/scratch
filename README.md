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

## Status / order of operations

1. ☐ Cursor prompts 1–7 per the prompt sequence (build Phase 2 contracts + tests, fork suite included)
2. ☐ Human read of StakingVault diff after prompt 2
3. ☐ `forge coverage` + external adversarial review pass after prompt 7
4. ☐ Gates: VRF coordinator on 4663 (Chainlink), Safe on 4663 (treasury) — ask in parallel with the build
5. ☐ Mainnet rehearsal per buildspec §9 (throwaway deploy, live VRF loop, failure drills) — no testnet stage
6. ☐ Legal read of prize/chance/consideration structure before the vault holds value
7. ☐ Production token + LP launch per `scratch-deploy/README-deploy.md`
8. ☐ Production game deploy, treasury ownership, 20% prize seed in, prize table set
9. ☐ Site live on scratch4663.xyz, CA in pinned post only

Foundry project files (foundry.toml, src/, test/, lib/) get created at this root by Cursor prompt 1.
