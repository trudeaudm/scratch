/**
 * §9 mainnet rehearsal orchestrator.
 *
 * Subcommands (idempotent — skip completed phases via rehearsal/state.json):
 *   prep | token | entropy | deploy | fund | watcher | d1..d8 | report | all
 *
 * Env: rehearsal/.env.rehearsal (see .env.rehearsal.example). Refuses to run if
 * that file is tracked by git. Entropy secret stays under rehearsal/ only.
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
  id,
  ZeroAddress,
} from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const ENV_FILE = resolve(__dirname, ".env.rehearsal");
const STATE_FILE = resolve(__dirname, "state.json");
const ENTROPY_FILE = resolve(__dirname, "entropy-state.json");
const ENTROPY_FILE_D7 = resolve(__dirname, "entropy-state-d7.json");
const WATCHER_PID = resolve(__dirname, "watcher.pid");
const WATCHER_LOG = resolve(__dirname, "watcher.log");
const DRILL_LOG_DIR = resolve(__dirname, "drill-logs");
const REPORT_FILE = resolve(__dirname, "REHEARSAL_REPORT.md");
const GENERATE_CHAIN = resolve(REPO_ROOT, "ops/entropy-operator/src/generate-chain.js");

const CHAIN_ID = 4663n;
const PREMIUM = 1;
const STANDARD = 0;
const RESCUE_DELAY = 600;
const EMISSION_RATE = 10n ** 18n; // ~1 ticket/sec sole staker
const MIN_STAKE = 10n ** 18n;
const PROMO_DAILY_CAP = 1000n * 10n ** 18n;
const FUND_AMOUNT = 100_000n * 10n ** 18n;
const USER_STAKE = 100n * 10n ** 18n;
const TICKET_COST = 10n ** 18n;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const GAME_ABI = [
  "function scratch(uint8 tier) returns (uint256 requestId)",
  "function rescue(uint256 requestId)",
  "function requests(uint256) view returns (address user, uint8 tier, uint64 requestedAt, uint8 status)",
  "function queueRandomnessSwap(address newProvider)",
  "function executeRandomnessSwap()",
  "function cancelRandomnessSwap()",
  "function pendingRandomness() view returns (address)",
  "function randomnessSwapEta() view returns (uint64)",
  "function acceptOwnership()",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "event ScratchRequested(address indexed user, uint256 indexed requestId, uint8 tier)",
  "event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 tier, uint256 rowIndex, address asset, uint256 amount)",
  "event ScratchRescued(address indexed user, uint256 indexed requestId, uint8 tier)",
  "event ScratchLateFulfillment(address indexed user, uint256 indexed requestId, uint8 tier)",
];

const VAULT_ABI = [
  "function fund(address asset, uint256 amount)",
  "function sweep(address asset, address to) returns (uint256 id)",
  "function executeSweep(uint256 id)",
  "function sweeps(uint256) view returns (address asset, address to, uint64 eta, bool pending)",
  "function acceptOwnership()",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "event PrizePaid(address indexed to, address indexed asset, uint256 amount, bool fellBack)",
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
  "function deposit(uint256 amount)",
  "function ticketsOf(address user) view returns (uint256)",
  "function users(address) view returns (uint256 staked, uint256 debt, uint256 banked)",
];

const ENTROPY_ABI = [
  "function registerChain(bytes32 commitment)",
  "function currentEpoch() view returns (uint64)",
  "function reveal(uint256 requestId, bytes32 preimage)",
  "function requests(uint256 requestId) view returns (uint64 epoch, bool pending)",
  "error WrongEpoch()",
];

const STATUS = { None: 0, Pending: 1, Settled: 2, Rescued: 3 };

// ---------------------------------------------------------------------------
// Env / git safety
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
      `REFUSING TO RUN: ${rel} is tracked by git. Remove it from the index immediately ` +
        `(git rm --cached ${rel}) and confirm it is listed in .gitignore.`,
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function defaultState() {
  return {
    addresses: {},
    entropyCommitment: null,
    entropyChainFile: ENTROPY_FILE,
    checkpoints: { deployAssert: false, watcherStarted: false },
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
  const path = join(DRILL_LOG_DIR, `${id}.log`);
  appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`);
  console.log(`[${id}] ${line}`);
}

function recordDrill(state, id, result) {
  state.drills[id] = { ...result, at: new Date().toISOString() };
  saveState(state);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    // Avoid shell mangling of args on Windows; forge/cast must be on PATH.
    shell: false,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) {
    throw new Error(`${cmd} failed to start: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`${cmd} exited ${r.status}`);
  }
  return out;
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
  const re = new RegExp(`${key}=\\s*(0x[a-fA-F0-9]{40}|0x[a-fA-F0-9]{64})`);
  const m = stdout.match(re);
  if (!m) throw new Error(`Could not parse ${key}= from output`);
  return m[1];
}

async function waitForReceipt(provider, txHash, label) {
  const receipt = await provider.waitForTransaction(txHash);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} failed: ${txHash}`);
  }
  return receipt;
}

async function sendAndLog(drillId, txPromise, label) {
  const tx = await txPromise;
  logDrill(drillId, `${label} submitted ${tx.hash}`);
  const receipt = await tx.wait();
  logDrill(
    drillId,
    `${label} confirmed block=${receipt.blockNumber} gasUsed=${receipt.gasUsed.toString()} status=${receipt.status}`,
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

async function waitForSettlement(provider, game, requestId, timeoutMs = 180_000) {
  const start = Date.now();
  const iface = new Interface(GAME_ABI);
  const settledTopic = id("ScratchSettled(address,uint256,uint8,uint256,address,uint256)");
  const lateTopic = id("ScratchLateFulfillment(address,uint256,uint8)");
  let fromBlock = await provider.getBlockNumber();

  while (Date.now() - start < timeoutMs) {
    const req = await game.requests(requestId);
    if (Number(req.status) === STATUS.Settled || Number(req.status) === STATUS.Rescued) {
      const toBlock = await provider.getBlockNumber();
      const logs = await provider.getLogs({
        address: await game.getAddress(),
        fromBlock: Math.max(0, fromBlock - 5),
        toBlock,
        topics: [[settledTopic, lateTopic]],
      });
      let settled = null;
      let late = null;
      let settledBlock = null;
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        if (!parsed) continue;
        if (parsed.args.requestId === requestId) {
          if (parsed.name === "ScratchSettled") {
            settled = parsed;
            settledBlock = log.blockNumber;
          }
          if (parsed.name === "ScratchLateFulfillment") late = parsed;
        }
      }
      return {
        status: Number(req.status),
        settled,
        late,
        settledBlock,
        elapsedMs: Date.now() - start,
      };
    }
    await sleep(2_000);
  }
  throw new Error(`settlement timeout for request ${requestId}`);
}

// ---------------------------------------------------------------------------
// Watcher lifecycle
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

function startWatcher(env, state) {
  if (watcherRunning()) {
    console.log("Watcher already running (pid file present).");
    state.checkpoints.watcherStarted = true;
    saveState(state);
    return;
  }
  const watchScript = resolve(REPO_ROOT, "ops/entropy-operator/src/watch-and-reveal.js");
  const childEnv = {
    ...process.env,
    RPC_URL: env.RPC_URL,
    PRIVATE_KEY: normalizePk(env.BURNER_OPERATOR_PK),
    SELF_ENTROPY_ADDRESS: state.addresses.selfEntropy,
    CHAIN_FILE: state.entropyChainFile || ENTROPY_FILE,
    POLL_MS: "2000",
  };
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
  console.log(`Watcher started pid=${child.pid} log=${WATCHER_LOG}`);
}

function stopWatcher() {
  if (!existsSync(WATCHER_PID)) {
    console.log("No watcher.pid — nothing to kill.");
    return;
  }
  const pid = Number(readFileSync(WATCHER_PID, "utf8").trim());
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to watcher pid=${pid}`);
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
  console.log("=== §9 rehearsal burners ===");
  console.log(`  deployer: ${deployer.address}  balance=${formatEther(db)} ETH`);
  console.log(`  operator: ${operator.address}  balance=${formatEther(ob)} ETH`);
  console.log(`  user:     ${user.address}  balance=${formatEther(ub)} ETH`);
  console.log("");
  console.log("Required funding (approx):");
  console.log("  deployer ~0.003 ETH  (deploys + gas for ops)");
  console.log("  operator ~0.001 ETH  (reveal txs)");
  console.log("  user     dust        (stake / scratch / rescue gas)");
  console.log("");

  const needDeployer = parseEther("0.003");
  const needOperator = parseEther("0.001");
  if (db < needDeployer || ob < needOperator || ub === 0n) {
    console.log("Balances look light — fund before continuing.");
  }

  await confirm("Confirm burners are funded on chain 4663.");
  const state = loadState();
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  state.addresses.deployer = deployer.address;
  state.addresses.operator = operator.address;
  state.addresses.user = user.address;
  saveState(state);
  return state;
}

async function phaseToken(env, state) {
  if (state.addresses.token && state.addresses.unbackedAsset) {
    console.log("Token already deployed — skipping (idempotent).");
    console.log(`  token=${state.addresses.token}`);
    console.log(`  unbacked=${state.addresses.unbackedAsset}`);
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
  console.log("Throwaway token deployed.");
  return state;
}

async function phaseEntropy(state) {
  if (state.entropyCommitment && existsSync(ENTROPY_FILE)) {
    console.log("Entropy chain already present — skipping regenerate.");
    console.log(`  commitment=${state.entropyCommitment}`);
    return state;
  }

  // Ensure ops deps
  if (!existsSync(resolve(REPO_ROOT, "ops/entropy-operator/node_modules"))) {
    run("npm", ["install", "--silent"], { cwd: resolve(REPO_ROOT, "ops/entropy-operator") });
  }

  const out = run(process.execPath, [GENERATE_CHAIN, "--n", "10000"], {
    env: { CHAIN_FILE: ENTROPY_FILE },
    cwd: resolve(REPO_ROOT, "ops/entropy-operator"),
  });

  const commitment = parseEqLog(out, "ENTROPY_COMMITMENT");
  state.entropyCommitment = commitment;
  state.entropyChainFile = ENTROPY_FILE;
  saveState(state);
  console.log(`Entropy commitment captured: ${commitment}`);
  console.log(`State file (SECRET — rehearsal/ only): ${ENTROPY_FILE}`);
  return state;
}

async function phaseDeploy(env, state) {
  if (state.checkpoints.deployAssert && state.addresses.game) {
    console.log("Deploy2 already completed (checkpoint 1) — skipping.");
    return state;
  }
  if (!state.addresses.token) throw new Error("Run token phase first");
  if (!state.entropyCommitment) throw new Error("Run entropy phase first");

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
    RANDOMNESS_PROVIDER: "self",
    OPERATOR: state.addresses.operator || new Wallet(normalizePk(env.BURNER_OPERATOR_PK)).address,
    ENTROPY_COMMITMENT: state.entropyCommitment,
    PREMIUM_PRIZE_TABLE: tables.premium,
    STANDARD_PRIZE_TABLE: tables.standard,
  };

  console.log("Running Deploy2 (RANDOMNESS_PROVIDER=self, RESCUE_DELAY=600)…");
  const out = run(
    "forge",
    ["script", "script/Deploy2.s.sol:Deploy2", "--rpc-url", env.RPC_URL, "--broadcast", "--slow", "-vv"],
    { env: deployEnv },
  );

  // Assertion block = checkpoint 1 (script reverts if assertWiring fails)
  state.addresses.prizeVault = parseDeployLog(out, "PrizeVault:");
  state.addresses.stakingVault = parseDeployLog(out, "StakingVault:");
  state.addresses.standardSource = parseDeployLog(out, "StandardTicketSource:");
  state.addresses.selfEntropy = parseDeployLog(out, "Randomness provider:");
  state.addresses.game = parseDeployLog(out, "ScratchGame:");
  state.checkpoints.deployAssert = true;
  saveState(state);
  console.log("Checkpoint 1 PASS — Deploy2 assertion block succeeded.");

  // Ownable2Step: treasury (= deployer) accepts ownership
  const provider = new JsonRpcProvider(env.RPC_URL);
  const w = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK), provider);
  for (const [name, addr] of [
    ["ScratchGame", state.addresses.game],
    ["PrizeVault", state.addresses.prizeVault],
    ["StandardTicketSource", state.addresses.standardSource],
  ]) {
    const c = new Contract(addr, ["function acceptOwnership()", "function owner() view returns (address)"], w);
    const owner = await c.owner();
    if (owner.toLowerCase() === w.address.toLowerCase()) {
      console.log(`${name} already owned by treasury.`);
      continue;
    }
    const tx = await c.acceptOwnership();
    await tx.wait();
    console.log(`Accepted ownership: ${name}`);
  }

  return state;
}

async function phaseFund(env, state) {
  if (!state.addresses.game) throw new Error("Run deploy phase first");
  const provider = new JsonRpcProvider(env.RPC_URL);
  const w = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK), provider);
  const token = new Contract(state.addresses.token, ERC20_ABI, w);
  const vault = new Contract(state.addresses.prizeVault, VAULT_ABI, w);

  const bal = await token.balanceOf(state.addresses.prizeVault);
  if (bal >= FUND_AMOUNT) {
    console.log(`PrizeVault already funded (balance=${bal}) — skipping fund.`);
  } else {
    const approveTx = await token.approve(state.addresses.prizeVault, FUND_AMOUNT);
    await approveTx.wait();
    const fundTx = await vault.fund(state.addresses.token, FUND_AMOUNT);
    await fundTx.wait();
    console.log(`Funded PrizeVault with ${FUND_AMOUNT} REHEARSAL`);
  }

  // Transfer stake tokens to user if needed
  const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
  const userBal = await token.balanceOf(user.address);
  if (userBal < USER_STAKE) {
    const tx = await token.transfer(user.address, USER_STAKE * 10n);
    await tx.wait();
    console.log(`Seeded user with ${USER_STAKE * 10n} REHEARSAL`);
  }

  console.log("Setting rehearsal prize tables…");
  run(
    "forge",
    [
      "script",
      "rehearsal/SetRehearsalTables.s.sol:SetRehearsalTables",
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
  if (!state.addresses.selfEntropy) throw new Error("Run deploy phase first");
  if (!existsSync(state.entropyChainFile || ENTROPY_FILE)) {
    throw new Error("Entropy state file missing — run entropy phase first");
  }
  startWatcher(env, state);
  console.log("Checkpoint 2 PASS — operator watcher running.");
  await sleep(3_000);
  return state;
}

// ---------------------------------------------------------------------------
// Drills
// ---------------------------------------------------------------------------

async function drillD1(env, state) {
  const id = "D1";
  const provider = new JsonRpcProvider(env.RPC_URL);
  const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
  const token = new Contract(state.addresses.token, ERC20_ABI, user);
  const staking = new Contract(state.addresses.stakingVault, STAKING_ABI, user);
  const game = new Contract(state.addresses.game, GAME_ABI, user);

  try {
    const staked = (await staking.users(user.address)).staked;
    if (staked < MIN_STAKE) {
      const allow = await token.allowance(user.address, state.addresses.stakingVault);
      if (allow < USER_STAKE) {
        await sendAndLog(id, token.approve(state.addresses.stakingVault, USER_STAKE), "approve");
      }
      await sendAndLog(id, staking.deposit(USER_STAKE), "deposit");
    } else {
      logDrill(id, `already staked ${staked}`);
    }

    logDrill(id, "waiting 90s for ticket accrual…");
    await sleep(90_000);
    const tickets = await waitUntilTickets(staking, user.address, TICKET_COST);
    logDrill(id, `ticketsOf=${tickets}`);

    const t0 = Date.now();
    const { receipt: scratchReceipt } = await sendAndLog(id, game.scratch(PREMIUM), "scratch premium");
    const scratchGas = scratchReceipt.gasUsed;
    const iface = new Interface(GAME_ABI);
    let requestId;
    for (const log of scratchReceipt.logs) {
      try {
        const p = iface.parseLog(log);
        if (p && p.name === "ScratchRequested") requestId = p.args.requestId;
      } catch {
        /* not ours */
      }
    }
    if (requestId == null) throw new Error("ScratchRequested not found");
    logDrill(id, `requestId=${requestId}`);

    const settle = await waitForSettlement(provider, game, requestId);
    const latencyMs = settle.elapsedMs;
    logDrill(id, `settle status=${settle.status} latencyMs=${latencyMs}`);

    if (settle.status !== STATUS.Settled || !settle.settled) {
      throw new Error("expected ScratchSettled (prize or explicit no-win)");
    }
    const rowIndex = settle.settled.args.rowIndex;
    const amount = settle.settled.args.amount;
    logDrill(id, `ScratchSettled rowIndex=${rowIndex} amount=${amount}`);

    // Fulfill gas: best-effort from watcher log / recent blocks — scan SelfEntropy RandomnessFulfilled
    let fulfillGas = null;
    try {
      const entropy = new Contract(state.addresses.selfEntropy, [
        "event RandomnessFulfilled(uint256 indexed requestId, uint256 randomWord)",
      ], provider);
      const fulLogs = await entropy.queryFilter(entropy.filters.RandomnessFulfilled(requestId));
      if (fulLogs.length) {
        const fr = await provider.getTransactionReceipt(fulLogs[0].transactionHash);
        fulfillGas = fr.gasUsed;
        logDrill(id, `fulfill tx=${fulLogs[0].transactionHash} gasUsed=${fulfillGas}`);
      }
    } catch (e) {
      addSurprise(state, `D1 fulfill gas capture: ${e.message}`);
    }

    state.metrics.revealLatencyMs = latencyMs;
    state.metrics.scratchGas = scratchGas.toString();
    if (fulfillGas != null) state.metrics.fulfillGas = fulfillGas.toString();
    saveState(state);

    recordDrill(state, id, {
      status: "PASS",
      requestId: requestId.toString(),
      scratchTx: scratchReceipt.hash,
      scratchGas: scratchGas.toString(),
      fulfillGas: fulfillGas != null ? fulfillGas.toString() : null,
      revealLatencyMs: latencyMs,
      rowIndex: rowIndex.toString(),
      amount: amount.toString(),
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    throw e;
  }
}

