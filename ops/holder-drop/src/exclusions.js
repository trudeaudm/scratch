/**
 * Protocol addresses always excluded from holder drops (lowercase).
 * LP / periphery contracts without a fixed address are still dropped by eth_getCode (EOAs only).
 * Includes retired v1 + live v2 stacks so neither generation's protocol wallets get credited.
 */
export const DEFAULT_EXCLUSIONS = [
  // PrizeVault (v1 / v2)
  "0x86ade8b30d481bbd9d2897d20931b107e776ba52",
  "0xafbea86784f9dbd31573b74e68133c3b2b21247e",
  // StakingVault (v1 / v2)
  "0x577cecbe33d1b2f7f4df7e0d8bf03690c2b17ed6",
  "0x3d8ec3a0d98e2a5015c502b4d40a5167f378db7c",
  // StandardTicketSource (v1 retired / v2 live)
  "0xc94894cd3986e2d0f85616a0dc59914f1057f003",
  "0x6c7cc31d5ec5899c7f5019516cfa3629167b2fd8",
  // ScratchGame (v1 / v2)
  "0xbed604b5ab226134edf154cc31881d8c93f4c9e6",
  "0xe6ba601710afd1297114d738ca201d1d84eb3da1",
  // SelfEntropyProvider (v1 / v2)
  "0xd305290daf2b14b60fe3aae7281c4a001b973ab0",
  "0x5b765d373c97eedd52f9bc8741b17f7167dedd36",
  // Ops VestingWallet
  "0xf2c4bfe47e8b24a526f1584b86810eeed495cbde",
  // Treasury EOA (still listed — never grant the treasury itself)
  "0x429a47560f348753e96bbe0c9ddfd9bff902eb85",
];

export function parseExcludeEnv(raw) {
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[a-f0-9]{40}$/.test(s));
}

export function buildExclusionSet(extra = []) {
  return new Set(
    [...DEFAULT_EXCLUSIONS, ...extra].map((a) => a.toLowerCase()),
  );
}
