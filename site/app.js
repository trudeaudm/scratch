/**
 * $SCRATCH live site — ES module (viem via esm.sh).
 * Wire from index.html: <script type="module" src="./app.js"></script>
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  formatUnits,
  parseUnits,
  parseAbiItem,
  getAddress,
  zeroAddress,
  defineChain,
  decodeEventLog,
} from 'https://esm.sh/viem@2.21.54';

/** Live chain + contract config (Robinhood Chain mainnet). */
export const CONFIG = {
  chainId: 4663,
  chainName: 'Robinhood Chain',
  explorer: 'https://robinhoodchain.blockscout.com',
  rpc: {
    alchemy: 'https://robinhood-mainnet.g.alchemy.com/v2/Mnnnl8pj1I4NQNUzq7BXU',
    public: 'https://rpc.mainnet.chain.robinhood.com',
  },
  addresses: {
    GAME: '0xBeD604b5AB226134EdF154cc31881d8C93f4C9e6',
    STAKING_VAULT: '0x577Cecbe33d1B2F7f4DF7E0D8Bf03690C2b17eD6',
    PRIZE_VAULT: '0x86Ade8b30D481bBd9D2897d20931b107e776Ba52',
    STANDARD_SOURCE: '0xC94894Cd3986E2D0f85616a0Dc59914f1057f003',
    SCRATCH: '0xf5E5f4D3C34A14B2fDfD59584Fe555Cd5e21F196',
    USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // from dashboard tokens.json
    SPCX: '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea', // from dashboard tokens.json
  },
  dex: {
    chainId: 'robinhood',
    pairAddress: '0x3f66e1430c12a7a64839f43050165db6d1bf1ae5bd7df11e47a37a8e73bc00ef',
  },
  ticketCost: 10n ** 18n,
  oddsDenom: 1_000_000,
  refreshMs: 30_000,
  logChunkBlocks: 2000n,
  winsLookbackSec: 24 * 60 * 60,
};

/* -------------------------------------------------------------------------- */
/* Minimal ABIs (inlined — static hosting may not resolve JSON imports)        */
/* -------------------------------------------------------------------------- */

