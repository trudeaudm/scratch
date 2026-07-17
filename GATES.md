# Open gates

Tracked from `scratch-contracts-buildspec.md` §8. Fine to build against constructor/env params now; verify before mainnet.

1. **Chainlink VRF coordinator on 4663** — address unknown; `ChainlinkVRFAdapter` takes coordinator / keyHash / subscription via constructor/env. Until VRF (or another oracle such as Pyth Entropy) is live, deploy with `RANDOMNESS_PROVIDER=self` (`SelfEntropyProvider` — committed hash chain, operator-revealed). Swap later via ScratchGame's timelocked randomness swap. Do not weaken `IRandomness` for a trusted-signer fallback that can choose outcomes.
2. **USDG + stock token addresses and transfer restrictions** — drives PrizeVault fallback rates (`setFallbackRate`). Do not hardcode placeholders that could ship.
3. **Legal review** of the prize / chance / consideration structure — required before funding PrizeVault, not after.
4. **Audit / review pass** — at minimum a second-model review + Slither/Aderyn clean run before the prize vault holds real value.
5. **Standard tier (STANDARD=0) campaign readiness** — `Deploy2.s.sol` sets the standard prize table (`$SCRATCH`-only initially) and wires `StandardTicketSource` to `STANDARD`. Still blocked until treasury `acceptOwnership` on ScratchGame / PrizeVault / StandardTicketSource and campaigns are intentionally opened (grants/credits). Do not ship a non-SCRATCH standard table without revisiting this gate.
