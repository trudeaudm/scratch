/**
 * $SCRATCH live site — ES module (viem via esm.sh).
 * Wire from index.html: <script type="module" src="./app.js?v=…"></script>
 * Bump ASSET_VERSION (and the index.html ?v=) on every site/ commit.
 */
export const ASSET_VERSION = 'wallet-6963-1';

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
    USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // seeded; overwritten by tokens.json
    SPCX: '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea', // seeded; overwritten by tokens.json
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
    name: 'emissionRate',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'totalStaked',
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

const EVENT_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

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

/** Populated from `./tokens.json` at boot — shared with dashboard. */
let TOKEN_LIST = [];
/** address(lowercase) → { symbol, decimals, kind, ticker?, preferredPair?, price?, name? } */
let KNOWN_TOKENS = {};

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
/* Shared token config (site/tokens.json)                                      */
/* -------------------------------------------------------------------------- */

async function loadTokenConfig() {
  const res = await fetch(`./tokens.json?v=${ASSET_VERSION}`);
  if (!res.ok) throw new Error(`tokens.json ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('tokens.json must be an array');

  TOKEN_LIST = list;
  const next = {};
  for (const t of list) {
    if (!t?.address || !t?.symbol) continue;
    const key = String(t.address).toLowerCase();
    next[key] = {
      symbol: String(t.symbol),
      decimals: Number(t.decimals ?? 18),
      kind: t.kind === 'stock' ? 'stock' : t.kind || 'crypto',
      ticker: t.ticker,
      name: t.name,
      price: t.price,
      preferredPair: t.preferredPair || null,
    };
    const sym = String(t.symbol).toUpperCase();
    if (sym === 'SCRATCH') CONFIG.addresses.SCRATCH = getAddress(t.address);
    if (sym === 'USDG') CONFIG.addresses.USDG = getAddress(t.address);
    if (sym === 'SPCX') CONFIG.addresses.SPCX = getAddress(t.address);
    if (sym === 'WETH') {
      /* priced via preferredPair / DexScreener; no CONFIG slot required */
    }
  }
  KNOWN_TOKENS = next;
  addr.scratch = getAddress(CONFIG.addresses.SCRATCH);
  addr.usdg = getAddress(CONFIG.addresses.USDG);
  addr.spcx = getAddress(CONFIG.addresses.SPCX);
}

/* -------------------------------------------------------------------------- */
/* DOM                                                                         */
/* -------------------------------------------------------------------------- */

function $(id) {
  return document.getElementById(id);
}

function setText(el, text) {
  if (el) el.textContent = text;
}

const WALLET_REJECT_TOAST =
  "Request declined in your wallet. If you didn't mean to: retry and approve the 'Add Robinhood Chain' prompt — and if you use multiple wallet extensions, make sure the right one responded.";

/** Non-blocking toast. kind: '' | 'warn' | 'error' */
function showToast(message, opts = {}) {
  const host = $('toastHost');
  if (!host || !message) return;
  const el = document.createElement('div');
  el.className = 'toast' + (opts.kind ? ` ${opts.kind}` : '');
  el.setAttribute('role', 'status');
  el.textContent = message;
  host.appendChild(el);
  const ms = opts.duration ?? (opts.kind === 'warn' || opts.kind === 'error' ? 7000 : 4500);
  const dismiss = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  el.addEventListener('click', dismiss);
  setTimeout(dismiss, ms);
}

function toastWalletError(err, fallback) {
  if (isUserRejection(err)) {
    showToast(WALLET_REJECT_TOAST, { kind: 'warn', duration: 9000 });
    return;
  }
  const msg = err?.shortMessage || err?.message || fallback || String(err);
  showToast(msg, { kind: 'error' });
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

function formatScratchWhole(amount) {
  const n = Number(formatUnits(amount ?? 0n, 18));
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

function minStakePretty() {
  return Number(formatUnits(state.minStake, 18)).toLocaleString('en-US', {
    maximumFractionDigits: 0,
  });
}

function ticketCount(raw) {
  return Number(raw / CONFIG.ticketCost);
}

/** Format ticket-wei as whole.fraction (e.g. 2.45) with whole part emphasized in HTML. */
function formatTicketBalanceHtml(raw) {
  const n = Number(formatUnits(raw ?? 0n, 18));
  if (!Number.isFinite(n) || n <= 0) {
    return '<span class="tk-whole">0</span><span class="tk-frac">.00</span>';
  }
  const fixed = n.toFixed(2);
  const [whole, frac] = fixed.split('.');
  const wholePretty = Number(whole).toLocaleString('en-US');
  return `<span class="tk-whole">${wholePretty}</span><span class="tk-frac">.${frac}</span>`;
}

function updateStakedTicketsTip() {
  const tip = $('stakedTicketsTipText');
  if (!tip) return;
  tip.textContent = `Tickets accrue continuously while you stake ${minStakePretty()}+. Whole tickets are scratchable. All staking tickets are burned if you withdraw any stake.`;
}

/** Eligible for staked-tier accrual (same rule as StakingVault). */
function isStakeEligible(staked = state.userStaked) {
  return staked >= state.minStake && staked !== 0n;
}

/**
 * Seconds until the next whole staked ticket at the user's current share of emissions.
 * remaining = 1e18 − fractional(pending+banked); rate = emissionRate × stake / totalStaked.
 */
function computeStakeNextTicketSec() {
  const staked = state.userStaked ?? 0n;
  const total = state.totalStaked ?? 0n;
  const emission = state.emissionRate ?? 0n;
  if (!isStakeEligible(staked) || total === 0n || emission === 0n) return null;

  const tickets = state.liveTickets.prem ?? 0n;
  const frac = tickets % CONFIG.ticketCost;
  const remaining = CONFIG.ticketCost - frac;
  const userRate = (emission * staked) / total;
  if (userRate === 0n) return null;

  return Number((remaining + userRate - 1n) / userRate);
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
  /** @type {{ requestId: string, txHash: string|null, sharePrize: string, cardPrize: string, tierKey: string }|null} */
  lastWin: null,
  pendingRequestId: null,
  rescueDelay: 24n * 60n * 60n,
  minStake: 1_000_000n * 10n ** 18n,
  emissionRate: 0n,
  totalStaked: 0n,
  userStaked: 0n,
  scratchBalance: 0n,
  prices: {
    scratchUsd: null,
    ethUsd: null,
    spcxUsd: null,
    byToken: {},
  },
  liveTickets: { std: 0n, prem: 0n },
  demoTickets: loadDemoTickets(),
  prizeTables: { 0: [], 1: [] },
  /** Incremental recent-wins feed — never cleared wholesale on refresh. */
  winsFeed: {
    /** @type {Map<string, { user: string, asset: string, amount: bigint, blockNumber: bigint, requestId: bigint, ageSec: number, prizeLabel?: string }>} */
    byId: new Map(),
    /** @type {bigint|null} */
    lastSeenBlock: null,
    bootstrapped: false,
    inFlight: false,
  },
  drawing: false,
  pollTimer: null,
  refreshTimer: null,
  reassureTimer: null,
  eventUnwatch: null,
  transferUnwatch: null,
  expirySec: 0,
  userExpiry: 0n,
  _stakeNextSecs: null,
  session: {
    phase: PHASE.IDLE,
    requestId: null,
    tier: TIER_STD,
    tierKey: 'std',
    startedAt: 0,
    optimisticDelta: 0,
    /** Ticket-wei balance snapshot at pick — used to know when chain reflects the spend. */
    ticketsAtPick: null,
    requestedAt: 0n,
  },
};

function stageBusy() {
  return state.session.phase !== PHASE.IDLE;
}

function sessionPhase() {
  return state.session.phase;
}

/** Active scratch in flight (not idle, not post-reveal). */
function sessionInFlight() {
  const p = sessionPhase();
  return p === PHASE.PICKED || p === PHASE.PENDING || p === PHASE.READY;
}

/* -------------------------------------------------------------------------- */
/* Session authority — single dispatch for every scratch control               */
/* -------------------------------------------------------------------------- */

const ACTION = {
  SELECT_TIER: 'SELECT_TIER',
  QUICK_SCRATCH: 'QUICK_SCRATCH',
  PICK_CARD: 'PICK_CARD',
  SCRATCH_ANOTHER: 'SCRATCH_ANOTHER',
  DISCONNECT: 'DISCONNECT',
};

/**
 * Sole entry point for scratch-related UI actions.
 * Controls must not branch on their own copy of phase — call this, then applySessionView().
 */
async function sessionDispatch(action, payload = {}) {
  switch (action) {
    case ACTION.SELECT_TIER:
      await dispatchSelectTier(payload.tierKey);
      break;
    case ACTION.QUICK_SCRATCH:
      await dispatchQuickScratch(payload.tierKey);
      break;
    case ACTION.PICK_CARD:
      await dispatchPickCard();
      break;
    case ACTION.SCRATCH_ANOTHER:
      dispatchScratchAnother();
      break;
    case ACTION.DISCONNECT:
      dispatchDisconnect();
      break;
    default:
      console.warn('sessionDispatch: unknown action', action);
  }
  applySessionView();
}

async function dispatchSelectTier(tierKey) {
  if (tierKey !== 'std' && tierKey !== 'prem') return;
  if (state.mode === 'live' && sessionInFlight()) return;
  if (state.mode === 'live' && sessionPhase() === PHASE.REVEALED) {
    resetSessionToIdle({ keepNote: true });
  }
  state.tier = tierKey;
  if (sessionPhase() === PHASE.IDLE) renderTier();
}

async function dispatchQuickScratch(tierKey) {
  if (tierKey !== 'std' && tierKey !== 'prem') return;
  if (state.mode === 'live' && sessionInFlight()) return;

  if (state.mode === 'live' && sessionPhase() === PHASE.REVEALED) {
    resetSessionToIdle({ keepNote: true });
  }

  state.tier = tierKey;
  if (sessionPhase() === PHASE.IDLE) renderTier();

  if (state.mode === 'demo') {
    startDemoScratch();
    return;
  }
  await startLiveScratch(tierKey === 'prem' ? TIER_PREM : TIER_STD);
}

async function dispatchPickCard() {
  if (state.mode === 'live' && sessionPhase() !== PHASE.IDLE) return;
  if (activeTierTickets() <= 0) return;
  if (state.mode === 'demo') startDemoScratch();
  else await startLiveScratch();
}

function dispatchScratchAnother() {
  if (state.mode !== 'live') return;
  if (sessionPhase() !== PHASE.REVEALED) return;
  resetSessionToIdle();
}

function dispatchDisconnect() {
  clearSessionTimers();
  state.account = null;
  state.walletClient = null;
  state.userStaked = 0n;
  state.scratchBalance = 0n;
  state.liveTickets = { std: 0n, prem: 0n };
  state._stakeNextSecs = null;
  stopScratchTransferWatch();
  const btn = $('connectBtn');
  if (btn) {
    btn.textContent = 'Connect';
    delete btn.dataset.connected;
  }
  const panel = $('walletPanel');
  if (panel) panel.hidden = true;
  updateStakeFormBalances();
  resetSessionToIdle({ keepNote: true });
  setSessionNote('Wallet disconnected.');
}

/** Sync every scratch control from the single session phase + ticket counts. */
function applySessionView() {
  const phase = sessionPhase();
  const live = state.mode === 'live';
  const inFlight = live && sessionInFlight();
  const t = activeTier();

  const tabStd = $('tabStd');
  const tabPrem = $('tabPrem');
  if (tabStd) {
    tabStd.disabled = inFlight;
    tabStd.classList.toggle('active', state.tier === 'std');
    tabStd.setAttribute('aria-selected', String(state.tier === 'std'));
  }
  if (tabPrem) {
    tabPrem.disabled = inFlight;
    tabPrem.classList.toggle('active', state.tier === 'prem');
    tabPrem.setAttribute('aria-selected', String(state.tier === 'prem'));
  }

  const quickOk = (tierKey) => {
    if (inFlight) return false;
    if (state.mode === 'demo') return (tierKey === 'std' ? t.std : t.prem) >= 1;
    if (!state.account) return false;
    return (tierKey === 'std' ? t.std : t.prem) >= 1;
  };
  const stdBtn = $('scratchBtnStd');
  const premBtn = $('scratchBtnPrem');
  const stdPath = $('scratchBtnStdPath');
  if (stdBtn) stdBtn.disabled = !quickOk('std');
  if (premBtn) premBtn.disabled = !quickOk('prem');
  if (stdPath) stdPath.disabled = !quickOk('std');

  setText($('cntStd'), String(t.std));
  setText($('cntPrem'), String(t.prem));

  const fan = $('fan');
  if (phase === PHASE.IDLE) {
    const locked = activeTierTickets() <= 0;
    fan?.classList.toggle('locked', locked);
    fan?.classList.remove('picked');
  }

  if (phase === PHASE.IDLE || phase === PHASE.REVEALED) {
    renderStageFooter();
  } else {
    clearStageFooter();
  }

  if (phase === PHASE.REVEALED) {
    renderPostRevealAction();
  }
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
  // Keep deducting the in-flight scratch until ticketsOf drops below the pick snapshot.
  if (state.session.optimisticDelta > 0) {
    if (state.session.tierKey === 'std') std = Math.max(0, std - state.session.optimisticDelta);
    else prem = Math.max(0, prem - state.session.optimisticDelta);
  }
  return { std, prem };
}

/** Spendable whole tickets on a tier (floor), honoring in-flight optimistic spend. */
function spendableOnTier(tierKey) {
  const t = activeTier();
  return tierKey === 'std' ? t.std : t.prem;
}

function activeTierTickets() {
  // Post-reveal / in-flight must use the session's scratched tier, not a tab that changed underneath.
  const tierKey =
    sessionPhase() !== PHASE.IDLE ? state.session.tierKey || state.tier : state.tier;
  return spendableOnTier(tierKey);
}

/** Clear optimistic spend only once chain balance is below the pick-time snapshot. */
function reconcileOptimisticSpend() {
  if (state.session.optimisticDelta <= 0) return;
  if (state.session.ticketsAtPick == null) {
    state.session.optimisticDelta = 0;
    return;
  }
  const key = state.session.tierKey === 'prem' ? 'prem' : 'std';
  if (state.liveTickets[key] < state.session.ticketsAtPick) {
    state.session.optimisticDelta = 0;
    state.session.ticketsAtPick = null;
  }
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
  const byToken = { ...state.prices.byToken };
  const scratchUsd = await fetchPairUsd(CONFIG.dex.chainId, CONFIG.dex.pairAddress);
  state.prices.scratchUsd = scratchUsd;
  byToken[CONFIG.addresses.SCRATCH.toLowerCase()] = scratchUsd;

  for (const t of TOKEN_LIST) {
    const key = String(t.address).toLowerCase();
    if (t.price === 'usdg') {
      byToken[key] = 1;
      continue;
    }
    if (t.price === 'scratch') {
      byToken[key] = scratchUsd;
      continue;
    }
    let px = null;
    if (t.preferredPair?.chainId && t.preferredPair?.pairAddress) {
      px = await fetchPairUsd(t.preferredPair.chainId, t.preferredPair.pairAddress);
    }
    if (px == null) px = await fetchTokenUsd(t.address);
    if (px != null) byToken[key] = px;
    if (String(t.symbol).toUpperCase() === 'SPCX') state.prices.spcxUsd = px;
    if (t.price === 'eth') state.prices.ethUsd = px;
  }

  state.prices.byToken = byToken;
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
  const known = KNOWN_TOKENS[key];
  if (known?.price === 'usdg') {
    state.prices.byToken[key] = 1;
    return 1;
  }
  if (known?.preferredPair?.chainId && known?.preferredPair?.pairAddress) {
    const pinned = await fetchPairUsd(
      known.preferredPair.chainId,
      known.preferredPair.pairAddress,
    );
    if (pinned != null) {
      state.prices.byToken[key] = pinned;
      return pinned;
    }
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
  // Assign only after a full successful read — never wipe prior tables mid-refresh.
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
    // Loading placeholder only before the first successful paint.
    if (!el.dataset.filled) {
      el.innerHTML = '<div class="prize-row"><span class="p">Loading prize table…</span></div>';
    }
    return;
  }

  try {
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
    el.dataset.filled = '1';
  } catch (err) {
    // Keep last good paint — stale odds beat a blank/loading panel.
    if (!el.dataset.filled) {
      el.innerHTML = `<div class="prize-row"><span class="p">Prize table unavailable</span></div>`;
    }
    console.warn('prize list', tier, err);
  }
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
      if (meta.kind === 'stock') {
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
    el.dataset.filled = '1';
  } catch (err) {
    // Keep last good inventory — never blank the panel on a failed refresh.
    if (!el.dataset.filled) {
      el.innerHTML = `<div class="inv-row muted">Inventory unavailable: ${escapeHtml(
        err?.shortMessage || err?.message || String(err),
      )}</div>`;
    }
    console.warn('vault inventory', err);
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
    const pretty = minStakePretty();

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
    updateStakedTicketsTip();
    if (
      state.account &&
      (sessionPhase() === PHASE.IDLE || sessionPhase() === PHASE.REVEALED)
    ) {
      renderStageFooter();
    }
  } catch {
    /* keep previous */
  }
}

/* -------------------------------------------------------------------------- */
/* Recent wins — incremental keep-and-merge (keyed by requestId)               */
/* -------------------------------------------------------------------------- */

function winsLookbackBlocks() {
  // ~0.1s blocks → ~864_000 blocks / 24h; clamp lookback
  return BigInt(Math.min(Math.ceil(CONFIG.winsLookbackSec / 0.1), 1_000_000));
}

function pruneWinsOutsideWindow(windowStartBlock) {
  for (const [id, w] of state.winsFeed.byId) {
    if (w.blockNumber < windowStartBlock || w.ageSec > CONFIG.winsLookbackSec) {
      state.winsFeed.byId.delete(id);
    }
  }
}

function refreshWinAges(latestBlock) {
  for (const w of state.winsFeed.byId.values()) {
    w.ageSec = Number(latestBlock - w.blockNumber) * 0.1;
  }
}

function mergeSettledLog(log, newIds) {
  const asset = log.args.asset;
  if (!asset || asset.toLowerCase() === zeroAddress.toLowerCase()) return;
  if (!log.args.amount || log.args.amount === 0n) return;
  const requestId = log.args.requestId;
  if (requestId == null) return;
  const id = requestId.toString();
  const prev = state.winsFeed.byId.get(id);
  if (!prev) newIds.add(id);
  state.winsFeed.byId.set(id, {
    user: log.args.user,
    asset,
    amount: log.args.amount,
    blockNumber: log.blockNumber,
    requestId,
    ageSec: prev?.ageSec ?? 0,
    prizeLabel: prev?.prizeLabel,
  });
}

/**
 * Fetch ScratchSettled logs in [fromBlock, toBlock], merge into winsFeed.byId.
 * Bootstrap tolerates per-chunk failures; incremental fails closed so lastSeen is not advanced.
 * @returns {Promise<Set<string>>} requestIds newly inserted this call
 */
async function fetchWinsRange(fromBlock, toBlock) {
  const newIds = new Set();
  if (fromBlock > toBlock) return newIds;

  const chunks = [];
  for (let start = fromBlock; start <= toBlock; start += CONFIG.logChunkBlocks) {
    const end =
      start + CONFIG.logChunkBlocks - 1n > toBlock
        ? toBlock
        : start + CONFIG.logChunkBlocks - 1n;
    chunks.push({ fromBlock: start, toBlock: end });
  }

  const concurrency = 8;
  let cursor = 0;
  const bootstrap = !state.winsFeed.bootstrapped;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
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
          for (const log of logs) mergeSettledLog(log, newIds);
          if (bootstrap && state.winsFeed.byId.size) {
            refreshWinAges(tb);
            await paintRecentWins({ animateNew: false, newIds: new Set() });
          }
        } catch (err) {
          if (bootstrap) continue;
          throw err;
        }
      }
    }),
  );
  return newIds;
}

async function loadRecentWins() {
  const el = $('recentWins');
  if (!el) return;
  if (state.winsFeed.inFlight) return;
  state.winsFeed.inFlight = true;

  const hadRows = state.winsFeed.byId.size > 0;
  // Loading placeholder may only appear on the very first load when the list is empty.
  if (!hadRows && !state.winsFeed.bootstrapped && !el.querySelector('[data-request-id]')) {
    el.innerHTML = '<div class="win-row muted">Loading recent wins…</div>';
  }

  try {
    const latest = await publicClient.getBlockNumber();
    const lookback = winsLookbackBlocks();
    const windowStart = latest > lookback ? latest - lookback : 0n;

    const incremental =
      state.winsFeed.bootstrapped && state.winsFeed.lastSeenBlock != null;
    let fromBlock = incremental ? state.winsFeed.lastSeenBlock + 1n : windowStart;

    let newIds = new Set();
    if (fromBlock <= latest) {
      newIds = await fetchWinsRange(fromBlock, latest);
    }

    refreshWinAges(latest);
    pruneWinsOutsideWindow(windowStart);
    state.winsFeed.lastSeenBlock = latest;
    state.winsFeed.bootstrapped = true;

    await paintRecentWins({
      animateNew: incremental,
      newIds,
    });
  } catch (err) {
    // Failed refresh: leave existing list untouched; retry next cycle.
    if (!hadRows && state.winsFeed.byId.size === 0) {
      el.innerHTML = `<div class="win-row muted">Could not load wins: ${escapeHtml(
        err?.shortMessage || err?.message || String(err),
      )}</div>`;
    }
    console.warn('recent wins', err);
  } finally {
    state.winsFeed.inFlight = false;
  }
}

/**
 * Sync DOM to winsFeed.byId without clearing the list first.
 * New rows (by requestId) are prepended with a short entrance animation.
 */
async function paintRecentWins({ animateNew = false, newIds = new Set() } = {}) {
  const el = $('recentWins');
  if (!el) return;

  const wins = [...state.winsFeed.byId.values()]
    .sort((a, b) => {
      const bd = Number(b.blockNumber - a.blockNumber);
      if (bd) return bd;
      return Number(b.requestId - a.requestId);
    })
    .slice(0, 40);

  if (!wins.length) {
    if (state.winsFeed.bootstrapped) {
      el.innerHTML = '<div class="win-row muted">No wins in the last 24h yet.</div>';
    }
    return;
  }

  // Drop loading / empty placeholders — never wipe real win rows wholesale.
  for (const child of [...el.children]) {
    if (!(child instanceof HTMLElement)) continue;
    if (!child.dataset.requestId) child.remove();
  }

  for (const w of wins) {
    if (!w.prizeLabel) {
      const meta = await tokenMeta(w.asset);
      w.prizeLabel = `+${formatHuman(w.amount, meta.decimals)} ${meta.symbol}`;
    }
  }

  const byDom = new Map();
  for (const node of el.querySelectorAll('[data-request-id]')) {
    byDom.set(node.dataset.requestId, node);
  }

  const keepIds = new Set(wins.map((w) => w.requestId.toString()));
  for (const [id, node] of byDom) {
    if (!keepIds.has(id)) {
      node.remove();
      byDom.delete(id);
    }
  }

  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    const id = w.requestId.toString();
    let node = byDom.get(id);
    if (!node) {
      node = document.createElement('div');
      node.className =
        animateNew && newIds.has(id) ? 'win-row win-enter' : 'win-row';
      node.dataset.requestId = id;
      node.innerHTML = `<span class="who">${shortAddr(
        w.user,
      )}</span><span class="win-prize">${escapeHtml(
        w.prizeLabel,
      )}</span><span class="age">${ageLabel(w.ageSec)}</span>`;
      byDom.set(id, node);
    } else {
      const ageEl = node.querySelector('.age');
      if (ageEl) ageEl.textContent = ageLabel(w.ageSec);
      const prizeEl = node.querySelector('.win-prize');
      if (prizeEl && w.prizeLabel) prizeEl.textContent = w.prizeLabel;
    }
    const ref = el.children[i] || null;
    if (ref !== node) el.insertBefore(node, ref);
  }
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
  const stage = $('stage');
  const fan = $('fan');
  const panel = $('panel');
  const promptEl = $('prompt');
  const inFlight = state.mode === 'live' && sessionInFlight();

  const minPretty = minStakePretty();
  const human = formatUnits(state.minStake, 18);
  const tierNote = $('tierNote');
  if (tierNote && !inFlight) {
    if (state.tier === 'std') {
      tierNote.innerHTML =
        'Holder (standard) tickets from grants · odds are live from the game contract · pays $SCRATCH &amp; USDG';
    } else {
      tierNote.innerHTML = `Staked tickets · min stake <b>${minPretty} $SCRATCH <span class="usd-live" data-scratch-amount="${human}"></span></b> · pays $SCRATCH, USDG &amp; stocks`;
    }
    fillUsdLive();
  }

  if (inFlight || sessionPhase() === PHASE.REVEALED) {
    applySessionView();
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

  const n = activeTierTickets();
  fan?.classList.toggle('locked', n <= 0);
  if (promptEl) {
    promptEl.textContent = n <= 0 ? 'No tickets left on this tier' : 'Choose your free scratch';
  }
  applySessionView();
}

/**
 * Stage footer truth table (IDLE + REVEALED only):
 *   tickets > 0                          → "N tickets left on this tier"
 *   tickets = 0 AND staked ≥ minStake    → live accrual countdown (staked tier)
 *   tickets = 0 AND staked < minStake    → stake CTA (staked tier)
 *   tickets = 0 holder tier              → daily-drop copy
 * Never: em-dash countdown placeholders, or any countdown beside tickets > 0.
 * If accrual rate is still loading → show nothing.
 */
function renderStageFooter() {
  const el = $('stageFooter');
  if (!el) return;

  if (state.mode === 'demo') {
    const n = activeTierTickets();
    if (n > 0) {
      state._stakeNextSecs = null;
      el.textContent = `${n} ticket${n === 1 ? '' : 's'} left on this tier`;
      el.classList.add('show');
    } else {
      state._stakeNextSecs = null;
      el.textContent =
        'Out of demo tickets on this tier. Use Demo: reset after a reveal, or switch tiers.';
      el.classList.add('show');
    }
    return;
  }

  const n = activeTierTickets();
  if (n > 0) {
    state._stakeNextSecs = null;
    el.textContent = `${n} ticket${n === 1 ? '' : 's'} left on this tier`;
    el.classList.add('show');
    return;
  }

  // tickets === 0
  if (state.tier === 'std') {
    state._stakeNextSecs = null;
    el.textContent = holderDailyDropCopy();
    el.classList.add('show');
    return;
  }

  // Staked tier, zero spendable tickets
  if (!isStakeEligible()) {
    state._stakeNextSecs = null;
    el.textContent = stakeCtaCopy();
    el.classList.add('show');
    return;
  }

  // Eligible — need live rate; show nothing while loading (never a placeholder dash).
  if (!state.emissionRate || state.emissionRate === 0n || !state.totalStaked || state.totalStaked === 0n) {
    state._stakeNextSecs = null;
    clearStageFooter();
    return;
  }

  const sec = computeStakeNextTicketSec();
  if (sec == null) {
    state._stakeNextSecs = null;
    clearStageFooter();
    return;
  }
  state._stakeNextSecs = sec;
  el.innerHTML = `Next ticket accrues in <b id="accrueTimer">${formatCountdown(sec)}</b>`;
  el.classList.add('show');
}

function clearStageFooter() {
  const el = $('stageFooter');
  if (!el) return;
  el.classList.remove('show');
  el.textContent = '';
  el.innerHTML = '';
}

function holderDailyDropCopy() {
  const minPretty = minStakePretty();
  if (state.scratchBalance >= state.minStake) {
    return `Holder tickets drop daily to wallets holding ${minPretty}+ SCRATCH.`;
  }
  return `Hold ${minPretty}+ SCRATCH to receive the daily drop.`;
}

function stakeCtaCopy() {
  const minPretty = minStakePretty();
  let text = `Stake ${minPretty}+ SCRATCH to start earning tickets`;
  if (state.scratchBalance >= state.minStake) {
    text += " — you're holding enough — stake it to start the clock";
  }
  return text;
}

/** @deprecated use renderStageFooter — kept as alias for refreshMinStake callers */
function renderEmptyStageNote() {
  renderStageFooter();
}

function renderPostRevealAction() {
  const claimRow = $('claimRow');
  const btn = $('claimBtn');
  const wait = $('nextWaitNote');
  const shareBtn = $('shareXBtn');
  const saveBtn = $('saveWinCardBtn');
  if (!claimRow || sessionPhase() !== PHASE.REVEALED) return;

  claimRow.classList.add('show');
  // Remaining on the tier we just scratched (optimistic spend still applied if chain is stale).
  const left = spendableOnTier(state.session.tierKey || state.tier);
  const showShare = !!(state.currentWin && state.lastWin);

  if (shareBtn) shareBtn.hidden = !showShare;
  if (saveBtn) saveBtn.hidden = !showShare;

  if (left >= 1) {
    if (btn) {
      btn.hidden = false;
      btn.disabled = false;
      btn.textContent = `Scratch another (${left} left)`;
    }
    if (wait) {
      wait.classList.remove('show');
      wait.textContent = '';
    }
    return;
  }

  if (btn) {
    btn.hidden = true;
    btn.textContent = 'Scratch another';
  }
  if (wait) {
    wait.classList.remove('show');
    wait.textContent = '';
  }
}

/* -------------------------------------------------------------------------- */
/* Share win → X + win-card PNG                                                */
/* -------------------------------------------------------------------------- */

function buildWinShareText(win) {
  const prize = win.sharePrize || '+?';
  const tier = win.tierKey === 'prem' ? 'prem' : 'std';
  const req = encodeURIComponent(win.requestId || '');
  const page = `https://scratch4663.xyz/win.html?req=${req}&tier=${tier}`;
  // Exactly two lines: voice line + share page (receipt lives inside win.html).
  return `scratched a free ticket on @scratch4663 → ${prize} 🎟️\n${page}`;
}

function shareWinOnX() {
  const win = state.lastWin;
  if (!win || !state.currentWin) return;
  const text = buildWinShareText(win);
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function isLikelyWalletWebView() {
  const ua = navigator.userAgent || '';
  return /MetaMaskMobile|CoinbaseWallet|TrustWallet|Rainbow|StatusIM|WebView|FBAN|FBAV|Instagram|Line\/|MicroMessenger/i.test(
    ua,
  );
}

function triggerPngDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  const canDownload =
    typeof a.download === 'string' && a.download !== '' && !isLikelyWalletWebView();
  if (canDownload) {
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
      // Last resort: navigate current tab (rare popup-blocked wallets).
      location.href = url;
      return;
    }
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function drawLetterspaced(ctx, text, x, y, tracking, align = 'left') {
  const chars = [...String(text)];
  if (!chars.length) return;
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total =
    widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);
  let cx = x;
  if (align === 'right') cx = x - total;
  else if (align === 'center') cx = x - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], cx, y);
    cx += widths[i] + tracking;
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function renderWinCardCanvas(win) {
  const W = 1200;
  const H = 675;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#0B1015';
  ctx.fillRect(0, 0, W, H);

  // Soft vignette
  const vig = ctx.createRadialGradient(W / 2, H / 2, 80, W / 2, H / 2, 520);
  vig.addColorStop(0, 'rgba(33,206,153,0.07)');
  vig.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  const cardX = 90;
  const cardY = 70;
  const cardW = W - 180;
  const cardH = H - 160;
  roundRectPath(ctx, cardX, cardY, cardW, cardH, 28);
  ctx.fillStyle = '#10161C';
  ctx.fill();
  ctx.strokeStyle = '#22303A';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Certificate frame
  ctx.strokeStyle = '#21CE99';
  ctx.lineWidth = 3;
  roundRectPath(ctx, cardX + 28, cardY + 28, cardW - 56, cardH - 56, 10);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(33,206,153,0.45)';
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, cardX + 40, cardY + 40, cardW - 80, cardH - 80, 6);
  ctx.stroke();

  // Gold confetti around card edges (outside + near rim)
  const golds = ['#C9A227', '#EAD37E', '#F4E7B0', '#8F6E14', '#F2C94C'];
  for (let i = 0; i < 70; i++) {
    const edge = i % 4;
    let x;
    let y;
    if (edge === 0) {
      x = cardX + Math.random() * cardW;
      y = cardY - 8 + Math.random() * 36;
    } else if (edge === 1) {
      x = cardX + Math.random() * cardW;
      y = cardY + cardH - 28 + Math.random() * 40;
    } else if (edge === 2) {
      x = cardX - 10 + Math.random() * 40;
      y = cardY + Math.random() * cardH;
    } else {
      x = cardX + cardW - 30 + Math.random() * 40;
      y = cardY + Math.random() * cardH;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.random() * Math.PI);
    ctx.fillStyle = golds[i % golds.length];
    ctx.fillRect(-3 - Math.random() * 3, -5 - Math.random() * 4, 5 + Math.random() * 5, 8 + Math.random() * 6);
    ctx.restore();
  }

  const reqLabel = win.requestId ? `REQUEST #${win.requestId}` : 'REQUEST';
  const prem = win.tierKey === 'prem';
  const tierLabel = prem ? 'PREMIUM' : 'STANDARD';

  ctx.font = '700 22px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#7E93A0';
  drawLetterspaced(ctx, reqLabel, cardX + 64, cardY + 88, 4, 'left');
  ctx.fillStyle = prem ? '#C9A227' : '#21CE99';
  drawLetterspaced(ctx, tierLabel, cardX + cardW - 64, cardY + 88, 5, 'right');

  ctx.fillStyle = '#21CE99';
  ctx.font = '800 72px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const prize = win.cardPrize || '+?';
  // Shrink slightly if the prize string is very long
  let prizeSize = 72;
  while (prizeSize > 40 && ctx.measureText(prize).width > cardW - 120) {
    prizeSize -= 4;
    ctx.font = `800 ${prizeSize}px Inter, system-ui, sans-serif`;
  }
  ctx.fillText(prize, W / 2, H / 2 - 8);

  ctx.fillStyle = '#8FA3B0';
  ctx.font = '500 26px Inter, system-ui, sans-serif';
  ctx.fillText('Paid to your wallet', W / 2, H / 2 + 52);

  ctx.fillStyle = '#7E93A0';
  ctx.font = '600 20px Inter, system-ui, sans-serif';
  ctx.fillText('scratch4663.xyz', W / 2, cardY + cardH + 48);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  return canvas;
}

