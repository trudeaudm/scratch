import { promises as fs } from "fs";
import path from "path";
import type { StoredSnapshot } from "@/utils/stakersSnapshot";
import { isStoredSnapshot } from "@/utils/stakersSnapshot";

/** Local ops state — gitignored under `dashboard/.data/`. */
export function stakersSnapshotPath(): string {
  return path.join(process.cwd(), ".data", "stakers-v2-snapshot.json");
}

export async function readStakersSnapshotFile(): Promise<StoredSnapshot | null> {
  try {
    const raw = await fs.readFile(stakersSnapshotPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredSnapshot(parsed)) return null;
    return parsed;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw e;
  }
}

export async function writeStakersSnapshotFile(snap: StoredSnapshot): Promise<void> {
  const dir = path.dirname(stakersSnapshotPath());
  await fs.mkdir(dir, { recursive: true });
  const body = `${JSON.stringify(snap, null, 2)}\n`;
  const tmp = `${stakersSnapshotPath()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, stakersSnapshotPath());
}
