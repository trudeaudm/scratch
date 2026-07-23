/**
 * Resolve ScratchSettled for a requestId via eth_getLogs (indexed requestId).
 * v1: single event. v2 (GAME_V2 gate): aggregate batch cards for /win/:req.
 */
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { resolveToken, ZERO } from "./tokens.js";

const SCRATCH_SETTLED_ABI_V1 = [
  "event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 tier, uint256 rowIndex, address asset, uint256 amount)",
];
const SCRATCH_SETTLED_ABI_V2 = [
  "event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 cardIndex, uint8 tier, uint256 rowIndex, address asset, uint256 amount)",
];

const DEFAULT_GAME = "0xBeD604b5AB226134EdF154cc31881d8C93f4C9e6";
const DEFAULT_DEPLOY_BLOCK = 13_138_508;
const LOG_CHUNK = 9_000;

function formatHuman(amount, decimals = 18, maxFrac = 4) {
  const n = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  if (n >= 1_000_000) return Math.round(n).toLocaleString("en-US");
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

export function gameAddress() {
  return process.env.GAME || process.env.GAME_ADDRESS || DEFAULT_GAME;
}

/**
 * Same gate as entropy-operator: GAME_V2=1/true or GAME_V2(_ADDRESS)=0x… matching GAME.
 */
export function isGameV2() {
  const flag = (process.env.GAME_V2 || "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  const v2Addr = (
    process.env.GAME_V2_ADDRESS ||
    (flag.startsWith("0x") ? flag : "")
  ).toLowerCase();
  if (!v2Addr) return false;
  return gameAddress().toLowerCase() === v2Addr;
}

/**
 * @returns {Promise<null | {
 *   requestId: string,
 *   tier: number,
 *   isWin: boolean,
 *   cardPrize: string,
 *   sharePrize: string,
 *   symbol: string,
 *   txHash: string|null,
 *   cardCount?: number,
 *   winCount?: number,
 * }>}
 */
export async function fetchWin(requestId) {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL is required");

  const req = BigInt(requestId);
  const game = gameAddress();
  const v2 = isGameV2();
  const fromBlock = Number(process.env.GAME_DEPLOY_BLOCK || DEFAULT_DEPLOY_BLOCK);
  const provider = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(
    game,
    v2 ? SCRATCH_SETTLED_ABI_V2 : SCRATCH_SETTLED_ABI_V1,
    provider,
  );
  const tip = await provider.getBlockNumber();

  let logs = [];
  for (let start = tip; start >= fromBlock; ) {
    const chunkFrom = Math.max(fromBlock, start - LOG_CHUNK + 1);
    try {
      const found = await contract.queryFilter(
        contract.filters.ScratchSettled(null, req),
        chunkFrom,
        start,
      );
      if (found.length) {
        logs = found;
        break;
      }
    } catch {
      /* try older chunk */
    }
    if (chunkFrom <= fromBlock) break;
    start = chunkFrom - 1;
  }

  if (!logs.length) return null;

  if (!v2) {
    const found = logs[logs.length - 1];
    const asset = (found.args.asset || "").toLowerCase();
    const amount = found.args.amount ?? 0n;
    const isWin = amount > 0n && asset && asset !== ZERO;
    const tier = Number(found.args.tier ?? 0);
    const meta = resolveToken(asset);
    const human = isWin ? formatHuman(amount, meta.decimals) : "";
    const cardPrize = isWin ? `+${human} ${meta.symbol}` : "Not this time";
    const sharePrize =
      isWin && meta.symbol === "SCRATCH"
        ? `+${human} $SCRATCH`
        : isWin
          ? `+${human} ${meta.symbol}`
          : "Not this time";

    return {
      requestId: req.toString(),
      tier,
      isWin,
      cardPrize,
      sharePrize,
      symbol: isWin ? meta.symbol : "NO_WIN",
      txHash: found.transactionHash || null,
    };
  }

  // v2: aggregate all cards for this requestId
  const tier = Number(logs[0].args.tier ?? 0);
  const cardCount = logs.length;
  const wins = [];
  let totalBySymbol = new Map();

  for (const log of logs) {
    const asset = (log.args.asset || "").toLowerCase();
    const amount = log.args.amount ?? 0n;
    if (!(amount > 0n && asset && asset !== ZERO)) continue;
    const meta = resolveToken(asset);
    wins.push({ meta, amount });
    const prev = totalBySymbol.get(meta.symbol) || 0n;
    totalBySymbol.set(meta.symbol, prev + amount);
  }

  const winCount = wins.length;
  const isWin = winCount > 0;
  const txHash = logs[logs.length - 1].transactionHash || null;

  if (!isWin) {
    return {
      requestId: req.toString(),
      tier,
      isWin: false,
      cardPrize: "Not this time",
      sharePrize: "Not this time",
      symbol: "NO_WIN",
      txHash,
      cardCount,
      winCount: 0,
    };
  }

  // Prefer a single-symbol total for the share line; otherwise list parts.
  let sharePrize;
  let cardPrize;
  let symbol;
  if (totalBySymbol.size === 1) {
    const [sym, raw] = [...totalBySymbol.entries()][0];
    const meta = resolveToken(
      wins.find((w) => w.meta.symbol === sym)?.meta.address || ZERO,
    );
    const human = formatHuman(raw, meta.decimals);
    symbol = sym;
    const label = sym === "SCRATCH" ? "$SCRATCH" : sym;
    sharePrize =
      cardCount > 1
        ? `${winCount} wins from ${cardCount} scratches +${human} ${label}`
        : `+${human} ${label}`;
    cardPrize = sharePrize;
  } else {
    const parts = [...totalBySymbol.entries()].map(([sym, raw]) => {
      const meta = resolveToken(
        wins.find((w) => w.meta.symbol === sym)?.meta.address || ZERO,
      );
      return `+${formatHuman(raw, meta.decimals)} ${sym}`;
    });
    symbol = "MIXED";
    sharePrize = `${winCount} wins from ${cardCount} scratches ${parts.join(" · ")}`;
    cardPrize = sharePrize;
  }

  return {
    requestId: req.toString(),
    tier,
    isWin: true,
    cardPrize,
    sharePrize,
    symbol,
    txHash,
    cardCount,
    winCount,
  };
}
