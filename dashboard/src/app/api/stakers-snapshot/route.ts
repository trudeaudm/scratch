import { NextRequest, NextResponse } from "next/server";
import { refuseUnlessLocalDev } from "@/utils/localApiGuard";
import { isStoredSnapshot } from "@/utils/stakersSnapshot";
import {
  readStakersSnapshotFile,
  writeStakersSnapshotFile,
} from "@/utils/stakersSnapshotFile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — latest stakers snapshot from `dashboard/.data/` (404 body when missing). */
export async function GET() {
  try {
    const snapshot = await readStakersSnapshotFile();
    if (!snapshot) {
      return NextResponse.json({ snapshot: null }, { status: 404 });
    }
    return NextResponse.json({ snapshot });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** PUT — persist snapshot to disk (localhost / non-production only). */
export async function PUT(req: NextRequest) {
  const blocked = refuseUnlessLocalDev(req);
  if (blocked) return blocked;

  try {
    const body = (await req.json()) as { snapshot?: unknown };
    if (!isStoredSnapshot(body.snapshot)) {
      return NextResponse.json({ error: "Invalid snapshot payload" }, { status: 400 });
    }
    await writeStakersSnapshotFile(body.snapshot);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
