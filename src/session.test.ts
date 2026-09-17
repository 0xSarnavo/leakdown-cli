import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { checkAssertions, goalExitCode, mergeInbox, stuckPattern } from "./session.js";
import type { StepEvent } from "./types.js";

/**
 * Build a step trail from shorthand: "click:e1", "scroll:down", and for scrolls
 * an optional page position, "scroll:down@600".
 */
function trail(...actions: string[]): StepEvent[] {
  return actions.map((spec, i) => {
    const [head, at] = spec.split("@");
    const [type, arg = ""] = head.split(":");
    const action =
      type === "scroll"
        ? { type: "scroll", direction: arg || "down" }
        : { type, target: arg };
    return {
      n: i + 1,
      url: "https://example.com",
      timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      decision: { thought: "", emotion: "", confusion: 3, action },
      ...(at === undefined ? {} : { scrollY: Number(at) }),
    } as StepEvent;
  });
}

describe("mergeInbox", () => {
  const CODE = "mail #1 from auth@site.com — subject: your code\n  candidate codes: 483920";

  it("shows fresh mail as-is", () => {
    assert.equal(mergeInbox({ text: CODE, mail: CODE }), CODE);
  });

  it("passes an empty inbox through when nothing ever arrived", () => {
    assert.equal(mergeInbox({ text: "(no new mail after waiting 15s)" }), "(no new mail after waiting 15s)");
  });

  it("keeps mail that already landed visible on a later empty check", () => {
    // the provider reports only NEW messages — without this the code disappears
    // and a working magic-link flow reads as broken
    const merged = mergeInbox({ text: "(no new mail after waiting 15s)" }, CODE);
    assert.match(merged, /483920/);
    assert.match(merged, /still sitting in your inbox/);
  });

  it("drops the give-up nudge once something is in the inbox", () => {
    const exhausted = "(no new mail after waiting 15s) — you have now waited longer than your patience allows. You are done waiting; abandon or find another way.";
    assert.ok(!/abandon/.test(mergeInbox({ text: exhausted }, CODE)));
    assert.match(mergeInbox({ text: exhausted }), /abandon/);
  });
});

describe("stuckPattern", () => {
  it("does not fire before there is enough evidence", () => {
    assert.equal(stuckPattern(trail()), null);
    assert.equal(stuckPattern(trail("click:e1")), null);
    assert.equal(stuckPattern(trail("click:e1", "click:e1")), null);
  });

  it("catches the same action three times", () => {
    assert.match(String(stuckPattern(trail("click:e1", "click:e1", "click:e1"))), /same action/);
  });

  it("catches an A-B ping-pong, which the old check missed", () => {
    const t = trail("click:e1", "back", "click:e1", "back", "click:e1", "back");
    assert.match(String(stuckPattern(t)), /2-step loop/);
  });

  it("needs three rounds of a two-step loop, not two", () => {
    assert.equal(stuckPattern(trail("click:e1", "back", "click:e1", "back")), null);
  });

  it("catches a three-step cycle", () => {
    const t = trail("click:e1", "click:e2", "back", "click:e1", "click:e2", "back");
    assert.match(String(stuckPattern(t)), /3-step loop/);
  });

  it("leaves ordinary exploration alone", () => {
    assert.equal(
      stuckPattern(trail("click:e1", "click:e2", "scroll:down", "click:e3", "back", "click:e4")),
      null,
    );
  });

  it("leaves a scroll-and-read rhythm alone when it is still progressing", () => {
    // alternating but only two rounds, then a different action — not a loop
    assert.equal(
      stuckPattern(trail("scroll:down", "wait", "scroll:down", "wait", "click:e9")),
      null,
    );
  });

  it("treats the same action on different targets as different", () => {
    assert.equal(stuckPattern(trail("click:e1", "click:e2", "click:e3")), null);
  });

  it("only judges the most recent steps, so an early loop does not stick", () => {
    const t = trail(
      "click:e1", "click:e1", "click:e1", // looped early…
      "click:e2", "scroll:down", "click:e3", "back", // …then recovered
    );
    assert.equal(stuckPattern(t), null);
  });
});

describe("stuckPattern — scrolling down a long page is not a loop", () => {
  it("lets a persona work its way down, which a viewport-sized snapshot requires", () => {
    // the whole point of the viewport split: reaching the bottom of a 21-screen
    // page takes ~14 scrolls, and "same action 3x" would have killed the session
    assert.equal(
      stuckPattern(trail("scroll:down@0", "scroll:down@600", "scroll:down@1200", "scroll:down@1800")),
      null,
    );
  });

  it("still catches a persona wedged at the bottom, scrolling nowhere", () => {
    assert.ok(
      stuckPattern(trail("scroll:down@16000", "scroll:down@16000", "scroll:down@16000")),
      "a persona scrolling against the end of the page ran forever",
    );
  });

  it("still catches scrolling up and down on the spot", () => {
    assert.ok(
      stuckPattern(
        trail("scroll:down@0", "scroll:up@600", "scroll:down@0", "scroll:up@600", "scroll:down@0", "scroll:up@600"),
      ),
    );
  });

  it("treats unmeasured scrolls as it always did, so old sessions read the same", () => {
    assert.ok(stuckPattern(trail("scroll:down", "scroll:down", "scroll:down")));
  });
});

describe("checkAssertions", () => {
  const page = `- heading "Your bag"\n- text: Subtotal $120.00\n- text: "Discount SAVE20 applied"\n- text: Total: $120.00\n- button "Pay now"`;

  it("passes when every expected value is somewhere on the page", () => {
    const r = checkAssertions([{ label: "discount", expected: "SAVE20" }, { label: "total", expected: "$120.00" }], page);
    assert.ok(r.every((a) => a.ok));
  });

  it("quotes the line that mentions the label when the value is missing", () => {
    const [r] = checkAssertions([{ label: "total", expected: "$96.00" }], page);
    assert.equal(r.ok, false);
    assert.match(r.found, /Total: \$120\.00/);
  });

  it("says so when nothing on the page mentions the label", () => {
    const [r] = checkAssertions([{ label: "shipping", expected: "free" }], page);
    assert.equal(r.ok, false);
    assert.match(r.found, /nothing mentioning "shipping"/);
  });

  it("caps the quoted line at 160 characters so a wall of text cannot flood the report", () => {
    const long = `- text: total ${"x".repeat(500)}`;
    const [r] = checkAssertions([{ label: "total", expected: "$1" }], long);
    assert.ok(r.found.length <= 163, `found was ${r.found.length} chars`);
  });

  it("ignores whitespace differences, since snapshots wrap text", () => {
    const [r] = checkAssertions([{ label: "total", expected: "Total:   $120.00" }], page);
    assert.ok(r.ok);
  });
});

describe("goalExitCode", () => {
  it("is 0 only when every session completed", () => {
    assert.equal(goalExitCode(["completed", "completed"], 2), 0);
  });

  it("is 1 when the site failed anybody, even if others could not run", () => {
    assert.equal(goalExitCode(["completed", "abandoned"], 2), 1);
    assert.equal(goalExitCode(["guardrail", "couldnotrun"], 2), 1);
  });

  it("is 2 when nothing failed but something could not run — infra, not the app", () => {
    assert.equal(goalExitCode(["completed", "couldnotrun"], 2), 2);
    assert.equal(goalExitCode(["couldnotrun"], 1), 2);
  });

  it("is 2 when a session vanished without any verdict", () => {
    assert.equal(goalExitCode(["completed"], 2), 2);
  });
});
