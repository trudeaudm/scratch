import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "viem";
import type { TokenConfig } from "../config/addresses";
import {
  findSymbolConflicts,
  normalizeSymbol,
  symbolsConfusinglySimilar,
} from "./symbolConflict";

describe("normalizeSymbol", () => {
  it("strips case and whitespace", () => {
    assert.equal(normalizeSymbol("  Us Dg "), "usdg");
    assert.equal(normalizeSymbol("USDG"), "usdg");
  });
});

describe("symbolsConfusinglySimilar", () => {
  it("flags exact duplicates ignoring case/space", () => {
    assert.equal(symbolsConfusinglySimilar("USDG", "usdg"), true);
    assert.equal(symbolsConfusinglySimilar("US DG", "USDG"), true);
  });

  it("flags near-misses", () => {
    assert.equal(symbolsConfusinglySimilar("USDG", "USD G"), true);
    assert.equal(symbolsConfusinglySimilar("SCRATCH", "SCRATC"), true);
  });

  it("allows unrelated symbols", () => {
    assert.equal(symbolsConfusinglySimilar("USDG", "WETH"), false);
    assert.equal(symbolsConfusinglySimilar("SPCX", "SCRATCH"), false);
  });
});

describe("findSymbolConflicts", () => {
  const existing: TokenConfig[] = [
    {
      symbol: "USDG",
      address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
      decimals: 6,
      price: "usdg",
    },
  ];

  it("warns on a second USDG at another address", () => {
    const conflicts = findSymbolConflicts(
      "usdg",
      "0x0000000000000000000000000000000000000001" as Address,
      existing,
    );
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.reason, "exact");
    assert.equal(conflicts[0]?.existing.symbol, "USDG");
  });

  it("ignores the same address being re-checked", () => {
    const conflicts = findSymbolConflicts(
      "USDG",
      "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
      existing,
    );
    assert.equal(conflicts.length, 0);
  });
});