async function saveWinCardPng() {
  const win = state.lastWin;
  if (!win || !state.currentWin) return;
  try {
    if (document.fonts?.ready) await document.fonts.ready;
  } catch {
    /* draw with fallback stack */
  }
  const canvas = renderWinCardCanvas(win);
  if (!canvas) return;
  const n = win.requestId || 'win';
  const filename = `scratch-win-${n}.png`;
  await new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (blob) triggerPngDownload(blob, filename);
        resolve();
      },
      'image/png',
    );
  });
}

function updateStakeFormBalances() {
  const walletEl = $('stakeWalletBal');
  const stakedEl = $('withdrawStakedBal');
  if (!state.account) {
    if (walletEl) walletEl.textContent = 'Wallet: —';
    if (stakedEl) stakedEl.textContent = 'Staked: —';
    setPctRowEnabled('stakePctRow', false);
    setPctRowEnabled('withdrawPctRow', false);
    return;
  }
  if (walletEl) {
    walletEl.textContent = `Wallet: ${formatScratchWhole(state.scratchBalance)} SCRATCH`;
  }
  if (stakedEl) {
    stakedEl.textContent = `Staked: ${formatScratchWhole(state.userStaked)} SCRATCH`;
  }
  setPctRowEnabled('stakePctRow', state.scratchBalance > 0n);
  setPctRowEnabled('withdrawPctRow', state.userStaked > 0n);
}

