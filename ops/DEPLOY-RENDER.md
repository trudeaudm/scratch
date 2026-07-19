# Render deploy — entropy operator + win-cards

The static site (`scratch4663` / `scratch4663.xyz`) already lives on this Render account and is defined in repo-root `render.yaml`. **Do not** fold these two ops services into that Blueprint — Blueprint sync would fight the existing site service. Create both from the Render dashboard (same repo, different root directories).

| Service | Type | Root dir | Start | Auto-deploy | Disk |
|---------|------|----------|-------|-------------|------|
| `scratch-entropy-operator` | Background Worker | `ops/entropy-operator` | `npm run watch` | **OFF** | `/data` 1 GB |
| `scratch-win-cards` | Web Service | `ops/win-cards` | `npm start` | ON | `/data` 1 GB |

---

## SERVICE A — `scratch-entropy-operator`

Dashboard → **New +** → **Background Worker** → connect the same GitHub repo as the site.

| Field | Value |
|-------|-------|
| Name | `scratch-entropy-operator` |
| Region | same as the site |
| Branch | `main` (or your production branch) |
| Root Directory | `ops/entropy-operator` |
| Runtime | Node |
| Build Command | `npm ci` |
| Start Command | `npm run watch` |
| Instance type | **Starter** |
| Auto-Deploy | **No** (manual deploys only — never surprise-restart the reveal bot) |

**Disk:** Add persistent disk → name `entropy-data` → mount path `/data` → size **1 GB**.

### Environment variables

| Key | Value |
|-----|-------|
| `OPERATOR_PRIVATE_KEY` | operator EOA private key (secret) |
| `RPC_URL` | Alchemy (or other) HTTPS JSON-RPC |
| `WSS_URL` | Alchemy `wss://…` (preferred; else inferred from Alchemy HTTPS) |
| `SELF_ENTROPY_ADDRESS` | `0xd305290DaF2b14b60FE3aaE7281C4A001B973aB0` |
| `CHAIN_FILE` | `/data/entropy-state.json` |
| `LEDGER_FILE` | `/data/payout-ledger.csv` |

Optional: `GAME_ADDRESS`, `POLL_MS`, `HEAD_CHECK_MS`.

On first start **before** state is pasted, the watcher hard-exits with `chain state file not found: /data/entropy-state.json` — that exit proves env + disk wiring. Leave it stopped (or crashed) until migration step (b).

---

## SERVICE B — `scratch-win-cards`

Dashboard → **New +** → **Web Service** → same repo.

| Field | Value |
|-------|-------|
| Name | `scratch-win-cards` |
| Root Directory | `ops/win-cards` |
| Runtime | Node |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Instance type | Starter (or free if available) |
| Auto-Deploy | **Yes** |

**Disk:** Add persistent disk → name `win-cards-cache` → mount path `/data` → size **1 GB**.

### Environment variables

| Key | Value |
|-----|-------|
| `RPC_URL` | same HTTPS RPC as the site / operator |
| `GAME` | `0xBeD604b5AB226134EdF154cc31881d8C93f4C9e6` |
| `CACHE_DIR` | `/data/win-cards` |
| `SITE_ORIGIN` | `https://scratch4663.xyz` |
| `PUBLIC_ORIGIN` | `https://share.scratch4663.xyz` |

`PORT` is injected by Render — do not set it.

### Custom domain `share.scratch4663.xyz`

1. In the `scratch-win-cards` service → **Settings** → **Custom Domains** → **Add** → `share.scratch4663.xyz`.
2. Render shows a CNAME target (usually `something.onrender.com`). Copy it.
3. **Namecheap** → Domain List → `scratch4663.xyz` → **Advanced DNS**:
   - Type: **CNAME Record**
   - Host: `share`
   - Value: the Render target (e.g. `scratch-win-cards.onrender.com`)
   - TTL: Automatic
4. Wait for Render to show **Certificate issued** / TLS green on the custom domain.
5. Smoke: `https://share.scratch4663.xyz/healthz` → `ok`, and `https://share.scratch4663.xyz/win/<recentReq>.png` returns a PNG.

