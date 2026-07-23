import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chunkAddresses,
  filterEligibleHolders,
  takeWithinAllowance,
} from "../src/filter.js";
import { buildExclusionSet } from "../src/exclusions.js";

describe("filterEligibleHolders", () => {
  it("keeps EOAs above threshold, drops exclusions and contracts", async () => {
    const exclusions = buildExclusionSet([
      "0x1111111111111111111111111111111111111111",
    ]);
    const contracts = new Set([
      "0x2222222222222222222222222222222222222222",
    ]);
    const holders = [
      { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", balance: 2_000_000n * 10n ** 18n },
      { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", balance: 500_000n * 10n ** 18n },
      { address: "0x1111111111111111111111111111111111111111", balance: 5_000_000n * 10n ** 18n },
      { address: "0x2222222222222222222222222222222222222222", balance: 9_000_000n * 10n ** 18n },
      { address: "0xcccccccccccccccccccccccccccccccccccccccc", balance: 3_000_000n * 10n ** 18n },
    ];
    const { eligible, excludedListed, excludedContracts, belowThreshold } =
      await filterEligibleHolders(holders, {
        threshold: 1_000_000n * 10n ** 18n,
        exclusions,
        isContract: (a) => contracts.has(a.toLowerCase()),
      });

    assert.equal(belowThreshold, 1);
    assert.equal(excludedListed, 1);
    assert.equal(excludedContracts, 1);
    assert.deepEqual(
      eligible.map((e) => e.address),
      [
        "0xcccccccccccccccccccccccccccccccccccccccc",
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
    );
  });
});

describe("takeWithinAllowance", () => {
  it("caps by remaining / ticketsEach", () => {
    const eligible = [
      { address: "0x1", balance: 3n },
      { address: "0x2", balance: 2n },
      { address: "0x3", balance: 1n },
    ];
    const { recipients, skippedOverCap } = takeWithinAllowance(
      eligible,
      2n * 10n ** 18n,
      1n * 10n ** 18n,
    );
    assert.equal(recipients.length, 2);
    assert.equal(skippedOverCap, 1);
    assert.equal(recipients[0].address, "0x1");
  });
});

describe("chunkAddresses", () => {
  it("batches at most 100", () => {
    const addrs = Array.from({ length: 250 }, (_, i) => `0x${i}`);
    const chunks = chunkAddresses(addrs, 100);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, 100);
    assert.equal(chunks[2].length, 50);
  });
});
