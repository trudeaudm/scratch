# §9 Mainnet Rehearsal Report

Generated: 2026-07-18T15:10:31.825Z
Started: 2026-07-18T14:25:00.990Z
Finished: 2026-07-18T15:10:31.014Z

## Drill results

| Drill | Result | Detail |
|-------|--------|--------|
| D1 | PASS | 2 |
| D2 | PASS | 7 |
| D3 | PASS | 8 |
| D4 | PASS | 9 |
| D5 | PASS |  |
| D6 | PASS |  |
| D7 | PASS | 10 |
| D8 | PASS | 11 |

## Headline numbers

| Metric | Value |
|--------|-------|
| Reveal latency (ms) | 2481 |
| Scratch gas | 124406 |
| Fulfill gas | 101052 |

## Deployed addresses

| Contract | Address |
|----------|---------|
| REHEARSAL token | 0x019505385abEF96123d631e422C2FD05933DdB5b |
| Unbacked asset | 0x924Dfcab2241B997D6c04362D4295b34e3814942 |
| PrizeVault | 0x122CFF0127D9eF621549551bEDb77fF608907dA9 |
| StakingVault | 0x459DeA493da496045A8325E793338518884Fe7e8 |
| StandardTicketSource | 0xc627343fd55c7ab02D428a935bF5719AC63c3872 |
| SelfEntropyProvider | 0x5c5253d9d0B9668dA3b16a97E40eC8Eba36bBc4B |
| ScratchGame | 0xE24ae2e2b6F1A1eb33940612d67354D6000782fe |
| Deployer burner | 0x5948c3CE4EE156c705180AD23161266a3bb9fe33 |
| Operator burner | 0xF551Ac6B13AD1241A91Cf04eF116a4b795DA2d7b |
| User burner | 0xadd2c3070Cf95B41604BbCb55B30Ce0b6f911949 |

## SURPRISES

- **2026-07-18T14:25:00.989Z**: Token deploy succeeded but harness failed to parse forge console2.log spacing; addresses recovered from broadcast/log
- **2026-07-18T14:25:28.692Z**: ENTROPY_COMMITMENT was truncated by parseEqLog (40 before 64); restored full tip from entropy-state.json
- **2026-07-18T14:34:09.346Z**: D1 first attempt timed out: watcher ABI missing requester + restart fromBlock missed in-flight request; manually revealed request 1 then cleared drills to re-run D1
- **2026-07-18T14:35:59.058Z**: D1 fulfill gas capture: could not coalesce error (error={ "code": -32600, "message": "You can make eth_getLogs requests with up to a 10000 block range. Based on your parameters, this block range should work: [0x0, 0x270f]" }, payload={ "id": 27, "jsonrpc": "2.0", "method": "eth_getLogs", "params": [ { "address": "0x5c5253d9d0b9668da3b16a97e40ec8eba36bbc4b", "fromBlock": "0x0", "toBlock": "latest", "topics": [ "0x546aca7b2683440b8f02fa95faeb8efc79dd0f16af3d815a002742ea6f76116c", "0x0000000000000000000000000000000000000000000000000000000000000002" ] } ] }, code=UNKNOWN_ERROR, version=6.17.0)
- **2026-07-18T14:47:57.599Z**: D4: const id=D4 shadowed ethers id(); watcher eth_getLogs exceeded Alchemy 10k range — fixed ethId rename + chunked/clamped lookback; late fulfill for request 9 completed after rescue
- **2026-07-18T15:09:42.807Z**: D7: harness process exited during rescueDelay sleep (PowerShell Tee-Object pipeline); WrongEpoch + registerChain already confirmed; rescue tx landed on-chain — marked PASS from chain evidence

## Reminder

**Retire the three burner keys.** Do not reuse `BURNER_*_PK` or the rehearsal entropy secret outside `rehearsal/`. Abandon this deployment.