function setPctRowEnabled(rowId, enabled) {
  const row = $(rowId);
  if (!row) return;
  row.classList.toggle('disabled', !enabled);
  row.querySelectorAll('button').forEach((btn) => {
    btn.disabled = !enabled;
  });
}

/** Fill input with pct% of balance at full token precision (bigint math). */
function fillPctAmount(inputId, balance, pct) {
  const input = $(inputId);
  if (!input || balance == null || balance <= 0n) return 0n;
  const amount = pct >= 100 ? balance : (balance * BigInt(pct)) / 100n;
  input.value = formatUnits(amount, 18);
  return amount;
}

function belowMinStakeHint() {
  return `Below minimum — stake at least ${minStakePretty()} SCRATCH to start earning tickets`;
}

function applyStakePctFill(pct) {
  const amount = fillPctAmount('stakeAmount', state.scratchBalance, pct);
  const path = $('stakeAmountPath');
  if (path) fillPctAmount('stakeAmountPath', state.scratchBalance, pct);

  const status = $('stakeStatus');
  const resulting = (state.userStaked ?? 0n) + amount;
  if (amount > 0n && (resulting < state.minStake || resulting === 0n)) {
    setStatus(status, belowMinStakeHint());
    status?.classList.add('warn');
  } else if (status?.classList.contains('warn')) {
    setStatus(status, '');
    status.classList.remove('warn');
  }
}

