/**
 * Public win share page — loads ScratchSettled for ?req=&tier= and renders the card.
 * Bump ASSET_VERSION in sync with win.html ?v=.
 */
export const ASSET_VERSION = 'mint-tokens-1';

import {
  createPublicClient,
  fallback,
  http,
  formatUnits,
  parseAbiItem,
  getAddress,
  zeroAddress,
  defineChain,
} from 'https://esm.sh/viem@2.21.54';

const CONFIG = {
  chainId: 4663,
  explorer: 'https://robinhoodchain.blockscout.com',
  rpc: {
    alchemy: 'https://robinhood-mainnet.g.alchemy.com/v2/Mnnnl8pj1I4NQNUzq7BXU',
    public: 'https://rpc.mainnet.chain.robinhood.com',
  },
  game: '0xBeD604b5AB226134EdF154cc31881d8C93f4C9e6',
  deployBlock: 13_138_508n,
  logChunkBlocks: 9_000n,
  /** Seeded fallbacks; overwritten by `./tokens.json` at boot. */
  tokens: {
    '0xf5e5f4d3c34a14b2fdfd59584fe555cd5e21f196': { symbol: 'SCRATCH', decimals: 18, kind: 'crypto' },
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { symbol: 'USDG', decimals: 6, kind: 'crypto' },
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73': { symbol: 'WETH', decimals: 18, kind: 'crypto' },
    '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea': { symbol: 'SPCX', decimals: 18, kind: 'stock' },
  },
};

async function loadTokenConfig() {
  try {
    const res = await fetch(`./tokens.json?v=${ASSET_VERSION}`);
    if (!res.ok) return;
    const list = await res.json();
    if (!Array.isArray(list)) return;
    const next = {};
    for (const t of list) {
      if (!t?.address || !t?.symbol) continue;
      next[String(t.address).toLowerCase()] = {
        symbol: String(t.symbol),
        decimals: Number(t.decimals ?? 18),
        kind: t.kind === 'stock' ? 'stock' : t.kind || 'crypto',
      };
    }
    CONFIG.tokens = next;
  } catch {
    /* keep seeded map */
  }
}

const EVENT_SCRATCH_SETTLED = parseAbiItem(
  'event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 tier, uint256 rowIndex, address asset, uint256 amount)',
);

const ABI_ERC20 = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

const chain = defineChain({
  id: CONFIG.chainId,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpc.alchemy, CONFIG.rpc.public] } },
  blockExplorers: { default: { name: 'Blockscout', url: CONFIG.explorer } },
});

const client = createPublicClient({
  chain,
  transport: fallback([http(CONFIG.rpc.alchemy), http(CONFIG.rpc.public)]),
});

const metaCache = new Map();

function $(id) {
  return document.getElementById(id);
}

function formatHuman(amount, decimals = 18, maxFrac = 4) {
  const n = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(n)) return '0';
  if (n === 0) return '0';
  if (n >= 1_000_000) return Math.round(n).toLocaleString('en-US');
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
}

function parseQuery() {
  const q = new URLSearchParams(location.search);
  const reqRaw = (q.get('req') || '').trim();
  const tierRaw = (q.get('tier') || '').trim().toLowerCase();
  let requestId = null;
  if (/^\d+$/.test(reqRaw)) {
    try {
      requestId = BigInt(reqRaw);
    } catch {
      requestId = null;
    }
  }
  let tierHint = null;
  if (tierRaw === 'prem' || tierRaw === 'premium' || tierRaw === '1') tierHint = 1;
  else if (tierRaw === 'std' || tierRaw === 'standard' || tierRaw === '0') tierHint = 0;
  return { requestId, tierHint, reqRaw };
}

function showGeneric() {
  document.body.classList.remove('is-premium');
  $('winCard')?.classList.remove('premium');
  const reqEl = $('winReq');
  if (reqEl) reqEl.textContent = 'ONCHAIN WIN';
  const tierEl = $('winTier');
  if (tierEl) {
    tierEl.textContent = 'SCRATCH';
    tierEl.className = 'tier-badge';
  }
  const amt = $('winAmt');
  if (amt) {
    amt.textContent = 'Wins are settled onchain';
    amt.className = 'amt';
  }
  setText($('winLbl'), 'Odds and payouts come from the live game contract.');
  const receipt = $('winReceipt');
  if (receipt) {
    receipt.hidden = true;
    receipt.removeAttribute('href');
  }
  $('winStatus')?.classList.add('show');
  setText($('winStatus'), 'Share a win from the app to get a receipt link for a specific ticket.');
}

function setText(el, text) {
  if (el) el.textContent = text;
}

