/**
 * Protocol addresses always excluded from holder drops (lowercase).
 * LP / periphery contracts without a fixed address are still dropped by eth_getCode (EOAs only).
 */
export const DEFAULT_EXCLUSIONS = [
  // PrizeVault
  "0x86ade8b30d481bbd9d2897d20931b107e776ba52",
  // StakingVault
  "0x577cecbe33d1b2f7f4df7e0d8bf03690c2b17ed6",
  // StandardTicketSource
  "0xc94894cd3986e2d0f85616a0dc59914f1057f003",
  // ScratchGame
  "0xbed604b5ab226134edf154cc31881d8c93f4c9e6",
  // SelfEntropyProvider
  "0xd305290daf2b14b60fe3aae7281c4a001b973ab0",
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
