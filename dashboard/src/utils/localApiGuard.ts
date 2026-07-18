import { NextRequest, NextResponse } from "next/server";

/**
 * Refuse token-config mutations outside local dev.
 * Blocks NODE_ENV=production and any non-localhost Host.
 */
export function refuseUnlessLocalDev(req: NextRequest): NextResponse | null {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Token config writes are disabled when NODE_ENV is production" },
      { status: 403 },
    );
  }

  const host = (req.headers.get("host") ?? "").split(",")[0]?.trim() ?? "";
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  const local =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1";

  if (!local) {
    return NextResponse.json(
      { error: "Token config writes are only allowed from localhost" },
      { status: 403 },
    );
  }

  return null;
}
