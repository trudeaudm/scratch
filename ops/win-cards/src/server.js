#!/usr/bin/env node
/**
 * Win-card OG service.
 *
 *   GET /win/:req      → HTML with per-win OG meta; humans → site win.html
 *   GET /win/:req.png  → 1200×630 PNG (disk-cached under CACHE_DIR)
 *   GET /healthz       → ok
 *
 * Env: RPC_URL, GAME (or GAME_ADDRESS), PORT, CACHE_DIR,
 *      SITE_ORIGIN, PUBLIC_ORIGIN (optional)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { fetchWin } from "./fetch-win.js";
import { renderWinCardPng } from "./render-card.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const PORT = Number(process.env.PORT || 8787);
const CACHE_DIR = path.resolve(
  process.env.CACHE_DIR || path.join(__dirname, "..", "cache"),
);
const SITE_ORIGIN = (process.env.SITE_ORIGIN || "https://scratch4663.xyz").replace(
  /\/$/,
  "",
);
const PUBLIC_ORIGIN = (
  process.env.PUBLIC_ORIGIN ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`
).replace(/\/$/, "");

fs.mkdirSync(CACHE_DIR, { recursive: true });

const app = express();
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => {
  res.type("text").send("ok");
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ogHtml({ reqId, title, description, imageUrl, redirectUrl }) {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const img = escapeHtml(imageUrl);
  const url = escapeHtml(`${PUBLIC_ORIGIN}/win/${reqId}`);
  const dest = escapeHtml(redirectUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${url}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@scratch4663">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${img}">
<meta http-equiv="refresh" content="0;url=${dest}">
<link rel="canonical" href="${dest}">
</head>
<body style="background:#0B1015;color:#E8EDF0;font-family:system-ui,sans-serif;padding:48px;text-align:center">
  <p>Redirecting to your win receipt…</p>
  <p><a href="${dest}" style="color:#21CE99">continue →</a></p>
  <script>location.replace(${JSON.stringify(redirectUrl)})</script>
</body>
</html>`;
}

const winCache = new Map(); // reqId → { win, at }
const WIN_TTL_MS = 60_000;

async function resolveWin(reqId) {
  const hit = winCache.get(reqId);
  if (hit && Date.now() - hit.at < WIN_TTL_MS) return hit.win;
  let win = null;
  try {
    win = await fetchWin(reqId);
  } catch (err) {
    console.error(`fetchWin ${reqId}:`, err?.message || err);
  }
  winCache.set(reqId, { win, at: Date.now() });
  return win;
}

app.get("/win/:req.png", async (req, res) => {
  const reqId = String(req.params.req || "").replace(/\.png$/i, "");
  if (!/^\d+$/.test(reqId)) {
    res.status(400).type("text").send("bad request id");
    return;
  }

  const cachePath = path.join(CACHE_DIR, `${reqId}.png`);
  if (fs.existsSync(cachePath)) {
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.type("png").send(fs.readFileSync(cachePath));
    return;
  }

  try {
    const win = await resolveWin(reqId);
    let png;
    if (!win) {
      png = renderWinCardPng({ requestId: reqId, generic: true });
    } else if (!win.isWin) {
      png = renderWinCardPng({
        requestId: win.requestId,
        tier: win.tier,
        isWin: false,
        cardPrize: win.cardPrize,
      });
    } else {
      png = renderWinCardPng({
        requestId: win.requestId,
        tier: win.tier,
        isWin: true,
        cardPrize: win.cardPrize,
      });
    }
    try {
      fs.writeFileSync(cachePath, png);
    } catch (err) {
      console.error(`cache write ${cachePath}:`, err?.message || err);
    }
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.type("png").send(png);
  } catch (err) {
    console.error(`png ${reqId}:`, err?.message || err);
    const fallback = renderWinCardPng({ requestId: reqId, generic: true });
    res.type("png").send(fallback);
  }
});

app.get("/win/:req", async (req, res) => {
  const reqId = String(req.params.req || "");
  if (!/^\d+$/.test(reqId)) {
    res.status(400).type("text").send("bad request id");
    return;
  }

  const win = await resolveWin(reqId);
  const tierKey = win && Number(win.tier) === 1 ? "prem" : "std";
  const redirectUrl = `${SITE_ORIGIN}/win.html?req=${encodeURIComponent(reqId)}&tier=${tierKey}`;
  const imageUrl = `${PUBLIC_ORIGIN}/win/${reqId}.png`;

  let title = "somebody just scratched a winner — $SCRATCH";
  let description =
    "daily onchain scratch-offs. odds rendered from the contract that enforces them.";

  if (win?.isWin) {
    title = `scratched ${win.sharePrize} on $SCRATCH`;
    description = `Request #${reqId} · paid onchain · scratch4663.xyz`;
  } else if (win && !win.isWin) {
    title = `request #${reqId} settled — $SCRATCH`;
    description = "Not this time — same time tomorrow. Odds from the live contract.";
  }

  res
    .status(200)
    .type("html")
    .setHeader("Cache-Control", "public, max-age=60")
    .send(
      ogHtml({
        reqId,
        title,
        description,
        imageUrl,
        redirectUrl,
      }),
    );
});

app.get("/", (_req, res) => {
  res.type("text").send("scratch win-cards — GET /win/:req  ·  GET /win/:req.png");
});

app.listen(PORT, () => {
  console.log(`win-cards listening on :${PORT}`);
  console.log(`  CACHE_DIR=${CACHE_DIR}`);
  console.log(`  GAME=${process.env.GAME || process.env.GAME_ADDRESS || "(default)"}`);
  console.log(`  SITE_ORIGIN=${SITE_ORIGIN}`);
  console.log(`  PUBLIC_ORIGIN=${PUBLIC_ORIGIN}`);
});
