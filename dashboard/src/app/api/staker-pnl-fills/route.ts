import { NextRequest, NextResponse } from "next/server";
import { refuseUnlessLocalDev } from "@/utils/localApiGuard";
import { isPnlFillsStore } from "@/utils/stakerPnlFills";
import { readPnlFillsFile, writePnlFillsFile } from "@/utils/stakerPnlFillsFile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — persisted market fills for incremental PnL. */
export async function GET() {
  try {
    const store = await readPnlFillsFile();
    if (!store) {
      return NextResponse.json({ store: null }, { status: 404 });
    }
    return NextResponse.json({ store });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** PUT — persist fills store (localhost / non-production only). */
export async function PUT(req: NextRequest) {
  const blocked = refuseUnlessLocalDev(req);
  if (blocked) return blocked;

  try {
    const body = (await req.json()) as { store?: unknown };
    if (!isPnlFillsStore(body.store)) {
      return NextResponse.json({ error: "Invalid fills store" }, { status: 400 });
    }
    await writePnlFillsFile(body.store);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
