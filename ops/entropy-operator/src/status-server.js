/**
 * Optional HTTP status/ledger surface for the entropy operator.
 * Started only when STATUS_PORT is set.
 *
 * Public (no auth):
 *   GET /healthz
 *   GET /wins.json          — recent real wins from payout-ledger.csv
 *   GET /settlement/:id.json — ledger rows for one requestId (win-cards)
 *
 * Bearer STATUS_TOKEN:
 *   GET /status, /reconcile, /ledger.csv
 */
import http from "node:http";
import fs from "node:fs";
import {
  defaultLedgerPath,
  readRecentWinsFromLedger,
  readSettlementFromLedger,
  splitCsvLine,
} from "./payout-ledger.js";
import { runReconcile } from "./reconcile-ledger.js";

const DEFAULT_CORS_ORIGINS = [
  "https://scratch4663.xyz",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
];

function corsOrigins() {
  const raw = (process.env.WINS_CORS_ORIGINS || "").trim();
  if (!raw) return DEFAULT_CORS_ORIGINS;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function readBearer(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

function applyCors(req, res, { publicCache = false } = {}) {
  const origin = req.headers.origin || "";
  const allowed = corsOrigins();
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!origin) {
    // non-browser clients
    res.setHeader("Access-Control-Allow-Origin", allowed[0] || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (publicCache) {
    res.setHeader("Cache-Control", "public, max-age=5");
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(raw);
}

function parseSinceMs(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
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

      if (req.method === "OPTIONS") {
        applyCors(req, res);
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && path === "/healthz") {
        applyCors(req, res);
        return sendJson(res, 200, { ok: true, ...getHealth() });
      }

      if (req.method === "GET" && path === "/wins.json") {
        applyCors(req, res, { publicCache: true });
        const sinceMs = parseSinceMs(url.searchParams.get("since"));
        let limit = Number(url.searchParams.get("limit"));
        if (!Number.isFinite(limit)) limit = 50;
        const { wins, total } = readRecentWinsFromLedger({ sinceMs, limit });
        return sendJson(
          res,
          200,
          {
            wins,
            total,
            since: sinceMs != null ? new Date(sinceMs).toISOString() : null,
            limit: Math.min(Math.max(1, limit), 200),
          },
          { "Cache-Control": "public, max-age=5" },
        );
      }

      const settlementMatch = path.match(/^\/settlement\/(\d+)\.json$/);
      if (req.method === "GET" && settlementMatch) {
        applyCors(req, res, { publicCache: true });
        const found = readSettlementFromLedger(settlementMatch[1]);
        if (!found) {
          return sendJson(
            res,
            404,
            { error: "not found", requestId: settlementMatch[1] },
            { "Cache-Control": "public, max-age=5" },
          );
        }
        return sendJson(res, 200, found, { "Cache-Control": "public, max-age=5" });
      }

      if (readBearer(req) !== token) {
        applyCors(req, res);
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
    console.log(
      `  status HTTP:     :${port} (/healthz /wins.json /settlement/:id.json public; others Bearer STATUS_TOKEN)`,
    );
  });

  return server;
}
