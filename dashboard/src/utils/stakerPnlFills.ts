/**
 * Persisted market fills for staker PnL — avoid genesis alchemy_getAssetTransfers
 * on every Reload. Disk: dashboard/.data/staker-pnl-fills.json
 */

/** Bump when fill classification changes — clears cached fills + StakersPanel PnL. */
export const PNL_LOGIC_VERSION = 4;

export type StoredPnlFill = {
  side: "buy" | "sell";
  amount: string;
  ts: number;
};

export type StoredWalletPnlFills = {
  transfersThroughBlock: number;
  fills: StoredPnlFill[];
  logicVersion: number;
};

export type PnlFillsStore = {
  updatedAt: number;
  logicVersion: number;
  wallets: Record<string, StoredWalletPnlFills>;
};

export function emptyPnlFillsStore(): PnlFillsStore {
  return {
    updatedAt: Date.now(),
    logicVersion: PNL_LOGIC_VERSION,
    wallets: {},
  };
}

export function isPnlFillsStore(v: unknown): v is PnlFillsStore {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.updatedAt === "number" && typeof o.wallets === "object" && o.wallets != null;
}

let memory: PnlFillsStore | null = null;
let loadPromise: Promise<PnlFillsStore> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadPnlFillsStore(): Promise<PnlFillsStore> {
  if (memory) return memory;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      if (typeof window !== "undefined") {
        const res = await fetch("/api/staker-pnl-fills", { cache: "no-store" });
        if (res.status === 404) {
          memory = emptyPnlFillsStore();
          return memory;
        }
        if (!res.ok) throw new Error(`staker-pnl-fills GET ${res.status}`);
        const data = (await res.json()) as { store: PnlFillsStore | null };
        memory =
          data.store && isPnlFillsStore(data.store)
            ? data.store
            : emptyPnlFillsStore();
        if (memory.logicVersion !== PNL_LOGIC_VERSION) {
          memory = emptyPnlFillsStore();
        }
        return memory;
      }
      // Server import path (tests) — lazy require file util
      const { readPnlFillsFile } = await import("@/utils/stakerPnlFillsFile");
      const disk = await readPnlFillsFile();
      memory =
        disk && isPnlFillsStore(disk) && disk.logicVersion === PNL_LOGIC_VERSION
          ? disk
          : emptyPnlFillsStore();
      return memory;
    } catch {
      memory = emptyPnlFillsStore();
      return memory;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export function getWalletFills(store: PnlFillsStore, wallet: string): StoredWalletPnlFills | null {
  const row = store.wallets[wallet.toLowerCase()];
  if (!row || row.logicVersion !== PNL_LOGIC_VERSION) return null;
  return row;
}

export function setWalletFills(
  store: PnlFillsStore,
  wallet: string,
  row: StoredWalletPnlFills,
): void {
  store.wallets[wallet.toLowerCase()] = row;
  store.updatedAt = Date.now();
  store.logicVersion = PNL_LOGIC_VERSION;
  memory = store;
  schedulePersist(store);
}

function schedulePersist(store: PnlFillsStore): void {
  if (typeof window === "undefined") return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void fetch("/api/staker-pnl-fills", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store }),
    }).catch(() => {
      /* best-effort */
    });
  }, 800);
}

/** Flush pending disk write immediately (end of PnL batch). */
export async function flushPnlFillsStore(): Promise<void> {
  if (typeof window === "undefined" || !memory) return;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  await fetch("/api/staker-pnl-fills", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ store: memory }),
  });
}
