/**
 * v2 mainnet rehearsal orchestrator (Deploy3 + StakingVaultV2 + ScratchGameV2).
 *
 * Subcommands (idempotent via rehearsal/state-v2.json):
 *   prep | token | entropy | deploy | fund | watcher | v1..v8 | report | all
 *
 * Env: rehearsal/.env.rehearsal — same shape as v1 (unchanged). Refuses if tracked.
 * Production .env is never read. Fresh entropy under rehearsal/ only.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  unlinkSync,
  openSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  Interface,
  AbiCoder,
  getAddress,
  formatEther,
  parseEther,
  id as ethId,
  ZeroAddress,
} from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const ENV_FILE = resolve(__dirname, ".env.rehearsal");
const STATE_FILE = resolve(__dirname, "state-v2.json");
const ENTROPY_FILE = resolve(__dirname, "entropy-state-v2.json");
const ENTROPY_FILE_V8 = resolve(__dirname, "entropy-state-v2-v8.json");
const WATCHER_PID = resolve(__dirname, "watcher-v2.pid");
const WATCHER_LOG = resolve(__dirname, "watcher-v2.log");
const DRILL_LOG_DIR = resolve(__dirname, "drill-logs-v2");
const REPORT_FILE = resolve(__dirname, "REHEARSAL_V2_REPORT.md");
const GENERATE_CHAIN = resolve(REPO_ROOT, "ops/entropy-operator/src/generate-chain.js");

const CHAIN_ID = 4663n;
const PREMIUM = 1;
const STANDARD = 0;
const TIER_NORMAL = 1;
const TIER_ENHANCED = 2;

const RESCUE_DELAY = 600;
const UNLOCK_NORMAL = 300;
const UNLOCK_ENHANCED = 900;
const BOOST_BPS = 2000;
const BURN_BPS = 5000;
const EMISSION_RATE = 10n ** 18n;
const MIN_STAKE = 10n ** 18n;
const PROMO_DAILY_CAP = 1000n * 10n ** 18n;
const FUND_AMOUNT = 100_000n * 10n ** 18n;
const USER_STAKE = 100n * 10n ** 18n;
const TICKET_COST = 10n ** 18n;
const ACCRUAL_WINDOW_S = 60;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const USDG_DUST = 1_000_000n; // 1 USDG if 6 decimals — best-effort

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const GAME_ABI = [
  "function scratch(uint8 tier) returns (uint256 requestId)",
  "function scratchMany(uint8 tier, uint256 count) returns (uint256 requestId)",
  "function rescue(uint256 requestId)",
  "function requests(uint256) view returns (address user, uint8 tier, uint64 requestedAt, uint8 status, uint8 count)",
  "function queueRandomnessSwap(address newProvider)",
  "function executeRandomnessSwap()",
  "function cancelRandomnessSwap()",
  "function pendingRandomness() view returns (address)",
  "function randomnessSwapEta() view returns (uint64)",
  "function acceptOwnership()",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function MAX_BATCH() view returns (uint8)",
  "event ScratchRequested(address indexed user, uint256 indexed requestId, uint8 tier)",
  "event ScratchBatch(address indexed user, uint8 tier, uint256 count, uint256 requestId)",
  "event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 cardIndex, uint8 tier, uint256 rowIndex, address asset, uint256 amount)",
  "event ScratchRescued(address indexed user, uint256 indexed requestId, uint8 tier)",
  "event ScratchLateFulfillment(address indexed user, uint256 indexed requestId, uint8 tier, uint8 count)",
];

const VAULT_ABI = [
  "function fund(address asset, uint256 amount)",
  "function sweep(address asset, address to) returns (uint256 id)",
  "function executeSweep(uint256 id)",
  "function sweeps(uint256) view returns (address asset, address to, uint64 eta, bool pending)",
  "function setFallbackRate(address asset, uint256 scratchPerUnit)",
  "function acceptOwnership()",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "event SweepQueued(uint256 indexed id, address indexed asset, address indexed to, uint64 eta)",
];

const STANDARD_ABI = [
  "function grant(address[] users, uint256 amountEach)",
  "function ticketsOf(address user) view returns (uint256)",
  "function acceptOwnership()",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
];

const STAKING_ABI = [
  "function deposit(uint256 amount, uint8 tier)",
  "function upgradeTier()",
  "function requestUnlock(uint256 amount)",
  "function claimUnlocked()",
  "function cancelUnlock()",
  "function ticketsOf(address user) view returns (uint256)",
  "function users(address) view returns (uint256 staked, uint256 debt, uint256 banked, uint8 tier)",
  "function unlocking(address) view returns (uint256 amount, uint64 releaseAt)",
  "function totalWeight() view returns (uint256)",
  "function burnBps() view returns (uint16)",
  "function boostBps() view returns (uint16)",
  "function unlockNormal() view returns (uint64)",
  "function unlockEnhanced() view returns (uint64)",
  "event UnlockRequested(address indexed user, uint256 amount, uint256 ticketsBurned, uint64 releaseAt)",
  "event UnlockClaimed(address indexed user, uint256 amount, uint256 terminalTicketsBurned)",
];

const PRIZE_PAID_ABI = [
  "event PrizePaid(address indexed to, address indexed asset, uint256 amount, bool fellBack)",
];

const ENTROPY_ABI = [
  "function registerChain(bytes32 commitment)",
  "function currentEpoch() view returns (uint64)",
  "function reveal(uint256 requestId, bytes32 preimage)",
  "function requests(uint256 requestId) view returns (address requester, uint64 epoch, bool pending)",
  "function acceptOwnership()",
  "function owner() view returns (address)",
  "function transferOwnership(address)",
  "event RandomnessRequested(uint256 indexed requestId, address indexed requester)",
  "event RandomnessFulfilled(uint256 indexed requestId, uint256 randomWord)",
];

const STATUS = { None: 0, Pending: 1, Settled: 2, Rescued: 3 };

// ---------------------------------------------------------------------------
// Env / state
// ---------------------------------------------------------------------------

function loadEnvFile(path) {
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}. Copy rehearsal/.env.rehearsal.example → rehearsal/.env.rehearsal and fill burner keys + RPC_URL.`,
    );
  }
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function assertEnvNotTracked() {
  const rel = "rehearsal/.env.rehearsal";
  const r = spawnSync("git", ["ls-files", "--error-unmatch", rel], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (r.status === 0) {
    throw new Error(
      `REFUSING TO RUN: ${rel} is tracked by git. Remove it from the index immediately.`,
    );
  }
}

function requireKeys(env) {
  for (const k of ["BURNER_DEPLOYER_PK", "BURNER_OPERATOR_PK", "BURNER_USER_PK", "RPC_URL"]) {
    if (!env[k]) throw new Error(`Missing ${k} in rehearsal/.env.rehearsal`);
  }
}

function normalizePk(pk) {
  return pk.startsWith("0x") ? pk : `0x${pk}`;
}

function defaultState() {
  return {
    addresses: {},
    burnerB: null, // ephemeral second staker (pk kept in gitignored state only)
    entropyCommitment: null,
    entropyChainFile: ENTROPY_FILE,
    checkpoints: { deployAssert: false, watcherStarted: false, tablesSet: false },
    drills: {},
    metrics: {},
    surprises: [],
    startedAt: null,
    finishedAt: null,
  };
}

function loadState() {
  if (!existsSync(STATE_FILE)) return defaultState();
  return { ...defaultState(), ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function addSurprise(state, msg) {
  state.surprises.push({ at: new Date().toISOString(), msg });
  saveState(state);
}

function logDrill(id, line) {
  mkdirSync(DRILL_LOG_DIR, { recursive: true });
  appendFileSync(join(DRILL_LOG_DIR, `${id}.log`), `[${new Date().toISOString()}] ${line}\n`);
  console.log(`[${id}] ${line}`);
}

function recordDrill(state, id, result) {
  state.drills[id] = { ...result, at: new Date().toISOString() };
  saveState(state);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function confirm(prompt) {
  if (process.env.REHEARSAL_YES === "1") {
    console.log(`${prompt} (REHEARSAL_YES=1 — continuing)`);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolvePromise) => {
    rl.question(`${prompt}\nPress ENTER to continue (Ctrl+C to abort)… `, () => {
      rl.close();
      resolvePromise();
    });
  });
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || REPO_ROOT,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    shell: false,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
  return `${r.stdout || ""}${r.stderr || ""}`;
}

function encodePrizeTable(rows) {
  return AbiCoder.defaultAbiCoder().encode(
    ["tuple(address asset,uint96 amountOrBps,bool isBpsOfPool,uint32 cumOdds)[]"],
    [rows],
  );
}

function bootstrapTables(scratch) {
  const premium = [
    { asset: scratch, amountOrBps: 1n * 10n ** 18n, isBpsOfPool: false, cumOdds: 100_000 },
    { asset: ZeroAddress, amountOrBps: 0n, isBpsOfPool: false, cumOdds: 1_000_000 },
  ];
  const standard = [
    { asset: scratch, amountOrBps: 1n * 10n ** 18n, isBpsOfPool: false, cumOdds: 50_000 },
    { asset: ZeroAddress, amountOrBps: 0n, isBpsOfPool: false, cumOdds: 1_000_000 },
  ];
  return {
    premium: encodePrizeTable(premium),
    standard: encodePrizeTable(standard),
  };
}

function parseDeployLog(stdout, label) {
  const re = new RegExp(`${label}\\s+(0x[a-fA-F0-9]{40})`);
  const m = stdout.match(re);
  if (!m) throw new Error(`Could not parse ${label} from forge output`);
  return getAddress(m[1]);
}

function parseEqLog(stdout, key) {
  const re = new RegExp(`${key}=\\s*(0x[a-fA-F0-9]{64}|0x[a-fA-F0-9]{40})`);
  const m = stdout.match(re);
  if (!m) throw new Error(`Could not parse ${key}= from output`);
  return m[1];
}

async function sendAndLog(drillId, txPromise, label) {
  const tx = await txPromise;
  logDrill(drillId, `${label} submitted ${tx.hash}`);
  const receipt = await tx.wait();
  logDrill(
    drillId,
    `${label} confirmed block=${receipt.blockNumber} gasUsed=${receipt.gasUsed.toString()} status=${receipt.status} tx=${tx.hash}`,
  );
  if (receipt.status !== 1) throw new Error(`${label} reverted`);
  return { tx, receipt };
}

async function waitUntilTickets(staking, user, minTickets, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const bal = await staking.ticketsOf(user);
    if (bal >= minTickets) return bal;
    await sleep(5_000);
  }
  throw new Error(`ticketsOf timeout: need >= ${minTickets}`);
}

function parseRequestId(receipt, iface) {
  for (const log of receipt.logs) {
    try {
      const p = iface.parseLog(log);
      if (p && (p.name === "ScratchRequested" || p.name === "ScratchBatch")) {
        return p.args.requestId ?? p.args[3];
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

async function waitForBatchSettle(provider, game, requestId, expectedCards, timeoutMs = 180_000) {
  const start = Date.now();
  const iface = new Interface(GAME_ABI);
  const settledTopic = ethId(
    "ScratchSettled(address,uint256,uint8,uint8,uint256,address,uint256)",
  );
  const lateTopic = ethId("ScratchLateFulfillment(address,uint256,uint8,uint8)");
  const fromBlock = Math.max(0, (await provider.getBlockNumber()) - 20);

  while (Date.now() - start < timeoutMs) {
    const req = await game.requests(requestId);
    if (Number(req.status) === STATUS.Settled || Number(req.status) === STATUS.Rescued) {
      const tip = await provider.getBlockNumber();
      const from = Math.max(0, tip - 9_000, fromBlock);
      const allLogs = await provider.getLogs({
        address: await game.getAddress(),
        fromBlock: from,
        toBlock: tip,
        topics: [[settledTopic, lateTopic]],
      });
      const settled = [];
      let late = null;
      for (const log of allLogs) {
        let parsed;
        try {
          parsed = iface.parseLog(log);
        } catch {
          continue;
        }
        if (!parsed || BigInt(parsed.args.requestId) !== BigInt(requestId)) continue;
        if (parsed.name === "ScratchSettled") settled.push(parsed);
        if (parsed.name === "ScratchLateFulfillment") late = parsed;
      }
      return {
        status: Number(req.status),
        settled,
        late,
        elapsedMs: Date.now() - start,
        count: Number(req.count),
      };
    }
    await sleep(1_500);
  }
  throw new Error(
    `batch settlement timeout for request ${requestId} (expected ${expectedCards} cards)`,
  );
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

function watcherRunning() {
  if (!existsSync(WATCHER_PID)) return false;
  const pid = Number(readFileSync(WATCHER_PID, "utf8").trim());
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startWatcher(env, state) {
  if (watcherRunning()) {
    console.log("v2 watcher already running.");
    state.checkpoints.watcherStarted = true;
    saveState(state);
    return;
  }
  const watchScript = resolve(REPO_ROOT, "ops/entropy-operator/src/watch-and-reveal.js");
  const childEnv = {
    ...process.env,
    RPC_URL: env.RPC_URL,
    PRIVATE_KEY: normalizePk(env.BURNER_OPERATOR_PK),
    OPERATOR_PRIVATE_KEY: normalizePk(env.BURNER_OPERATOR_PK),
    SELF_ENTROPY_ADDRESS: state.addresses.selfEntropy,
    GAME_ADDRESS: state.addresses.game,
    GAME_V2: "1",
    CHAIN_FILE: state.entropyChainFile || ENTROPY_FILE,
    POLL_MS: "2000",
    I_AM_THE_PRODUCTION_HOST: "true", // rehearsal host opt-in; not production .env
  };
  const provider = new JsonRpcProvider(env.RPC_URL);
  const tip = await provider.getBlockNumber();
  childEnv.START_BLOCK = String(
    Math.max(0, tip - 9_000, state.watcherStartBlock ?? tip - 100),
  );
  state.watcherStartBlock = Number(childEnv.START_BLOCK);

  const fd = openSync(WATCHER_LOG, "a");
  const child = spawn(process.execPath, ["--use-system-ca", watchScript], {
    cwd: resolve(REPO_ROOT, "ops/entropy-operator"),
    env: childEnv,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  writeFileSync(WATCHER_PID, String(child.pid));
  state.checkpoints.watcherStarted = true;
  saveState(state);
  console.log(`v2 watcher pid=${child.pid} START_BLOCK=${childEnv.START_BLOCK}`);
}

function stopWatcher() {
  if (!existsSync(WATCHER_PID)) {
    console.log("No watcher-v2.pid");
    return;
  }
  const pid = Number(readFileSync(WATCHER_PID, "utf8").trim());
  try {
    process.kill(pid, "SIGTERM");
    console.log(`SIGTERM watcher-v2 pid=${pid}`);
  } catch (e) {
    console.warn(`Watcher kill: ${e.message}`);
  }
  try {
    unlinkSync(WATCHER_PID);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function phasePrep(env) {
  const provider = new JsonRpcProvider(env.RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== CHAIN_ID) {
    console.warn(`WARNING: RPC chainId=${net.chainId} (expected ${CHAIN_ID})`);
  }

  const deployer = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK), provider);
  const operator = new Wallet(normalizePk(env.BURNER_OPERATOR_PK), provider);
  const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);

  const [db, ob, ub] = await Promise.all([
    provider.getBalance(deployer.address),
    provider.getBalance(operator.address),
    provider.getBalance(user.address),
  ]);

  console.log("");
  console.log("=== v2 rehearsal burners ===");
  console.log(`  deployer: ${deployer.address}  ${formatEther(db)} ETH`);
  console.log(`  operator: ${operator.address}  ${formatEther(ob)} ETH`);
  console.log(`  user A:   ${user.address}  ${formatEther(ub)} ETH`);
  console.log("  user B:   (ephemeral — generated in state-v2.json, funded from deployer)");
  console.log("");

  await confirm("Confirm burners funded on chain 4663 (v2 rehearsal).");
  const state = loadState();
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  state.addresses.deployer = deployer.address;
  state.addresses.operator = operator.address;
  state.addresses.user = user.address;

  if (!state.burnerB?.pk) {
    const b = Wallet.createRandom();
    state.burnerB = { address: b.address, pk: b.privateKey };
    const fundTx = await deployer.sendTransaction({
      to: b.address,
      value: parseEther("0.0005"),
    });
    await fundTx.wait();
    console.log(`Funded ephemeral burner B ${b.address}`);
  }
  state.addresses.userB = state.burnerB.address;
  saveState(state);
  return state;
}

async function phasePrepQuiet(env, state) {
  const provider = new JsonRpcProvider(env.RPC_URL);
  state.addresses.deployer = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK), provider).address;
  state.addresses.operator = new Wallet(normalizePk(env.BURNER_OPERATOR_PK), provider).address;
  state.addresses.user = new Wallet(normalizePk(env.BURNER_USER_PK), provider).address;
  if (state.burnerB?.address) state.addresses.userB = state.burnerB.address;
  saveState(state);
  return state;
}

async function phaseToken(env, state) {
  if (state.addresses.token && state.addresses.unbackedAsset) {
    console.log("Token already deployed — skip.");
    return state;
  }
  const out = run(
    "forge",
    [
      "script",
      "rehearsal/DeployRehearsalToken.s.sol:DeployRehearsalToken",
      "--rpc-url",
      env.RPC_URL,
      "--broadcast",
      "--slow",
      "-vv",
    ],
    { env: { PRIVATE_KEY: normalizePk(env.BURNER_DEPLOYER_PK) } },
  );
  state.addresses.token = getAddress(parseEqLog(out, "REHEARSAL_TOKEN"));
  state.addresses.unbackedAsset = getAddress(parseEqLog(out, "UNBACKED_ASSET"));
  saveState(state);
  return state;
}

async function phaseEntropy(state) {
  if (state.entropyCommitment && existsSync(ENTROPY_FILE)) {
    console.log("Entropy chain present — skip.");
    return state;
  }
  if (!existsSync(resolve(REPO_ROOT, "ops/entropy-operator/node_modules"))) {
    run("npm", ["install", "--silent"], { cwd: resolve(REPO_ROOT, "ops/entropy-operator") });
  }
  const out = run(process.execPath, [GENERATE_CHAIN, "--n", "10000"], {
    env: { CHAIN_FILE: ENTROPY_FILE },
    cwd: resolve(REPO_ROOT, "ops/entropy-operator"),
  });
  state.entropyCommitment = parseEqLog(out, "ENTROPY_COMMITMENT");
  state.entropyChainFile = ENTROPY_FILE;
  saveState(state);
  console.log(`Entropy commitment: ${state.entropyCommitment}`);
  return state;
}

async function phaseDeploy(env, state) {
  if (state.checkpoints.deployAssert && state.addresses.game) {
    console.log("Deploy3 already done (checkpoint 1) — skip.");
    return state;
  }
  if (!state.addresses.token) throw new Error("Run token first");
  if (!state.entropyCommitment) throw new Error("Run entropy first");

  const deployer = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK));
  const tables = bootstrapTables(state.addresses.token);
  const deployEnv = {
    PRIVATE_KEY: normalizePk(env.BURNER_DEPLOYER_PK),
    SCRATCH: state.addresses.token,
    TREASURY: deployer.address,
    EMISSION_RATE: EMISSION_RATE.toString(),
    MIN_STAKE: MIN_STAKE.toString(),
    RESCUE_DELAY: String(RESCUE_DELAY),
    PROMO_DAILY_CAP: PROMO_DAILY_CAP.toString(),
    UNLOCK_NORMAL: String(UNLOCK_NORMAL),
    UNLOCK_ENHANCED: String(UNLOCK_ENHANCED),
    BOOST_BPS: String(BOOST_BPS),
    BURN_BPS: String(BURN_BPS),
    RANDOMNESS_PROVIDER: "self",
    OPERATOR: state.addresses.operator || new Wallet(normalizePk(env.BURNER_OPERATOR_PK)).address,
    ENTROPY_COMMITMENT: state.entropyCommitment,
    PREMIUM_PRIZE_TABLE: tables.premium,
    STANDARD_PRIZE_TABLE: tables.standard,
  };

  console.log("Running Deploy3 (v2 stack, RESCUE_DELAY=600, unlock 300/900)…");
  const out = run(
    "forge",
    ["script", "script/Deploy3.s.sol:Deploy3", "--rpc-url", env.RPC_URL, "--broadcast", "--slow", "-vv"],
    { env: deployEnv },
  );

  state.addresses.prizeVault = parseDeployLog(out, "PrizeVault:");
  state.addresses.stakingVault = parseDeployLog(out, "StakingVaultV2:");
  state.addresses.standardSource = parseDeployLog(out, "StandardTicketSource:");
  state.addresses.selfEntropy = parseDeployLog(out, "Randomness provider:");
  state.addresses.game = parseDeployLog(out, "ScratchGameV2:");
  state.checkpoints.deployAssert = true;
  saveState(state);
  console.log("Checkpoint 1 PASS — Deploy3 assertion block succeeded.");

  const provider = new JsonRpcProvider(env.RPC_URL);
  const w = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK), provider);
  for (const [name, addr, abi] of [
    ["ScratchGameV2", state.addresses.game, ["function acceptOwnership()", "function owner() view returns (address)"]],
    ["PrizeVault", state.addresses.prizeVault, ["function acceptOwnership()", "function owner() view returns (address)"]],
    ["StandardTicketSource", state.addresses.standardSource, ["function acceptOwnership()", "function owner() view returns (address)"]],
  ]) {
    const c = new Contract(addr, abi, w);
    if ((await c.owner()).toLowerCase() === w.address.toLowerCase()) {
      console.log(`${name} already owned.`);
      continue;
    }
    await (await c.acceptOwnership()).wait();
    console.log(`Accepted ownership: ${name}`);
  }
  // SelfEntropy already transferred in Deploy3 (Ownable)
  return state;
}

async function phaseFund(env, state) {
  if (!state.addresses.game) throw new Error("Run deploy first");
  const provider = new JsonRpcProvider(env.RPC_URL);
  const w = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK), provider);
  const token = new Contract(state.addresses.token, ERC20_ABI, w);
  const vault = new Contract(state.addresses.prizeVault, VAULT_ABI, w);

  const bal = await token.balanceOf(state.addresses.prizeVault);
  if (bal < FUND_AMOUNT) {
    await (await token.approve(state.addresses.prizeVault, FUND_AMOUNT)).wait();
    await (await vault.fund(state.addresses.token, FUND_AMOUNT)).wait();
    console.log(`Funded PrizeVault with ${FUND_AMOUNT} REHEARSAL`);
  } else {
    console.log("PrizeVault already funded with REHEARSAL.");
  }

  // Dust real USDG (best-effort — may be zero on burner)
  try {
    const usdg = new Contract(USDG, ERC20_ABI, w);
    const uBal = await usdg.balanceOf(w.address);
    if (uBal > 0n) {
      const dust = uBal < USDG_DUST ? uBal : USDG_DUST;
      await (await usdg.approve(state.addresses.prizeVault, dust)).wait();
      await (await vault.fund(USDG, dust)).wait();
      try {
        await (await vault.setFallbackRate(USDG, 10n ** 18n)).wait();
      } catch (e) {
        addSurprise(state, `setFallbackRate USDG: ${e.shortMessage || e.message}`);
      }
      console.log(`Funded PrizeVault with ${dust} USDG dust`);
    } else {
      addSurprise(state, "Deployer has 0 USDG — skipped real-asset dust fund (throwaway-only rehearsal)");
    }
  } catch (e) {
    addSurprise(state, `USDG fund skipped: ${e.shortMessage || e.message}`);
  }

  // Seed both stakers
  const userA = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
  const userB = new Wallet(normalizePk(state.burnerB.pk), provider);
  for (const u of [userA, userB]) {
    const b = await token.balanceOf(u.address);
    if (b < USER_STAKE * 20n) {
      await (await token.transfer(u.address, USER_STAKE * 50n)).wait();
      console.log(`Seeded ${u.address} with REHEARSAL`);
    }
  }

  console.log("Setting v2 rehearsal prize tables…");
  run(
    "forge",
    [
      "script",
      "rehearsal/SetRehearsalTablesV2.s.sol:SetRehearsalTablesV2",
      "--rpc-url",
      env.RPC_URL,
      "--broadcast",
      "--slow",
      "-vv",
    ],
    {
      env: {
        PRIVATE_KEY: normalizePk(env.BURNER_DEPLOYER_PK),
        GAME: state.addresses.game,
        SCRATCH: state.addresses.token,
        UNBACKED_ASSET: state.addresses.unbackedAsset,
      },
    },
  );
  state.checkpoints.tablesSet = true;
  saveState(state);
  return state;
}

async function phaseWatcher(env, state) {
  if (!state.addresses.selfEntropy) throw new Error("Run deploy first");
  await startWatcher(env, state);
  console.log("Checkpoint 2 PASS — v2 operator watcher running.");
  await sleep(3_000);
  return state;
}

// ---------------------------------------------------------------------------
// Drills V1–V8
// ---------------------------------------------------------------------------

async function drillV1(env, state) {
  const id = "V1";
  try {
    const provider = new JsonRpcProvider(env.RPC_URL);
    const a = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
    const b = new Wallet(normalizePk(state.burnerB.pk), provider);
    const tokenA = new Contract(state.addresses.token, ERC20_ABI, a);
    const tokenB = new Contract(state.addresses.token, ERC20_ABI, b);
    const stakingA = new Contract(state.addresses.stakingVault, STAKING_ABI, a);
    const stakingB = new Contract(state.addresses.stakingVault, STAKING_ABI, b);

    for (const [label, wallet, token, staking, tier] of [
      ["A", a, tokenA, stakingA, TIER_NORMAL],
      ["B", b, tokenB, stakingB, TIER_ENHANCED],
    ]) {
      const u = await staking.users(wallet.address);
      if (u.staked < USER_STAKE) {
        await sendAndLog(id, token.approve(state.addresses.stakingVault, USER_STAKE), `approve ${label}`);
        await sendAndLog(id, staking.deposit(USER_STAKE, tier), `deposit ${label} tier=${tier}`);
      } else {
        logDrill(id, `${label} already staked ${u.staked} tier=${u.tier}`);
      }
    }

    // Snapshot AFTER both positions exist so A's solo head-start is excluded.
    // Compare deltas over the window (BOOST_BPS=2000 → B ≈ 1.2× A at equal stake).
    await sleep(3_000);
    const t0A = await stakingA.ticketsOf(a.address);
    const t0B = await stakingB.ticketsOf(b.address);
    logDrill(id, `t0 ticketsA=${t0A} ticketsB=${t0B}`);
    logDrill(id, `waiting ${ACCRUAL_WINDOW_S}s accrual window…`);
    await sleep(ACCRUAL_WINDOW_S * 1000);

    const t1A = await stakingA.ticketsOf(a.address);
    const t1B = await stakingB.ticketsOf(b.address);
    const deltaA = t1A - t0A;
    const deltaB = t1B - t0B;
    logDrill(id, `t1 ticketsA=${t1A} ticketsB=${t1B} deltaA=${deltaA} deltaB=${deltaB}`);
    if (deltaA <= 0n) throw new Error(`A accrued nothing (deltaA=${deltaA})`);
    const ratio = Number(deltaB) / Number(deltaA);
    const ok = ratio > 1.15 && ratio < 1.25;
    if (!ok) throw new Error(`expected ΔB≈1.2×ΔA, got ratio=${ratio}`);

    recordDrill(state, id, {
      status: "PASS",
      ticketsA: t1A.toString(),
      ticketsB: t1B.toString(),
      deltaA: deltaA.toString(),
      deltaB: deltaB.toString(),
      ratio,
    });
    logDrill(id, `PASS deltaRatio=${ratio.toFixed(4)}`);
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    throw e;
  }
}

async function drillV2(env, state) {
  const id = "V2";
  try {
    const provider = new JsonRpcProvider(env.RPC_URL);
    const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
    const staking = new Contract(state.addresses.stakingVault, STAKING_ABI, user);
    const game = new Contract(state.addresses.game, GAME_ABI, user);
    const entropy = new Contract(state.addresses.selfEntropy, ENTROPY_ABI, provider);
    const iface = new Interface(GAME_ABI);

    await waitUntilTickets(staking, user.address, TICKET_COST * 40n, 300_000);

    // --- batch path ---
    const tipBefore = await provider.getBlockNumber();
    const t0 = Date.now();
    const { receipt: batchReceipt, tx: batchTx } = await sendAndLog(
      id,
      game.scratchMany(PREMIUM, 20),
      "scratchMany(PREMIUM, 20)",
    );
    const requestId = parseRequestId(batchReceipt, iface);
    if (requestId == null) throw new Error("no requestId from scratchMany");
    logDrill(id, `batch requestId=${requestId}`);

    // Exactly one RandomnessRequested for this id
    const tip = await provider.getBlockNumber();
    const reqLogs = await entropy.queryFilter(
      entropy.filters.RandomnessRequested(requestId),
      Math.max(0, tipBefore - 5),
      tip,
    );
    if (reqLogs.length !== 1) {
      throw new Error(`expected 1 RandomnessRequested, got ${reqLogs.length}`);
    }

    const settle = await waitForBatchSettle(provider, game, requestId, 20);
    const batchLatency = settle.elapsedMs;
    if (settle.status !== STATUS.Settled) throw new Error(`batch status=${settle.status}`);
    if (settle.settled.length !== 20) {
      throw new Error(`expected 20 ScratchSettled, got ${settle.settled.length}`);
    }
    const indexes = settle.settled.map((p) => Number(p.args.cardIndex)).sort((x, y) => x - y);
    for (let i = 0; i < 20; i++) {
      if (indexes[i] !== i) throw new Error(`cardIndex gap: ${indexes.join(",")}`);
    }

    // Aggregation check: per-card ScratchSettled sums == PrizePaid on fulfill tx
    const cardSums = new Map();
    for (const p of settle.settled) {
      const asset = (p.args.asset || ZeroAddress).toLowerCase();
      const amt = BigInt(p.args.amount);
      if (asset === ZeroAddress.toLowerCase() || amt === 0n) continue;
      cardSums.set(asset, (cardSums.get(asset) || 0n) + amt);
    }
    logDrill(
      id,
      `batch latencyMs=${batchLatency} gas scratchMany=${batchReceipt.gasUsed} payingAssets=${cardSums.size}`,
    );

    let fulfillGas = null;
    let fulfillReceipt = null;
    try {
      const ful = await entropy.queryFilter(entropy.filters.RandomnessFulfilled(requestId));
      if (ful.length) {
        fulfillReceipt = await provider.getTransactionReceipt(ful[0].transactionHash);
        fulfillGas = fulfillReceipt.gasUsed;
      }
    } catch (e) {
      addSurprise(state, `V2 fulfill gas: ${e.message}`);
    }

    if (fulfillReceipt) {
      const paidIface = new Interface(PRIZE_PAID_ABI);
      const paidSums = new Map();
      for (const log of fulfillReceipt.logs) {
        try {
          const p = paidIface.parseLog(log);
          if (!p || p.name !== "PrizePaid") continue;
          if (getAddress(p.args.to) !== getAddress(user.address)) continue;
          const asset = getAddress(p.args.asset).toLowerCase();
          paidSums.set(asset, (paidSums.get(asset) || 0n) + BigInt(p.args.amount));
        } catch {
          /* skip */
        }
      }
      for (const [asset, sum] of cardSums) {
        const paid = paidSums.get(asset) || 0n;
        // Fallback may pay SCRATCH instead of the row asset — allow either match or surprise.
        if (paid !== sum) {
          const scratchPaid = paidSums.get(state.addresses.token.toLowerCase()) || 0n;
          if (scratchPaid > 0n && paid === 0n) {
            addSurprise(
              state,
              `V2 asset ${asset} cardSum=${sum} fell back (PrizePaid on SCRATCH=${scratchPaid})`,
            );
          } else if (paid !== sum) {
            throw new Error(`aggregate mismatch asset=${asset} cards=${sum} paid=${paid}`);
          }
        }
      }
      logDrill(id, `aggregate payouts OK (${paidSums.size} PrizePaid asset(s))`);
    } else if (cardSums.size > 0) {
      addSurprise(state, "V2: could not load fulfill receipt for PrizePaid aggregation check");
    }

    // --- 20 singles comparison (gas/latency sample) ---
    await waitUntilTickets(staking, user.address, TICKET_COST * 20n, 300_000);
    const singleGas = [];
    const singleLatencies = [];
    for (let i = 0; i < 20; i++) {
      const s0 = Date.now();
      const { receipt } = await sendAndLog(id, game.scratch(PREMIUM), `scratch single #${i + 1}`);
      singleGas.push(receipt.gasUsed);
      const rid = parseRequestId(receipt, iface);
      const s = await waitForBatchSettle(provider, game, rid, 1, 120_000);
      singleLatencies.push(s.elapsedMs);
    }
    const sumSingleGas = singleGas.reduce((a, b) => a + b, 0n);
    const sumSingleLatency = singleLatencies.reduce((a, b) => a + b, 0);

    state.metrics.batchScratchManyGas = batchReceipt.gasUsed.toString();
    state.metrics.batchFulfillGas = fulfillGas?.toString() ?? null;
    state.metrics.batchLatencyMs = batchLatency;
    state.metrics.batchTx = batchTx.hash;
    state.metrics.singlesScratchGasSum = sumSingleGas.toString();
    state.metrics.singlesLatencySumMs = sumSingleLatency;
    state.metrics.singlesLatencyAvgMs = Math.round(sumSingleLatency / 20);
    saveState(state);

    if (batchLatency > 15_000) {
      addSurprise(state, `V2 batch latency ${batchLatency}ms > 15s (target ~3s)`);
    }

    recordDrill(state, id, {
      status: "PASS",
      requestId: requestId.toString(),
      batchLatencyMs: batchLatency,
      batchGas: batchReceipt.gasUsed.toString(),
      singlesGasSum: sumSingleGas.toString(),
      singlesLatencySumMs: sumSingleLatency,
      tx: batchTx.hash,
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    throw e;
  }
}

