# $SCRATCH Contracts — Project Rules

You are building the Phase 2 smart contract suite for $SCRATCH per `scratch-contracts-buildspec.md`, which is the source of truth. If anything you're about to write conflicts with the buildspec, stop and flag it instead of improvising.

## Environment
- Solidity 0.8.24, Foundry (forge/anvil/cast), OpenZeppelin Contracts 5.x pinned in `foundry.toml` remappings.
- Target chain: Robinhood Chain (id 4663), an Arbitrum Orbit L2 — standard EVM, 100ms blocks, FCFS sequencer, ETH gas.
- Run `forge build` and `forge test` after every meaningful change; do not present code that doesn't compile or whose tests fail.

## Non-negotiable invariants (never "improve" these away)
1. No admin power over user deposits in StakingVault: no pause on withdraw, no proxy, no migration touching principal. The only path moving a staker's tokens is that staker's own `withdraw`.
2. Any withdrawal (including partial) burns that user's pending + banked tickets.
3. Ticket tiers are non-fungible: a ticket source serves exactly one tier; no conversion functions.
4. Randomness comes only through the `IRandomness` interface; never blockhash, prevrandao, or a trusted signer fallback.
5. `PrizeVault.payout` never reverts a settlement — failed/gated asset transfers fall back to SCRATCH at the configured rate.
6. Prize-table cumulative odds must validate to exactly 1_000_000 with a terminal no-win row.

## Style
- Custom errors, not require strings. Events on every state transition. NatSpec on every external function.
- Checks-Effects-Interactions + ReentrancyGuard on token-moving externals. SafeERC20 for all non-SCRATCH assets.
- No assembly unless a test proves it's needed. No dependencies beyond OZ + forge-std.
- Keep contracts small and boring. If a feature isn't in the buildspec, ask before adding it.

## Workflow
- Work in the order: scaffold -> StakingVault + unit tests -> PrizeVault + unit tests -> IRandomness + ChainlinkVRFAdapter + mock -> ScratchGame + unit tests -> Deploy2.s.sol -> invariant/fuzz suite -> fork integration suite.
- Write tests alongside each contract, not after everything. Each buildspec §6 case gets a named test.
- There is no testnet stage. Integration tests run against a mainnet fork (`anvil --fork-url` chain 4663); live VRF is exercised via the buildspec §9 mainnet rehearsal, not by code you write.
- `Deploy2.s.sol` must be fully env-driven (including `RESCUE_DELAY`) so the identical script serves both the §9 rehearsal and production — never add rehearsal-only code paths or mock branches to deployable contracts.
- When a buildspec "open gate" blocks something (e.g., VRF coordinator address), code against an env var / constructor param and note it in a `GATES.md` at repo root — never hardcode a placeholder address that could ship.