async function tokenMeta(asset) {
  const key = (asset || '').toLowerCase();
  if (!key || key === zeroAddress) return { symbol: 'NO_WIN', decimals: 18, kind: 'none' };
  if (CONFIG.tokens[key]) return CONFIG.tokens[key];
  if (metaCache.has(key)) return metaCache.get(key);
  try {
    const address = getAddress(asset);
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address, abi: ABI_ERC20, functionName: 'symbol' }),
      client.readContract({ address, abi: ABI_ERC20, functionName: 'decimals' }),
    ]);
    const meta = { symbol: String(symbol), decimals: Number(decimals), kind: 'other' };
    metaCache.set(key, meta);
    return meta;
  } catch {
    const fallbackMeta = { symbol: `${key.slice(0, 6)}…`, decimals: 18, kind: 'other' };
    metaCache.set(key, fallbackMeta);
    return fallbackMeta;
  }
}

async function findSettled(requestId) {
  const tip = await client.getBlockNumber();
  const from = CONFIG.deployBlock;
  const game = getAddress(CONFIG.game);
  for (let start = tip; start >= from; ) {
    const chunkFrom =
      start + 1n > CONFIG.logChunkBlocks ? start + 1n - CONFIG.logChunkBlocks : from;
    const clampedFrom = chunkFrom < from ? from : chunkFrom;
    try {
      const logs = await client.getLogs({
        address: game,
        event: EVENT_SCRATCH_SETTLED,
        args: { requestId },
        fromBlock: clampedFrom,
        toBlock: start,
      });
      if (logs.length) return logs[logs.length - 1];
    } catch {
      /* try older chunk */
    }
    if (clampedFrom <= from) break;
    start = clampedFrom - 1n;
  }
  return null;
}

function applyTierUi(tier) {
  const prem = Number(tier) === 1;
  document.body.classList.toggle('is-premium', prem);
  $('winCard')?.classList.toggle('premium', prem);
  const tierEl = $('winTier');
  if (tierEl) {
    tierEl.textContent = prem ? '★ PREMIUM' : 'STANDARD';
    tierEl.className = 'tier-badge' + (prem ? ' prem' : '');
  }
}

async function renderWin(log, tierHint) {
  const args = log.args;
  const tier = args.tier != null ? Number(args.tier) : tierHint;
  applyTierUi(tier ?? 0);

  const reqEl = $('winReq');
  if (reqEl) reqEl.textContent = `REQUEST #${args.requestId.toString()}`;

  const asset = args.asset;
  const amount = args.amount ?? 0n;
  const isWin =
    asset &&
    asset.toLowerCase() !== zeroAddress.toLowerCase() &&
    amount > 0n;

  const amt = $('winAmt');
  if (!isWin) {
    if (amt) {
      amt.textContent = 'Not this time';
      amt.className = 'amt';
    }
    setText($('winLbl'), 'Same time tomorrow — ticket settled onchain.');
  } else {
    const meta = await tokenMeta(asset);
    const human = formatHuman(amount, meta.decimals);
    if (amt) {
      amt.textContent = `+${human} ${meta.symbol}`;
      amt.className = 'amt ' + (meta.kind === 'stock' ? 'gold' : 'win');
    }
    setText($('winLbl'), 'Paid to your wallet');
  }

  const receipt = $('winReceipt');
  const tx = log.transactionHash;
  if (receipt && tx) {
    receipt.hidden = false;
    receipt.href = `${CONFIG.explorer}/tx/${tx}`;
  } else if (receipt) {
    receipt.hidden = true;
  }

  $('winStatus')?.classList.remove('show');
  setText($('winStatus'), '');
}

async function main() {
  await loadTokenConfig();
  const { requestId, tierHint } = parseQuery();
  if (tierHint != null) applyTierUi(tierHint);

  if (requestId == null) {
    showGeneric();
    return;
  }

  setText($('winReq'), `REQUEST #${requestId.toString()}`);
  setText($('winAmt'), 'Loading…');
  setText($('winLbl'), 'Fetching settlement from chain');
  $('winReceipt').hidden = true;

  try {
    const log = await findSettled(requestId);
    if (!log) {
      showGeneric();
      setText(
        $('winStatus'),
        `Request #${requestId.toString()} isn’t in recent settlements yet — wins settle onchain.`,
      );
      $('winStatus')?.classList.add('show');
      return;
    }
    await renderWin(log, tierHint);
  } catch (err) {
    console.warn('win page', err);
    showGeneric();
    setText($('winStatus'), 'Couldn’t reach the chain just now — try again in a moment.');
    $('winStatus')?.classList.add('show');
  }
}

main();