async function drillV3(env, state) {
  const id = "V3";
  try {
    const provider = new JsonRpcProvider(env.RPC_URL);
    const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
    const token = new Contract(state.addresses.token, ERC20_ABI, user);
    const staking = new Contract(state.addresses.stakingVault, STAKING_ABI, user);
    const game = new Contract(state.addresses.game, GAME_ABI, user);

    // Ensure stake + banked
    let u = await staking.users(user.address);
    if (u.staked < USER_STAKE) {
      await sendAndLog(id, token.approve(state.addresses.stakingVault, USER_STAKE), "approve");
      await sendAndLog(id, staking.deposit(USER_STAKE, TIER_NORMAL), "deposit NORMAL");
    }
    await sleep(30_000);
    // Settle pending into banked via dust deposit
    await sendAndLog(id, token.approve(state.addresses.stakingVault, 1n), "approve dust");
    await sendAndLog(id, staking.deposit(1n, Number((await staking.users(user.address)).tier)), "dust settle");

    u = await staking.users(user.address);
    const stakedBefore = u.staked;
    const unlockAmt = (stakedBefore * 60n) / 100n;
    if (unlockAmt === 0n) throw new Error("unlockAmt=0");
    logDrill(id, `staked=${stakedBefore} unlockAmt=${unlockAmt} (60%)`);

    const { receipt: unlockReceipt } = await sendAndLog(
      id,
      staking.requestUnlock(unlockAmt),
      "requestUnlock 60%",
    );
    const stakingIface = new Interface(STAKING_ABI);
    let burned = null;
    for (const log of unlockReceipt.logs) {
      try {
        const p = stakingIface.parseLog(log);
        if (p?.name === "UnlockRequested") {
          burned = BigInt(p.args.ticketsBurned);
          break;
        }
      } catch {
        /* skip */
      }
    }
    if (burned == null) throw new Error("UnlockRequested not found");

    // banked_at_burn = banked_after + burned (settle happened inside requestUnlock)
    u = await staking.users(user.address);
    const bankedAtBurn = u.banked + burned;
    const expectedBurn =
      (bankedAtBurn * BigInt(BURN_BPS) * unlockAmt) / (10_000n * stakedBefore);
    if (burned !== expectedBurn) {
      throw new Error(
        `burn ${burned} != floor(banked×0.5×0.6)=${expectedBurn} (bankedAtBurn=${bankedAtBurn})`,
      );
    }
    logDrill(id, `PASS burn math burned=${burned} bankedAtBurn=${bankedAtBurn}`);

    // Scratch a surviving ticket during unlock window
    const tickets = await staking.ticketsOf(user.address);
    if (tickets < TICKET_COST) {
      await waitUntilTickets(staking, user.address, TICKET_COST, 120_000);
    }
    await sendAndLog(id, game.scratch(PREMIUM), "scratch during unlock window");

    recordDrill(state, id, {
      status: "PASS",
      bankedAtBurn: bankedAtBurn.toString(),
      burned: burned.toString(),
      expectedBurn: expectedBurn.toString(),
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    throw e;
  }
}

async function drillV4(env, state) {
  const id = "V4";
  try {
    const provider = new JsonRpcProvider(env.RPC_URL);
    const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
    const staking = new Contract(state.addresses.stakingVault, STAKING_ABI, user);

    const slot = await staking.unlocking(user.address);
    if (slot.amount === 0n) {
      // ensure something unlocking
      const u = await staking.users(user.address);
      if (u.staked === 0n) throw new Error("no stake for V4 — run V3 first");
      await sendAndLog(id, staking.requestUnlock(u.staked), "requestUnlock full for claim drill");
    }

    let earlyRevert = false;
    try {
      await staking.claimUnlocked.staticCall();
      await staking.claimUnlocked();
    } catch (e) {
      earlyRevert = true;
      logDrill(id, `claim before release reverted: ${e.shortMessage || e.message}`);
    }
    if (!earlyRevert) throw new Error("claimUnlocked should revert before releaseAt");

    const unlock = await staking.unlocking(user.address);
    const now = (await provider.getBlock("latest")).timestamp;
    const waitS = Math.max(0, Number(unlock.releaseAt) - Number(now) + 5);
    logDrill(id, `waiting ${waitS}s for releaseAt=${unlock.releaseAt}`);
    await sleep(waitS * 1000);

    // Full exit path: unlock any remaining stake first so claim leaves staked==0
    let u = await staking.users(user.address);
    if (u.staked > 0n) {
      await sendAndLog(id, staking.requestUnlock(u.staked), "unlock remainder for full exit");
      const unlock2 = await staking.unlocking(user.address);
      const now2 = (await provider.getBlock("latest")).timestamp;
      await sleep(Math.max(0, Number(unlock2.releaseAt) - Number(now2) + 5) * 1000);
    }

    u = await staking.users(user.address);
    const ticketsBefore = await staking.ticketsOf(user.address);
    await sendAndLog(id, staking.claimUnlocked(), "claimUnlocked full exit");
    u = await staking.users(user.address);
    const ticketsAfter = await staking.ticketsOf(user.address);
    if (u.staked !== 0n) throw new Error("staked not zero after full exit claim");
    if (u.tier !== 0) throw new Error(`tier not reset (got ${u.tier})`);
    if (u.banked !== 0n || ticketsAfter !== 0n) {
      throw new Error(`terminal burn incomplete banked=${u.banked} tickets=${ticketsAfter}`);
    }

    recordDrill(state, id, {
      status: "PASS",
      earlyRevert: true,
      ticketsBefore: ticketsBefore.toString(),
      tierReset: true,
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    throw e;
  }
}

async function drillV5(env, state) {
  const id = "V5";
  try {
    const provider = new JsonRpcProvider(env.RPC_URL);
    const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
    const token = new Contract(state.addresses.token, ERC20_ABI, user);
    const staking = new Contract(state.addresses.stakingVault, STAKING_ABI, user);

    // Fresh stake after V4 exit
    await sendAndLog(id, token.approve(state.addresses.stakingVault, USER_STAKE), "approve");
    await sendAndLog(id, staking.deposit(USER_STAKE, TIER_NORMAL), "deposit NORMAL");
    await sleep(20_000);
    await sendAndLog(id, staking.deposit(1n, TIER_NORMAL), "settle");

    const ticketsBefore = await staking.ticketsOf(user.address);
    const u0 = await staking.users(user.address);
    const bankedBefore = u0.banked;
    const weightBefore = await staking.totalWeight();

    await sendAndLog(id, staking.requestUnlock(USER_STAKE / 2n), "requestUnlock half");
    const uMid = await staking.users(user.address);
    const bankedMid = uMid.banked; // after proportional burn
    const weightMid = await staking.totalWeight();

    await sendAndLog(id, staking.cancelUnlock(), "cancelUnlock");
    const ticketsAfter = await staking.ticketsOf(user.address);
    const weightAfter = await staking.totalWeight();
    const slot = await staking.unlocking(user.address);
    const u1 = await staking.users(user.address);

    if (slot.amount !== 0n) throw new Error("unlocking not cleared");
    // cancelUnlock may settle pending into banked, but must not burn again
    if (u1.banked < bankedMid) {
      throw new Error(`banked shrunk on cancel ${bankedMid} → ${u1.banked}`);
    }
    if (u1.staked < u0.staked) throw new Error("stake not restored");
    if (weightAfter <= weightMid) throw new Error("weight not restored");

    // Accrual resumes
    await sleep(15_000);
    const ticketsLater = await staking.ticketsOf(user.address);
    if (ticketsLater <= ticketsAfter) {
      addSurprise(state, `V5 accrual after cancel flat (${ticketsAfter} → ${ticketsLater}) — check eligibility`);
    }

    recordDrill(state, id, {
      status: "PASS",
      ticketsBefore: ticketsBefore.toString(),
      bankedBefore: bankedBefore.toString(),
      bankedAfterCancel: u1.banked.toString(),
      weightBefore: weightBefore.toString(),
      weightAfter: weightAfter.toString(),
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    throw e;
  }
}

async function drillV6(env, state) {
  const id = "V6";
  try {
    stopWatcher();
    await sleep(2_000);

    const provider = new JsonRpcProvider(env.RPC_URL);
    const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
    const staking = new Contract(state.addresses.stakingVault, STAKING_ABI, user);
    const game = new Contract(state.addresses.game, GAME_ABI, user);
    const iface = new Interface(GAME_ABI);

    await waitUntilTickets(staking, user.address, TICKET_COST * 5n, 300_000);
    const ticketsBefore = await staking.ticketsOf(user.address);
    const { receipt } = await sendAndLog(id, game.scratchMany(PREMIUM, 5), "scratchMany(_,5) watcher dead");
    const requestId = parseRequestId(receipt, iface);
    const ticketsAfterScratch = await staking.ticketsOf(user.address);
    if (ticketsBefore - ticketsAfterScratch !== TICKET_COST * 5n) {
      throw new Error(`expected spend 5 tickets, delta=${ticketsBefore - ticketsAfterScratch}`);
    }

    logDrill(id, `waiting ${RESCUE_DELAY + 10}s for rescue…`);
    await sleep((RESCUE_DELAY + 10) * 1000);
    const mid = await staking.ticketsOf(user.address);
    await sendAndLog(id, game.rescue(requestId), "rescue batch");
    const after = await staking.ticketsOf(user.address);
    if (after - mid !== TICKET_COST * 5n) {
      throw new Error(`rescue refund ${(after - mid).toString()} != 5e18`);
    }
    const req = await game.requests(requestId);
    if (Number(req.status) !== STATUS.Rescued) throw new Error("not rescued");
    if (Number(req.count) !== 5) throw new Error(`count=${req.count}`);

    await startWatcher(env, state);
    await sleep(3_000);

    // Late fulfill: poll for ScratchLateFulfillment(count=5); no payout / status stays Rescued
    const lateTopic = ethId("ScratchLateFulfillment(address,uint256,uint8,uint8)");
    const fromBlock = Math.max(0, (await provider.getBlockNumber()) - 50);
    let late = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const tip = await provider.getBlockNumber();
      const logs = await provider.getLogs({
        address: state.addresses.game,
        fromBlock: Math.max(0, tip - 9_000, fromBlock),
        toBlock: tip,
        topics: [lateTopic],
      });
      const iface = new Interface(GAME_ABI);
      for (const log of logs) {
        try {
          const p = iface.parseLog(log);
          if (p && BigInt(p.args.requestId) === BigInt(requestId)) {
            late = p;
            break;
          }
        } catch {
          /* skip */
        }
      }
      if (late) break;
      await sleep(2_000);
    }
    if (late) {
      if (Number(late.args.count) !== 5) {
        throw new Error(`late count=${late.args.count}`);
      }
      logDrill(id, "ScratchLateFulfillment count=5 observed (no payout)");
    } else {
      logDrill(id, "no late fulfill observed within window");
      addSurprise(state, "V6: late fulfill event not observed — status remains Rescued");
    }

    const finalReq = await game.requests(requestId);
    if (Number(finalReq.status) !== STATUS.Rescued) {
      throw new Error(`expected Rescued after late window, got ${finalReq.status}`);
    }

    recordDrill(state, id, {
      status: "PASS",
      requestId: requestId.toString(),
      refunded: (TICKET_COST * 5n).toString(),
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    try {
      await startWatcher(env, state);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

async function drillV7(env, state) {
  const id = "V7";
  try {
    const provider = new JsonRpcProvider(env.RPC_URL);
    const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
    const token = new Contract(state.addresses.token, ERC20_ABI, user);
    const staking = new Contract(state.addresses.stakingVault, STAKING_ABI, user);

    let u = await staking.users(user.address);
    if (u.tier === 0 || u.staked < MIN_STAKE) {
      await sendAndLog(id, token.approve(state.addresses.stakingVault, USER_STAKE), "approve");
      await sendAndLog(id, staking.deposit(USER_STAKE, TIER_NORMAL), "deposit NORMAL");
    } else if (Number(u.tier) === TIER_ENHANCED) {
      // Need NORMAL for upgrade — full exit + restake (slow). Prefer burner B if A is enhanced.
      addSurprise(state, "V7: user already ENHANCED — using ephemeral B if NORMAL");
      const b = new Wallet(normalizePk(state.burnerB.pk), provider);
      const tokenB = new Contract(state.addresses.token, ERC20_ABI, b);
      const stakingB = new Contract(state.addresses.stakingVault, STAKING_ABI, b);
      const ub = await stakingB.users(b.address);
      if (Number(ub.tier) !== TIER_NORMAL) {
        if (ub.staked === 0n) {
          await sendAndLog(id, tokenB.approve(state.addresses.stakingVault, USER_STAKE), "approve B");
          await sendAndLog(id, stakingB.deposit(USER_STAKE, TIER_NORMAL), "deposit B NORMAL");
        } else {
          throw new Error("need a NORMAL position for upgradeTier drill");
        }
      }
      // Run upgrade path on B
      await sendAndLog(id, stakingB.requestUnlock(USER_STAKE / 4n), "B requestUnlock before upgrade");
      const slotBefore = await stakingB.unlocking(b.address);
      const releaseBefore = slotBefore.releaseAt;
      await sleep(20_000);
      const tBefore = await stakingB.ticketsOf(b.address);
      await sendAndLog(id, stakingB.upgradeTier(), "B upgradeTier");
      const slotAfter = await stakingB.unlocking(b.address);
      if (slotAfter.releaseAt !== releaseBefore) {
        throw new Error(`releaseAt changed ${releaseBefore} → ${slotAfter.releaseAt}`);
      }
      await sleep(20_000);
      const tAfter = await stakingB.ticketsOf(b.address);
      const delta = tAfter - tBefore;
      logDrill(id, `post-upgrade accrual delta=${delta}`);
      recordDrill(state, id, {
        status: "PASS",
        releaseAtPreserved: releaseBefore.toString(),
        via: "burnerB",
      });
      logDrill(id, "PASS");
      return;
    }

    await sendAndLog(id, staking.requestUnlock(USER_STAKE / 4n), "requestUnlock before upgrade");
    const slotBefore = await staking.unlocking(user.address);
    const releaseBefore = slotBefore.releaseAt;

    await sleep(25_000);
    const t0 = await staking.ticketsOf(user.address);
    await sleep(20_000);
    const t1 = await staking.ticketsOf(user.address);
    const rateBefore = t1 - t0;

    await sendAndLog(id, staking.upgradeTier(), "upgradeTier NORMAL→ENHANCED");
    const slotAfter = await staking.unlocking(user.address);
    if (slotAfter.releaseAt !== releaseBefore) {
      throw new Error(`releaseAt changed on upgrade ${releaseBefore} → ${slotAfter.releaseAt}`);
    }

    // Sole / dominant staker still gets ~100% of emission — rate may not visibly rise.
    // Compare weight instead, and ticket delta vs a peer if present.
    const weight = await staking.totalWeight();
    u = await staking.users(user.address);
    if (Number(u.tier) !== TIER_ENHANCED) throw new Error("tier not ENHANCED");
    logDrill(id, `weight=${weight} rateBefore=${rateBefore}`);

    await sleep(20_000);
    const t2 = await staking.ticketsOf(user.address);
    const rateAfter = t2 - t1;
    logDrill(id, `rateAfter=${rateAfter}`);
    // With another ENHANCED/NORMAL peer, share should increase; if sole, rates ≈ equal.
    if (rateAfter + 1n < rateBefore / 2n) {
      throw new Error("accrual collapsed after upgrade");
    }

    recordDrill(state, id, {
      status: "PASS",
      releaseAtPreserved: releaseBefore.toString(),
      rateBefore: rateBefore.toString(),
      rateAfter: rateAfter.toString(),
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    throw e;
  }
}

async function drillV8(env, state) {
  const id = "V8";
  try {
    const provider = new JsonRpcProvider(env.RPC_URL);
    const treasury = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK), provider);
    const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
    const vault = new Contract(state.addresses.prizeVault, VAULT_ABI, treasury);
    const game = new Contract(state.addresses.game, GAME_ABI, treasury);
    const gameUser = new Contract(state.addresses.game, GAME_ABI, user);
    const staking = new Contract(state.addresses.stakingVault, STAKING_ABI, user);
    const entropy = new Contract(state.addresses.selfEntropy, ENTROPY_ABI, treasury);
    const iface = new Interface(GAME_ABI);

    // --- sweep queue / early execute revert ---
    const { receipt: qReceipt } = await sendAndLog(
      id,
      vault.sweep(state.addresses.token, treasury.address),
      "queue sweep",
    );
    let sweepId;
    const vIface = new Interface(VAULT_ABI);
    for (const log of qReceipt.logs) {
      try {
        const p = vIface.parseLog(log);
        if (p?.name === "SweepQueued") sweepId = p.args.id;
      } catch {
        /* skip */
      }
    }
    let sweepReverted = false;
    try {
      await vault.executeSweep.staticCall(sweepId);
      await vault.executeSweep(sweepId);
    } catch (e) {
      sweepReverted = true;
      logDrill(id, `executeSweep early revert: ${e.shortMessage || e.message}`);
    }
    if (!sweepReverted) throw new Error("sweep early execute should revert");

    // --- randomness swap queue / cancel ---
    const dummy = "0x000000000000000000000000000000000000dEaD";
    await sendAndLog(id, game.queueRandomnessSwap(dummy), "queueRandomnessSwap");
    let swapReverted = false;
    try {
      await game.executeRandomnessSwap.staticCall();
      await game.executeRandomnessSwap();
    } catch (e) {
      swapReverted = true;
      logDrill(id, `executeRandomnessSwap early revert: ${e.shortMessage || e.message}`);
    }
    if (!swapReverted) throw new Error("swap early execute should revert");
    await sendAndLog(id, game.cancelRandomnessSwap(), "cancelRandomnessSwap");
    if ((await game.pendingRandomness()) !== ZeroAddress) throw new Error("pending not cleared");

    // --- epoch orphan → rescue ---
    stopWatcher();
    await sleep(2_000);
    await waitUntilTickets(staking, user.address, TICKET_COST, 300_000);
    const { receipt } = await sendAndLog(id, gameUser.scratch(PREMIUM), "scratch before registerChain");
    const requestId = parseRequestId(receipt, iface);

    if (!existsSync(resolve(REPO_ROOT, "ops/entropy-operator/node_modules"))) {
      run("npm", ["install", "--silent"], { cwd: resolve(REPO_ROOT, "ops/entropy-operator") });
    }
    const out = run(process.execPath, [GENERATE_CHAIN, "--n", "1000"], {
      env: { CHAIN_FILE: ENTROPY_FILE_V8 },
      cwd: resolve(REPO_ROOT, "ops/entropy-operator"),
    });
    const commitment = parseEqLog(out, "ENTROPY_COMMITMENT");
    await sendAndLog(id, entropy.registerChain(commitment), "registerChain new epoch");

    let wrongEpoch = false;
    const oldSecret = JSON.parse(readFileSync(ENTROPY_FILE, "utf8")).secret;
    const op = new Wallet(normalizePk(env.BURNER_OPERATOR_PK), provider);
    const entropyOp = new Contract(state.addresses.selfEntropy, ENTROPY_ABI, op);
    try {
      await entropyOp.reveal(requestId, oldSecret);
      throw new Error("reveal unexpectedly succeeded");
    } catch (e) {
      if (/unexpectedly succeeded/.test(e.message)) throw e;
      wrongEpoch = true;
      logDrill(id, `reveal reverted (orphan): ${e.shortMessage || e.message}`);
    }

    logDrill(id, `waiting ${RESCUE_DELAY + 10}s then rescue orphan…`);
    await sleep((RESCUE_DELAY + 10) * 1000);
    await sendAndLog(id, gameUser.rescue(requestId), "rescue orphan");
    const req = await gameUser.requests(requestId);
    if (Number(req.status) !== STATUS.Rescued) throw new Error("orphan not rescued");

    state.entropyChainFile = ENTROPY_FILE_V8;
    state.entropyCommitment = commitment;
    saveState(state);
    await startWatcher(env, state);

    recordDrill(state, id, {
      status: "PASS",
      sweepReverted,
      swapReverted,
      wrongEpoch,
      orphanRequestId: requestId.toString(),
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    try {
      await startWatcher(env, state);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function writeReport(state) {
  const drills = ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8"];
  const rows = drills.map((d) => {
    const r = state.drills[d];
    const status = r?.status || "SKIP";
    const detail = r?.error || r?.tx || r?.requestId || r?.ratio || "";
    return `| ${d} | ${status} | ${detail} |`;
  });
  const a = state.addresses || {};
  const m = state.metrics || {};
  const md = `# $SCRATCH v2 Rehearsal Report

Generated: ${new Date().toISOString()}
Started: ${state.startedAt || "—"}
Finished: ${state.finishedAt || "—"}

## Drill results

| Drill | Result | Detail |
|-------|--------|--------|
${rows.join("\n")}

## Latency + gas — scratchMany(20) vs 20 singles

| Metric | Value |
|--------|-------|
| Batch request→settle latency (ms) | ${m.batchLatencyMs ?? "—"} |
| scratchMany(20) gas | ${m.batchScratchManyGas ?? "—"} |
| Batch fulfill gas | ${m.batchFulfillGas ?? "—"} |
| Batch tx | ${m.batchTx ?? "—"} |
| 20× scratch gas sum | ${m.singlesScratchGasSum ?? "—"} |
| 20× settle latency sum (ms) | ${m.singlesLatencySumMs ?? "—"} |
| 20× settle latency avg (ms) | ${m.singlesLatencyAvgMs ?? "—"} |

Target: batch settle ~3s (not 20× single latency).

## Deployed addresses

| Contract | Address |
|----------|---------|
| REHEARSAL token | ${a.token || "—"} |
| Unbacked asset | ${a.unbackedAsset || "—"} |
| PrizeVault | ${a.prizeVault || "—"} |
| StakingVaultV2 | ${a.stakingVault || "—"} |
| StandardTicketSource | ${a.standardSource || "—"} |
| SelfEntropyProvider | ${a.selfEntropy || "—"} |
| ScratchGameV2 | ${a.game || "—"} |
| Deployer burner | ${a.deployer || "—"} |
| Operator burner | ${a.operator || "—"} |
| User A (NORMAL path) | ${a.user || "—"} |
| User B (ephemeral) | ${a.userB || "—"} |

## Env (rehearsal)

| Param | Value |
|-------|-------|
| MIN_STAKE | 1e18 |
| EMISSION_RATE | 1e18 |
| RESCUE_DELAY | 600 |
| UNLOCK_NORMAL | 300 |
| UNLOCK_ENHANCED | 900 |
| BOOST_BPS | 2000 |
| BURN_BPS | 5000 |

## SURPRISES

${
  (state.surprises || []).length === 0
    ? "_None recorded._"
    : state.surprises.map((s) => `- **${s.at}**: ${s.msg}`).join("\n")
}

## Reminder

**Retire the burner keys** in \`.env.rehearsal\` and the ephemeral burner B in \`state-v2.json\`.
Do not reuse rehearsal entropy secrets outside \`rehearsal/\`. Abandon this deployment — production uses fresh keys + Deploy3 env.
`;

  writeFileSync(REPORT_FILE, md);
  console.log(`Wrote ${REPORT_FILE}`);
}

function printRetireReminder() {
  console.log("");
  console.log("================================================================");
  console.log("  RETIRE THE BURNERS — do not reuse BURNER_*_PK after this run.");
  console.log("  Ephemeral burner B pk lives only in gitignored state-v2.json.");
  console.log("  Do not reuse the entropy secret outside rehearsal/.");
  console.log("  Abandon this deployment; production uses fresh keys + Deploy3.");
  console.log("================================================================");
  console.log("");
}

async function withContext(fn) {
  assertEnvNotTracked();
  const env = loadEnvFile(ENV_FILE);
  requireKeys(env);
  let state = loadState();
  state = (await fn(env, state)) || state;
  saveState(state);
  return state;
}

async function main() {
  const cmd = (process.argv[2] || "all").toLowerCase();
  mkdirSync(DRILL_LOG_DIR, { recursive: true });

  const drills = {
    v1: drillV1,
    v2: drillV2,
    v3: drillV3,
    v4: drillV4,
    v5: drillV5,
    v6: drillV6,
    v7: drillV7,
    v8: drillV8,
  };

  try {
    if (cmd === "prep") {
      await withContext(async (env) => phasePrep(env));
    } else if (cmd === "token") {
      await withContext(async (env, state) => phaseToken(env, await phasePrepQuiet(env, state)));
    } else if (cmd === "entropy") {
      await withContext(async (env, state) => phaseEntropy(state));
    } else if (cmd === "deploy") {
      await withContext(async (env, state) => phaseDeploy(env, state));
    } else if (cmd === "fund") {
      await withContext(async (env, state) => phaseFund(env, state));
    } else if (cmd === "watcher") {
      await withContext(async (env, state) => phaseWatcher(env, state));
    } else if (drills[cmd]) {
      await withContext(async (env, state) => {
        await drills[cmd](env, state);
        return state;
      });
    } else if (cmd === "report") {
      writeReport(loadState());
      printRetireReminder();
    } else if (cmd === "all") {
      await withContext(async (env, state) => {
        state = await phasePrep(env);
        state = await phaseToken(env, state);
        state = await phaseEntropy(state);
        state = await phaseDeploy(env, state);
        state = await phaseFund(env, state);
        state = await phaseWatcher(env, state);

        for (const [name, fn] of Object.entries(drills)) {
          const id = name.toUpperCase();
          if (state.drills[id]?.status === "PASS") {
            console.log(`${id} already PASS — skip.`);
            continue;
          }
          console.log(`\n======== ${id} ========`);
          try {
            await fn(env, state);
          } catch (e) {
            console.error(`${id} failed: ${e.message}`);
            state.finishedAt = new Date().toISOString();
            saveState(state);
            writeReport(state);
            printRetireReminder();
            process.exitCode = 1;
            return state;
          }
        }

        state.finishedAt = new Date().toISOString();
        saveState(state);
        writeReport(state);
        printRetireReminder();
        return state;
      });
    } else {
      console.log(`Unknown command: ${cmd}`);
      console.log(
        "Usage: node run-v2.mjs <prep|token|entropy|deploy|fund|watcher|v1..v8|report|all>",
      );
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e.message || e);
    printRetireReminder();
    process.exitCode = 1;
  }
}

main();
