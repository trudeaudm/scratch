import { formatUnits, type Address } from "viem";

export function fmtToken(amount: bigint, decimals: number, maxFrac = 4): string {
  const n = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(n)) return formatUnits(amount, decimals);
  if (n === 0) return "0";
  if (Math.abs(n) < 0.0001) return n.toExponential(2);
  return n.toLocaleString(undefined, {
    maximumFractionDigits: maxFrac,
    minimumFractionDigits: 0,
  });
}

export function fmtUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 4 : 2,
  });
}

export function shortAddr(addr: Address): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function parseAmount(input: string, decimals: number): bigint | null {
  const t = input.trim();
  if (!t || !/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  const padded = frac.padEnd(decimals, "0");
  try {
    return BigInt(whole + padded);
  } catch {
    return null;
  }
}

export function countdown(seconds: number): string {
  if (seconds <= 0) return "now";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