function applyWithdrawPctFill(pct) {
  fillPctAmount('withdrawAmount', state.userStaked, pct);
}

function updateScratchButtons() {
  applySessionView();
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

/** Port of #scratch-mark (viewBox 0 0 100 140): stroked hook + diamond, no text. */
function drawScratchMark(ctx, cx, cy, scale, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-50, -70);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 16;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(28, 38);
  ctx.bezierCurveTo(28, 22, 36, 18, 50, 18);
  ctx.bezierCurveTo(64, 18, 72, 22, 72, 38);
  ctx.bezierCurveTo(72, 52, 58, 60, 50, 72);
  ctx.lineTo(50, 86);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(50, 105.3);
  ctx.lineTo(62.7, 118);
  ctx.lineTo(50, 130.7);
  ctx.lineTo(37.3, 118);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

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
  // Marching-ants stamp lives on the print overlay; skip static dash while printing.
  if ($('foilPrintOverlay')?.hidden !== false) {
    ctx.setLineDash([7, 6]);
    ctx.strokeRect(8, 8, r.width - 16, r.height - 16);
    ctx.setLineDash([]);
  }
  // Same geometry as #scratch-mark (viewBox 0 0 100 140) — no text glyph.
  drawScratchMark(
    ctx,
    r.width / 2,
    r.height / 2,
    Math.min(r.width, r.height) / 150,
    prem ? '#C9A227' : '#5C3F12',
  );
  ctx.fillStyle = prem ? 'rgba(201,162,39,.8)' : 'rgba(92,63,18,.9)';
  ctx.font = "700 11px 'Inter'";
  ctx.textAlign = 'center';
  // Printing overlay owns the caption; keep canvas clear of competing copy.
  if ($('foilPrintOverlay')?.hidden !== false) {
    ctx.fillText('SCRATCH TO REVEAL', r.width / 2, r.height - 20);
  }
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
  hidePrintingOverlay();
  canvas.style.transition = 'none';
  canvas.style.opacity = '1';
  canvas.style.pointerEvents = 'auto';
  canvas.classList.remove('is-printing');
  canvas.style.cursor = '';
  paintFoil();
}