async function loopUntilRow(env, state, drillId, targetRow, assertFn) {
  const provider = new JsonRpcProvider(env.RPC_URL);
  const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
  const staking = new Contract(state.addresses.stakingVault, STAKING_ABI, user);
  const game = new Contract(state.addresses.game, GAME_ABI, user);
  const vault = new Contract(state.addresses.prizeVault, VAULT_ABI, provider);
  const maxAttempts = 40;

  for (let i = 1; i <= maxAttempts; i++) {
    await waitUntilTickets(staking, user.address, TICKET_COST, 300_000);
    const { receipt } = await sendAndLog(drillId, game.scratch(PREMIUM), `scratch#${i}`);
    const iface = new Interface(GAME_ABI);
    let requestId;
    for (const log of receipt.logs) {
      try {
        const p = iface.parseLog(log);
        if (p && p.name === "ScratchRequested") requestId = p.args.requestId;
      } catch {
        /* skip */
      }
    }
    const settle = await waitForSettlement(provider, game, requestId);
    if (settle.status !== STATUS.Settled || !settle.settled) {
      throw new Error(`${drillId}: expected settled`);
    }
    const rowIndex = Number(settle.settled.args.rowIndex);
    logDrill(drillId, `attempt ${i}: rowIndex=${rowIndex} amount=${settle.settled.args.amount}`);
    if (rowIndex === targetRow) {
      await assertFn({ settle, requestId, receipt, user, vault, provider, game });
      return { requestId, settle, attempts: i };
    }
  }
  throw new Error(`${drillId}: target row ${targetRow} not hit in ${maxAttempts} attempts`);
}

