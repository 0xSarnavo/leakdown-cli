import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { confidenceInterval, lift, overlap, strength } from "./stats.js";

const pct = ([lo, hi]: [number, number]) => [Math.round(lo * 100), Math.round(hi * 100)];

describe("confidenceInterval (Wilson, 95%)", () => {
  it("matches hand-computed bounds on 3 of 5", () => {
    assert.deepEqual(pct(confidenceInterval(3, 5)), [23, 88]);
  });

  it("stays inside [0, 1] at the edges instead of going negative like the normal approximation", () => {
    assert.deepEqual(pct(confidenceInterval(0, 5)), [0, 43]);
    assert.deepEqual(pct(confidenceInterval(5, 5)), [57, 100]);
  });

  it("narrows as n grows", () => {
    const [lo5, hi5] = confidenceInterval(3, 5);
    const [lo50, hi50] = confidenceInterval(30, 50);
    assert.ok(hi50 - lo50 < hi5 - lo5);
  });

  it("is the whole range when there is nothing to count", () => {
    assert.deepEqual(confidenceInterval(0, 0), [0, 1]);
  });
});

describe("strength", () => {
  it("renders count, rate and interval", () => {
    assert.equal(strength(3, 5), "3/5 sessions · 60% [23–88%]");
  });

  it("refuses to quantify under three sessions", () => {
    assert.equal(strength(2, 2), "2/2 sessions · too few to call");
    assert.equal(strength(1, 1), "1/1 sessions · too few to call");
  });
});

describe("lift", () => {
  it("is the rate difference, variant minus base", () => {
    assert.equal(lift({ hits: 1, n: 4 }, { hits: 3, n: 4 }), 0.5);
    assert.equal(lift({ hits: 3, n: 4 }, { hits: 1, n: 4 }), -0.5);
  });

  it("is zero when either side has no sessions", () => {
    assert.equal(lift({ hits: 0, n: 0 }, { hits: 3, n: 4 }), 0);
  });
});

describe("overlap", () => {
  it("says two small samples overlap even when their rates differ a lot", () => {
    assert.ok(overlap({ hits: 1, n: 4 }, { hits: 3, n: 4 }));
  });

  it("separates clearly different large samples", () => {
    assert.ok(!overlap({ hits: 5, n: 50 }, { hits: 40, n: 50 }));
  });
});
