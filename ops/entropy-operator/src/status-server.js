/**
 * Optional HTTP status/ledger surface for the entropy operator.
 * Started only when STATUS_PORT is set. Bearer auth via STATUS_TOKEN
 * except GET /healthz (Render health checks).
 */
import http from "node:http";
import fs from "node:fs";
import { defaultLedgerPath, splitCsvLine } from "./payout-ledger.js";
import { runReconcile } from "./reconcile-ledger.js";

function readBearer(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(raw);
}

function ledgerStats(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) {
    return {
      exists: false,
      rows: 0,
      newest: null,
      livePricingLast24h: 0,
    };
  }
  const lines = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean);
  const start = lines[0]?.startsWith("timestamp") ? 1 : 0;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let livePricingLast24h = 0;
  let newest = null;
  for (let i = start; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    if (c.length < 12) continue;
    const ts = c[0];
    const requestId = c[1];
    const retro = String(c[11]).toLowerCase() === "true";
    const t = Date.parse(ts);
    if (!newest || (Number.isFinite(t) && t >= Date.parse(newest.timestamp || 0))) {
      newest = { timestamp: ts, requestId };
    }
    if (!retro && Number.isFinite(t) && t >= cutoff) livePricingLast24h++;
  }
  return {
    exists: true,
    rows: Math.max(0, lines.length - start),
    newest,
    livePricingLast24h,
  };
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.token
 * @param {() => object} opts.getHealth  sync snapshot for /healthz
 * @param {() => Promise<object>} opts.getLiveStatus  live chain + ledger for /status
 */
export function startStatusServer({ port, token, getHealth, getLiveStatus }) {
  if (!token) {
    throw new Error("STATUS_TOKEN is required when STATUS_PORT is set");
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/healthz") {
        return sendJson(res, 200, { ok: true, ...getHealth() });
      }

      if (readBearer(req) !== token) {
        return sendJson(res, 401, { error: "unauthorized" });
      }

      if (req.method === "GET" && path === "/status") {
        const live = await getLiveStatus();
        const ledger = ledgerStats(defaultLedgerPath());
        return sendJson(res, 200, { ...live, ledger });
      }

      if (req.method === "GET" && path === "/reconcile") {
        const summary = await runReconcile({ silent: true });
        return sendJson(res, 200, summary);
      }

      if (req.method === "GET" && path === "/ledger.csv") {
        const ledgerPath = defaultLedgerPath();
        if (!fs.existsSync(ledgerPath)) {
          return sendJson(res, 404, { error: "ledger not found", path: ledgerPath });
        }
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="payout-ledger.csv"',
          "Cache-Control": "no-store",
        });
        fs.createReadStream(ledgerPath).pipe(res);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      console.error(`status-server error: ${err?.message || err}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: err?.message || String(err) });
      }
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`  status HTTP:     :${port} (/healthz public; others Bearer STATUS_TOKEN)`);
  });

  return server;
}
