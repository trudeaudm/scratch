/**
 * Paginated SCRATCH holders via Blockscout module=token&action=getTokenHolders.
 */

const DEFAULT_API = "https://robinhoodchain.blockscout.com/api";

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithRetry(fetchImpl, url, { retries = 8 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchImpl(url);
    if (res.status === 429 || res.status >= 500) {
      const backoff = Math.min(30_000, 500 * 2 ** attempt);
      lastErr = new Error(`Blockscout HTTP ${res.status}`);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Blockscout holders HTTP ${res.status}`);
    }
    return res.json();
  }
  throw lastErr || new Error("Blockscout retries exhausted");
}

/**
 * @param {string} scratch
 * @param {{ api?: string, pageSize?: number, fetchImpl?: typeof fetch, pageDelayMs?: number }} [opts]
 * @returns {Promise<{ address: string, balance: bigint }[]>}
 */
export async function fetchAllHolders(scratch, opts = {}) {
  const api = opts.api || process.env.BLOCKSCOUT_API || DEFAULT_API;
  const pageSize = opts.pageSize || Number(process.env.HOLDERS_PAGE_SIZE || 100);
  const pageDelayMs = opts.pageDelayMs ?? Number(process.env.HOLDERS_PAGE_DELAY_MS || 400);
  const fetchImpl = opts.fetchImpl || fetch;
  const holders = [];
  let page = 1;

  for (;;) {
    const url = new URL(api);
    url.searchParams.set("module", "token");
    url.searchParams.set("action", "getTokenHolders");
    url.searchParams.set("contractaddress", scratch);
    url.searchParams.set("page", String(page));
    url.searchParams.set("offset", String(pageSize));

    const body = await fetchJsonWithRetry(fetchImpl, url.toString());
    if (body.status === "0" && (!body.result || body.result.length === 0)) {
      break;
    }
    if (body.message && body.message !== "OK" && !Array.isArray(body.result)) {
      throw new Error(`Blockscout holders error: ${body.message || JSON.stringify(body)}`);
    }
    const rows = Array.isArray(body.result) ? body.result : [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const address = (row.address || row.Address || "").toLowerCase();
      const value = row.value ?? row.Value ?? "0";
      holders.push({ address, balance: BigInt(value) });
    }

    if (rows.length < pageSize) break;
    page += 1;
    if (page > 10_000) throw new Error("holders pagination exceeded 10000 pages — abort");
    if (pageDelayMs > 0) await sleep(pageDelayMs);
  }

  return holders;
}
