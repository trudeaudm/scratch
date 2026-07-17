# Gates

Tracked from `scratch-contracts-buildspec.md` §8. Status as of Jul 17 2026.

## CLOSED

1. **Chainlink VRF coordinator on 4663** — **CLOSED.** Verified absent from Chainlink and Gelato supported networks and from the Pyth Entropy chainlist as of Jul 17 2026. Shipping `SelfEntropyProvider` (`RANDOMNESS_PROVIDER=self`) as the documented interim. Migration path when an oracle lands: ScratchGame's 48h timelocked randomness swap (`RANDOMNESS_SWAP_DELAY`). Do not weaken `IRandomness` for a trusted-signer fallback that can choose outcomes. `ChainlinkVRFAdapter` remains env-parameterized for when a coordinator appears.

4. **Audit / review pass** — **CLOSED** for launch gating. External adversarial review completed across the full suite; findings fixed in commits `ff5da79`, `32d48c5`, `6d0d9d5`, `c5efff8`, and the swap/no-win commit. Slither gate has zero untriaged findings (`SECURITY.md`, `2006b2d`). **Formal third-party audit: not yet performed.**

5. **Standard tier (STANDARD=0) campaign readiness** — **CLOSED for launch.** `StandardTicketSource` is built, capped, and wired in `Deploy2.s.sol` to `STANDARD` with a `$SCRATCH`-only prize table. Campaigns (grants/credits) remain pending prize-table funding and intentional treasury open. Do not ship a non-SCRATCH standard table without revisiting this gate.

## PARTIALLY CLOSED

2. **USDG + stock token addresses and transfer restrictions** — **PARTIALLY CLOSED.** USDG address is in use in fork tests and env (canonical `0x5fc5…d168` on 4663). Stock-token addresses and transfer restrictions remain open — required before any premium prize table includes stocks. Do not hardcode stock placeholders that could ship. Drives PrizeVault fallback rates (`setFallbackRate`).

## OPEN

3. **Legal review** of the prize / chance / consideration structure — required before funding PrizeVault, not after.
