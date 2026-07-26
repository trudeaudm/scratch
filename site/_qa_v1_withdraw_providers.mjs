/**
 * Offline checks for v1-legacy withdraw provider discovery assumptions.
 * Simulates EIP-6963 announce + legacy window.ethereum injection the way
 * Uniswap / Base / MetaMask in-app browsers do — no browser required.
 *
 * Run: node site/_qa_v1_withdraw_providers.mjs
 */
import fs from 'fs';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

const src = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

/** Mirror of site discovery: prefer session-matching provider among 6963 + legacy. */
function pickProvider({ session, selected, discovered }) {
  const sessionKey = session.toLowerCase();
  if (selected?.provider) {
    const still = discovered.find((p) => p.provider === selected.provider) || selected;
    const accs = still.accounts || [];
    if (accs.length && accs[0].toLowerCase() === sessionKey) return still;
  }
  for (const d of discovered) {
    const accs = d.accounts || [];
    if (accs.length && accs[0].toLowerCase() === sessionKey) return d;
  }
  if (discovered.length === 1) return discovered[0];
  return null;
}

const session = '0xAbc0000000000000000000000000000000000001';

// EIP-6963 multi-wallet: pick the one that holds the session account
{
  const mm = { id: 'mm', provider: { id: 'mm' }, accounts: ['0xDead000000000000000000000000000000000001'] };
  const uni = { id: 'uni', provider: { id: 'uni' }, accounts: [session] };
  const picked = pickProvider({ session, selected: null, discovered: [mm, uni] });
  assert(picked === uni, 'EIP-6963: picks provider announcing session account');
}

// Stale selectedWallet pointing at wrong extension → rebind to matching one
{
  const stale = { id: 'stale', provider: { id: 'stale' }, accounts: ['0xDead000000000000000000000000000000000001'] };
  const live = { id: 'live', provider: { id: 'live' }, accounts: [session] };
  const picked = pickProvider({ session, selected: stale, discovered: [stale, live] });
  assert(picked === live, 'rejects stale selectedWallet that no longer matches session');
}

// Single legacy window.ethereum (typical in-app browser) — use it
{
  const eth = { id: 'legacy', provider: { id: 'ethereum' }, accounts: [session] };
  const picked = pickProvider({ session, selected: null, discovered: [eth] });
  assert(picked === eth, 'legacy injected: single provider is selected');
}

// Account mismatch on sole provider → caller must guard (we still return it; ensureLiveWalletForWrite throws)
{
  const eth = { id: 'legacy', provider: { id: 'ethereum' }, accounts: ['0xOther000000000000000000000000000000000002'] };
  const picked = pickProvider({ session, selected: null, discovered: [eth] });
  assert(picked === eth, 'single provider returned even if accounts differ (mismatch guard is separate)');
  assert(picked.accounts[0].toLowerCase() !== session.toLowerCase(), 'mismatch detectable by caller');
}

// Source wiring
assert(src.includes('eip6963:requestProvider'), 're-requests EIP-6963 on write');
assert(src.includes('captureLegacyEthereum'), 'captures legacy window.ethereum');
assert(src.includes('ensureLiveWalletForWrite'), 'ensureLiveWalletForWrite present');
assert(
  /CONFIG\.addresses\.STAKING_VAULT/.test(
    src.slice(src.indexOf('function v1StakingAddress'), src.indexOf('function v1StakingAddress') + 400),
  ),
  'v1StakingAddress reads CONFIG.addresses.STAKING_VAULT (not addr.staking / v2)',
);
assert(src.includes("'0x577Cecbe33d1B2F7f4DF7E0D8Bf03690C2b17eD6'"), 'v1 vault address in CONFIG');

console.log(process.exitCode ? '\nv1 withdraw providers: FAIL' : '\nv1 withdraw providers: PASS');
