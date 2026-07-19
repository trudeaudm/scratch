/**
 * Resolve ScratchSettled for a requestId via eth_getLogs (indexed requestId).
 */
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { resolveToken, ZERO } from "./tokens.js";

const SCRATCH_SETTLED_ABI = [
  "event ScratchSettled(address indexed user, uint256 indexed requestId, uint8 tier, uint256 rowIndex, address asset, uint256 amount)",
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
 * @returns {Promise<null | {
 *   requestId: string,
 *   tier: number,
 *   isWin: boolean,
 *   cardPrize: string,
 *   sharePrize: string,
 *   symbol: string,
 *   txHash: string|null,
 * }>}
 */
export async function fetchWin(requestId) {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL is required");

  const req = BigInt(requestId);
  const game = gameAddress();
  const fromBlock = Number(process.env.GAME_DEPLOY_BLOCK || DEFAULT_DEPLOY_BLOCK);
  const provider = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(game, SCRATCH_SETTLED_ABI, provider);
  const tip = await provider.getBlockNumber();

  let found = null;
  for (let start = tip; start >= fromBlock; ) {
    const chunkFrom = Math.max(fromBlock, start - LOG_CHUNK + 1);
    try {
      const logs = await contract.queryFilter(
        contract.filters.ScratchSettled(null, req),
        chunkFrom,
        start,
      );
      if (logs.length) {
        found = logs[logs.length - 1];
        break;
      }
    } catch {
      /* try older chunk */
    }
    if (chunkFrom <= fromBlock) break;
    start = chunkFrom - 1;
  }

  if (!found) return null;

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