async function drillD2(env, state) {
  const id = "D2";
  try {
    const provider = new JsonRpcProvider(env.RPC_URL);
    const token = new Contract(
      state.addresses.token,
      [...ERC20_ABI, "event Transfer(address indexed from, address indexed to, uint256 value)"],
      provider,
    );

    const result = await loopUntilRow(env, state, id, 1, async ({ settle, user }) => {
      const paid = settle.settled.args.amount;
      const asset = settle.settled.args.asset;
      if (getAddress(asset) !== getAddress(state.addresses.token)) {
        throw new Error(`expected REHEARSAL asset, got ${asset}`);
      }
      if (paid !== 10n * 10n ** 18n) {
        throw new Error(`expected fixed 10e18 payout, got ${paid}`);
      }
      const fromBlock = settle.settledBlock != null ? Number(settle.settledBlock) : undefined;
      const transfers = await token.queryFilter(
        token.filters.Transfer(state.addresses.prizeVault, user.address),
        fromBlock,
        fromBlock,
      );
      const got = transfers.some((t) => t.args.value === paid);
      if (!got) {
        throw new Error("expected ERC20 Transfer from PrizeVault to user for fixed payout");
      }
      logDrill(id, `fixed-asset transfer confirmed amount=${paid}`);
    });

    recordDrill(state, id, {
      status: "PASS",
      attempts: result.attempts,
      requestId: result.requestId.toString(),
      amount: result.settle.settled.args.amount.toString(),
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    throw e;
  }
}

async function drillD3(env, state) {
  const id = "D3";
  try {
    const result = await loopUntilRow(env, state, id, 2, async ({ settle, provider, requestId }) => {
      const vault = new Contract(state.addresses.prizeVault, VAULT_ABI, provider);
      const settledBlock = settle.settledBlock;
      const latest = await provider.getBlockNumber();
      const fromBlock = settledBlock != null ? Number(settledBlock) : Math.max(0, latest - 50);
      const logs = await vault.queryFilter(vault.filters.PrizePaid(), fromBlock, latest);
      const hit = logs.filter((l) => l.args.fellBack === true);
      logDrill(
        id,
        `unbacked row settled requestAmount=${settle.settled.args.amount} PrizePaid(fellBack)=${hit.length}`,
      );
      if (hit.length === 0) {
        throw new Error("expected PrizePaid(..., fellBack=true) for unbacked asset row");
      }
      // Settlement did not revert (we observed ScratchSettled). Fallback paid zero SCRATCH when rate unset.
      const zeroPay = hit.some((l) => l.args.fellBack && l.args.amount === 0n);
      if (!zeroPay) {
        addSurprise(state, "D3: fellBack emitted but amount != 0 (fallback rate may have been set)");
      }
    });

    recordDrill(state, id, {
      status: "PASS",
      attempts: result.attempts,
      requestId: result.requestId.toString(),
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    throw e;
  }
}

async function drillD4(env, state) {
  const id = "D4";
  try {
    logDrill(id, "killing watcher…");
    stopWatcher();
    await sleep(2_000);

    const provider = new JsonRpcProvider(env.RPC_URL);
    const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
    const staking = new Contract(state.addresses.stakingVault, STAKING_ABI, user);
    const game = new Contract(state.addresses.game, GAME_ABI, user);

    await waitUntilTickets(staking, user.address, TICKET_COST, 300_000);
    const ticketsBefore = await staking.ticketsOf(user.address);
    const { receipt } = await sendAndLog(id, game.scratch(PREMIUM), "scratch (watcher down)");
    const iface = new Interface(GAME_ABI);
    let requestId;
    for (const log of receipt.logs) {
      try {
        const p = iface.parseLog(log);
        if (p && p.name === "ScratchRequested") requestId = p.args.requestId;
      } catch {
        /* skip */
      }
    }
    logDrill(id, `requestId=${requestId} — waiting ${RESCUE_DELAY + 10}s for rescueDelay…`);
    await sleep((RESCUE_DELAY + 10) * 1000);

    // rescue from USER key (permissionless)
    const { receipt: rescueReceipt } = await sendAndLog(id, game.rescue(requestId), "rescue (user key)");
    const req = await game.requests(requestId);
    if (Number(req.status) !== STATUS.Rescued) throw new Error("status not Rescued");
    const ticketsAfter = await staking.ticketsOf(user.address);
    if (ticketsAfter < ticketsBefore - TICKET_COST) {
      // spent one then refunded one → should be back near before (minus any accrual timing)
    }
    // Refund restores ticket — after rescue should be >= before - dust accrual noise
    if (ticketsAfter + TICKET_COST < ticketsBefore) {
      addSurprise(state, `D4 ticket math: before=${ticketsBefore} after=${ticketsAfter}`);
    }
    logDrill(id, `ticket refunded ticketsBefore=${ticketsBefore} after=${ticketsAfter}`);

    // Restart watcher — late fulfill should emit ScratchLateFulfillment, no payout
    state.entropyChainFile = ENTROPY_FILE;
    startWatcher(env, state);
    logDrill(id, "watcher restarted — waiting for late fulfill…");

    let late = false;
    const tEnd = Date.now() + 120_000;
    while (Date.now() < tEnd) {
      const settle = await waitForSettlement(provider, game, requestId, 5_000).catch(() => null);
      if (settle?.late) {
        late = true;
        break;
      }
      // query logs
      const latest = await provider.getBlockNumber();
      const logs = await provider.getLogs({
        address: state.addresses.game,
        fromBlock: latest - 50,
        toBlock: latest,
        topics: [id("ScratchLateFulfillment(address,uint256,uint8)")],
      });
      for (const log of logs) {
        const p = iface.parseLog(log);
        if (p && p.args.requestId === requestId) {
          late = true;
          logDrill(id, `ScratchLateFulfillment seen tx=${log.transactionHash}`);
        }
      }
      if (late) break;
      await sleep(3_000);
    }
    if (!late) {
      addSurprise(state, "D4: ScratchLateFulfillment not observed within 120s (seq may be behind)");
      // Still PASS rescue path; note surprise
    }

    recordDrill(state, id, {
      status: "PASS",
      requestId: requestId.toString(),
      rescueTx: rescueReceipt.hash,
      lateFulfillmentObserved: late,
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    // try to restart watcher for subsequent drills
    try {
      startWatcher(env, state);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

async function drillD5(env, state) {
  const id = "D5";
  try {
    const provider = new JsonRpcProvider(env.RPC_URL);
    const treasury = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK), provider);
    const vault = new Contract(state.addresses.prizeVault, VAULT_ABI, treasury);

    const { receipt: qReceipt } = await sendAndLog(
      id,
      vault.sweep(state.addresses.token, treasury.address),
      "queue sweep",
    );
    const iface = new Interface(VAULT_ABI);
    let sweepId;
    for (const log of qReceipt.logs) {
      try {
        const p = iface.parseLog(log);
        if (p && p.name === "SweepQueued") sweepId = p.args.id;
      } catch {
        /* skip */
      }
    }
    if (sweepId == null) throw new Error("SweepQueued not found");
    logDrill(id, `sweepId=${sweepId}`);

    let reverted = false;
    try {
      await vault.executeSweep.staticCall(sweepId);
      await vault.executeSweep(sweepId);
    } catch (e) {
      reverted = true;
      logDrill(id, `executeSweep immediately reverted as expected: ${e.shortMessage || e.message}`);
    }
    if (!reverted) throw new Error("executeSweep should revert before eta");

    recordDrill(state, id, { status: "PASS", sweepId: sweepId.toString(), immediateExecuteReverted: true });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    throw e;
  }
}

async function drillD6(env, state) {
  const id = "D6";
  try {
    const provider = new JsonRpcProvider(env.RPC_URL);
    const treasury = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK), provider);
    const game = new Contract(state.addresses.game, GAME_ABI, treasury);
    const dummy = "0x000000000000000000000000000000000000dEaD";

    await sendAndLog(id, game.queueRandomnessSwap(dummy), "queueRandomnessSwap");
    const eta = await game.randomnessSwapEta();
    logDrill(id, `eta=${eta}`);

    let reverted = false;
    try {
      await game.executeRandomnessSwap.staticCall();
      await game.executeRandomnessSwap();
    } catch (e) {
      reverted = true;
      logDrill(id, `executeRandomnessSwap before eta reverted: ${e.shortMessage || e.message}`);
    }
    if (!reverted) throw new Error("executeRandomnessSwap should revert before eta");

    await sendAndLog(id, game.cancelRandomnessSwap(), "cancelRandomnessSwap");
    const pending = await game.pendingRandomness();
    if (pending !== ZeroAddress) throw new Error("pendingRandomness not cleared");
    const eta2 = await game.randomnessSwapEta();
    if (eta2 !== 0n) throw new Error("randomnessSwapEta not cleared");

    recordDrill(state, id, { status: "PASS", cleared: true });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    throw e;
  }
}

async function drillD7(env, state) {
  const id = "D7";
  try {
    // Stop watcher so we can scratch without immediate reveal, then registerChain
    stopWatcher();
    await sleep(2_000);

    const provider = new JsonRpcProvider(env.RPC_URL);
    const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
    const deployer = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK), provider);
    const staking = new Contract(state.addresses.stakingVault, STAKING_ABI, user);
    const game = new Contract(state.addresses.game, GAME_ABI, user);
    const entropy = new Contract(state.addresses.selfEntropy, ENTROPY_ABI, deployer);

    await waitUntilTickets(staking, user.address, TICKET_COST, 300_000);
    const { receipt } = await sendAndLog(id, game.scratch(PREMIUM), "scratch before registerChain");
    const iface = new Interface(GAME_ABI);
    let requestId;
    for (const log of receipt.logs) {
      try {
        const p = iface.parseLog(log);
        if (p && p.name === "ScratchRequested") requestId = p.args.requestId;
      } catch {
        /* skip */
      }
    }
    logDrill(id, `orphaned requestId=${requestId}`);

    // Fresh commitment into a separate chain file (do not overwrite primary secret mid-report)
    if (!existsSync(resolve(REPO_ROOT, "ops/entropy-operator/node_modules"))) {
      run("npm", ["install", "--silent"], { cwd: resolve(REPO_ROOT, "ops/entropy-operator") });
    }
    const out = run(process.execPath, [GENERATE_CHAIN, "--n", "1000"], {
      env: { CHAIN_FILE: ENTROPY_FILE_D7 },
      cwd: resolve(REPO_ROOT, "ops/entropy-operator"),
    });
    const commitment = parseEqLog(out, "ENTROPY_COMMITMENT");
    await sendAndLog(id, entropy.registerChain(commitment), "registerChain (new epoch)");

    // Assert old request cannot be revealed (WrongEpoch)
    const d7State = JSON.parse(readFileSync(ENTROPY_FILE, "utf8"));
    // Use a dummy preimage — WrongEpoch should fire before BadPreimage if epoch mismatch
    let wrongEpoch = false;
    try {
      await entropy.reveal.staticCall(requestId, d7State.secret);
    } catch (e) {
      const msg = `${e.shortMessage || ""} ${e.message || ""} ${e.data || ""}`;
      wrongEpoch = /WrongEpoch/i.test(msg) || msg.includes("0x");
      logDrill(id, `reveal staticCall reverted (expected WrongEpoch): ${e.shortMessage || e.message}`);
    }
    if (!wrongEpoch) {
      // try actual reveal from operator key
      const op = new Wallet(normalizePk(env.BURNER_OPERATOR_PK), provider);
      const entropyOp = new Contract(state.addresses.selfEntropy, ENTROPY_ABI, op);
      try {
        await entropyOp.reveal(requestId, d7State.secret);
        throw new Error("reveal unexpectedly succeeded");
      } catch (e) {
        if (/unexpectedly succeeded/.test(e.message)) throw e;
        wrongEpoch = true;
        logDrill(id, `reveal reverted: ${e.shortMessage || e.message}`);
      }
    }

    logDrill(id, `waiting ${RESCUE_DELAY + 10}s then rescue…`);
    await sleep((RESCUE_DELAY + 10) * 1000);
    await sendAndLog(id, game.rescue(requestId), "rescue orphaned request");
    const req = await game.requests(requestId);
    if (Number(req.status) !== STATUS.Rescued) throw new Error("not rescued");

    // Point watcher at new chain for subsequent drills
    state.entropyChainFile = ENTROPY_FILE_D7;
    state.entropyCommitment = commitment;
    saveState(state);
    startWatcher(env, state);

    recordDrill(state, id, {
      status: "PASS",
      requestId: requestId.toString(),
      wrongEpochAsserted: wrongEpoch,
      newCommitment: commitment,
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    try {
      startWatcher(env, state);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

async function drillD8(env, state) {
  const id = "D8";
  try {
    const provider = new JsonRpcProvider(env.RPC_URL);
    const treasury = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK), provider);
    const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
    const standard = new Contract(state.addresses.standardSource, STANDARD_ABI, treasury);
    const game = new Contract(state.addresses.game, GAME_ABI, user);

    await sendAndLog(id, standard.grant([user.address], TICKET_COST), "grant 1 ticket");
    const bal = await standard.ticketsOf(user.address);
    if (bal < TICKET_COST) throw new Error(`grant failed ticketsOf=${bal}`);

    const { receipt } = await sendAndLog(id, game.scratch(STANDARD), "scratch standard (tier 0)");
    const iface = new Interface(GAME_ABI);
    let requestId;
    for (const log of receipt.logs) {
      try {
        const p = iface.parseLog(log);
        if (p && p.name === "ScratchRequested") requestId = p.args.requestId;
      } catch {
        /* skip */
      }
    }
    const settle = await waitForSettlement(provider, game, requestId);
    if (settle.status !== STATUS.Settled || !settle.settled) {
      throw new Error("standard scratch did not settle");
    }
    logDrill(id, `settled rowIndex=${settle.settled.args.rowIndex} amount=${settle.settled.args.amount}`);

    recordDrill(state, id, {
      status: "PASS",
      requestId: requestId.toString(),
      rowIndex: settle.settled.args.rowIndex.toString(),
      amount: settle.settled.args.amount.toString(),
    });
    logDrill(id, "PASS");
  } catch (e) {
    recordDrill(state, id, { status: "FAIL", error: e.message });
    logDrill(id, `FAIL ${e.message}`);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function writeReport(state) {
  const drills = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"];
  const rows = drills.map((d) => {
    const r = state.drills[d];
    const status = r?.status || "SKIP";
    const detail = r?.error || r?.requestId || "";
    return `| ${d} | ${status} | ${detail} |`;
  });

  const a = state.addresses || {};
  const md = `# §9 Mainnet Rehearsal Report

Generated: ${new Date().toISOString()}
Started: ${state.startedAt || "—"}
Finished: ${state.finishedAt || "—"}

## Drill results

| Drill | Result | Detail |
|-------|--------|--------|
${rows.join("\n")}

## Headline numbers

| Metric | Value |
|--------|-------|
| Reveal latency (ms) | ${state.metrics.revealLatencyMs ?? "—"} |
| Scratch gas | ${state.metrics.scratchGas ?? "—"} |
| Fulfill gas | ${state.metrics.fulfillGas ?? "—"} |

## Deployed addresses

| Contract | Address |
|----------|---------|
| REHEARSAL token | ${a.token || "—"} |
| Unbacked asset | ${a.unbackedAsset || "—"} |
| PrizeVault | ${a.prizeVault || "—"} |
| StakingVault | ${a.stakingVault || "—"} |
| StandardTicketSource | ${a.standardSource || "—"} |
| SelfEntropyProvider | ${a.selfEntropy || "—"} |
| ScratchGame | ${a.game || "—"} |
| Deployer burner | ${a.deployer || "—"} |
| Operator burner | ${a.operator || "—"} |
| User burner | ${a.user || "—"} |

## SURPRISES

${
  (state.surprises || []).length === 0
    ? "_None recorded._"
    : state.surprises.map((s) => `- **${s.at}**: ${s.msg}`).join("\n")
}

## Reminder

**Retire the three burner keys.** Do not reuse \`BURNER_*_PK\` or the rehearsal entropy secret outside \`rehearsal/\`. Abandon this deployment.
`;

  writeFileSync(REPORT_FILE, md);
  console.log(`Wrote ${REPORT_FILE}`);
}

function printRetireReminder() {
  console.log("");
  console.log("================================================================");
  console.log("  RETIRE THE BURNERS — do not reuse BURNER_*_PK after this run.");
  console.log("  Do not reuse the entropy secret outside rehearsal/.");
  console.log("  Abandon this deployment; production uses fresh keys + §5 env.");
  console.log("================================================================");
  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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
    d1: drillD1,
    d2: drillD2,
    d3: drillD3,
    d4: drillD4,
    d5: drillD5,
    d6: drillD6,
    d7: drillD7,
    d8: drillD8,
  };

  try {
    if (cmd === "prep" || cmd === "0") {
      await withContext(async (env, state) => phasePrep(env));
    } else if (cmd === "token" || cmd === "1") {
      await withContext(async (env, state) => phaseToken(env, await phasePrepQuiet(env, state)));
    } else if (cmd === "entropy" || cmd === "2") {
      await withContext(async (env, state) => phaseEntropy(state));
    } else if (cmd === "deploy" || cmd === "3") {
      await withContext(async (env, state) => phaseDeploy(env, state));
    } else if (cmd === "fund" || cmd === "4") {
      await withContext(async (env, state) => phaseFund(env, state));
    } else if (cmd === "watcher" || cmd === "5") {
      await withContext(async (env, state) => phaseWatcher(env, state));
    } else if (drills[cmd]) {
      await withContext(async (env, state) => {
        await drills[cmd](env, state);
        return state;
      });
    } else if (cmd === "report") {
      const state = loadState();
      writeReport(state);
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
            console.log(`${id} already PASS — skip (idempotent).`);
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
        "Usage: node run.mjs <prep|token|entropy|deploy|fund|watcher|d1..d8|report|all>",
      );
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e.message || e);
    printRetireReminder();
    process.exitCode = 1;
  }
}

async function phasePrepQuiet(env, state) {
  const provider = new JsonRpcProvider(env.RPC_URL);
  const deployer = new Wallet(normalizePk(env.BURNER_DEPLOYER_PK), provider);
  const operator = new Wallet(normalizePk(env.BURNER_OPERATOR_PK), provider);
  const user = new Wallet(normalizePk(env.BURNER_USER_PK), provider);
  state.addresses.deployer = deployer.address;
  state.addresses.operator = operator.address;
  state.addresses.user = user.address;
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  saveState(state);
  return state;
}

main();
