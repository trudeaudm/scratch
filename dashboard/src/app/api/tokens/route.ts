import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { refuseUnlessLocalDev } from "@/utils/localApiGuard";
import {
  normalizeConfirmSymbol,
  readTokensFile,
  writeTokensFile,
} from "@/utils/tokensFile";
import type { DexPair, TokenConfig, TokenKind } from "@/config/addresses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** EOA-style pair address (20 bytes) or Uniswap v4 pool id (32-byte hex). */
function isPairId(v: string): boolean {
  if (isAddress(v)) return true;
  return /^0x[0-9a-fA-F]{64}$/.test(v);
}

function normalizePairId(v: string): `0x${string}` {
  if (isAddress(v)) return getAddress(v) as `0x${string}`;
  return (`0x${v.slice(2).toLowerCase()}`) as `0x${string}`;
}

function isDexPair(v: unknown): v is DexPair {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.chainId === "string" &&
    o.chainId.length > 0 &&
    typeof o.pairAddress === "string" &&
    isPairId(o.pairAddress)
  );
}

function parseTokenBody(body: unknown): { token?: TokenConfig; error?: string } {
  if (!body || typeof body !== "object") return { error: "Invalid JSON body" };
  const o = body as Record<string, unknown>;
  const symbol = typeof o.symbol === "string" ? o.symbol.trim() : "";
  if (!symbol) return { error: "symbol required" };
  if (typeof o.address !== "string" || !isAddress(o.address)) return { error: "valid address required" };
  const decimals = Number(o.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return { error: "decimals must be an integer 0–36" };
  }
  const price =
    o.price === "scratch" ||
    o.price === "usdg" ||
    o.price === "eth" ||
    o.price === "dex" ||
    o.price === "none"
      ? o.price
      : "dex";

  const token: TokenConfig = {
    symbol,
    address: getAddress(o.address),
    decimals,
    price,
  };

  if (typeof o.name === "string" && o.name.trim()) token.name = o.name.trim();
  if (o.kind === "stock" || o.kind === "crypto") token.kind = o.kind as TokenKind;
  if (typeof o.ticker === "string" && o.ticker.trim()) token.ticker = o.ticker.trim();
  if (o.preferredPair !== undefined) {
    if (!isDexPair(o.preferredPair)) return { error: "preferredPair invalid" };
    token.preferredPair = {
      chainId: o.preferredPair.chainId,
      pairAddress: normalizePairId(o.preferredPair.pairAddress),
    };
  }
  if (token.kind === "stock" && !token.ticker) {
    return { error: "ticker required when kind is stock" };
  }

  return { token };
}

/** GET — current verified tokens (always allowed in local ops UI). */
export async function GET() {
  try {
    const tokens = await readTokensFile();
    return NextResponse.json({ tokens });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to read tokens.json" },
      { status: 500 },
    );
  }
}

/** POST — append a verified token (local-dev only). */
export async function POST(req: NextRequest) {
  const blocked = refuseUnlessLocalDev(req);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const confirm =
    body && typeof body === "object" && typeof (body as { confirmSymbol?: unknown }).confirmSymbol === "string"
      ? normalizeConfirmSymbol((body as { confirmSymbol: string }).confirmSymbol)
      : "";

  const { token, error } = parseTokenBody(
    body && typeof body === "object" && "token" in (body as object)
      ? (body as { token: unknown }).token
      : body,
  );
  if (error || !token) {
    return NextResponse.json({ error: error ?? "invalid token" }, { status: 400 });
  }
  if (confirm !== token.symbol) {
    return NextResponse.json(
      { error: `Type the symbol "${token.symbol}" exactly to confirm` },
      { status: 400 },
    );
  }

  try {
    const tokens = await readTokensFile();
    if (tokens.some((t) => t.address.toLowerCase() === token.address.toLowerCase())) {
      return NextResponse.json({ error: "Address already in verified config" }, { status: 409 });
    }
    tokens.push(token);
    await writeTokensFile(tokens);
    return NextResponse.json({ tokens, token });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to write tokens.json" },
      { status: 500 },
    );
  }
}

/** DELETE — remove a verified token (local-dev only). */
export async function DELETE(req: NextRequest) {
  const blocked = refuseUnlessLocalDev(req);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (typeof o.address !== "string" || !isAddress(o.address)) {
    return NextResponse.json({ error: "valid address required" }, { status: 400 });
  }
  const confirm =
    typeof o.confirmSymbol === "string" ? normalizeConfirmSymbol(o.confirmSymbol) : "";

  try {
    const tokens = await readTokensFile();
    const addr = o.address.toLowerCase();
    const idx = tokens.findIndex((t) => t.address.toLowerCase() === addr);
    if (idx < 0) {
      return NextResponse.json({ error: "Token not in verified config" }, { status: 404 });
    }
    const existing = tokens[idx]!;
    if (confirm !== existing.symbol) {
      return NextResponse.json(
        { error: `Type the symbol "${existing.symbol}" exactly to confirm` },
        { status: 400 },
      );
    }
    tokens.splice(idx, 1);
    await writeTokensFile(tokens);
    return NextResponse.json({ tokens, removed: existing });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to write tokens.json" },
      { status: 500 },
    );
  }
}
