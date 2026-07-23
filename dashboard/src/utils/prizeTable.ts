import { formatUnits, type Address, zeroAddress } from "viem";
import { tokens, type TokenConfig } from "../config/addresses";
import { tokenUsd, type PriceMap } from "./prices";

/** Matches ScratchGame.ODDS_DENOM */
export const ODDS_DENOM = 1_000_000;

export const TIER_STANDARD = 0;
export const TIER_PREMIUM = 1;

export type TierId = typeof TIER_STANDARD | typeof TIER_PREMIUM;

export const TIER_LABELS: Record<TierId, string> = {
  [TIER_STANDARD]: "Standard (0)",
  [TIER_PREMIUM]: "Premium (1)",
};

/** On-chain ScratchGame.PrizeRow */
export type PrizeRow = {
  asset: Address;
  amountOrBps: bigint;
  isBpsOfPool: boolean;
  cumOdds: number;
};

/** Editor row: human probability % (e.g. "10.000"), amount as human string for fixed or bps integer string */
export type EditorRow = {
  id: string;
  asset: Address;
  amountInput: string;
  isBpsOfPool: boolean;
  /** Human probability percent with up to 3 fractional digits (e.g. "10.000"). */
  probabilityPercent: string;
};

export type ValidationIssue = {
  code:
    | "empty"
    | "bad_probability"
    | "prob_sum"
    | "not_monotonic"
    | "bad_terminal"
    | "asset_unbacked"
    | "bad_amount"
    | "bps_range";
  message: string;
  rowIndex?: number;
  /** When true, blocks submit. Soft warnings use false. */
  blocking: boolean;
};

export type AssetCoverage = {
  asset: Address;
  vaultBalance: bigint;
  fallbackRate: bigint;
};

export type AnnotatedRow = {
  row: PrizeRow;
  index: number;
  oddsDelta: number;
  probability: number;
  oneInN: number | null;
  payoutAmount: bigint;
  payoutUsd: number | null;
  exceedsTenPercentVault: boolean;
};

export function resolveToken(asset: Address): TokenConfig | null {
  if (isNoWinAsset(asset)) return null;
  return tokens.find((t) => t.address.toLowerCase() === asset.toLowerCase()) ?? null;
}

/** Case-insensitive NO-WIN / zero-address check (chain may return mixed-case). */
export function isNoWinAsset(asset: string): boolean {
  return asset.toLowerCase() === zeroAddress;
}

/** Lowercase address for stable <select> values and comparisons. */
export function normalizeAsset(asset: string): Address {
  return asset.toLowerCase() as Address;
}

export function assetLabel(asset: Address): { symbol: string; known: boolean } {
  if (isNoWinAsset(asset)) return { symbol: "NO-WIN", known: true };
  const t = resolveToken(asset);
  if (t) return { symbol: t.symbol, known: true };
  return { symbol: `${asset.slice(0, 6)}…`, known: false };
}

/**
 * Prize rows first, exactly one terminal NO-WIN last.
 * Collapses duplicate NO-WIN rows (keeps the first one's probability).
 */
export function ensureTerminalNoWin(rows: EditorRow[]): EditorRow[] {
  const prizes = rows.filter((r) => !isNoWinAsset(r.asset));
  const existing = rows.find((r) => isNoWinAsset(r.asset));
  const terminal: EditorRow = existing
    ? {
        ...existing,
        asset: zeroAddress,
        isBpsOfPool: false,
        amountInput: "0",
      }
    : newEditorRow({
        asset: zeroAddress,
        probabilityPercent: "0.001",
        amountInput: "0",
        isBpsOfPool: false,
      });
  return [...prizes, terminal];
}

