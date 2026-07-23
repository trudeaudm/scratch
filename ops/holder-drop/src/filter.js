/**
 * Pure filtering helpers (unit-tested).
 */

/**
 * @param {{ address: string, balance: bigint }[]} holders
 * @param {{ threshold: bigint, exclusions: Set<string>, isContract: (addr: string) => boolean | Promise<boolean> }} opts
 */
export async function filterEligibleHolders(holders, { threshold, exclusions, isContract }) {
  const eligible = [];
  let excludedListed = 0;
  let excludedContracts = 0;
  let belowThreshold = 0;

  for (const h of holders) {
    const addr = String(h.address || "").toLowerCase();
    const bal = typeof h.balance === "bigint" ? h.balance : BigInt(h.balance);
    if (!/^0x[a-f0-9]{40}$/.test(addr)) continue;
    if (bal < threshold) {
      belowThreshold++;
      continue;
    }
    if (exclusions.has(addr)) {
      excludedListed++;
      continue;
    }
    const contract = await isContract(addr);
    if (contract) {
      excludedContracts++;
      continue;
    }
    eligible.push({ address: addr, balance: bal });
  }

  eligible.sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1));

  return {
    eligible,
    excludedListed,
    excludedContracts,
    belowThreshold,
  };
}

/**
 * Cap recipients by remaining grant allowance (ticket-wei / ticketsEach).
 * @param {{ address: string, balance: bigint }[]} eligible sorted desc
 * @param {bigint} remainingAllowance total ticket-wei remaining today
 * @param {bigint} ticketsEach
 */
export function takeWithinAllowance(eligible, remainingAllowance, ticketsEach) {
  if (ticketsEach <= 0n) {
    return { recipients: [], skippedOverCap: eligible.length };
  }
  const maxRecipients = remainingAllowance / ticketsEach;
  const n = maxRecipients > BigInt(Number.MAX_SAFE_INTEGER)
    ? eligible.length
    : Math.min(eligible.length, Number(maxRecipients));
  return {
    recipients: eligible.slice(0, n),
    skippedOverCap: Math.max(0, eligible.length - n),
  };
}

export function chunkAddresses(addrs, size = 100) {
  const out = [];
  for (let i = 0; i < addrs.length; i += size) {
    out.push(addrs.slice(i, i + size));
  }
  return out;
}
