import { promises as fs } from "fs";
import path from "path";
import type { PnlFillsStore } from "@/utils/stakerPnlFills";
import { isPnlFillsStore } from "@/utils/stakerPnlFills";

export function stakerPnlFillsPath(): string {
  return path.join(process.cwd(), ".data", "staker-pnl-fills.json");
}

export async function readPnlFillsFile(): Promise<PnlFillsStore | null> {
  try {
    const raw = await fs.readFile(stakerPnlFillsPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPnlFillsStore(parsed)) return null;
    return parsed;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw e;
  }
}

export async function writePnlFillsFile(store: PnlFillsStore): Promise<void> {
  const dir = path.dirname(stakerPnlFillsPath());
  await fs.mkdir(dir, { recursive: true });
  const body = `${JSON.stringify(store, null, 2)}\n`;
  const tmp = `${stakerPnlFillsPath()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, stakerPnlFillsPath());
}