/** Move a row by id before/after another (NO-WIN stays terminal). */
export function reorderEditorRows(
  rows: EditorRow[],
  fromId: string,
  toId: string,
): EditorRow[] {
  if (fromId === toId) return rows;
  const from = rows.findIndex((r) => r.id === fromId);
  const to = rows.findIndex((r) => r.id === toId);
  if (from < 0 || to < 0) return rows;
  // Don't drag the terminal NO-WIN.
  if (isNoWinAsset(rows[from].asset)) return rows;
  const next = [...rows];
  const [item] = next.splice(from, 1);
  // Dropping on terminal NO-WIN = move to end of prize list (still before terminal).
  if (isNoWinAsset(rows[to].asset)) {
    const terminalIdx = next.findIndex((r) => isNoWinAsset(r.asset));
    const insertAt = terminalIdx < 0 ? next.length : terminalIdx;
    next.splice(insertAt, 0, item);
    return ensureTerminalNoWin(next);
  }
  const adjustedTo = next.findIndex((r) => r.id === toId);
  const insertAt = adjustedTo < 0 ? next.length : adjustedTo;
  next.splice(insertAt, 0, item);
  return ensureTerminalNoWin(next);
}

/**
 * Parse a human percent string (up to 4 decimals) into ODDS_DENOM units.
 * 100% → 1_000_000; 10% → 100_000; 0.0001% → 1 (finest resolution).
 */
