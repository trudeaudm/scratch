# Open gates

Tracked from `scratch-contracts-buildspec.md` §8. Fine to build against constructor/env params now; verify before mainnet.

1. **Chainlink VRF coordinator on 4663** — address unknown; `ChainlinkVRFAdapter` takes coordinator / keyHash / subscription via constructor/env. If VRF is not live at ship time, ship a `GelatoVRFAdapter` behind the same `IRandomness` interface (do not weaken the interface for a trusted signer).
2. **USDG + stock token addresses and transfer restrictions** — drives PrizeVault fallback rates (`setFallbackRate`). Do not hardcode placeholders that could ship.
3. **Legal review** of the prize / chance / consideration structure — required before funding PrizeVault, not after.
4. **Audit / review pass** — at minimum a second-model review + Slither/Aderyn clean run before the prize vault holds real value.
5. **Standard tier (STANDARD=0) campaign readiness** — before any standard-tier promo campaign: set the standard prize table at deploy (`$SCRATCH`-only initially) and wire `StandardTicketSource` via `ScratchGame.setTicketSource(STANDARD, source)`. Neither ships in `Deploy2.s.sol` until those ops are sequenced; do not open grants/credits against an unwired tier.
