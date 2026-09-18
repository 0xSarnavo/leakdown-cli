import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeModelMap, parseModelMap } from "./picker.js";

/**
 * The parser is the whole validation surface for `--model-for`. It runs in
 * `parseCommon`, before a browser or a mailbox exists, so a typo here is the
 * difference between a message and a run that dies four minutes in.
 */
describe("parseModelMap", () => {
  it("returns undefined when nothing was given, so absent stays distinct from empty", () => {
    assert.equal(parseModelMap([]), undefined);
    assert.equal(parseModelMap([""]), undefined);
    assert.equal(parseModelMap(["", "  "]), undefined);
  });

  it("reads one pair per entry and comma-separated pairs alike", () => {
    assert.deepEqual(parseModelMap(["persona=sonnet"]), { persona: "sonnet" });
    assert.deepEqual(parseModelMap(["persona=sonnet,expert=haiku"]), {
      persona: "sonnet",
      expert: "haiku",
    });
  });

  it("lets a later entry override an earlier one — flags beat LEAKDOWN_MODELS", () => {
    assert.deepEqual(parseModelMap(["persona=haiku", "persona=sonnet"]), { persona: "sonnet" });
  });

  it("takes a vendor-prefixed model id", () => {
    assert.deepEqual(parseModelMap(["persona=opencode/muse-spark-1.3-contributor-free"]), {
      persona: "opencode/muse-spark-1.3-contributor-free",
    });
  });

  it("names the roles when one is misspelled, rather than ignoring it", () => {
    assert.throws(() => parseModelMap(["personas=sonnet"]), /Unknown role "personas"/);
    assert.throws(() => parseModelMap(["personas=sonnet"]), /persona, expert, scores/);
  });

  it("rejects a pair with no =, and one with an empty role", () => {
    assert.throws(() => parseModelMap(["sonnet"]), /<role>=<model>/);
    assert.throws(() => parseModelMap(["=sonnet"]), /<role>=<model>/);
  });

  /* The value is handed to a spawned CLI as an argv element. */
  it("rejects a model carrying whitespace, a quote or a newline", () => {
    assert.throws(() => parseModelMap(["persona=son net"]), /Invalid model/);
    assert.throws(() => parseModelMap(['persona=son"net']), /Invalid model/);
    assert.throws(() => parseModelMap(["persona=son\nnet"]), /Invalid model/);
    assert.throws(() => parseModelMap(["persona="]), /Invalid model/);
  });
});

describe("describeModelMap", () => {
  it("is empty for no map, so the banner drops the segment entirely", () => {
    assert.equal(describeModelMap(undefined), "");
  });

  it("prints in role order, not insertion order, so two runs read the same", () => {
    assert.equal(
      describeModelMap({ expert: "haiku", persona: "sonnet" }),
      "persona=sonnet expert=haiku",
    );
  });
});

describe("parseModelMap, one named expert", () => {
  it("takes expert:<id> for an expert in the registry", () => {
    assert.deepEqual(parseModelMap(["expert:ux=sonnet"]), { "expert:ux": "sonnet" });
  });

  it("catches a misspelled expert id here, not by silently never matching", () => {
    assert.throws(() => parseModelMap(["expert:ux-writer=sonnet"]), /Unknown expert "ux-writer"/);
  });

  it("names expert:<id> as an option when the role itself is wrong", () => {
    assert.throws(() => parseModelMap(["experts=haiku"]), /or expert:<id>/);
  });

  it("describes a qualified key after the plain roles", () => {
    assert.equal(
      describeModelMap({ "expert:ux": "sonnet", expert: "haiku", persona: "sonnet" }),
      "persona=sonnet expert=haiku expert:ux=sonnet",
    );
  });
});
