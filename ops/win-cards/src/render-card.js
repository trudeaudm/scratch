/**
 * 1200×630 OG win card (node-canvas + vendored Inter TTFs).
 * Deterministic confetti seeded by requestId for stable cache hits.
 */
import { createCanvas, registerFont } from "canvas";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS = path.resolve(__dirname, "../fonts");

let fontsReady = false;

function ensureFonts() {
  if (fontsReady) return;
  registerFont(path.join(FONTS, "Inter-Medium.ttf"), {
    family: "Inter",
    weight: "500",
  });
  registerFont(path.join(FONTS, "Inter-SemiBold.ttf"), {
    family: "Inter",
    weight: "600",
  });
  registerFont(path.join(FONTS, "Inter-Bold.ttf"), {
    family: "Inter",
    weight: "700",
  });
  registerFont(path.join(FONTS, "Inter-ExtraBold.ttf"), {
    family: "Inter",
    weight: "800",
  });
  fontsReady = true;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromReq(requestId) {
  const s = String(requestId || "0");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function drawLetterspaced(ctx, text, x, y, tracking, align = "left") {
  const chars = [...String(text)];
  if (!chars.length) return;
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total =
    widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);
  let cx = x;
  if (align === "right") cx = x - total;
  else if (align === "center") cx = x - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], cx, y);
    cx += widths[i] + tracking;
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * @param {{
 *   requestId?: string,
 *   tier?: number,
 *   isWin?: boolean,
 *   cardPrize?: string,
 *   generic?: boolean,
 * }} win
 * @returns {Buffer}
 */
export function renderWinCardPng(win = {}) {
  ensureFonts();
  const W = 1200;
  const H = 630;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const rand = mulberry32(seedFromReq(win.requestId));

  ctx.fillStyle = "#0B1015";
  ctx.fillRect(0, 0, W, H);

  const vig = ctx.createRadialGradient(W / 2, H / 2, 80, W / 2, H / 2, 520);
  vig.addColorStop(0, "rgba(33,206,153,0.07)");
  vig.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  const cardX = 90;
  const cardY = 55;
  const cardW = W - 180;
  const cardH = H - 130;
  roundRectPath(ctx, cardX, cardY, cardW, cardH, 28);
  ctx.fillStyle = "#10161C";
  ctx.fill();
  ctx.strokeStyle = "#22303A";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = "#21CE99";
  ctx.lineWidth = 3;
  roundRectPath(ctx, cardX + 28, cardY + 28, cardW - 56, cardH - 56, 10);
  ctx.stroke();
  ctx.strokeStyle = "rgba(33,206,153,0.45)";
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, cardX + 40, cardY + 40, cardW - 80, cardH - 80, 6);
  ctx.stroke();

  const golds = ["#C9A227", "#EAD37E", "#F4E7B0", "#8F6E14", "#F2C94C"];
  for (let i = 0; i < 70; i++) {
    const edge = i % 4;
    let x;
    let y;
    if (edge === 0) {
      x = cardX + rand() * cardW;
      y = cardY - 8 + rand() * 36;
    } else if (edge === 1) {
      x = cardX + rand() * cardW;
      y = cardY + cardH - 28 + rand() * 40;
    } else if (edge === 2) {
      x = cardX - 10 + rand() * 40;
      y = cardY + rand() * cardH;
    } else {
      x = cardX + cardW - 30 + rand() * 40;
      y = cardY + rand() * cardH;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rand() * Math.PI);
    ctx.fillStyle = golds[i % golds.length];
    ctx.fillRect(-3 - rand() * 3, -5 - rand() * 4, 5 + rand() * 5, 8 + rand() * 6);
    ctx.restore();
  }

  const generic = Boolean(win.generic) || !win.requestId;
  const isWin = Boolean(win.isWin) && !generic;
  const prem = Number(win.tier) === 1;
  const reqLabel = generic
    ? "ONCHAIN WIN"
    : `REQUEST #${win.requestId}`;
  const tierLabel = generic ? "SCRATCH" : prem ? "PREMIUM" : "STANDARD";

  ctx.font = "700 22px Inter";
  ctx.fillStyle = "#7E93A0";
  ctx.textBaseline = "alphabetic";
  drawLetterspaced(ctx, reqLabel, cardX + 64, cardY + 88, 4, "left");
  ctx.fillStyle = prem && !generic ? "#C9A227" : "#21CE99";
  drawLetterspaced(ctx, tierLabel, cardX + cardW - 64, cardY + 88, 5, "right");

  let prize;
  let subtitle;
  if (generic) {
    prize = "Wins settle onchain";
    subtitle = "daily scratch-offs · scratch4663.xyz";
  } else if (!isWin) {
    prize = "Not this time";
    subtitle = "Same time tomorrow";
  } else {
    prize = win.cardPrize || "+?";
    subtitle = "Paid to your wallet";
  }

  ctx.fillStyle = isWin || generic ? "#21CE99" : "#E8EDF0";
  ctx.font = "800 64px Inter";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let prizeSize = 64;
  while (prizeSize > 36 && ctx.measureText(prize).width > cardW - 120) {
    prizeSize -= 4;
    ctx.font = `800 ${prizeSize}px Inter`;
  }
  ctx.fillText(prize, W / 2, H / 2 - 6);

  ctx.fillStyle = "#8FA3B0";
  ctx.font = "500 24px Inter";
  ctx.fillText(subtitle, W / 2, H / 2 + 48);

  ctx.fillStyle = "#7E93A0";
  ctx.font = "600 18px Inter";
  ctx.fillText("scratch4663.xyz", W / 2, cardY + cardH + 36);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  return canvas.toBuffer("image/png");
}