export function percentToOddsDelta(percent: string): number | null {
  const t = percent.trim();
  if (!t || !/^\d+(\.\d{1,4})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const fracPadded = frac.padEnd(4, "0");
  // percent * 10_000 = odds (100% * 10_000 = 1_000_000)
  try {
    const scaled = BigInt(whole) * 10_000n + BigInt(fracPadded);
    if (scaled <= 0n || scaled > BigInt(ODDS_DENOM)) return null;
    return Number(scaled);
  } catch {
    return null;
  }
}

export function oddsDeltaToPercent(delta: number): string {
  const intPart = Math.floor(delta / 10_000);
  const fracPart = String(delta % 10_000).padStart(4, "0");
  // Trim trailing zeros but keep at least 3 fractional digits for stable UI.
  let frac = fracPart.replace(/0+$/, "");
  if (frac.length < 3) frac = frac.padEnd(3, "0");
  return `${intPart}.${frac}`;
}

/** Build on-chain rows from editor rows (probability → cumOdds). */
export function editorToPrizeRows(rows: EditorRow[]): {
  prizeRows: PrizeRow[];
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  if (rows.length === 0) {
    return {
      prizeRows: [],
      issues: [{ code: "empty", message: "Table is empty", blocking: true }],
    };
  }

  const prizeRows: PrizeRow[] = [];
  let cum = 0;

  for (let i = 0; i < rows.length; i++) {
    const er = rows[i];
    const delta = percentToOddsDelta(er.probabilityPercent);
    if (delta === null || delta <= 0) {
      issues.push({
        code: "bad_probability",
                message: `Row ${i}: invalid probability "${er.probabilityPercent}" (need > 0, ≤4 decimals)`,
        rowIndex: i,
        blocking: true,
      });
      continue;
    }

    const token = resolveToken(er.asset);
    const decimals = token?.decimals ?? 18;
    let amountOrBps = 0n;

    if (isNoWinAsset(er.asset)) {
      amountOrBps = 0n;
    } else if (er.isBpsOfPool) {
      const t = er.amountInput.trim();
      if (!/^\d+$/.test(t)) {
        issues.push({
          code: "bad_amount",
          message: `Row ${i}: bps must be a non-negative integer`,
          rowIndex: i,
          blocking: true,
        });
      } else {
        amountOrBps = BigInt(t);
        if (amountOrBps > 10_000n) {
          issues.push({
            code: "bps_range",
            message: `Row ${i}: bps ${amountOrBps} exceeds 10000 (100%)`,
            rowIndex: i,
            blocking: true,
          });
        }
      }
    } else {
      const parsed = parseHumanAmount(er.amountInput, decimals);
      if (parsed === null) {
        issues.push({
          code: "bad_amount",
          message: `Row ${i}: invalid fixed amount`,
          rowIndex: i,
          blocking: true,
        });
      } else {
        amountOrBps = parsed;
        if (amountOrBps > 2n ** 96n - 1n) {
          issues.push({
            code: "bad_amount",
            message: `Row ${i}: amount exceeds uint96`,
            rowIndex: i,
            blocking: true,
          });
        }
      }
    }

    cum += delta;
    prizeRows.push({
      asset: normalizeAsset(er.asset),
      amountOrBps,
      isBpsOfPool: isNoWinAsset(er.asset) ? false : er.isBpsOfPool,
      cumOdds: cum,
    });
  }

  return { prizeRows, issues };
}

function parseHumanAmount(input: string, decimals: number): bigint | null {
  const t = input.trim();
  if (!t || !/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  try {
    return BigInt(whole + frac.padEnd(decimals, "0"));
  } catch {
    return null;
  }
}

export function prizeRowsToEditor(rows: PrizeRow[]): EditorRow[] {
  return ensureTerminalNoWin(
    rows.map((r, i) => {
      const prev = i === 0 ? 0 : rows[i - 1].cumOdds;
      const delta = r.cumOdds - prev;
      const token = resolveToken(r.asset);
      const decimals = token?.decimals ?? 18;
      let amountInput = "0";
      if (!isNoWinAsset(r.asset)) {
        if (r.isBpsOfPool) {
          amountInput = r.amountOrBps.toString();
        } else {
          amountInput = formatUnits(r.amountOrBps, decimals);
        }
      }
      return {
        id: `row-${i}-${r.cumOdds}-${normalizeAsset(r.asset).slice(2, 10)}`,
        asset: normalizeAsset(r.asset),
        amountInput,
        isBpsOfPool: isNoWinAsset(r.asset) ? false : r.isBpsOfPool,
        probabilityPercent: oddsDeltaToPercent(delta),
      };
    }),
  );
}

/**
 * Client validation mirroring ScratchGame._validateTable plus probability sum
 * and vault/fallback coverage checks.
 */
export function validatePrizeTable(
  rows: PrizeRow[],
  coverage?: Map<string, AssetCoverage> | AssetCoverage[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const n = rows.length;

  if (n === 0) {
    issues.push({ code: "empty", message: "TableEmpty: table has no rows", blocking: true });
    return issues;
  }

  let prev = 0;
  for (let i = 0; i < n; i++) {
    const c = rows[i].cumOdds;
    if (c <= prev) {
      issues.push({
        code: "not_monotonic",
        message: `TableNotMonotonic: row ${i} cumOdds ${c} <= previous ${prev}`,
        rowIndex: i,
        blocking: true,
      });
    }
    prev = c;
  }

  const last = rows[n - 1];
  if (last.cumOdds !== ODDS_DENOM || !isNoWinAsset(last.asset)) {
    issues.push({
      code: "bad_terminal",
      message: `TableBadTerminal: last row must be asset=0x0 and cumOdds=${ODDS_DENOM} (got asset=${last.asset}, cumOdds=${last.cumOdds})`,
      rowIndex: n - 1,
      blocking: true,
    });
  }

  // Probabilities sum to 100.000% ≡ last cumOdds == ODDS_DENOM (already checked)
  // and every delta > 0 (monotonic). Extra explicit sum check for editor messaging:
  if (last.cumOdds !== ODDS_DENOM) {
    const sumPct = oddsDeltaToPercent(last.cumOdds);
    issues.push({
      code: "prob_sum",
      message: `Probabilities sum to ${sumPct}% (need exactly 100.000%)`,
      blocking: true,
    });
  }

  const covMap = toCoverageMap(coverage);
  if (covMap) {
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      if (isNoWinAsset(r.asset)) continue;
      const cov = covMap.get(r.asset.toLowerCase());
      const bal = cov?.vaultBalance ?? 0n;
      const rate = cov?.fallbackRate ?? 0n;
      if (bal === 0n && rate === 0n) {
        issues.push({
          code: "asset_unbacked",
          message: `Row ${i}: asset ${r.asset} has zero vault balance and no fallbackRate — payouts may settle at zero`,
          rowIndex: i,
          blocking: true,
        });
      } else if (bal === 0n && rate > 0n) {
        issues.push({
          code: "asset_unbacked",
          message: `Row ${i}: vault holds 0 of this asset; fallbackRate is set (will pay SCRATCH on miss)`,
          rowIndex: i,
          blocking: false,
        });
      }
    }
  }

  return issues;
}

function toCoverageMap(
  coverage?: Map<string, AssetCoverage> | AssetCoverage[],
): Map<string, AssetCoverage> | null {
  if (!coverage) return null;
  if (coverage instanceof Map) return coverage;
  const m = new Map<string, AssetCoverage>();
  for (const c of coverage) m.set(c.asset.toLowerCase(), c);
  return m;
}

export function annotateRows(
  rows: PrizeRow[],
  vaultBalances: Map<string, bigint>,
  prices: PriceMap,
): AnnotatedRow[] {
  return rows.map((row, index) => {
    const prev = index === 0 ? 0 : rows[index - 1].cumOdds;
    const oddsDelta = row.cumOdds - prev;
    const probability = oddsDelta / ODDS_DENOM;
    const oneInN = oddsDelta > 0 ? ODDS_DENOM / oddsDelta : null;

    let payoutAmount = 0n;
    if (!isNoWinAsset(row.asset)) {
      if (row.isBpsOfPool) {
        const bal = vaultBalances.get(row.asset.toLowerCase()) ?? 0n;
        payoutAmount = (row.amountOrBps * bal) / 10_000n;
      } else {
        payoutAmount = row.amountOrBps;
      }
    }

    const token = resolveToken(row.asset);
    const payoutUsd =
      token && payoutAmount > 0n
        ? tokenUsd(token, payoutAmount, prices)
        : isNoWinAsset(row.asset)
          ? 0
          : null;

    const vaultBal = vaultBalances.get(row.asset.toLowerCase()) ?? 0n;
    const exceedsTenPercentVault =
      !isNoWinAsset(row.asset) &&
      vaultBal > 0n &&
      payoutAmount * 10n > vaultBal; // > 10%

    return {
      row,
      index,
      oddsDelta,
      probability,
      oneInN,
      payoutAmount,
      payoutUsd,
      exceedsTenPercentVault,
    };
  });
}

export function tableEvUsd(annotated: AnnotatedRow[]): number | null {
  let sum = 0;
  let any = false;
  for (const a of annotated) {
    if (a.payoutUsd === null) return null;
    sum += a.probability * a.payoutUsd;
    any = true;
  }
  return any ? sum : null;
}

export function formatProbability(p: number): string {
  return `${(p * 100).toFixed(3)}%`;
}

export function formatOneInN(oneInN: number | null): string {
  if (oneInN === null || !Number.isFinite(oneInN)) return "—";
  if (oneInN >= 100) return `1 in ${Math.round(oneInN).toLocaleString()}`;
  return `1 in ${oneInN.toFixed(2)}`;
}

export type RowDiff = {
  index: number;
  kind: "same" | "changed" | "added" | "removed";
  oldRow?: PrizeRow;
  newRow?: PrizeRow;
  oldAnnotated?: AnnotatedRow;
  newAnnotated?: AnnotatedRow;
};

export function diffTables(
  oldRows: PrizeRow[],
  newRows: PrizeRow[],
  vaultBalances: Map<string, bigint>,
  prices: PriceMap,
): { rows: RowDiff[]; oldEv: number | null; newEv: number | null } {
  const oldA = annotateRows(oldRows, vaultBalances, prices);
  const newA = annotateRows(newRows, vaultBalances, prices);
  const max = Math.max(oldRows.length, newRows.length);
  const rows: RowDiff[] = [];
  for (let i = 0; i < max; i++) {
    const o = oldRows[i];
    const n = newRows[i];
    if (o && n) {
      const same =
        o.asset.toLowerCase() === n.asset.toLowerCase() &&
        o.amountOrBps === n.amountOrBps &&
        o.isBpsOfPool === n.isBpsOfPool &&
        o.cumOdds === n.cumOdds;
      rows.push({
        index: i,
        kind: same ? "same" : "changed",
        oldRow: o,
        newRow: n,
        oldAnnotated: oldA[i],
        newAnnotated: newA[i],
      });
    } else if (o) {
      rows.push({ index: i, kind: "removed", oldRow: o, oldAnnotated: oldA[i] });
    } else {
      rows.push({ index: i, kind: "added", newRow: n, newAnnotated: newA[i] });
    }
  }
  return {
    rows,
    oldEv: tableEvUsd(oldA),
    newEv: tableEvUsd(newA),
  };
}

export function newEditorRow(partial?: Partial<EditorRow>): EditorRow {
  return {
    id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    asset: tokens.find((t) => t.symbol === "SCRATCH")?.address ?? zeroAddress,
    amountInput: "0",
    isBpsOfPool: false,
    probabilityPercent: "0.000",
    ...partial,
  };
}

export function blockingIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.blocking);
}
