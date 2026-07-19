# Win-cards OG service

Express service that powers X/Twitter share previews for `$SCRATCH` wins.

| Route | Purpose |
|-------|---------|
| `GET /win/:req` | HTML with per-win `og:*` / `twitter:*` meta; humans redirect to `https://scratch4663.xyz/win.html?req=…` |
| `GET /win/:req.png` | 1200×630 PNG win card (node-canvas + vendored Inter TTFs), disk-cached |
| `GET /healthz` | liveness |

Unknown request IDs and no-win settlements get a generic / “Not this time” card so crawlers never see a broken image.

## Local

```bash
cd ops/win-cards
cp .env.example .env   # RPC_URL required
npm ci
npm start
# http://localhost:8787/win/123
# http://localhost:8787/win/123.png
```

## Env

| Var | Required | Notes |
|-----|----------|-------|
| `RPC_URL` | yes | HTTP JSON-RPC for ScratchSettled lookup |
| `GAME` | no | ScratchGame (alias `GAME_ADDRESS`; default production) |
| `PORT` | no | default `8787` (Render injects `PORT`) |
| `CACHE_DIR` | yes on Render | PNG cache root — use `/data/win-cards` on the persistent disk |
| `SITE_ORIGIN` | no | human redirect target (default `https://scratch4663.xyz`) |
| `PUBLIC_ORIGIN` | no | absolute origin for `og:image` (defaults to `RENDER_EXTERNAL_URL` or localhost) |

Symbol map loads `site/tokens.json` (includes **CASHCAT**) with a seeded fallback.

## Deploy

See [`../DEPLOY-RENDER.md`](../DEPLOY-RENDER.md) — service name `scratch-win-cards`, custom domain `share.scratch4663.xyz`.