function showPrintingOverlay() {
  const ov = $('foilPrintOverlay');
  if (ov) {
    ov.hidden = false;
    ov.setAttribute('aria-hidden', 'false');
  }
  if (canvas) {
    canvas.style.pointerEvents = 'none';
    canvas.classList.add('is-printing');
    canvas.style.cursor = 'not-allowed';
  }
  $('scratchCardEl')?.classList.remove('ready-pop');
}

function hidePrintingOverlay() {
  const ov = $('foilPrintOverlay');
  if (ov) {
    ov.hidden = true;
    ov.setAttribute('aria-hidden', 'true');
  }
  if (canvas) {
    canvas.classList.remove('is-printing');
  }
}

function lockFoilWaiting() {
  clearTimeout(disableTimer);
  if (!canvas) return;
  canvas.style.transition = 'none';
  canvas.style.opacity = '1';
  canvas.style.pointerEvents = 'none';
  canvas.classList.add('is-printing');
  canvas.style.cursor = 'not-allowed';
  showPrintingOverlay();
  paintFoil();
}

function unlockFoilForScratch() {
  if (!canvas) return;
  hidePrintingOverlay();
  canvas.style.pointerEvents = 'auto';
  canvas.style.opacity = '1';
  canvas.classList.remove('is-printing');
  canvas.style.cursor = 'grab';
  paintFoil();
  playReadyPop();
}

