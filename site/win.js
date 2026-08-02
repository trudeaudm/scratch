/**
 * Public win share page — loads ScratchSettled for ?req=&tier= and renders the card.
 * Prefers operator ledger (/settlement/:id.json); falls back to public RPC getLogs.
 * Bump ASSET_VERSION in sync with win.html ?v=.
 */
export const ASSET_VERSION = 'v2-live-2';

/** Game generation — production stays v1 until cutover. `?gen=2` forces v2 for verify. */
export const GAME_GENERATION = 2;

import {
  createPublicClient,
  http,
  formatUnits,
  parseAbiItem,
  getAddress,
  zeroAddress,
  defineChain,
} from 'https://esm.sh/viem@2.21.54';

function urlGenerationOverride() {
  try {
    const g = new URLSearchParams(location.search).get('gen');
    if (!g) return null;
    const v = String(g).toLowerCase();
    if (v === '2' || v === 'v2') return 2;
    if (v === '1' || v === 'v1') return 1;
  } catch {
    /* ignore */
  }
  return null;
}
function activeGeneration() {
  return urlGenerationOverride() ?? GAME_GENERATION;
}
function isV2() {
  return activeGeneration() === 2;
}

const CONFIG = {
  chainId: 4663,
  explorer: 'https://robinhoodchain.blockscout.com',
  rpc: {
    /** Public Robinhood RPC only — never ship an Alchemy key in the browser. */
    public: 'https://rpc.mainnet.chain.robinhood.com',
  },
  /** Same operator host as site/app.js — ledger-backed settlement lookup. */
  winsApi: 'https://scratch-operator-web.onrender.com',
  game: '0xBeD604b5AB226134EdF154cc31881d8C93f4C9e6',
  // v2 game (ScratchGameV2) — production Deploy3; used when generation is 2.
  gameV2: '0xe6BA601710aFd1297114D738CA201D1D84eb3Da1',
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

const EVENT_SCRATCH_SETTLED = isV2()
  ? parseAbiItem(
      'event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 cardIndex, uint8 tier, uint256 rowIndex, address asset, uint256 amount)',
    )
  : parseAbiItem(
      'event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 tier, uint256 rowIndex, address asset, uint256 amount)',
    );

/** Active game address for the current generation (v2 falls back to v1 if unfilled). */
function activeGameAddress() {
  if (isV2() && CONFIG.gameV2 && !/FILL/i.test(CONFIG.gameV2)) return CONFIG.gameV2;
  return CONFIG.game;
}

const ABI_ERC20 = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

const chain = defineChain({
  id: CONFIG.chainId,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpc.public] } },
  blockExplorers: { default: { name: 'Blockscout', url: CONFIG.explorer } },
});

const client = createPublicClient({
  chain,
  transport: http(CONFIG.rpc.public),
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

function setText(el, text) {
  if (el) el.textContent = text;
}

function showGeneric() {
  setText($('winAmt'), '—');
  setText($('winLbl'), 'Open a settled scratch from the main site to share a card.');
  $('winReceipt').hidden = true;
}

function parseQuery() {
  const q = new URLSearchParams(location.search);
  const reqRaw = q.get('req');
  const cardRaw = q.get('card');
  const tierRaw = q.get('tier');
  let requestId = null;
  try {
    if (reqRaw != null && reqRaw !== '') requestId = BigInt(reqRaw);
  } catch {
    requestId = null;
  }
  let cardIndex = null;
  if (cardRaw != null && cardRaw !== '') {
    const n = Number(cardRaw);
    if (Number.isFinite(n) && n >= 0) cardIndex = n;
  }
  let tierHint = null;
  if (tierRaw != null && tierRaw !== '') {
    const n = Number(tierRaw);
    if (n === 0 || n === 1) tierHint = n;
  }
  return { requestId, cardIndex, tierHint };
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

/**
 * Prefer operator ledger (originated on reveal) over eth_getLogs.
 * Returns a synthetic log-shaped object for renderWin.
 */
async function findSettledFromLedger(requestId, cardIndex) {
  try {
    const url = new URL(`/settlement/${requestId.toString()}.json`, CONFIG.winsApi);
    const res = await fetch(url.toString(), { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    if (!rows.length) return null;

    let row = null;
    if (cardIndex != null) {
      row = rows.find((r) => Number(r.cardIndex ?? 0) === cardIndex) || null;
    }
    if (!row) row = rows[rows.length - 1];

    let amount = 0n;
    try {
      amount = BigInt(row.amount || '0');
    } catch {
      amount = 0n;
    }
    return {
      transactionHash: row.txHash || null,
      args: {
        user: row.user,
        requestId,
        cardIndex: row.cardIndex != null ? Number(row.cardIndex) : null,
        tier: Number(row.tier ?? 0),
        rowIndex: BigInt(row.rowIndex || 0),
        asset: row.asset,
        amount,
      },
    };
  } catch {
    return null;
  }
}

function pickCard(logs, cardIndex) {
  if (!logs.length) return null;
  if (cardIndex != null) {
    const match = logs.find((l) => Number(l.args.cardIndex ?? 0) === cardIndex);
    if (match) return match;
  }
  return logs[logs.length - 1];
}

async function findSettledFromChain(requestId, cardIndex) {
  const tip = await client.getBlockNumber();
  const from = CONFIG.deployBlock;
  const game = getAddress(activeGameAddress());
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
      if (logs.length) return pickCard(logs, cardIndex);
    } catch {
      /* try older chunk */
    }
    if (clampedFrom <= from) break;
    start = clampedFrom - 1n;
  }
  return null;
}

async function findSettled(requestId, cardIndex) {
  const fromLedger = await findSettledFromLedger(requestId, cardIndex);
  if (fromLedger) return fromLedger;
  return findSettledFromChain(requestId, cardIndex);
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
  if (reqEl) {
    reqEl.textContent =
      args.cardIndex != null
        ? `REQUEST #${args.requestId.toString()} · card ${Number(args.cardIndex) + 1}`
        : `REQUEST #${args.requestId.toString()}`;
  }

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
  const { requestId, cardIndex, tierHint } = parseQuery();
  if (tierHint != null) applyTierUi(tierHint);

  if (requestId == null) {
    showGeneric();
    return;
  }

  const reqLabel =
    cardIndex != null
      ? `REQUEST #${requestId.toString()} · card ${cardIndex + 1}`
      : `REQUEST #${requestId.toString()}`;
  setText($('winReq'), reqLabel);
  setText($('winAmt'), 'Loading…');
  setText($('winLbl'), 'Fetching settlement');
  $('winReceipt').hidden = true;

  try {
    const log = await findSettled(requestId, cardIndex);
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
