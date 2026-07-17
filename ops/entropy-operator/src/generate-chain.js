#!/usr/bin/env node
/**
 * Generate a committed hash chain for SelfEntropyProvider.registerChain.
 *
 * Chain: chain[0] = secret; chain[i] = keccak256(abi.encodePacked(chain[i-1]));
 * Commitment (tip) = chain[N]. First reveal uses chain[N-1], then N-2, …
 *
 * Usage:
 *   node src/generate-chain.js              # N=100000 (default)
 *   node src/generate-chain.js --n 1000
 *   CHAIN_FILE=./my-state.json node src/generate-chain.js
 */
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, solidityPacked } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_N = 100_000;
const DEFAULT_FILE = resolve(__dirname, "..", "entropy-state.json");

function parseArgs(argv) {
  let n = DEFAULT_N;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--n" && argv[i + 1]) {
      n = Number(argv[++i]);
    }
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`invalid --n ${n}`);
  }
  return { n };
}

function hashPacked(preimageHex) {
  return keccak256(solidityPacked(["bytes32"], [preimageHex]));
}

function main() {
  const { n } = parseArgs(process.argv.slice(2));
  const outFile = resolve(process.env.CHAIN_FILE || DEFAULT_FILE);

  const secret = `0x${randomBytes(32).toString("hex")}`;
  let tip = secret;
  for (let i = 0; i < n; i++) {
    tip = hashPacked(tip);
  }

  const state = {
    version: 1,
    n,
    secret,
    commitment: tip,
    /** Index of the next preimage to reveal (walks from n-1 down to 0). */
    nextRevealIndex: n - 1,
    createdAt: new Date().toISOString(),
  };

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });

  console.log("SelfEntropyProvider hash chain generated");
  console.log(`  N (links):          ${n}`);
  console.log(`  commitment (tip):   ${state.commitment}`);
  console.log(`  state file:         ${outFile}`);
  console.log("");
  console.log("Pass the commitment to Deploy2 / registerChain:");
  console.log(`  ENTROPY_COMMITMENT=${state.commitment}`);
  console.log("");
  console.log("Keep the state file secret — it holds the chain seed.");
}

main();