function playReadyPop() {
  const card = $('scratchCardEl');
  if (!card) return;
  card.classList.remove('ready-pop');
  // Force reflow so the animation retriggers.
  void card.offsetWidth;
  card.classList.add('ready-pop');
  const clear = () => card.classList.remove('ready-pop');
  card.addEventListener('animationend', clear, { once: true });
}

function shakeFoilFrame() {
  const frame = $('scratchFrame');
  if (!frame) return;
  frame.classList.remove('foil-shake');
  void frame.offsetWidth;
  frame.classList.add('foil-shake');
  frame.addEventListener(
    'animationend',
    () => frame.classList.remove('foil-shake'),
    { once: true },
  );
}

function isPrintingPhase() {
  return (
    state.mode === 'live' &&
    (state.session.phase === PHASE.PICKED || state.session.phase === PHASE.PENDING)
  );
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
  const promptEl = $('prompt');
  if (promptEl) {
    promptEl.textContent = state.currentWin ? 'Nice.' : 'Better luck tomorrow.';
  }
  if (state.currentWin) burstConfetti();
  if (state.mode === 'live') {
    enterRevealedUI();
  } else {
    const claimRow = $('claimRow');
    claimRow?.classList.toggle('show', state.currentWin);
  }
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
    if (!canScratchInput()) {
      if (isPrintingPhase()) shakeFoilFrame();
      return;
    }
    drawing = true;
    last = null;
    canvas.setPointerCapture(e.pointerId);
    scratchMove(e);
  });
  canvas.addEventListener('pointermove', scratchMove);
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  const overlay = $('foilPrintOverlay');
  const onPrintTap = (e) => {
    if (!isPrintingPhase()) return;
    e.preventDefault();
    shakeFoilFrame();
  };
  overlay?.addEventListener('pointerdown', onPrintTap);

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
/* Wallet — EIP-6963 discovery + late-injection grace                          */
/* -------------------------------------------------------------------------- */

const NO_WALLET_MSG =
  "No wallet detected. Open this site inside your wallet's browser, or install a browser wallet.";
const WALLET_DISCOVERY_GRACE_MS = 3000;

/** @type {Map<string, { info: { uuid: string, name: string, icon?: string, rdns?: string }, provider: object }>} */
const discoveredWallets = new Map();
/** Session-selected provider detail (remembered until reload). */
let selectedWallet = null;
/** @type {object|null} */
let boundProvider = null;
/** @type {Promise<object[]>|null} */
let discoveryPromise = null;

function setStatus(elOrId, msg) {
  const el = typeof elOrId === 'string' ? $(elOrId) : elOrId;
  if (el) el.textContent = msg || '';
}

function getActiveProvider() {
  return selectedWallet?.provider ?? null;
}

function listDiscoveredWallets() {
  return [...discoveredWallets.values()];
}

function isProviderDiscovered(provider) {
  for (const d of discoveredWallets.values()) {
    if (d.provider === provider) return true;
  }
  return false;
}

function legacyWalletName(provider) {
  if (!provider || typeof provider !== 'object') return 'Browser wallet';
  if (provider.isRabby) return 'Rabby';
  if (provider.isCoinbaseWallet || provider.isBaseWallet) return 'Coinbase Wallet';
  if (provider.isOkxWallet || provider.isOKExWallet) return 'OKX Wallet';
  if (provider.isUniswapWallet) return 'Uniswap Wallet';
  if (provider.isBraveWallet) return 'Brave Wallet';
  if (provider.isMetaMask) return 'MetaMask';
  return 'Browser wallet';
}

function upsertDiscoveredWallet(detail) {
  const uuid = detail?.info?.uuid;
  const provider = detail?.provider;
  if (!uuid || !provider) return;
  discoveredWallets.set(uuid, {
    info: {
      uuid,
      name: detail.info.name || 'Wallet',
      icon: detail.info.icon || '',
      rdns: detail.info.rdns || '',
    },
    provider,
  });
}

function captureLegacyEthereum() {
  const eth = window.ethereum;
  if (!eth) return;
  const candidates =
    Array.isArray(eth.providers) && eth.providers.length > 0 ? eth.providers : [eth];
  for (let i = 0; i < candidates.length; i++) {
    const provider = candidates[i];
    if (!provider || isProviderDiscovered(provider)) continue;
    const name = legacyWalletName(provider);
    const uuid = `legacy:${name}:${i}`;
    upsertDiscoveredWallet({
      info: { uuid, name, icon: '', rdns: '' },
      provider,
    });
  }
}

function onEip6963Announce(event) {
  const { info, provider } = event.detail ?? {};
  if (!info?.uuid || !provider) return;
  upsertDiscoveredWallet({ info, provider });
}

function startWalletDiscovery() {
  if (discoveryPromise) return discoveryPromise;

  window.addEventListener('eip6963:announceProvider', onEip6963Announce);
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch {
    /* ignore */
  }
  captureLegacyEthereum();

  discoveryPromise = new Promise((resolve) => {
    const begun = Date.now();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      captureLegacyEthereum();
      resolve(listDiscoveredWallets());
    };

    const hasAny = () => {
      captureLegacyEthereum();
      return discoveredWallets.size > 0;
    };

    if (hasAny()) {
      // Brief settle so multiple EIP-6963 extensions can all announce.
      setTimeout(finish, 200);
      return;
    }

    const onEthInitialized = () => {
      captureLegacyEthereum();
    };
    window.addEventListener('ethereum#initialized', onEthInitialized, { once: true });

    const tick = setInterval(() => {
      if (hasAny() || Date.now() - begun >= WALLET_DISCOVERY_GRACE_MS) {
        clearInterval(tick);
        window.removeEventListener('ethereum#initialized', onEthInitialized);
        finish();
      }
    }, 100);
  });

  return discoveryPromise;
}

// Start as early as the module loads — in-app browsers often inject after first paint.
startWalletDiscovery();

function providerOff(provider, event, fn) {
  if (!provider || !fn) return;
  if (typeof provider.removeListener === 'function') provider.removeListener(event, fn);
  else if (typeof provider.off === 'function') provider.off(event, fn);
}

function unbindProviderEvents() {
  if (!boundProvider) return;
  providerOff(boundProvider, 'accountsChanged', onProviderAccountsChanged);
  providerOff(boundProvider, 'chainChanged', onProviderChainChanged);
  boundProvider = null;
}

function bindProviderEvents(provider) {
  if (!provider || boundProvider === provider) return;
  unbindProviderEvents();
  boundProvider = provider;
  provider.on?.('accountsChanged', onProviderAccountsChanged);
  provider.on?.('chainChanged', onProviderChainChanged);
}

function onProviderAccountsChanged(accs) {
  if (!accs?.length) {
    sessionDispatch(ACTION.DISCONNECT);
    return;
  }
  const provider = getActiveProvider();
  if (!provider) return;
  state.account = getAddress(accs[0]);
  state.walletClient = createWalletClient({
    account: state.account,
    chain: robinhoodChain,
    transport: custom(provider),
  });
  const btn = $('connectBtn');
  if (btn) {
    btn.textContent = shortAddr(state.account);
    btn.dataset.connected = '1';
  }
  watchScratchTransfers();
  refreshWalletPanel();
}

function onProviderChainChanged() {
  refreshWalletPanel();
}

/**
 * @param {ReturnType<typeof listDiscoveredWallets>} providers
 * @returns {Promise<object|null>}
 */
function showWalletPicker(providers) {
  return new Promise((resolve) => {
    const root = $('walletPicker');
    const list = $('walletPickerList');
    if (!root || !list) {
      resolve(providers[0] || null);
      return;
    }

    list.replaceChildren();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      root.hidden = true;
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
    };

    for (const detail of providers) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wallet-picker-item';
      const name = detail.info.name || 'Wallet';
      if (detail.info.icon) {
        const img = document.createElement('img');
        img.src = detail.info.icon;
        img.alt = '';
        img.width = 28;
        img.height = 28;
        btn.appendChild(img);
      } else {
        const fall = document.createElement('span');
        fall.className = 'wp-fallback';
        fall.textContent = name.slice(0, 1).toUpperCase();
        fall.setAttribute('aria-hidden', 'true');
        btn.appendChild(fall);
      }
      const label = document.createElement('span');
      label.textContent = name;
      btn.appendChild(label);
      btn.addEventListener('click', () => finish(detail));
      list.appendChild(btn);
    }

    const cancelBtn = $('walletPickerCancel');
    if (cancelBtn) cancelBtn.onclick = () => finish(null);
    root.onclick = (e) => {
      if (e.target === root) finish(null);
    };
    document.addEventListener('keydown', onKey);
    root.hidden = false;
    list.querySelector('button')?.focus();
  });
}

