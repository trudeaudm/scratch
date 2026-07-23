import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zeroAddress } from "viem";
import {
  ODDS_DENOM,
  annotateRows,
  blockingIssues,
  editorToPrizeRows,
  ensureTerminalNoWin,
  oddsDeltaToPercent,
  percentToOddsDelta,
  prizeRowsToEditor,
  reorderEditorRows,
  tableEvUsd,
  validatePrizeTable,
  type EditorRow,
  type PrizeRow,
} from "./prizeTable.ts";

const NO_WIN = zeroAddress;
const SCRATCH = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x2222222222222222222222222222222222222222" as const;

function row(
  asset: `0x${string}`,
  amountOrBps: bigint,
  isBpsOfPool: boolean,
  cumOdds: number,
): PrizeRow {
  return { asset, amountOrBps, isBpsOfPool, cumOdds };
}

describe("percent ↔ odds", () => {
  it("maps 100.000% to ODDS_DENOM", () => {
    assert.equal(percentToOddsDelta("100.000"), ODDS_DENOM);
    assert.equal(oddsDeltaToPercent(ODDS_DENOM), "100.000");
  });

  it("round-trips common deltas", () => {
    for (const p of ["10.000", "0.100", "0.001", "70.000", "19.999"]) {
      const d = percentToOddsDelta(p);
      assert.ok(d !== null, p);
      assert.equal(oddsDeltaToPercent(d!), p, p);
    }
  });

  it("rejects bad percent strings", () => {
    assert.equal(percentToOddsDelta(""), null);
    assert.equal(percentToOddsDelta("10.00000"), null);
    assert.equal(percentToOddsDelta("-1"), null);
    assert.equal(percentToOddsDelta("abc"), null);
  });
});

describe("validatePrizeTable (mirrors ScratchGame._validateTable)", () => {
  it("rejects empty", () => {
    const issues = validatePrizeTable([]);
    assert.ok(issues.some((i) => i.code === "empty" && i.blocking));
  });

  it("accepts valid terminal no-win table", () => {
    const table = [
      row(SCRATCH, 10n ** 18n, false, 100_000),
      row(NO_WIN, 0n, false, ODDS_DENOM),
    ];
    const issues = blockingIssues(validatePrizeTable(table));
    assert.equal(issues.length, 0);
  });

  it("rejects non-monotonic cumOdds", () => {
    const table = [
      row(SCRATCH, 1n, false, 500_000),
      row(SCRATCH, 1n, false, 400_000),
      row(NO_WIN, 0n, false, ODDS_DENOM),
    ];
    assert.ok(validatePrizeTable(table).some((i) => i.code === "not_monotonic" && i.blocking));
  });

  it("rejects equal consecutive cumOdds", () => {
    const table = [
      row(SCRATCH, 1n, false, 500_000),
      row(SCRATCH, 1n, false, 500_000),
      row(NO_WIN, 0n, false, ODDS_DENOM),
    ];
    assert.ok(validatePrizeTable(table).some((i) => i.code === "not_monotonic"));
  });

  it("rejects terminal with non-zero asset", () => {
    const table = [row(SCRATCH, 1n, false, ODDS_DENOM)];
    assert.ok(validatePrizeTable(table).some((i) => i.code === "bad_terminal" && i.blocking));
  });

  it("rejects terminal cumOdds != ODDS_DENOM", () => {
    const table = [
      row(SCRATCH, 1n, false, 100_000),
      row(NO_WIN, 0n, false, 999_999),
    ];
    assert.ok(validatePrizeTable(table).some((i) => i.code === "bad_terminal"));
  });

  it("blocks unbacked assets (no balance, no fallback)", () => {
    const table = [
      row(USDG, 10n ** 18n, false, 100_000),
      row(NO_WIN, 0n, false, ODDS_DENOM),
    ];
    const issues = validatePrizeTable(table, [
      { asset: USDG, vaultBalance: 0n, fallbackRate: 0n },
    ]);
    assert.ok(issues.some((i) => i.code === "asset_unbacked" && i.blocking));
  });

  it("warns (non-blocking) when balance is 0 but fallbackRate is set", () => {
    const table = [
      row(USDG, 10n ** 18n, false, 100_000),
      row(NO_WIN, 0n, false, ODDS_DENOM),
    ];
    const issues = validatePrizeTable(table, [
      { asset: USDG, vaultBalance: 0n, fallbackRate: 10n ** 18n },
    ]);
    const unbacked = issues.filter((i) => i.code === "asset_unbacked");
    assert.equal(unbacked.length, 1);
    assert.equal(unbacked[0].blocking, false);
  });

  it("allows asset with vault balance", () => {
    const table = [
      row(USDG, 10n ** 18n, false, 100_000),
      row(NO_WIN, 0n, false, ODDS_DENOM),
    ];
    const blocking = blockingIssues(
      validatePrizeTable(table, [{ asset: USDG, vaultBalance: 100n, fallbackRate: 0n }]),
    );
    assert.equal(blocking.length, 0);
  });
});

