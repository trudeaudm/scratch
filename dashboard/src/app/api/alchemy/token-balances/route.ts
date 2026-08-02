import { NextResponse } from "next/server";
import { getAddress, type Address } from "viem";
import { alchemyGetTokenBalancesDirect } from "@/utils/alchemy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { address?: string };
    if (!body.address) {
      return NextResponse.json({ error: "address required" }, { status: 400 });
    }
    let address: Address;
    try {
      address = getAddress(body.address);
    } catch {
      return NextResponse.json({ error: "invalid address" }, { status: 400 });
    }
    const tokens = await alchemyGetTokenBalancesDirect(address);
    return NextResponse.json({
      tokens: tokens.map((t) => ({
        address: t.address,
        balance: t.balance.toString(),
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