async function resolveWalletForConnect() {
  await startWalletDiscovery();
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch {
    /* ignore */
  }
  captureLegacyEthereum();

  const providers = listDiscoveredWallets();
  if (providers.length === 0) return null;

  if (selectedWallet) {
    const still = providers.find((p) => p.provider === selectedWallet.provider);
    if (still) return still;
  }
  if (providers.length === 1) return providers[0];
  return showWalletPicker(providers);
}

async function ensureChain() {
  const provider = getActiveProvider();
  if (!provider) throw new Error(NO_WALLET_MSG);
  const hexId = '0x' + CONFIG.chainId.toString(16);
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexId }],
    });
  } catch (err) {
    if (err?.code === 4902 || /Unrecognized chain/i.test(err?.message || '')) {
      await provider.request({
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
    const detail = await resolveWalletForConnect();
    if (!detail) {
      if (btn) btn.textContent = 'Connect';
      showToast(NO_WALLET_MSG, { kind: 'error', duration: 9000 });
      return;
    }
    selectedWallet = detail;
    bindProviderEvents(detail.provider);

    await ensureChain();
    const accounts = await detail.provider.request({ method: 'eth_requestAccounts' });
    const account = getAddress(accounts[0]);
    state.account = account;
    state.walletClient = createWalletClient({
      account,
      chain: robinhoodChain,
      transport: custom(detail.provider),
    });
    if (btn) {
      btn.textContent = shortAddr(account);
      btn.dataset.connected = '1';
      btn.style.minHeight = '44px';
    }
    if (state.mode === 'demo') setMode('live');
    await refreshWalletPanel({ skipStage: true });
    updateScratchButtons();
    watchScratchTransfers();
    await rehydratePendingSession();
    if (!stageBusy()) renderTier();
  } catch (err) {
    if (btn) btn.textContent = 'Connect';
    toastWalletError(err, 'Wallet connection failed');
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
    sessionDispatch(ACTION.DISCONNECT);
  }
}

async function refreshWalletPanel(opts = {}) {
  const panel = $('walletPanel');
  if (!state.account) {
    if (panel) panel.hidden = true;
    state.userStaked = 0n;
    state.scratchBalance = 0n;
    state._stakeNextSecs = null;
    updateStakeFormBalances();
    return;
  }
  try {
    const [user, stdTickets, premTickets, expiry, scratchBal, emissionRate, totalStaked] =
      await Promise.all([
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
        publicClient.readContract({
          address: addr.scratch,
          abi: ABI_ERC20,
          functionName: 'balanceOf',
          args: [state.account],
        }),
        publicClient.readContract({
          address: addr.staking,
          abi: ABI_STAKING,
          functionName: 'emissionRate',
        }),
        publicClient.readContract({
          address: addr.staking,
          abi: ABI_STAKING,
          functionName: 'totalStaked',
        }),
      ]);

    state.liveTickets.std = stdTickets;
    state.liveTickets.prem = premTickets;
    state.userExpiry = BigInt(expiry);
    state.emissionRate = emissionRate;
    state.totalStaked = totalStaked;
    state.scratchBalance = scratchBal;
    reconcileOptimisticSpend();

    const staked = user.staked ?? user[0];
    state.userStaked = staked;
    const now = Math.floor(Date.now() / 1000);
    const expSec = Number(expiry);
    const remain = expSec > now ? expSec - now : 0;
    state.expirySec = remain;

    if (panel) panel.hidden = false;
    setText($('walletStaked'), `${formatHuman(staked)} SCRATCH`);
    setText($('walletStdTickets'), String(ticketCount(stdTickets)));
    const premEl = $('walletPremTickets');
    if (premEl) premEl.innerHTML = formatTicketBalanceHtml(premTickets);
    setText($('walletExpiry'), remain > 0 ? formatCountdown(remain) : '—');
    updateStakedTicketsTip();
    updateStakeFormBalances();

    if (!opts.skipStage && sessionPhase() === PHASE.IDLE) {
      renderTier();
    } else {
      applySessionView();
    }
  } catch (e) {
    const status = $('scratchStatus');
    if (status) status.textContent = e instanceof Error ? e.message : 'Wallet read failed';
  }
}

function stopScratchTransferWatch() {
  try {
    state.transferUnwatch?.();
  } catch {
    /* ignore */
  }
  state.transferUnwatch = null;
}

function watchScratchTransfers() {
  stopScratchTransferWatch();
  if (!state.account) return;
  try {
    state.transferUnwatch = publicClient.watchContractEvent({
      address: addr.scratch,
      abi: [EVENT_TRANSFER],
      eventName: 'Transfer',
      onLogs: (logs) => {
        const me = state.account?.toLowerCase();
        if (!me) return;
        for (const log of logs) {
          const from = log.args?.from?.toLowerCase?.() || '';
          const to = log.args?.to?.toLowerCase?.() || '';
          if (from === me || to === me) {
            refreshWalletPanel({ skipStage: stageBusy() });
            break;
          }
        }
      },
    });
  } catch (err) {
    console.warn('transfer watch', err);
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
  state.session.ticketsAtPick = null;
  state.session.requestedAt = 0n;
  state.pendingRequestId = null;
  state.lastWin = null;
  state.currentWin = false;
  hidePrintingOverlay();
  $('scratchCardEl')?.classList.remove('ready-pop');
  $('scratchFrame')?.classList.remove('foil-shake');
  const panel = $('panel');
  panel?.classList.remove('show');
  panel?.classList.remove('session-pending');
  $('fan')?.classList.remove('picked');
  $('claimRow')?.classList.remove('show');
  const wait = $('nextWaitNote');
  if (wait) {
    wait.classList.remove('show');
    wait.textContent = '';
  }
  const claimBtn = $('claimBtn');
  if (claimBtn) {
    claimBtn.hidden = false;
    claimBtn.disabled = false;
  }
  const shareBtn = $('shareXBtn');
  const saveBtn = $('saveWinCardBtn');
  if (shareBtn) shareBtn.hidden = true;
  if (saveBtn) saveBtn.hidden = true;
  clearStageFooter();
  setReassure(false);
  show($('pendingRescue'), false);
  show($('rescueBtn'), false);
  revealed = false;
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
  state.session.ticketsAtPick =
    tierKey === 'prem' ? state.liveTickets.prem : state.liveTickets.std;
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
  clearStageFooter();

  const amtEl = $('prizeAmt');
  if (amtEl) {
    amtEl.textContent = '…';
    amtEl.className = 'amt';
  }
  setText($('prizeLbl'), 'Hang tight');
  setText($('prompt'), 'ticket printing…');
  setText($('ticketNo'), 'Confirm in wallet…');

  $('fan')?.classList.add('picked');
  const panel = $('panel');
  panel?.classList.add('show');
  panel?.classList.remove('session-pending');

  applySessionView();

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
  // Keep optimisticDelta until reconcileOptimisticSpend sees chain drop below ticketsAtPick.
  state.pendingRequestId = requestId;

  const panel = $('panel');
  panel?.classList.add('show');
  panel?.classList.add('session-pending');
  $('fan')?.classList.add('picked');

  setText($('ticketNo'), `Request #${requestId.toString()}`);
  setText($('prompt'), 'ticket printing…');
  const amtEl = $('prizeAmt');
  if (amtEl) {
    amtEl.textContent = '…';
    amtEl.className = 'amt';
  }
  setText($('prizeLbl'), 'Waiting for randomness');
  lockFoilWaiting();
  setReassure(false);
  applySessionView();

  if (state.reassureTimer) clearTimeout(state.reassureTimer);
  state.reassureTimer = setTimeout(() => {
    if (state.session.phase === PHASE.PENDING) setReassure(true);
  }, 30_000);
}

async function enterReadyUI(asset, amount, opts = {}) {
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
    state.lastWin = null;
  } else {
    const meta = await tokenMeta(asset);
    const human = formatHuman(amount, meta.decimals);
    const label = `+${human} ${meta.symbol}`;
    const amtEl = $('prizeAmt');
    if (amtEl) {
      amtEl.textContent = label;
      amtEl.className = 'amt ' + (meta.kind === 'stock' ? 'gold' : 'win');
    }
    setText($('prizeLbl'), 'Paid to your wallet');
    state.currentWin = true;
    const req =
      opts.requestId ?? state.session.requestId ?? state.pendingRequestId;
    const sharePrize =
      meta.symbol === 'SCRATCH' ? `+${human} $SCRATCH` : `+${human} ${meta.symbol}`;
    state.lastWin = {
      requestId: req != null ? req.toString() : '',
      txHash: opts.txHash || null,
      sharePrize,
      cardPrize: `+${human} ${meta.symbol}`,
      tierKey: state.session.tierKey || state.tier,
    };
  }

  const claimBtn = $('claimBtn');
  if (claimBtn) {
    claimBtn.hidden = true;
    claimBtn.disabled = false;
  }
  const shareBtn = $('shareXBtn');
  const saveBtn = $('saveWinCardBtn');
  if (shareBtn) shareBtn.hidden = true;
  if (saveBtn) saveBtn.hidden = true;
  const wait = $('nextWaitNote');
  if (wait) {
    wait.classList.remove('show');
    wait.textContent = '';
  }
  $('claimRow')?.classList.remove('show');
  clearStageFooter();

  setText($('prompt'), 'scratch to reveal');
  unlockFoilForScratch();
  applySessionView();
}

async function enterRevealedUI() {
  state.session.phase = PHASE.REVEALED;
  $('panel')?.classList.remove('session-pending');
  // Fresh position stats right after the reveal settles into view.
  try {
    await refreshWalletPanel({ skipStage: true });
  } catch {
    /* still render next action from cached counts */
  }
  applySessionView();
}

function canScratchInput() {
  if (state.mode === 'demo') return true;
  return state.session.phase === PHASE.READY && !revealed;
}

async function applySettledPrize(asset, amount, opts = {}) {
  if (
    state.session.phase !== PHASE.PENDING &&
    state.session.phase !== PHASE.PICKED &&
    state.session.phase !== PHASE.READY
  ) {
    return;
  }
  // Position stats (tickets / staked / balance) as soon as settlement lands.
  try {
    await refreshWalletPanel({ skipStage: true });
  } catch {
    /* continue into ready UI */
  }
  await enterReadyUI(asset, amount, opts);
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
        let txHash = null;
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
              const settled = recent[recent.length - 1];
              asset = settled.args.asset;
              amount = settled.args.amount;
              txHash = settled.transactionHash || null;
              break;
            }
          } catch {
            /* try older chunk */
          }
          if (clampedFrom <= from) break;
          start = clampedFrom - 1n;
        }
        await applySettledPrize(asset, amount, { txHash, requestId });
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
            await applySettledPrize(log.args.asset, log.args.amount, {
              txHash: log.transactionHash || null,
              requestId: log.args.requestId ?? requestId,
            });
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
  // Only IDLE may enter a new scratch; REVEALED must reset via sessionDispatch first.
  if (sessionPhase() !== PHASE.IDLE) return;

  const tier = tierOverride != null ? tierOverride : activeChainTier();
  const tierKey = tier === TIER_STD ? 'std' : 'prem';

  if (!state.account) {
    await connectWallet();
    if (!state.account) return;
  }

  const tickets =
    tier === TIER_STD ? state.liveTickets.std : state.liveTickets.prem;
  if (tickets < CONFIG.ticketCost) {
    showToast('No tickets on this tier.', { kind: 'warn' });
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

    setText($('prompt'), 'ticket printing…');
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
      showToast('Could not find the scratch request — check your wallet activity.', {
        kind: 'error',
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
      showToast(WALLET_REJECT_TOAST, { kind: 'warn', duration: 9000 });
      return;
    }
    resetSessionToIdle({ cancelNote: `Scratch failed: ${msg}` });
    showToast(`Scratch failed: ${msg}`, { kind: 'error' });
  }
}