---

## Migration runbook (exact order)

### (a) Create both services, env-complete; operator not settling yet

1. Create **SERVICE B** (`scratch-win-cards`) with env + disk + custom domain DNS as above. Let it deploy and go live.
2. Create **SERVICE A** (`scratch-entropy-operator`) with env + disk. Auto-Deploy **OFF**.
3. First deploy of A is expected to **crash-loop / exit** on missing `/data/entropy-state.json`. That is the wiring proof — do **not** paste state yet. If Render keeps restarting, use **Manual Suspend** or leave it until (c); either is fine as long as it is not successfully revealing.

### (b) Laptop → stop local watcher, paste state into Render shell

On the laptop (PowerShell):

```powershell
# Stop the local watcher (Ctrl+C in its terminal), then verify zero processes:
wmic process where "CommandLine like '%watch-and-reveal%'" get ProcessId,CommandLine
```

Expect only the `wmic` row itself (or empty). If a `node … watch-and-reveal.js` remains, kill it by PID.

Capture local line counts (for the paste verify):

```powershell
cd ops\entropy-operator
(Get-Content entropy-state.json | Measure-Object -Line).Lines
(Get-Content payout-ledger.csv | Measure-Object -Line).Lines
```

Open **SERVICE A** → **Shell**. Paste-create both files (files are small text). From the laptop, print contents to copy:

```powershell
Get-Content entropy-state.json -Raw
# then for the CSV — or open in an editor and copy all
Get-Content payout-ledger.csv -Raw
```

In the Render shell:

```bash
mkdir -p /data

cat > /data/entropy-state.json <<'EOF'
# paste the FULL contents of local entropy-state.json between this line and EOF
EOF

cat > /data/payout-ledger.csv <<'EOF'
# paste the FULL contents of local payout-ledger.csv between this line and EOF
EOF

# verify line counts match the laptop numbers from above
wc -l /data/entropy-state.json /data/payout-ledger.csv
ls -la /data/
```

If `wc -l` disagrees, delete the file (`rm /data/…`) and re-paste — do **not** start the watcher with a truncated chain file.

### (c) Start / restart SERVICE A; verify logs

1. Render → `scratch-entropy-operator` → **Manual Deploy** (or Clear build cache + deploy) / **Resume** if suspended.
2. **Logs** must show, in order:
   - `operator wallet: 0x…` matching the on-chain `SelfEntropyProvider.operator()`
   - `transport: websocket wss://…/v2/***` (wss mode) — or an explicit HTTP poll fallback if WSS is down
   - `chain file: /data/entropy-state.json`
   - `payout ledger: /data/payout-ledger.csv`
3. Scratch one ticket on the live site (or wait for organic traffic). Confirm one settlement end-to-end: `RandomnessRequested` → `reveal` tx → `ScratchSettled` / ledger append in logs.

### (d) Cutover declared — fail-safe the laptop copy

Rename the laptop chain file so an accidental `npm run watch` cannot double-reveal:

```powershell
cd ops\entropy-operator
Rename-Item entropy-state.json entropy-state.json.migrated-to-render
```

Local `npm run watch` will then hard-exit on missing chain file.

---

## After TLS is green on `share.scratch4663.xyz`

Site share intent already points at `https://share.scratch4663.xyz/win/N` (`site/app.js`, cache-bust `?v=share-og-1`). Once the custom domain answers with TLS:

1. Hard-refresh the live site and share a win → X intent URL must contain `share.scratch4663.xyz/win/`.
2. Paste that URL into [Twitter Card Validator](https://cards-dev.twitter.com/validator) / open in a private window — large image card should show the generated PNG.

---

## Rollback

- **Operator:** Suspend the Render worker; restore `entropy-state.json.migrated-to-render` → `entropy-state.json` on the laptop; `npm run watch` locally. Only one reveal process may run.
- **Share URLs:** Revert `buildWinShareText` in `site/app.js` to `https://scratch4663.xyz/win.html?req=…` and bump `?v=`.
