/**
 * One-shot: find nextRevealIndex whose preimage hashes to on-chain epochCursor.
 * Walks the hash chain once (O(n)), not O(n²).
 * Usage: node src/resync-index.mjs [--write]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, solidityPacked, JsonRpcProvider, Contract } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(__dirname, "../../../.env");

function loadEnv(path) {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnv(rootEnv);

const SE =
  process.env.SELF_ENTROPY_ADDRESS ||
  "0xd305290DaF2b14b60FE3aaE7281C4A001B973aB0";
const chainFile =
  process.env.CHAIN_FILE || resolve(__dirname, "../entropy-state.json");
const write = process.argv.includes("--write");

const state = JSON.parse(readFileSync(chainFile, "utf8"));
const provider = new JsonRpcProvider(process.env.RPC_URL);
const abi = [
  "function currentEpoch() view returns (uint64)",
  "function epochCursor(uint64) view returns (bytes32)",
  "function nextFulfillSeq(uint64) view returns (uint256)",
  "function nextSeq() view returns (uint256)",
];
const c = new Contract(SE, abi, provider);
const epoch = await c.currentEpoch();
const cursor = String(await c.epochCursor(epoch)).toLowerCase();
const head = await c.nextFulfillSeq(epoch);
const nextSeq = await c.nextSeq();

function hashPacked(preimageHex) {
  return keccak256(solidityPacked(["bytes32"], [preimageHex]));
}

console.log(`epoch=${epoch} head=${head} nextSeq=${nextSeq}`);
console.log(`on-chain cursor=${cursor}`);
console.log(`local nextRevealIndex=${state.nextRevealIndex} n=${state.n}`);

// cursor == H^{k}(secret) ⇒ nextRevealIndex = k - 1 (preimage is H^{k-1})
let h = state.secret;
let match = null;
const n = Number(state.n);
for (let k = 0; k <= n; k++) {
  if (h.toLowerCase() === cursor) {
    match = k - 1;
    break;
  }
  h = hashPacked(h);
}

if (match == null) {
  console.error("NO MATCH — cursor not on this chain (wrong secret/commitment)");
  process.exit(2);
}
if (match < 0) {
  console.error("cursor equals secret — impossible for a live epoch tip");
  process.exit(2);
}

const delta = match - Number(state.nextRevealIndex);
console.log(`MATCH nextRevealIndex=${match} (delta ${delta >= 0 ? "+" : ""}${delta})`);

if (write) {
  state.nextRevealIndex = match;
  writeFileSync(chainFile, JSON.stringify(state, null, 2) + "\n");
  console.log(`wrote ${chainFile}`);
} else {
  console.log("dry-run only; pass --write to persist");
}
