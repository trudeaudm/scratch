import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAmount, fmtToken } from "./format";

describe("parseAmount / fmtToken decimals", () => {
  it("parses USDG-style 6dp without assuming 18", () => {
    assert.equal(parseAmount("250", 6), 250_000_000n);
    assert.equal(parseAmount("250.5", 6), 250_500_000n);
    assert.equal(parseAmount("250.123456", 6), 250_123_456n);
    assert.equal(parseAmount("250.1234567", 6), null); // too many frac digits
  });

  it("does not treat 250 human as 250e18 when decimals=6", () => {
    const six = parseAmount("250", 6)!;
    const eighteen = parseAmount("250", 18)!;
    assert.equal(six, 250n * 10n ** 6n);
    assert.equal(eighteen, 250n * 10n ** 18n);
    assert.notEqual(six, eighteen);
  });

  it("formats 6dp balances correctly", () => {
    assert.equal(fmtToken(1_067_084_004n, 6, 6), "1,067.084004");
  });
});