describe("editor ↔ prize rows", () => {
  it("builds cumOdds from human probabilities summing to 100%", () => {
    const editor: EditorRow[] = [
      {
        id: "1",
        asset: SCRATCH,
        amountInput: "1",
        isBpsOfPool: false,
        probabilityPercent: "10.000",
      },
      {
        id: "2",
        asset: SCRATCH,
        amountInput: "500",
        isBpsOfPool: true,
        probabilityPercent: "20.000",
      },
      {
        id: "3",
        asset: NO_WIN,
        amountInput: "0",
        isBpsOfPool: false,
        probabilityPercent: "70.000",
      },
    ];
    const { prizeRows, issues } = editorToPrizeRows(editor);
    assert.equal(issues.filter((i) => i.blocking).length, 0);
    assert.equal(prizeRows[0].cumOdds, 100_000);
    assert.equal(prizeRows[1].cumOdds, 300_000);
    assert.equal(prizeRows[2].cumOdds, ODDS_DENOM);
    assert.equal(prizeRows[1].isBpsOfPool, true);
    assert.equal(prizeRows[1].amountOrBps, 500n);
  });

  it("round-trips through prizeRowsToEditor", () => {
    const table = [
      row(SCRATCH, 10n ** 18n, false, 100_000),
      row(NO_WIN, 0n, false, ODDS_DENOM),
    ];
    const editor = prizeRowsToEditor(table);
    assert.equal(editor[0].probabilityPercent, "10.000");
    assert.equal(editor[1].probabilityPercent, "90.000");
    const { prizeRows } = editorToPrizeRows(editor);
    assert.deepEqual(
      prizeRows.map((r) => r.cumOdds),
      table.map((r) => r.cumOdds),
    );
  });

  it("rejects probability sum != 100% via validate", () => {
    const editor: EditorRow[] = [
      {
        id: "1",
        asset: SCRATCH,
        amountInput: "1",
        isBpsOfPool: false,
        probabilityPercent: "10.000",
      },
      {
        id: "2",
        asset: NO_WIN,
        amountInput: "0",
        isBpsOfPool: false,
        probabilityPercent: "80.000",
      },
    ];
    const { prizeRows } = editorToPrizeRows(editor);
    assert.ok(validatePrizeTable(prizeRows).some((i) => i.code === "bad_terminal" || i.code === "prob_sum"));
  });

  it("ensureTerminalNoWin collapses duplicate NO-WIN and pins last", () => {
    const rows: EditorRow[] = [
      {
        id: "n1",
        asset: NO_WIN,
        amountInput: "0",
        isBpsOfPool: false,
        probabilityPercent: "50.000",
      },
      {
        id: "a",
        asset: SCRATCH,
        amountInput: "1",
        isBpsOfPool: false,
        probabilityPercent: "10.000",
      },
      {
        id: "n2",
        asset: "0x0000000000000000000000000000000000000000",
        amountInput: "9",
        isBpsOfPool: true,
        probabilityPercent: "40.000",
      },
    ];
    const out = ensureTerminalNoWin(rows);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, "a");
    assert.equal(out[1].id, "n1");
    assert.equal(out[1].probabilityPercent, "50.000");
    assert.equal(out[1].amountInput, "0");
    assert.equal(out[1].isBpsOfPool, false);
  });

  it("reorderEditorRows moves prizes and keeps NO-WIN terminal", () => {
    const rows: EditorRow[] = [
      {
        id: "a",
        asset: SCRATCH,
        amountInput: "1",
        isBpsOfPool: false,
        probabilityPercent: "10.000",
      },
      {
        id: "b",
        asset: USDG,
        amountInput: "1",
        isBpsOfPool: false,
        probabilityPercent: "20.000",
      },
      {
        id: "n",
        asset: NO_WIN,
        amountInput: "0",
        isBpsOfPool: false,
        probabilityPercent: "70.000",
      },
    ];
    const moved = reorderEditorRows(rows, "b", "a");
    assert.deepEqual(
      moved.map((r) => r.id),
      ["b", "a", "n"],
    );
    const toEnd = reorderEditorRows(moved, "b", "n");
    assert.deepEqual(
      toEnd.map((r) => r.id),
      ["a", "b", "n"],
    );
  });
});

describe("annotate + EV", () => {
  it("computes bps payout from vault balance", () => {
    const table = [
      row(SCRATCH, 500n, true, 100_000), // 5% of pool
      row(NO_WIN, 0n, false, ODDS_DENOM),
    ];
    const bal = new Map([[SCRATCH.toLowerCase(), 1000n * 10n ** 18n]]);
    const ann = annotateRows(table, bal, {
      scratchUsd: 1,
      ethUsd: null,
      fetchedAt: null,
      error: null,
    });
    // Without config token match, payoutUsd may be null — payout amount still computed
    assert.equal(ann[0].payoutAmount, 50n * 10n ** 18n); // 500 bps of 1000e18
    assert.equal(ann[0].probability, 0.1);
    assert.ok(ann[0].oneInN !== null && Math.abs(ann[0].oneInN! - 10) < 1e-9);
  });

  it("flags payout > 10% of vault", () => {
    const table = [
      row(SCRATCH, 200n * 10n ** 18n, false, 100_000),
      row(NO_WIN, 0n, false, ODDS_DENOM),
    ];
    const bal = new Map([[SCRATCH.toLowerCase(), 1000n * 10n ** 18n]]);
    const ann = annotateRows(table, bal, {
      scratchUsd: null,
      ethUsd: null,
      fetchedAt: null,
      error: null,
    });
    assert.equal(ann[0].exceedsTenPercentVault, true);
  });

  it("EV is probability-weighted sum", () => {
    // Use annotate with mocked payoutUsd by testing tableEvUsd directly on synthetic annotated rows
    const ev = tableEvUsd([
      {
        row: row(SCRATCH, 1n, false, 100_000),
        index: 0,
        oddsDelta: 100_000,
        probability: 0.1,
        oneInN: 10,
        payoutAmount: 1n,
        payoutUsd: 100,
        exceedsTenPercentVault: false,
      },
      {
        row: row(NO_WIN, 0n, false, ODDS_DENOM),
        index: 1,
        oddsDelta: 900_000,
        probability: 0.9,
        oneInN: 10 / 9,
        payoutAmount: 0n,
        payoutUsd: 0,
        exceedsTenPercentVault: false,
      },
    ]);
    assert.equal(ev, 10);
  });
});