const ABI_GAME = [
  {
    type: 'function',
    name: 'getPrizeRow',
    inputs: [
      { name: 'tier', type: 'uint8' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'asset', type: 'address' },
          { name: 'amountOrBps', type: 'uint96' },
          { name: 'isBpsOfPool', type: 'bool' },
          { name: 'cumOdds', type: 'uint32' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'tableLength',
    inputs: [{ name: 'tier', type: 'uint8' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'scratch',
    inputs: [{ name: 'tier', type: 'uint8' }],
    outputs: [{ name: 'requestId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'requests',
    inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'user', type: 'address' },
      { name: 'tier', type: 'uint8' },
      { name: 'requestedAt', type: 'uint64' },
      { name: 'status', type: 'uint8' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'rescue',
    inputs: [{ name: 'requestId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'rescueDelay',
    inputs: [],
    outputs: [{ type: 'uint64' }],
    stateMutability: 'view',
  },
];

const ABI_STAKING = [
  {
    type: 'function',
    name: 'deposit',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'withdraw',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'minStake',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'ticketsOf',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'users',
    inputs: [{ type: 'address' }],
    outputs: [
      { name: 'staked', type: 'uint256' },
      { name: 'debt', type: 'uint256' },
      { name: 'banked', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
];

const ABI_PRIZE_VAULT = [
  {
    type: 'function',
    name: 'inventory',
    inputs: [],
    outputs: [
      { name: 'assets', type: 'address[]' },
      { name: 'balances', type: 'uint256[]' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
];

const ABI_STANDARD = [
  {
    type: 'function',
    name: 'ticketsOf',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'expiryOf',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'uint64' }],
    stateMutability: 'view',
  },
];

const ABI_ERC20 = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
];

const EVENT_SCRATCH_REQUESTED = parseAbiItem(
  'event ScratchRequested(address indexed user, uint256 indexed requestId, uint8 tier)',
);
const EVENT_SCRATCH_SETTLED = parseAbiItem(
  'event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 tier, uint256 rowIndex, address asset, uint256 amount)',
);

const STATUS = { None: 0, Pending: 1, Settled: 2, Rescued: 3 };
const TIER_STD = 0;
const TIER_PREM = 1;

/** Scratch stage session — owns fan/panel while ≠ IDLE. */
const PHASE = {
  IDLE: 'idle',
  PICKED: 'picked',
  PENDING: 'pending',
  READY: 'ready',
  REVEALED: 'revealed',
};

const DEMO_STORAGE_KEY = 'scratch_demo_tickets_v1';
const SPCX_PAIR = {
  chainId: 'robinhood',
  pairAddress: '0x7cf7a805185bce4766278dc4e4047fbc5d8e2bc8a33b3268270d43b86e10236b',
};

const KNOWN_TOKENS = {
  [CONFIG.addresses.SCRATCH.toLowerCase()]: {
    symbol: 'SCRATCH',
    decimals: 18,
    kind: 'scratch',
  },
  [CONFIG.addresses.USDG.toLowerCase()]: {
    symbol: 'USDG',
    decimals: 6,
    kind: 'usdg',
  },
  ['0x0bd7d308f8e1639fab988df18a8011f41eacad73']: {
    symbol: 'WETH',
    decimals: 18,
    kind: 'eth',
  },
  [CONFIG.addresses.SPCX.toLowerCase()]: {
    symbol: 'SPCX',
    decimals: 18,
    kind: 'stock',
  },
};

const robinhoodChain = defineChain({
  id: CONFIG.chainId,
  name: CONFIG.chainName,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [CONFIG.rpc.alchemy, CONFIG.rpc.public] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: CONFIG.explorer },
  },
});

const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: fallback([http(CONFIG.rpc.alchemy), http(CONFIG.rpc.public)]),
});

const addr = {
  game: getAddress(CONFIG.addresses.GAME),
  staking: getAddress(CONFIG.addresses.STAKING_VAULT),
  prizeVault: getAddress(CONFIG.addresses.PRIZE_VAULT),
  standard: getAddress(CONFIG.addresses.STANDARD_SOURCE),
  scratch: getAddress(CONFIG.addresses.SCRATCH),
  usdg: getAddress(CONFIG.addresses.USDG),
  spcx: getAddress(CONFIG.addresses.SPCX),
};

/* -------------------------------------------------------------------------- */
/* DOM                                                                         */
/* -------------------------------------------------------------------------- */

function $(id) {
  return document.getElementById(id);
}

function setText(el, text) {
  if (el) el.textContent = text;
}

function setHtml(el, html) {
  if (el) el.innerHTML = html;
}

function show(el, on) {
  if (!el) return;
  el.style.display = on ? '' : 'none';
  el.hidden = !on;
}

function shortAddr(a) {
  if (!a) return '';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function formatHuman(amount, decimals = 18, maxFrac = 4) {
  const n = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(n)) return '0';
  if (n === 0) return '0';
  if (n >= 1_000_000) return Math.round(n).toLocaleString('en-US');
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
}

function formatApproxUsd(usd) {
  if (!(usd > 0) || !Number.isFinite(usd)) return '';
  const n = Number(usd.toPrecision(2));
  const display = n >= 100 ? Math.round(n).toLocaleString('en-US') : String(n);
  return `(≈$${display})`;
}

function ageLabel(secAgo) {
  if (secAgo < 60) return `${Math.max(1, Math.floor(secAgo))}s ago`;
  if (secAgo < 3600) return `${Math.floor(secAgo / 60)}m ago`;
  if (secAgo < 86400) return `${Math.floor(secAgo / 3600)}h ago`;
  return `${Math.floor(secAgo / 86400)}d ago`;
}

function formatCountdown(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

function ticketCount(raw) {
  return Number(raw / CONFIG.ticketCost);
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

const state = {
  mode: 'live', // 'demo' | 'live'
  account: null,
  walletClient: null,
  tier: 'std', // 'std' | 'prem'
  currentWin: false,
  pendingRequestId: null,
  rescueDelay: 24n * 60n * 60n,
  minStake: 1_000_000n * 10n ** 18n,
  prices: {
    scratchUsd: null,
    ethUsd: null,
    spcxUsd: null,
    byToken: {},
  },
  liveTickets: { std: 0n, prem: 0n },
  demoTickets: loadDemoTickets(),
  prizeTables: { 0: [], 1: [] },
  drawing: false,
  pollTimer: null,
  refreshTimer: null,
  reassureTimer: null,
  eventUnwatch: null,
  expirySec: 0,
  userExpiry: 0n,
  session: {
    phase: PHASE.IDLE,
    requestId: null,
    tier: TIER_STD,
    tierKey: 'std',
    startedAt: 0,
    optimisticDelta: 0,
    requestedAt: 0n,
  },
};

function stageBusy() {
  return state.session.phase !== PHASE.IDLE;
}

function clearSessionTimers() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.reassureTimer) {
    clearTimeout(state.reassureTimer);
    state.reassureTimer = null;
  }
  try {
    state.eventUnwatch?.();
  } catch {
    /* ignore */
  }
  state.eventUnwatch = null;
}

function setSessionNote(msg, kind) {
  const el = $('sessionNote');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('cancel', kind === 'cancel');
}

function setReassure(on) {
  const el = $('sessionReassure');
  if (!el) return;
  el.classList.toggle('show', !!on);
}

const DEMO_PRIZES = {
  std: [
    ['+250 $SCRATCH', 'Sent to your wallet automatically', 'win'],
    ['+500 $SCRATCH', 'Sent to your wallet automatically', 'win'],
    ['+5,000 $SCRATCH', 'Big one. Sent automatically', 'win'],
    ['+25 USDG', 'Stable win. Sent automatically', 'win'],
    ['Not this time', 'Same time tomorrow', ''],
    ['Not this time', 'Same time tomorrow', ''],
  ],
  prem: [
    ['+1,000 $SCRATCH', 'Sent to your wallet automatically', 'win'],
    ['+50 USDG', 'Stable win. Sent automatically', 'win'],
    ['+MEME', 'Top RH Chain memecoin. Sent automatically', 'gold'],
    ['1× SPCX', 'An actual onchain share.', 'gold'],
    ['Not this time', 'Keep staking — same time tomorrow', ''],
  ],
};

function loadDemoTickets() {
  try {
    const raw = localStorage.getItem(DEMO_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        std: Math.max(0, Number(parsed.std) || 3),
        prem: Math.max(0, Number(parsed.prem) || 2),
      };
    }
  } catch {
    /* ignore */
  }
  return { std: 3, prem: 2 };
}

function saveDemoTickets() {
  try {
    localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state.demoTickets));
  } catch {
    /* ignore */
  }
}

function activeTier() {
  if (state.mode === 'demo') {
    return { std: state.demoTickets.std, prem: state.demoTickets.prem };
  }
  let std = ticketCount(state.liveTickets.std);
  let prem = ticketCount(state.liveTickets.prem);
  if (state.session.optimisticDelta > 0) {
    if (state.session.tierKey === 'std') std = Math.max(0, std - state.session.optimisticDelta);
    else prem = Math.max(0, prem - state.session.optimisticDelta);
  }
  return { std, prem };
}

function activeTierTickets() {
  const t = activeTier();
  return state.tier === 'std' ? t.std : t.prem;
}

function activeChainTier() {
  return state.tier === 'std' ? TIER_STD : TIER_PREM;
}

/* -------------------------------------------------------------------------- */
/* Prices                                                                      */
/* -------------------------------------------------------------------------- */

async function fetchPairUsd(chainId, pairAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pair ?? data.pairs?.[0];
    const n = Number(pair?.priceUsd);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function fetchTokenUsd(tokenAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = (data.pairs || [])
      .map((p) => ({
        price: Number(p.priceUsd),
        liq: Number(p.liquidity?.usd) || 0,
      }))
      .filter((p) => p.price > 0)
      .sort((a, b) => b.liq - a.liq);
    return pairs[0]?.price ?? null;
  } catch {
    return null;
  }
}

async function refreshPrices() {
  const [scratchUsd, spcxPair, ethUsd] = await Promise.all([
    fetchPairUsd(CONFIG.dex.chainId, CONFIG.dex.pairAddress),
    fetchPairUsd(SPCX_PAIR.chainId, SPCX_PAIR.pairAddress),
    fetchTokenUsd('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  ]);
  let spcxUsd = spcxPair;
  if (spcxUsd == null) spcxUsd = await fetchTokenUsd(CONFIG.addresses.SPCX);

  state.prices.scratchUsd = scratchUsd;
  state.prices.ethUsd = ethUsd;
  state.prices.spcxUsd = spcxUsd;
  state.prices.byToken = {
    [CONFIG.addresses.SCRATCH.toLowerCase()]: scratchUsd,
    [CONFIG.addresses.USDG.toLowerCase()]: 1,
    [CONFIG.addresses.SPCX.toLowerCase()]: spcxUsd,
    ['0x0bd7d308f8e1639fab988df18a8011f41eacad73']: ethUsd,
  };
  fillUsdLive();
}

function unitUsd(tokenAddr) {
  const key = (tokenAddr || '').toLowerCase();
  const p = state.prices.byToken[key];
  return p != null && p > 0 ? p : null;
}

function fillUsdLive() {
  document.querySelectorAll('.usd-live').forEach((el) => {
    const amount = Number(el.dataset.scratchAmount);
    const px = state.prices.scratchUsd;
    if (px == null || !(amount > 0)) {
      el.textContent = '';
      return;
    }
    el.textContent = formatApproxUsd(amount * px);
  });
}

/* -------------------------------------------------------------------------- */
/* Token metadata                                                              */
/* -------------------------------------------------------------------------- */

const metaCache = new Map();

async function tokenMeta(asset) {
  const key = asset.toLowerCase();
  if (KNOWN_TOKENS[key]) return KNOWN_TOKENS[key];
  if (metaCache.has(key)) return metaCache.get(key);
  try {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({
        address: getAddress(asset),
        abi: ABI_ERC20,
        functionName: 'symbol',
      }),
      publicClient.readContract({
        address: getAddress(asset),
        abi: ABI_ERC20,
        functionName: 'decimals',
      }),
    ]);
    const meta = { symbol: String(symbol), decimals: Number(decimals), kind: 'other' };
    metaCache.set(key, meta);
    return meta;
  } catch {
    const fallback = { symbol: shortAddr(asset), decimals: 18, kind: 'other' };
    metaCache.set(key, fallback);
    return fallback;
  }
}

async function ensureTokenPrice(asset) {
  const key = asset.toLowerCase();
  if (state.prices.byToken[key] != null) return state.prices.byToken[key];
  if (key === CONFIG.addresses.USDG.toLowerCase()) {
    state.prices.byToken[key] = 1;
    return 1;
  }
  const px = await fetchTokenUsd(asset);
  if (px != null) state.prices.byToken[key] = px;
  return px;
}

/* -------------------------------------------------------------------------- */
/* Prize tables                                                                */
/* -------------------------------------------------------------------------- */

async function loadPrizeTable(tier) {
  const len = await publicClient.readContract({
    address: addr.game,
    abi: ABI_GAME,
    functionName: 'tableLength',
    args: [tier],
  });
  const rows = [];
  for (let i = 0n; i < len; i++) {
    const row = await publicClient.readContract({
      address: addr.game,
      abi: ABI_GAME,
      functionName: 'getPrizeRow',
      args: [tier, i],
    });
    rows.push({
      asset: row.asset,
      amountOrBps: BigInt(row.amountOrBps),
      isBpsOfPool: Boolean(row.isBpsOfPool),
      cumOdds: Number(row.cumOdds),
    });
  }
  state.prizeTables[tier] = rows;
  return rows;
}

function oneInN(delta) {
  if (!(delta > 0)) return null;
  const n = CONFIG.oddsDenom / delta;
  if (n >= 100) return Math.round(n);
  if (n >= 10) return Math.round(n * 10) / 10;
  return Math.round(n * 100) / 100;
}

async function renderPrizeList(tier, containerId) {
  const el = $(containerId);
  if (!el) return;
  const rows = state.prizeTables[tier] || [];
  if (!rows.length) {
    el.innerHTML = '<div class="prize-row"><span class="p">Loading prize table…</span></div>';
    return;
  }

  const parts = [];
  let prev = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const delta = row.cumOdds - prev;
    prev = row.cumOdds;
    const isNoWin =
      row.asset.toLowerCase() === zeroAddress.toLowerCase() ||
      (row.amountOrBps === 0n && !row.isBpsOfPool);

    if (isNoWin && i === rows.length - 1) {
      const n = oneInN(delta);
      parts.push(
        `<div class="prize-row"><span class="p">No win</span><span class="o">${
          n != null ? `1 in ${n}` : '—'
        }</span></div>`,
      );
      continue;
    }
    if (isNoWin) continue;

    const meta = await tokenMeta(row.asset);
    let amountLabel;
    let usdHint = '';

    if (row.isBpsOfPool) {
      let bal = 0n;
      try {
        bal = await publicClient.readContract({
          address: addr.prizeVault,
          abi: ABI_PRIZE_VAULT,
          functionName: 'balanceOf',
          args: [getAddress(row.asset)],
        });
      } catch {
        bal = 0n;
      }
      const live = (bal * row.amountOrBps) / 10000n;
      amountLabel = `+${formatHuman(live, meta.decimals)} ${meta.symbol}`;
      const px = (await ensureTokenPrice(row.asset)) ?? unitUsd(row.asset);
      if (px != null) {
        const human = Number(formatUnits(live, meta.decimals));
        usdHint = ` ${formatApproxUsd(human * px)}`;
      }
    } else {
      amountLabel = `+${formatHuman(row.amountOrBps, meta.decimals)} ${meta.symbol}`;
      const px = (await ensureTokenPrice(row.asset)) ?? unitUsd(row.asset);
      if (px != null) {
        const human = Number(formatUnits(row.amountOrBps, meta.decimals));
        usdHint = ` ${formatApproxUsd(human * px)}`;
      }
    }

    const n = oneInN(delta);
    const stockBadge =
      meta.kind === 'stock' ? '<span class="tk">STOCK</span>' : '';
    parts.push(
      `<div class="prize-row"><span class="p">${stockBadge}${amountLabel}${usdHint}</span><span class="o">${
        n != null ? `1 in ${n}` : '—'
      }</span></div>`,
    );
  }
  el.innerHTML = parts.join('') || '<div class="prize-row"><span class="p">No prizes listed</span></div>';
}

/* -------------------------------------------------------------------------- */
/* Vault inventory                                                             */
/* -------------------------------------------------------------------------- */

async function renderVaultInventory() {
  const el = $('vaultInventory');
  if (!el) return;
  try {
    const [assets, balances] = await publicClient.readContract({
      address: addr.prizeVault,
      abi: ABI_PRIZE_VAULT,
      functionName: 'inventory',
    });
    const items = [];
    const stocks = [];
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const bal = balances[i];
      if (bal === 0n) continue;
      const meta = await tokenMeta(asset);
      await ensureTokenPrice(asset);
      const human = Number(formatUnits(bal, meta.decimals));
      const px = unitUsd(asset);
      const usd = px != null ? formatApproxUsd(human * px) : '';
      const line = `<div class="inv-row"><span class="inv-sym">${meta.symbol}</span><span class="inv-bal">${formatHuman(
        bal,
        meta.decimals,
      )} ${usd}</span></div>`;
      if (meta.kind === 'stock' || asset.toLowerCase() === CONFIG.addresses.SPCX.toLowerCase()) {
        stocks.push(line);
      } else {
        items.push(line);
      }
    }
    let html = items.join('') || '<div class="inv-row muted">Vault empty or loading…</div>';
    if (stocks.length) {
      html += `<div class="inv-sub">Stocks</div>${stocks.join('')}`;
    }
    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = `<div class="inv-row muted">Inventory unavailable: ${escapeHtml(
      err?.shortMessage || err?.message || String(err),
    )}</div>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* -------------------------------------------------------------------------- */
/* Min stake                                                                   */
/* -------------------------------------------------------------------------- */

async function refreshMinStake() {
  try {
    const min = await publicClient.readContract({
      address: addr.staking,
      abi: ABI_STAKING,
      functionName: 'minStake',
    });
    state.minStake = min;
    const human = formatUnits(min, 18);
    const pretty = Number(human).toLocaleString('en-US', { maximumFractionDigits: 0 });

    document.querySelectorAll('.usd-live[data-scratch-amount]').forEach((el) => {
      el.dataset.scratchAmount = human;
    });

    const amt = $('minStakeAmount');
    if (amt) amt.textContent = pretty;

    const rate = $('minStakeRate');
    if (rate) {
      rate.innerHTML = `Stake at least <b id="minStakeAmount">${pretty}</b> $SCRATCH <span class="usd-live" data-scratch-amount="${human}"></span> · your share of <b>65%</b> of emissions · <b>no lockup</b>`;
    }

    const live = $('minStakeLive');
    if (live && !live.dataset.locked) {
      live.textContent = 'Promo / grant tickets · odds below are live from the game contract';
    }

    fillUsdLive();
  } catch {
    /* keep previous */
  }
}

/* -------------------------------------------------------------------------- */
/* Recent wins                                                                 */
/* -------------------------------------------------------------------------- */

async function loadRecentWins() {
  const el = $('recentWins');
  if (!el) return;

  try {
    const latest = await publicClient.getBlockNumber();
    // ~0.1s blocks → ~864_000 blocks / 24h; clamp lookback
    const lookbackBlocks = BigInt(
      Math.min(Math.ceil(CONFIG.winsLookbackSec / 0.1), 1_000_000),
    );
    const fromBlock =
      latest > lookbackBlocks ? latest - lookbackBlocks : 0n;

    const chunks = [];
    for (let start = fromBlock; start <= latest; start += CONFIG.logChunkBlocks) {
      const end =
        start + CONFIG.logChunkBlocks - 1n > latest
          ? latest
          : start + CONFIG.logChunkBlocks - 1n;
      chunks.push({ fromBlock: start, toBlock: end });
    }

    el.innerHTML = '<div class="win-row muted">Loading recent wins…</div>';

    const wins = [];
    const concurrency = 8;
    let cursor = 0;

    async function worker() {
      while (cursor < chunks.length) {
        const i = cursor++;
        const { fromBlock: fb, toBlock: tb } = chunks[i];
        try {
          const logs = await publicClient.getLogs({
            address: addr.game,
            event: EVENT_SCRATCH_SETTLED,
            fromBlock: fb,
            toBlock: tb,
          });
          for (const log of logs) {
            const asset = log.args.asset;
            if (!asset || asset.toLowerCase() === zeroAddress.toLowerCase()) continue;
            if (!log.args.amount || log.args.amount === 0n) continue;
            wins.push({
              user: log.args.user,
              asset,
              amount: log.args.amount,
              blockNumber: log.blockNumber,
              requestId: log.args.requestId,
            });
          }
          // Progressive render
          if (wins.length && el) {
            renderWinsPartial(el, wins);
          }
        } catch {
          /* skip chunk */
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    // Attach ages via latest block timestamp approximation
    const tip = await publicClient.getBlock({ blockNumber: latest });
    const tipTs = Number(tip.timestamp);
    for (const w of wins) {
      const ageBlocks = Number(latest - w.blockNumber);
      w.ageSec = ageBlocks * 0.1;
      w.ts = tipTs - w.ageSec;
    }
    wins.sort((a, b) => Number(b.blockNumber - a.blockNumber));
    await renderWinsFinal(el, wins.slice(0, 40));
  } catch (err) {
    el.innerHTML = `<div class="win-row muted">Could not load wins: ${escapeHtml(
      err?.shortMessage || err?.message || String(err),
    )}</div>`;
  }
}

function renderWinsPartial(el, wins) {
  const sorted = [...wins].sort((a, b) => Number(b.blockNumber - a.blockNumber)).slice(0, 20);
  el.innerHTML = sorted
    .map(
      (w) =>
        `<div class="win-row"><span class="win-who">${shortAddr(
          w.user,
        )}</span><span class="win-prize">…</span><span class="win-age">…</span></div>`,
    )
    .join('');
}

async function renderWinsFinal(el, wins) {
  if (!wins.length) {
    el.innerHTML = '<div class="win-row muted">No wins in the last 24h yet.</div>';
    return;
  }
  const parts = [];
  for (const w of wins) {
    const meta = await tokenMeta(w.asset);
    const label = `+${formatHuman(w.amount, meta.decimals)} ${meta.symbol}`;
    parts.push(
      `<div class="win-row"><span class="win-who">${shortAddr(
        w.user,
      )}</span><span class="win-prize">${escapeHtml(label)}</span><span class="win-age">${ageLabel(
        w.ageSec,
      )}</span></div>`,
    );
  }
  el.innerHTML = parts.join('');
}

/* -------------------------------------------------------------------------- */
/* Fairness note                                                               */
/* -------------------------------------------------------------------------- */

function injectFairnessNote() {
  const el = $('fairnessNote');
  if (!el) return;
  el.textContent =
    'Randomness: committed hash chain, operator-run. The operator can delay a reveal — delayed reveals auto-refund your ticket — but cannot choose outcomes. Migrating to an oracle via 48h public timelock when one deploys on this chain.';
  el.dataset.filled = '1';
}

/* -------------------------------------------------------------------------- */
/* Tier UI / demo                                                              */
/* -------------------------------------------------------------------------- */

function isDemo() {
  return state.mode === 'demo';
}

function setMode(mode) {
  const next = mode === 'demo' ? 'demo' : 'live';
  if (next === 'demo' && stageBusy()) {
    // Drop in-flight live session before entering demo
    resetSessionToIdle({ keepNote: true });
    setSessionNote('Switched to demo — live draw cancelled on this screen only (check chain if a tx already confirmed).');
  }
  state.mode = next;
  const note = $('demoNote');
  if (note) {
    if (state.mode === 'demo') {
      note.hidden = false;
      note.style.display = '';
      note.innerHTML =
        '<b>Demo mode</b> — try the scratch UX without a wallet. Tickets and prizes here are local. Switch back to live to use real tickets.';
    } else {
      note.hidden = true;
      note.style.display = 'none';
    }
  }
  const btn = $('playModeDemo');
  if (btn) {
    btn.textContent = state.mode === 'demo' ? 'Back to live' : 'Try the demo';
  }
  const again = $('againBtn');
  if (again) {
    again.style.display = state.mode === 'demo' ? '' : 'none';
  }
  renderTier();
  updateScratchButtons();
}

function renderTier() {
  const t = activeTier();
  const tabStd = $('tabStd');
  const tabPrem = $('tabPrem');
  const stage = $('stage');
  const fan = $('fan');
  const panel = $('panel');
  const promptEl = $('prompt');
  const lockedNote = $('lockedNote');
  const busy = stageBusy() && state.mode === 'live';

  tabStd?.classList.toggle('active', state.tier === 'std');
  tabStd?.setAttribute('aria-selected', String(state.tier === 'std'));
  tabPrem?.classList.toggle('active', state.tier === 'prem');
  tabPrem?.setAttribute('aria-selected', String(state.tier === 'prem'));

  setText($('cntStd'), String(t.std));
  setText($('cntPrem'), String(t.prem));

  const minPretty = Number(formatUnits(state.minStake, 18)).toLocaleString('en-US', {
    maximumFractionDigits: 0,
  });
  const human = formatUnits(state.minStake, 18);
  const tierNote = $('tierNote');
  if (tierNote && !busy) {
    if (state.tier === 'std') {
      tierNote.innerHTML =
        'Holder (standard) tickets from grants · odds are live from the game contract · pays $SCRATCH &amp; USDG';
    } else {
      tierNote.innerHTML = `Staked tickets · min stake <b>${minPretty} $SCRATCH <span class="usd-live" data-scratch-amount="${human}"></span></b> · pays $SCRATCH, USDG &amp; stocks`;
    }
    fillUsdLive();
  }

  if (busy) {
    updateScratchButtons();
    return;
  }

  stage?.classList.toggle('premium', state.tier === 'prem');
  $('scratchCardEl')?.classList.toggle('premium', state.tier === 'prem');
  const badge = $('premBadge');
  if (badge) badge.style.display = state.tier === 'prem' ? 'inline' : 'none';

  panel?.classList.remove('show');
  panel?.classList.remove('session-pending');
  fan?.classList.remove('picked');
  $('claimRow')?.classList.remove('show');
  setReassure(false);

  const locked = activeTierTickets() <= 0;
  fan?.classList.toggle('locked', locked);
  lockedNote?.classList.toggle('show', locked);
  if (promptEl) {
    promptEl.textContent = locked ? 'No tickets left on this tier' : 'Choose your free scratch';
  }
  updateScratchButtons();
}

function updateScratchButtons() {
  const t = activeTier();
  const busy = stageBusy() && state.mode === 'live';
  const stdBtn = $('scratchBtnStd');
  const premBtn = $('scratchBtnPrem');
  const stdPath = $('scratchBtnStdPath');
  if (stdBtn) {
    stdBtn.disabled = busy || t.std < 1 || (state.mode === 'live' && !state.account);
  }
  if (premBtn) {
    premBtn.disabled = busy || t.prem < 1 || (state.mode === 'live' && !state.account);
  }
  if (stdPath) {
    stdPath.disabled = busy || t.std < 1 || (state.mode === 'live' && !state.account);
  }
}

/* -------------------------------------------------------------------------- */
/* Canvas foil / confetti                                                      */
/* -------------------------------------------------------------------------- */

let canvas;
let ctx;
let revealed = false;
let drawing = false;
let last = null;
let strokeDist = 0;
let moveCount = 0;
let disableTimer = null;

function paintFoil() {
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  if (r.width === 0) {
    if (!paintFoil._retried) {
      paintFoil._retried = true;
      setTimeout(paintFoil, 250);
    }
    return;
  }
  paintFoil._retried = false;
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  const prem = state.tier === 'prem';
  const g = ctx.createLinearGradient(0, 0, r.width, r.height);
  if (prem) {
    g.addColorStop(0, '#1A222B');
    g.addColorStop(1, '#10161C');
  } else {
    g.addColorStop(0, '#B07F35');
    g.addColorStop(1, '#8F6222');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, r.width, r.height);
  ctx.strokeStyle = prem ? 'rgba(201,162,39,.55)' : 'rgba(255,244,214,.55)';
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 6]);
  ctx.strokeRect(8, 8, r.width - 16, r.height - 16);
  ctx.setLineDash([]);
  ctx.fillStyle = prem ? '#C9A227' : '#5C3F12';
  ctx.font = "800 56px 'Inter'";
  ctx.textAlign = 'center';
  ctx.fillText('?', r.width / 2, r.height / 2 + 8);
  ctx.fillStyle = g;
  ctx.fillRect(r.width / 2 - 22, r.height / 2 - 6, 44, 18);
  ctx.fillStyle = prem ? '#C9A227' : '#5C3F12';
  ctx.beginPath();
  const dcx = r.width / 2;
  const dcy = r.height / 2 + 4;
  const ds = 8;
  ctx.moveTo(dcx, dcy - ds);
  ctx.lineTo(dcx + ds * 0.78, dcy);
  ctx.lineTo(dcx, dcy + ds);
  ctx.lineTo(dcx - ds * 0.78, dcy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = prem ? 'rgba(201,162,39,.8)' : 'rgba(92,63,18,.9)';
  ctx.font = "700 11px 'Inter'";
  ctx.fillText('SCRATCH TO REVEAL', r.width / 2, r.height - 20);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineWidth = 34;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  revealed = false;
  strokeDist = 0;
  moveCount = 0;
}

function resetScratch() {
  clearTimeout(disableTimer);
  if (!canvas) return;
  canvas.style.transition = 'none';
  canvas.style.opacity = '1';
  canvas.style.pointerEvents = 'auto';
  paintFoil();
}

function lockFoilWaiting() {
  clearTimeout(disableTimer);
  if (!canvas) return;
  canvas.style.transition = 'none';
  canvas.style.opacity = '1';
  canvas.style.pointerEvents = 'none';
  paintFoil();
}

function unlockFoilForScratch() {
  if (!canvas) return;
  canvas.style.pointerEvents = 'auto';
  canvas.style.opacity = '1';
  paintFoil();
}

function pos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function scratchMove(e) {
  if (!drawing || !ctx) return;
  const p = pos(e);
  if (last) strokeDist += Math.hypot(p.x - last.x, p.y - last.y);
  ctx.beginPath();
  ctx.moveTo((last || p).x, (last || p).y);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  last = p;
  if (++moveCount % 6 === 0) checkReveal();
}

function doReveal() {
  if (revealed) return;
  revealed = true;
  canvas.style.transition = 'opacity .55s ease';
  canvas.style.opacity = '0';
  disableTimer = setTimeout(() => {
    canvas.style.pointerEvents = 'none';
  }, 500);
  const claimRow = $('claimRow');
  claimRow?.classList.toggle('show', state.currentWin);
  const promptEl = $('prompt');
  if (promptEl) {
    promptEl.textContent = state.currentWin ? 'Nice.' : 'Better luck tomorrow.';
  }
  if (state.currentWin) burstConfetti();
  if (state.mode === 'live') enterRevealedUI();
}

function checkReveal() {
  if (revealed || !ctx) return;
  const rx = Math.floor(canvas.width * 0.18);
  const rw = Math.floor(canvas.width * 0.64);
  const ry = Math.floor(canvas.height * 0.28);
  const rh = Math.floor(canvas.height * 0.44);
  if (rw <= 0 || rh <= 0) return;
  const d = ctx.getImageData(rx, ry, rw, rh).data;
  let clear = 0;
  let total = 0;
  for (let i = 3; i < d.length; i += 64) {
    total++;
    if (d[i] === 0) clear++;
  }
  if (clear / total > 0.6) doReveal();
}

function release() {
  drawing = false;
  last = null;
  if (!revealed && strokeDist > 30) doReveal();
}

function burstConfetti() {
  const cCan = $('confetti');
  if (!cCan) return;
  const cCtx = cCan.getContext('2d');
  cCan.width = innerWidth;
  cCan.height = innerHeight;
  const colors =
    state.tier === 'prem'
      ? ['#C9A227', '#EAD37E', '#F4E7B0', '#8F6E14']
      : ['#F2C94C', '#E0A93F', '#B67F1E', '#F7E3A8'];
  const parts = Array.from({ length: 90 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 260,
    y: innerHeight * 0.3,
    vx: (Math.random() - 0.5) * 2.2,
    vy: -(Math.random() * 2.5 + 0.8),
    w: 5 + Math.random() * 5,
    h: 8 + Math.random() * 6,
    c: colors[Math.floor(Math.random() * colors.length)],
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.12,
    sway: Math.random() * Math.PI * 2,
  }));
  let frames = 0;
  (function tick() {
    cCtx.clearRect(0, 0, cCan.width, cCan.height);
    for (const p of parts) {
      p.sway += 0.05;
      p.x += p.vx + Math.sin(p.sway) * 0.7;
      p.y += p.vy;
      p.vy = Math.min(p.vy + 0.055, 2.4);
      p.rot += p.vr;
      cCtx.save();
      cCtx.translate(p.x, p.y);
      cCtx.rotate(p.rot);
      cCtx.fillStyle = p.c;
      cCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      cCtx.restore();
    }
    if (++frames < 380) requestAnimationFrame(tick);
    else cCtx.clearRect(0, 0, cCan.width, cCan.height);
  })();
}

function wireCanvas() {
  canvas = $('scratchCanvas');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  canvas.addEventListener('pointerdown', (e) => {
    if (canvas.style.pointerEvents === 'none') return;
    if (!canScratchInput()) return;
    drawing = true;
    last = null;
    canvas.setPointerCapture(e.pointerId);
    scratchMove(e);
  });
  canvas.addEventListener('pointermove', scratchMove);
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  window.addEventListener('resize', () => {
    const panel = $('panel');
    if (!panel?.classList.contains('show') || revealed) return;
    if (state.mode === 'live' && state.session.phase === PHASE.READY) paintFoil();
    else if (state.mode === 'live' && (state.session.phase === PHASE.PICKED || state.session.phase === PHASE.PENDING))
      lockFoilWaiting();
    else if (state.mode === 'demo') paintFoil();
  });
}

/* -------------------------------------------------------------------------- */
/* Demo scratch                                                                */
/* -------------------------------------------------------------------------- */

function rollDemoPrize() {
  const list = DEMO_PRIZES[state.tier];
  const [amt, lbl, cls] = list[Math.floor(Math.random() * list.length)];
  const amtEl = $('prizeAmt');
  if (amtEl) {
    amtEl.textContent = amt;
    amtEl.className = 'amt' + (cls ? ' ' + cls : '');
  }
  setText($('prizeLbl'), lbl);
  state.currentWin = !!cls;
}

function startDemoScratch() {
  if (activeTierTickets() <= 0) return;
  if (state.tier === 'std') state.demoTickets.std--;
  else state.demoTickets.prem--;
  saveDemoTickets();
  rollDemoPrize();
  $('fan')?.classList.add('picked');
  setText($('prompt'), 'Scratch to reveal your reward');
  $('panel')?.classList.add('show');
  setText($('cntStd'), String(state.demoTickets.std));
  setText($('cntPrem'), String(state.demoTickets.prem));
  const claimBtn = $('claimBtn');
  if (claimBtn) {
    claimBtn.textContent = 'Claim reward';
    claimBtn.disabled = false;
  }
  requestAnimationFrame(() => requestAnimationFrame(resetScratch));
  setTimeout(resetScratch, 350);
}

/* -------------------------------------------------------------------------- */
/* Wallet                                                                      */
/* -------------------------------------------------------------------------- */

function setStatus(elOrId, msg) {
  const el = typeof elOrId === 'string' ? $(elOrId) : elOrId;
  if (el) el.textContent = msg || '';
}

async function ensureChain() {
  if (!window.ethereum) throw new Error('No wallet found. Install MetaMask or another injected wallet.');
  const hexId = '0x' + CONFIG.chainId.toString(16);
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexId }],
    });
  } catch (err) {
    if (err?.code === 4902 || /Unrecognized chain/i.test(err?.message || '')) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: hexId,
            chainName: CONFIG.chainName,
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [CONFIG.rpc.public, CONFIG.rpc.alchemy],
            blockExplorerUrls: [CONFIG.explorer],
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

async function connectWallet() {
  const btn = $('connectBtn');
  try {
    if (!window.ethereum) {
      setStatus(btn, 'No wallet');
      alert('No Ethereum wallet detected. Install MetaMask or a compatible wallet.');
      return;
    }
    await ensureChain();
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const account = getAddress(accounts[0]);
    state.account = account;
    state.walletClient = createWalletClient({
      account,
      chain: robinhoodChain,
      transport: custom(window.ethereum),
    });
    if (btn) {
      btn.textContent = shortAddr(account);
      btn.dataset.connected = '1';
      btn.style.minHeight = '44px';
    }
    if (state.mode === 'demo') setMode('live');
    await refreshWalletPanel({ skipStage: true });
    updateScratchButtons();
    await rehydratePendingSession();
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    if (btn) btn.textContent = 'Connect';
    alert(`Wallet: ${msg}`);
  }
}

function disconnectOrCopy() {
  const btn = $('connectBtn');
  if (!state.account) {
    connectWallet();
    return;
  }
  // Second click: copy address; long-press style via confirm disconnect
  const action = confirm(
    `${state.account}\n\nOK = copy address\nCancel = disconnect`,
  );
  if (action) {
    navigator.clipboard?.writeText(state.account);
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => {
        btn.textContent = prev;
      }, 1200);
    }
  } else {
    state.account = null;
    state.walletClient = null;
    if (btn) {
      btn.textContent = 'Connect';
      delete btn.dataset.connected;
    }
    const panel = $('walletPanel');
    if (panel) panel.hidden = true;
    updateScratchButtons();
  }
}

async function refreshWalletPanel(opts = {}) {
  const panel = $('walletPanel');
  if (!state.account) {
    if (panel) panel.hidden = true;
    return;
  }
  try {
    const [user, stdTickets, premTickets, expiry] = await Promise.all([
      publicClient.readContract({
        address: addr.staking,
        abi: ABI_STAKING,
        functionName: 'users',
        args: [state.account],
      }),
      publicClient.readContract({
        address: addr.standard,
        abi: ABI_STANDARD,
        functionName: 'ticketsOf',
        args: [state.account],
      }),
      publicClient.readContract({
        address: addr.staking,
        abi: ABI_STAKING,
        functionName: 'ticketsOf',
        args: [state.account],
      }),
      publicClient.readContract({
        address: addr.standard,
        abi: ABI_STANDARD,
        functionName: 'expiryOf',
        args: [state.account],
      }),
    ]);

    state.liveTickets.std = stdTickets;
    state.liveTickets.prem = premTickets;
    state.userExpiry = BigInt(expiry);

    const staked = user.staked ?? user[0];
    const banked = user.banked ?? user[2];
    const now = Math.floor(Date.now() / 1000);
    const expSec = Number(expiry);
    const remain = expSec > now ? expSec - now : 0;
    state.expirySec = remain;

    if (panel) panel.hidden = false;
    setText($('walletStaked'), `${formatHuman(staked)} SCRATCH`);
    setText($('walletBanked'), `${formatHuman(banked)} tickets`);
    setText($('walletStdTickets'), String(ticketCount(stdTickets)));
    setText($('walletPremTickets'), String(ticketCount(premTickets)));
    setText($('walletExpiry'), remain > 0 ? formatCountdown(remain) : '—');

    // Reconcile ticket balances from chain; optimistic delta cleared once pending/settled.
    if (state.session.phase === PHASE.PENDING || state.session.phase === PHASE.READY || state.session.phase === PHASE.REVEALED) {
      state.session.optimisticDelta = 0;
    }
    setText($('cntStd'), String(activeTier().std));
    setText($('cntPrem'), String(activeTier().prem));
    updateScratchButtons();
    if (!opts.skipStage && !stageBusy()) renderTier();
    else if (!opts.skipStage && stageBusy()) {
      // counts already updated above
    }
  } catch (e) {
    const status = $('scratchStatus');
    if (status) status.textContent = e instanceof Error ? e.message : 'Wallet read failed';
  }
}

/* -------------------------------------------------------------------------- */
/* Live scratch — session state machine                                        */
/* -------------------------------------------------------------------------- */

function resetSessionToIdle(opts = {}) {
  clearSessionTimers();
  state.session.phase = PHASE.IDLE;
  state.session.requestId = null;
  state.session.optimisticDelta = 0;
  state.session.requestedAt = 0n;
  state.pendingRequestId = null;
  const panel = $('panel');
  panel?.classList.remove('show');
  panel?.classList.remove('session-pending');
  $('fan')?.classList.remove('picked');
  $('claimRow')?.classList.remove('show');
  $('lockedNote')?.classList.remove('show');
  setReassure(false);
  show($('pendingRescue'), false);
  show($('rescueBtn'), false);
  if (opts.cancelNote) setSessionNote(opts.cancelNote, 'cancel');
  else if (!opts.keepNote) setSessionNote('');
  renderTier();
}

function enterPickedUI(tier, tierKey) {
  state.session.phase = PHASE.PICKED;
  state.session.tier = tier;
  state.session.tierKey = tierKey;
  state.session.startedAt = Date.now();
  state.session.requestId = null;
  state.session.optimisticDelta = 1;
  state.tier = tierKey;

  const stage = $('stage');
  stage?.classList.toggle('premium', tierKey === 'prem');
  $('scratchCardEl')?.classList.toggle('premium', tierKey === 'prem');
  const badge = $('premBadge');
  if (badge) badge.style.display = tierKey === 'prem' ? 'inline' : 'none';

  setSessionNote('');
  setReassure(false);
  show($('pendingRescue'), false);
  show($('rescueBtn'), false);
  $('claimRow')?.classList.remove('show');
  $('lockedNote')?.classList.remove('show');

  const amtEl = $('prizeAmt');
  if (amtEl) {
    amtEl.textContent = '…';
    amtEl.className = 'amt';
  }
  setText($('prizeLbl'), 'Hang tight');
  setText($('prompt'), 'Printing your ticket…');
  setText($('ticketNo'), 'Confirm in wallet…');

  $('fan')?.classList.add('picked');
  const panel = $('panel');
  panel?.classList.add('show');
  panel?.classList.remove('session-pending');

  setText($('cntStd'), String(activeTier().std));
  setText($('cntPrem'), String(activeTier().prem));
  updateScratchButtons();

  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      lockFoilWaiting();
    }),
  );
}

function enterPendingUI(requestId, requestedAt) {
  state.session.phase = PHASE.PENDING;
  state.session.requestId = requestId;
  state.session.requestedAt = requestedAt ?? 0n;
  state.session.optimisticDelta = 0;
  state.pendingRequestId = requestId;

  const panel = $('panel');
  panel?.classList.add('show');
  panel?.classList.add('session-pending');
  $('fan')?.classList.add('picked');

  setText($('ticketNo'), `Request #${requestId.toString()}`);
  setText($('prompt'), 'Ticket printing…');
  const amtEl = $('prizeAmt');
  if (amtEl) {
    amtEl.textContent = '…';
    amtEl.className = 'amt';
  }
  setText($('prizeLbl'), 'Waiting for randomness');
  lockFoilWaiting();
  setReassure(false);

  if (state.reassureTimer) clearTimeout(state.reassureTimer);
  state.reassureTimer = setTimeout(() => {
    if (state.session.phase === PHASE.PENDING) setReassure(true);
  }, 30_000);
}

async function enterReadyUI(asset, amount) {
  state.session.phase = PHASE.READY;
  clearSessionTimers();
  const panel = $('panel');
  panel?.classList.remove('session-pending');
  panel?.classList.add('show');
  setReassure(false);
  show($('pendingRescue'), false);
  show($('rescueBtn'), false);

  const isWin =
    asset &&
    asset.toLowerCase() !== zeroAddress.toLowerCase() &&
    amount &&
    amount > 0n;

  if (!isWin) {
    const amtEl = $('prizeAmt');
    if (amtEl) {
      amtEl.textContent = 'Not this time';
      amtEl.className = 'amt';
    }
    setText($('prizeLbl'), 'Same time tomorrow');
    state.currentWin = false;
  } else {
    const meta = await tokenMeta(asset);
    const label = `+${formatHuman(amount, meta.decimals)} ${meta.symbol}`;
    const amtEl = $('prizeAmt');
    if (amtEl) {
      amtEl.textContent = label;
      amtEl.className = 'amt ' + (meta.kind === 'stock' ? 'gold' : 'win');
    }
    setText($('prizeLbl'), 'Paid to your wallet');
    state.currentWin = true;
  }

  const claimBtn = $('claimBtn');
  if (claimBtn) {
    claimBtn.textContent = state.currentWin ? 'Already sent · done' : 'Done';
    claimBtn.disabled = false;
  }

  setText($('prompt'), 'Scratch to reveal');
  unlockFoilForScratch();
}

function enterRevealedUI() {
  state.session.phase = PHASE.REVEALED;
  $('panel')?.classList.remove('session-pending');
}

function canScratchInput() {
  if (state.mode === 'demo') return true;
  return state.session.phase === PHASE.READY && !revealed;
}

async function applySettledPrize(asset, amount) {
  if (
    state.session.phase !== PHASE.PENDING &&
    state.session.phase !== PHASE.PICKED &&
    state.session.phase !== PHASE.READY
  ) {
    return;
  }
  await enterReadyUI(asset, amount);
}

async function pollRequest(requestId) {
  clearInterval(state.pollTimer);
  state.pendingRequestId = requestId;

  const check = async () => {
    if (state.session.phase !== PHASE.PENDING && state.session.phase !== PHASE.PICKED) {
      return;
    }
    try {
      const req = await publicClient.readContract({
        address: addr.game,
        abi: ABI_GAME,
        functionName: 'requests',
        args: [requestId],
      });
      const status = Number(req.status ?? req[3]);
      const requestedAt = BigInt(req.requestedAt ?? req[2]);
      state.session.requestedAt = requestedAt;
      const now = BigInt(Math.floor(Date.now() / 1000));

      if (status === STATUS.Settled) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        let asset = zeroAddress;
        let amount = 0n;
        const tip = await publicClient.getBlockNumber();
        const lookback = 900_000n;
        const from = tip > lookback ? tip - lookback : 0n;
        for (let start = tip; start >= from; ) {
          const chunkFrom =
            start + 1n > CONFIG.logChunkBlocks
              ? start + 1n - CONFIG.logChunkBlocks
              : from;
          const clampedFrom = chunkFrom < from ? from : chunkFrom;
          try {
            const recent = await publicClient.getLogs({
              address: addr.game,
              event: EVENT_SCRATCH_SETTLED,
              args: { requestId },
              fromBlock: clampedFrom,
              toBlock: start,
            });
            if (recent.length) {
              asset = recent[recent.length - 1].args.asset;
              amount = recent[recent.length - 1].args.amount;
              break;
            }
          } catch {
            /* try older chunk */
          }
          if (clampedFrom <= from) break;
          start = clampedFrom - 1n;
        }
        await applySettledPrize(asset, amount);
        await refreshWalletPanel({ skipStage: true });
        return;
      }

      if (status === STATUS.Rescued) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        setText($('prizeAmt'), 'Rescued');
        setText($('prizeLbl'), 'Ticket refunded');
        setText($('prompt'), 'Ticket returned to your balance');
        show($('rescueBtn'), false);
        setReassure(false);
        await refreshWalletPanel({ skipStage: true });
        resetSessionToIdle({ keepNote: true });
        setSessionNote('Ticket rescued — refunded to your balance.');
        return;
      }

      if (status === STATUS.Pending) {
        if (state.session.phase !== PHASE.PENDING) {
          enterPendingUI(requestId, requestedAt);
        }
        const due = now >= requestedAt + state.rescueDelay;
        show($('pendingRescue'), due);
        show($('rescueBtn'), due);
        const rescueBtn = $('rescueBtn');
        if (rescueBtn) {
          rescueBtn.onclick = () => rescueRequest(requestId);
        }
      }
    } catch (err) {
      setText($('prizeLbl'), err?.shortMessage || err?.message || 'Poll error');
    }
  };

  await check();
  state.pollTimer = setInterval(check, 2000);

  try {
    state.eventUnwatch = publicClient.watchContractEvent({
      address: addr.game,
      abi: [EVENT_SCRATCH_SETTLED],
      eventName: 'ScratchSettled',
      args: { requestId },
      onLogs: async (logs) => {
        for (const log of logs) {
          if (log.args.requestId === requestId) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
            try {
              state.eventUnwatch?.();
            } catch {
              /* ignore */
            }
            state.eventUnwatch = null;
            await applySettledPrize(log.args.asset, log.args.amount);
            await refreshWalletPanel({ skipStage: true });
          }
        }
      },
    });
  } catch {
    /* polling is enough */
  }
}

async function rescueRequest(requestId) {
  try {
    await ensureChain();
    setText($('prizeLbl'), 'Confirm rescue in wallet…');
    const hash = await state.walletClient.writeContract({
      address: addr.game,
      abi: ABI_GAME,
      functionName: 'rescue',
      args: [requestId],
      account: state.account,
      chain: robinhoodChain,
    });
    setText($('prizeLbl'), 'Rescue submitted…');
    await publicClient.waitForTransactionReceipt({ hash });
    setText($('prizeLbl'), 'Ticket refunded');
    setText($('prizeAmt'), 'Rescued');
    show($('rescueBtn'), false);
    await refreshWalletPanel({ skipStage: true });
    resetSessionToIdle({ keepNote: true });
    setSessionNote('Ticket rescued — refunded to your balance.');
  } catch (err) {
    setText(
      $('prizeLbl'),
      `Rescue failed: ${err?.shortMessage || err?.message || String(err)}`,
    );
  }
}

function extractRequestId(receipt) {
  for (const log of receipt.logs || []) {
    try {
      const decoded = decodeEventLog({
        abi: [EVENT_SCRATCH_REQUESTED],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'ScratchRequested') {
        return decoded.args.requestId;
      }
    } catch {
      /* not our event */
    }
  }
  return null;
}

function isUserRejection(err) {
  const msg = `${err?.shortMessage || ''} ${err?.message || ''} ${err?.code || ''}`;
  return (
    err?.code === 4001 ||
    err?.code === 'ACTION_REJECTED' ||
    /user rejected|denied|rejected the request|user cancelled/i.test(msg)
  );
}

async function startLiveScratch(tierOverride) {
  if (stageBusy()) return;

  const tier = tierOverride != null ? tierOverride : activeChainTier();
  const tierKey = tier === TIER_STD ? 'std' : 'prem';

  if (!window.ethereum) {
    alert('Connect a wallet to scratch live tickets.');
    return;
  }
  if (!state.account) {
    await connectWallet();
    if (!state.account) return;
  }

  const tickets =
    tier === TIER_STD ? state.liveTickets.std : state.liveTickets.prem;
  if (tickets < CONFIG.ticketCost) {
    alert('No tickets on this tier.');
    return;
  }

  enterPickedUI(tier, tierKey);

  try {
    await ensureChain();

    const hash = await state.walletClient.writeContract({
      address: addr.game,
      abi: ABI_GAME,
      functionName: 'scratch',
      args: [tier],
      account: state.account,
      chain: robinhoodChain,
    });

    setText($('prompt'), 'Ticket printing…');
    setText($('prizeLbl'), 'Submitted — waiting for confirmation…');

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    let requestId = extractRequestId(receipt);
    if (requestId == null) {
      const logs = await publicClient.getLogs({
        address: addr.game,
        event: EVENT_SCRATCH_REQUESTED,
        args: { user: state.account },
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });
      if (logs.length) requestId = logs[logs.length - 1].args.requestId;
    }
    if (requestId == null) {
      setText($('prizeLbl'), 'Could not find request id in receipt');
      resetSessionToIdle({
        cancelNote:
          'Something went wrong finding the request — check your wallet activity.',
      });
      return;
    }

    enterPendingUI(requestId);
    await refreshWalletPanel({ skipStage: true });
    await pollRequest(requestId);
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    if (isUserRejection(err)) {
      resetSessionToIdle({ cancelNote: 'Cancelled — ticket unspent.' });
      return;
    }
    resetSessionToIdle({ cancelNote: `Scratch failed: ${msg}` });
  }
}

function onCardPick() {
  if (state.mode === 'live' && stageBusy()) return;
  if (activeTierTickets() <= 0) return;
  if (state.mode === 'demo') {
    startDemoScratch();
  } else {
    startLiveScratch();
  }
}

/** Find newest Pending ScratchRequested for connected wallet and rehydrate. */
async function rehydratePendingSession() {
  if (!state.account || state.mode !== 'live' || stageBusy()) return;
  try {
    const tip = await publicClient.getBlockNumber();
    const lookbackBlocks = BigInt(
      Math.min(Math.ceil((CONFIG.winsLookbackSec * 2) / 0.1), 1_000_000),
    );
    const fromBlock = tip > lookbackBlocks ? tip - lookbackBlocks : 0n;
    let newest = null;

    for (let start = fromBlock; start <= tip; start += CONFIG.logChunkBlocks) {
      const end =
        start + CONFIG.logChunkBlocks - 1n > tip
          ? tip
          : start + CONFIG.logChunkBlocks - 1n;
      let logs = [];
      try {
        logs = await publicClient.getLogs({
          address: addr.game,
          event: EVENT_SCRATCH_REQUESTED,
          args: { user: state.account },
          fromBlock: start,
          toBlock: end,
        });
      } catch {
        continue;
      }
      for (const log of logs) {
        const requestId = log.args.requestId;
        if (requestId == null) continue;
        try {
          const req = await publicClient.readContract({
            address: addr.game,
            abi: ABI_GAME,
            functionName: 'requests',
            args: [requestId],
          });
          const status = Number(req.status ?? req[3]);
          if (status === STATUS.Pending) {
            newest = {
              requestId,
              tier: Number(req.tier ?? req[1]),
              requestedAt: BigInt(req.requestedAt ?? req[2]),
            };
          }
        } catch {
          /* skip */
        }
      }
    }

    if (!newest) return;

    const tierKey = newest.tier === TIER_PREM ? 'prem' : 'std';
    state.tier = tierKey;
    state.session.tier = newest.tier;
    state.session.tierKey = tierKey;
    const stage = $('stage');
    stage?.classList.toggle('premium', tierKey === 'prem');
    $('scratchCardEl')?.classList.toggle('premium', tierKey === 'prem');
    enterPendingUI(newest.requestId, newest.requestedAt);
    setSessionNote('Resumed a pending draw from your wallet.');
    await pollRequest(newest.requestId);
  } catch (err) {
    console.warn('rehydrate pending', err);
  }
}

/* -------------------------------------------------------------------------- */
/* Stake / withdraw                                                            */
/* -------------------------------------------------------------------------- */

async function doStake() {
  const input = $('stakeAmount');
  const pathInput = $('stakeAmountPath');
  const status = $('stakeStatus');
  if (!state.account) {
    await connectWallet();
    if (!state.account) return;
  }
  const raw = ((input?.value || pathInput?.value || '')).trim();
  if (!raw || Number(raw) <= 0) {
    setStatus(status, 'Enter an amount');
    return;
  }
  try {
    await ensureChain();
    const amount = parseUnits(raw, 18);
    setStatus(status, 'Checking allowance…');
    const allowance = await publicClient.readContract({
      address: addr.scratch,
      abi: ABI_ERC20,
      functionName: 'allowance',
      args: [state.account, addr.staking],
    });
    if (allowance < amount) {
      setStatus(status, 'Approve SCRATCH in wallet…');
      const approveHash = await state.walletClient.writeContract({
        address: addr.scratch,
        abi: ABI_ERC20,
        functionName: 'approve',
        args: [addr.staking, amount],
        account: state.account,
        chain: robinhoodChain,
      });
      setStatus(status, 'Waiting for approval…');
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }
    setStatus(status, 'Confirm stake in wallet…');
    const hash = await state.walletClient.writeContract({
      address: addr.staking,
      abi: ABI_STAKING,
      functionName: 'deposit',
      args: [amount],
      account: state.account,
      chain: robinhoodChain,
    });
    setStatus(status, 'Staking…');
    await publicClient.waitForTransactionReceipt({ hash });
    setStatus(status, 'Staked ✓');
    input.value = '';
    await refreshWalletPanel();
  } catch (err) {
    setStatus(status, err?.shortMessage || err?.message || String(err));
  }
}

async function doWithdraw() {
  const input = $('withdrawAmount');
  const warn = $('withdrawWarn');
  if (!input) return;
  if (!state.account) {
    await connectWallet();
    if (!state.account) return;
  }

  const warning =
    'Any withdrawal burns ALL your staking tickets — pending and banked. This cannot be undone. Continue?';
  if (warn) warn.textContent = warning;
  if (!confirm(warning)) return;

  const raw = (input.value || '').trim();
  if (!raw || Number(raw) <= 0) {
    if (warn) warn.textContent = 'Enter an amount';
    return;
  }
  try {
    await ensureChain();
    const amount = parseUnits(raw, 18);
    if (warn) warn.textContent = 'Confirm withdraw in wallet…';
    const hash = await state.walletClient.writeContract({
      address: addr.staking,
      abi: ABI_STAKING,
      functionName: 'withdraw',
      args: [amount],
      account: state.account,
      chain: robinhoodChain,
    });
    if (warn) warn.textContent = 'Withdrawing…';
    await publicClient.waitForTransactionReceipt({ hash });
    if (warn) {
      warn.textContent =
        'Withdrawn. All staking tickets (pending + banked) were burned.';
    }
    input.value = '';
    await refreshWalletPanel();
  } catch (err) {
    if (warn) warn.textContent = err?.shortMessage || err?.message || String(err);
  }
}

/* -------------------------------------------------------------------------- */
/* Wallet-free refresh                                                         */
/* -------------------------------------------------------------------------- */

async function refreshPublic() {
  try {
    await refreshPrices();
  } catch {
    /* ignore */
  }
  try {
    const delay = await publicClient.readContract({
      address: addr.game,
      abi: ABI_GAME,
      functionName: 'rescueDelay',
    });
    state.rescueDelay = BigInt(delay);
  } catch {
    /* keep default */
  }
  try {
    await refreshMinStake();
  } catch {
    /* ignore */
  }
  try {
    await Promise.all([loadPrizeTable(0), loadPrizeTable(1)]);
    await Promise.all([
      renderPrizeList(0, 'prizeListStd'),
      renderPrizeList(1, 'prizeListPrem'),
    ]);
  } catch (err) {
    console.warn('prize tables', err);
  }
  try {
    await renderVaultInventory();
  } catch {
    /* ignore */
  }
  try {
    await loadRecentWins();
  } catch {
    /* ignore */
  }
  if (state.account) {
    try {
      await refreshWalletPanel();
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Init                                                                        */
/* -------------------------------------------------------------------------- */

function wireUi() {
  $('tabStd')?.addEventListener('click', () => {
    if (stageBusy() && state.mode === 'live') return;
    state.tier = 'std';
    renderTier();
  });
  $('tabPrem')?.addEventListener('click', () => {
    if (stageBusy() && state.mode === 'live') return;
    state.tier = 'prem';
    renderTier();
  });

  $('fan')?.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('click', onCardPick);
  });

  $('againBtn')?.addEventListener('click', () => {
    if (state.mode !== 'demo') return;
    state.demoTickets[state.tier] = (state.demoTickets[state.tier] || 0) + 1;
    saveDemoTickets();
    renderTier();
    resetScratch();
  });

  $('claimBtn')?.addEventListener('click', function () {
    if (state.mode === 'live') {
      resetSessionToIdle();
      return;
    }
    this.textContent = 'Claimed ✓';
    this.disabled = true;
    setTimeout(() => {
      this.textContent = 'Claim reward';
      this.disabled = false;
    }, 2600);
  });

  const connectBtn = $('connectBtn');
  if (connectBtn) {
    connectBtn.style.minHeight = '44px';
    connectBtn.addEventListener('click', () => {
      if (connectBtn.dataset.connected) disconnectOrCopy();
      else connectWallet();
    });
  }

  $('playModeDemo')?.addEventListener('click', (e) => {
    e.preventDefault();
    setMode(state.mode === 'demo' ? 'live' : 'demo');
  });

  $('stakeBtn')?.addEventListener('click', doStake);
  $('stakeBtnPath')?.addEventListener('click', () => {
    const pathAmt = $('stakeAmountPath');
    const mainAmt = $('stakeAmount');
    if (pathAmt && mainAmt && pathAmt.value && !mainAmt.value) mainAmt.value = pathAmt.value;
    else if (pathAmt && mainAmt) mainAmt.value = pathAmt.value || mainAmt.value;
    doStake();
  });
  $('withdrawBtn')?.addEventListener('click', doWithdraw);

  $('scratchBtnStd')?.addEventListener('click', () => {
    state.tier = 'std';
    renderTier();
    if (state.mode === 'demo') startDemoScratch();
    else startLiveScratch(TIER_STD);
  });
  $('scratchBtnStdPath')?.addEventListener('click', () => {
    state.tier = 'std';
    renderTier();
    if (state.mode === 'demo') startDemoScratch();
    else startLiveScratch(TIER_STD);
  });
  $('scratchBtnPrem')?.addEventListener('click', () => {
    state.tier = 'prem';
    renderTier();
    if (state.mode === 'demo') startDemoScratch();
    else startLiveScratch(TIER_PREM);
  });

  // Withdraw warning copy (static)
  const warn = $('withdrawWarn');
  if (warn && !warn.textContent.trim()) {
    warn.textContent =
      'Warning: any withdrawal burns all staking tickets (pending and banked).';
  }

  injectFairnessNote();

  // Referral helpers if present
  $('copyBtn')?.addEventListener('click', function () {
    const code = $('refCode')?.textContent?.trim();
    if (code && navigator.clipboard) navigator.clipboard.writeText(code);
    this.textContent = 'Copied ✓';
    setTimeout(() => {
      this.textContent = 'Copy';
    }, 1800);
  });
  $('applyBtn')?.addEventListener('click', () => {
    const v = $('refInput')?.value?.trim() || '';
    const msg = $('enterMsg');
    if (/^SCRTCH-[A-Z0-9]{4}$/i.test(v)) {
      if (msg) {
        msg.textContent = 'Code applied — buy $100+ through the site to start the clock.';
        msg.style.color = 'var(--green-dark)';
      }
    } else if (msg) {
      msg.textContent = 'Codes look like SCRTCH-XXXX.';
      msg.style.color = '#B04A3A';
    }
  });

  if (window.ethereum) {
    window.ethereum.on?.('accountsChanged', (accs) => {
      if (!accs?.length) {
        state.account = null;
        state.walletClient = null;
        const btn = $('connectBtn');
        if (btn) {
          btn.textContent = 'Connect';
          delete btn.dataset.connected;
        }
      } else {
        state.account = getAddress(accs[0]);
        state.walletClient = createWalletClient({
          account: state.account,
          chain: robinhoodChain,
          transport: custom(window.ethereum),
        });
        const btn = $('connectBtn');
        if (btn) {
          btn.textContent = shortAddr(state.account);
          btn.dataset.connected = '1';
        }
        refreshWalletPanel();
      }
    });
    window.ethereum.on?.('chainChanged', () => {
      /* soft refresh */
      refreshWalletPanel();
    });
  }

  // Expiry / next-ticket countdown
  setInterval(() => {
    if (state.userExpiry > 0n && state.account && state.mode === 'live') {
      const now = Math.floor(Date.now() / 1000);
      const remain = Math.max(0, Number(state.userExpiry) - now);
      state.expirySec = remain;
      const str = formatCountdown(remain);
      setText($('nextTicket'), remain > 0 ? str : '—');
      setText($('accrueTimer'), remain > 0 ? str : '—');
      setText($('walletExpiry'), str);
    } else if (state.mode === 'demo') {
      // soft demo timer
      if (!state._demoSecs) state._demoSecs = 2 * 3600 + 12 * 60 + 44;
      state._demoSecs = state._demoSecs > 0 ? state._demoSecs - 1 : 86400;
      const str = formatCountdown(state._demoSecs);
      setText($('nextTicket'), str);
      setText($('accrueTimer'), str);
    }
  }, 1000);
}

function init() {
  wireCanvas();
  wireUi();
  setMode('live');
  // Hide again button in live by default
  const again = $('againBtn');
  if (again) again.style.display = 'none';
  renderTier();
  refreshPublic().then(() => rehydratePendingSession());
  state.refreshTimer = setInterval(refreshPublic, CONFIG.refreshMs);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
