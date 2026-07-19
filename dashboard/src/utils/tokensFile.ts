import { promises as fs } from "fs";
import path from "path";
import type { TokenConfig } from "@/config/addresses";

/** Shared token metadata — `site/tokens.json` at repo root (cwd is `dashboard/`). */
export function tokensJsonPath(): string {
  return path.join(process.cwd(), "..", "site", "tokens.json");
}

export async function readTokensFile(): Promise<TokenConfig[]> {
  const raw = await fs.readFile(tokensJsonPath(), "utf8");
  const parsed = JSON.parse(raw) as TokenConfig[];
  if (!Array.isArray(parsed)) throw new Error("tokens.json must be an array");
  return parsed;
}

export async function writeTokensFile(tokens: TokenConfig[]): Promise<void> {
  const body = `${JSON.stringify(tokens, null, 2)}\n`;
  await fs.writeFile(tokensJsonPath(), body, "utf8");
}

export function normalizeConfirmSymbol(s: string): string {
  return s.trim();
}
