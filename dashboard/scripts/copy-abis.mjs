/**
 * Copy Foundry build ABIs from ../out into ./abi.
 * Run from dashboard/: `npm run copy-abis` (after `forge build` at repo root).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.resolve(root, "..", "out");
const abiDir = path.join(root, "abi");

const contracts = [
  "PrizeVault",
  "StakingVault",
  "StandardTicketSource",
  "ScratchGame",
];

if (!fs.existsSync(outDir)) {
  console.error("Missing ../out — run `forge build` from the repo root first.");
  process.exit(1);
}

fs.mkdirSync(abiDir, { recursive: true });

for (const name of contracts) {
  const src = path.join(outDir, `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(src)) {
    console.error(`Missing artifact: ${src}`);
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(src, "utf8"));
  const dest = path.join(abiDir, `${name}.json`);
  fs.writeFileSync(dest, JSON.stringify(artifact.abi, null, 2) + "\n");
  console.log(`Wrote abi/${name}.json (${artifact.abi.length} entries)`);
}

console.log("Done. VestingWallet.json and erc20.json are hand-maintained stubs.");
