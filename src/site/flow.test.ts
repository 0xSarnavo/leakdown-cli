import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// RUNS_ROOT resolves from cwd, so run each test inside a scratch dir
const origCwd = process.cwd();
let tmp: string;

describe("flow round-trip", () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "leakdown-flow-"));
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes FLOW.md and reads the same flow back", async () => {
    const { writeFlow, loadFlow } = await import("./flow.js");
    const flow = {
      intent: "signup through to the dashboard",
      checkpoints: ["found the signup CTA", "submitted the form", "saw the dashboard"],
    };
    writeFlow("https://example.com", flow);
    assert.deepEqual(loadFlow("https://example.com"), flow);
  });

  it("returns null for a site with no flow", async () => {
    const { loadFlow } = await import("./flow.js");
    assert.equal(loadFlow("https://never-tested.com"), null);
  });

  it("newlines in intent and checkpoints cannot break the file format", async () => {
    const { writeFlow, loadFlow } = await import("./flow.js");
    writeFlow("https://example.com", {
      intent: "line one\nline two",
      checkpoints: ["a\nb", "c"],
    });
    const back = loadFlow("https://example.com");
    assert.equal(back?.intent, "line one line two");
    assert.deepEqual(back?.checkpoints, ["a b", "c"]);
  });
});

describe("scoreFlow with an external judge", () => {
  const events = [
    { n: 1, url: "https://example.com", timestamp: "", decision: { thought: "looking for signup", emotion: "interested", confusion: 0, action: { type: "click", target: "e1" } } },
  ] as never;
  const flow = { intent: "signup", checkpoints: ["found the signup CTA", "saw the dashboard"] };
  const brain = { name: "x", decide: async () => ({}) as never };
  /** A judge that answers with whatever it was handed, or fails outright. */
  const stub = (score: { checkpoint: string; reached: boolean; note: string }[] | null) => ({
    verifyGoal: async () => null,
    judgeAssertions: async (r: never[]) => r,
    scoreFlow: async () => score,
  });

  it("takes the judge's answer when one is configured", async () => {
    const { scoreFlow } = await import("./flow.js");
    const score = await scoreFlow(flow, events, brain, stub([
      { checkpoint: "found the signup CTA", reached: true, note: "" },
      { checkpoint: "saw the dashboard", reached: false, note: "" },
    ]));
    assert.deepEqual(score?.map((c) => c.reached), [true, false]);
  });

  it("a judge that cannot answer leaves the session unscored, not half-scored", async () => {
    const { scoreFlow } = await import("./flow.js");
    assert.equal(await scoreFlow(flow, events, brain, stub(null)), null);
  });

  it("a judge that throws does not take the session down", async () => {
    const { scoreFlow } = await import("./flow.js");
    const throwing = { ...stub(null), scoreFlow: async () => { throw new Error("judge down"); } };
    assert.equal(await scoreFlow(flow, events, brain, throwing), null);
  });
});
