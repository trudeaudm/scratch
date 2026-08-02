import { NextResponse } from "next/server";
import { loadScratchOhlcv } from "@/utils/scratchOhlcvFile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — daily SCRATCH/USD OHLCV (disk cache + GeckoTerminal refresh). */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    const cache = await loadScratchOhlcv({ force });
    return NextResponse.json({
      pool: cache.pool,
      network: cache.network,
      fetchedAt: cache.fetchedAt,
      candles: cache.candles,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
