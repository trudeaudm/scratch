import type { Address } from "viem";
import type { TokenConfig } from "../config/addresses";

/** Case-insensitive, whitespace-stripped symbol key. */
export function normalizeSymbol(symbol: string): string {
  return symbol.toLowerCase().replace(/\s+/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    let prev = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cur =
        a[i] === b[j] ? row[j]! : 1 + Math.min(row[j]!, row[j + 1]!, prev);
      row[j] = prev;
      prev = cur;
    }
    row[b.length] = prev;
  }
  return row[b.length]!;
}

/**
 * True when symbols are the same (normalized) or confusingly similar
 * (substring containment for len≥3, or edit distance ≤1 for len≥3).
 */
export function symbolsConfusinglySimilar(a: string, b: string): boolean {
  const na = normalizeSymbol(a);
  const nb = normalizeSymbol(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 3 && nb.length >= 3) {
    if (na.includes(nb) || nb.includes(na)) return true;
    if (levenshtein(na, nb) <= 1) return true;
  }
  return false;
}

export type SymbolConflict = {
  existing: TokenConfig;
  reason: "exact" | "similar";
};

/** Conflicts against verified config, excluding the candidate address itself. */
export function findSymbolConflicts(
  symbol: string,
  candidateAddress: Address,
  existing: TokenConfig[],
): SymbolConflict[] {
  const out: SymbolConflict[] = [];
  const cand = candidateAddress.toLowerCase();
  for (const t of existing) {
    if (t.address.toLowerCase() === cand) continue;
    if (!symbolsConfusinglySimilar(symbol, t.symbol)) continue;
    out.push({
      existing: t,
      reason: normalizeSymbol(symbol) === normalizeSymbol(t.symbol) ? "exact" : "similar",
    });
  }
  return out;
}
