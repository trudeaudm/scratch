import { NextResponse } from "next/server";
import { getAddress, type Address } from "viem";
import {
  alchemyGetAssetTransfersDirect,
  type GetAssetTransfersOpts,
} from "@/utils/alchemy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      fromAddress?: string;
      toAddress?: string;
      contractAddresses?: string[];
      fromBlock?: string | number;
      maxPages?: number;
    };

    if (!body.fromAddress && !body.toAddress) {
      return NextResponse.json(
        { error: "fromAddress or toAddress required" },
        { status: 400 },
      );
    }

    const opts: GetAssetTransfersOpts = {
      fromBlock: body.fromBlock ?? "0x0",
      maxPages: body.maxPages ?? 50,
    };
    if (body.fromAddress) {
      try {
        opts.fromAddress = getAddress(body.fromAddress);
      } catch {
        return NextResponse.json({ error: "invalid fromAddress" }, { status: 400 });
      }
    }
    if (body.toAddress) {
      try {
        opts.toAddress = getAddress(body.toAddress);
      } catch {
        return NextResponse.json({ error: "invalid toAddress" }, { status: 400 });
      }
    }
    if (body.contractAddresses?.length) {
      const addrs: Address[] = [];
      for (const a of body.contractAddresses) {
        try {
          addrs.push(getAddress(a));
        } catch {
          return NextResponse.json(
            { error: `invalid contractAddress ${a}` },
            { status: 400 },
          );
        }
      }
      opts.contractAddresses = addrs;
    }

    const transfers = await alchemyGetAssetTransfersDirect(opts);
    return NextResponse.json({
      transfers: transfers.map((t) => ({
        from: t.from,
        to: t.to,
        hash: t.hash,
        rawValue: t.rawValue.toString(),
        contractAddress: t.contractAddress,
        blockTimestamp: t.blockTimestamp,
        blockNumber: t.blockNumber,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