function onCardPick() {
  sessionDispatch(ACTION.PICK_CARD);
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
    status?.classList.remove('warn');
    return;
  }
  try {
    await ensureChain();
    const amount = parseUnits(raw, 18);
    status?.classList.remove('warn');
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
    if (input) input.value = '';
    if (pathInput) pathInput.value = '';
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
    sessionDispatch(ACTION.SELECT_TIER, { tierKey: 'std' });
  });
  $('tabPrem')?.addEventListener('click', () => {
    sessionDispatch(ACTION.SELECT_TIER, { tierKey: 'prem' });
  });

  $('fan')?.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('click', () => sessionDispatch(ACTION.PICK_CARD));
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
      sessionDispatch(ACTION.SCRATCH_ANOTHER);
      return;
    }
    this.textContent = 'Claimed ✓';
    this.disabled = true;
    setTimeout(() => {
      this.textContent = 'Claim reward';
      this.disabled = false;
    }, 2600);
  });

  $('shareXBtn')?.addEventListener('click', () => shareWinOnX());
  $('saveWinCardBtn')?.addEventListener('click', () => {
    void saveWinCardPng();
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
  $('stakePctRow')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pct]');
    if (!btn || btn.disabled) return;
    applyStakePctFill(Number(btn.dataset.pct));
  });
  $('withdrawPctRow')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pct]');
    if (!btn || btn.disabled) return;
    applyWithdrawPctFill(Number(btn.dataset.pct));
  });

  $('scratchBtnStd')?.addEventListener('click', () => {
    sessionDispatch(ACTION.QUICK_SCRATCH, { tierKey: 'std' });
  });
  $('scratchBtnStdPath')?.addEventListener('click', () => {
    sessionDispatch(ACTION.QUICK_SCRATCH, { tierKey: 'std' });
  });
  $('scratchBtnPrem')?.addEventListener('click', () => {
    sessionDispatch(ACTION.QUICK_SCRATCH, { tierKey: 'prem' });
  });

  // Withdraw warning copy (static)
  const warn = $('withdrawWarn');
  if (warn && !warn.textContent.trim()) {
    warn.textContent =
      'Warning: any withdrawal burns all staking tickets (pending and banked).';
  }

  injectFairnessNote();

  // Address copy buttons (transparency / any .addr-copy)
  document.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('.addr-copy');
    if (!btn) return;
    const full = btn.getAttribute('data-copy') || '';
    if (!full) return;
    const done = () => {
      const prev = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('ok');
      setTimeout(() => {
        btn.textContent = prev || 'Copy';
        btn.classList.remove('ok');
      }, 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(full).then(done).catch(() => {
        /* ignore */
      });
    }
  });

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

  // Accrual countdown tick — only when footer is showing a live countdown (tickets === 0).
  setInterval(() => {
    if (state.account && state.userExpiry > 0n) {
      const now = Math.floor(Date.now() / 1000);
      const remain = Math.max(0, Number(state.userExpiry) - now);
      state.expirySec = remain;
      setText($('walletExpiry'), remain > 0 ? formatCountdown(remain) : '—');
    }

    if (activeTierTickets() > 0) {
      if (state._stakeNextSecs != null) {
        state._stakeNextSecs = null;
        if (sessionPhase() === PHASE.IDLE || sessionPhase() === PHASE.REVEALED) {
          renderStageFooter();
        }
      }
      return;
    }

    if (
      state.account &&
      state.tier === 'prem' &&
      state._stakeNextSecs != null &&
      isStakeEligible() &&
      (sessionPhase() === PHASE.IDLE || sessionPhase() === PHASE.REVEALED)
    ) {
      state._stakeNextSecs = Math.max(0, state._stakeNextSecs - 1);
      const timer = $('accrueTimer');
      if (timer) timer.textContent = formatCountdown(state._stakeNextSecs);
    }
  }, 1000);
}

async function init() {
  try {
    await loadTokenConfig();
  } catch (err) {
    console.warn('tokens.json load failed — using seeded addresses', err);
  }
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
  document.addEventListener('DOMContentLoaded', () => {
    void init();
  });
} else {
  void init();
}
