import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { generateAggregate, generateDetail, loadSessions, renderVariants } from "./aggregate.js";

const scratch = mkdtempSync(join(tmpdir(), "leakdown-agg-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** Write a session directory the way stage 1 does. */
function session(opts: {
  personaId: string;
  exit: Record<string, unknown>;
  steps?: { url: string; confusion: number; thought: string }[];
  url?: string;
  flow?: unknown;
  variant?: string;
}): string {
  const dir = join(scratch, `s${n++}-${opts.personaId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ url: opts.url ?? "https://site.com", personaId: opts.personaId, brain: "claude", exit: opts.exit, flow: opts.flow, variant: opts.variant }),
  );
  const steps = opts.steps ?? [{ url: "https://site.com/", confusion: 3, thought: "ok" }];
  writeFileSync(
    join(dir, "session.jsonl"),
    steps
      .map((s, i) =>
        JSON.stringify({
          n: i + 1,
          url: s.url,
          timestamp: "",
          decision: { thought: s.thought, emotion: "x", confusion: s.confusion, action: { type: "click", target: "e1" } },
        }),
      )
      .join("\n"),
  );
  return dir;
}

describe("loadSessions", () => {
  it("skips directories missing either artifact rather than throwing", () => {
    const partial = join(scratch, "partial");
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, "meta.json"), "{}");
    assert.deepEqual(loadSessions([partial]), []);
  });

  it("skips a corrupt meta.json without taking the run down", () => {
    const bad = join(scratch, "corrupt");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "meta.json"), "{not json");
    writeFileSync(join(bad, "session.jsonl"), "");
    const good = session({ personaId: "cold", exit: { kind: "completed", summary: "done" } });
    const loaded = loadSessions([bad, good]);
    assert.equal(loaded.length, 1, "one corrupt session discarded a valid one");
  });

  it("skips shape-valid meta without an exit instead of crashing later", () => {
    const hostile = join(scratch, "no-exit");
    mkdirSync(hostile, { recursive: true });
    writeFileSync(join(hostile, "meta.json"), JSON.stringify({ url: "https://x.com", personaId: "cold", brain: "claude" }));
    writeFileSync(join(hostile, "session.jsonl"), JSON.stringify({ n: 1, url: "u", timestamp: "", decision: { thought: "t", emotion: "e", confusion: 1, action: { type: "back" } } }));
    assert.doesNotThrow(() => loadSessions([hostile]));
    assert.equal(loadSessions([hostile]).length, 0);
  });

  it("drops malformed event lines but keeps the session's valid steps", () => {
    const dir = join(scratch, "mixed-events");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ url: "https://x.com", personaId: "cold", brain: "claude", exit: { kind: "completed", summary: "s" } }),
    );
    writeFileSync(
      join(dir, "session.jsonl"),
      [
        JSON.stringify({ n: 1, url: "u", timestamp: "", decision: { thought: "t", emotion: "e", confusion: 2, action: { type: "back" } } }),
        JSON.stringify({ n: 2, url: "u", timestamp: "" }), // no decision — used to crash stage 2
        "not json at all",
      ].join("\n"),
    );
    const loaded = loadSessions([dir]);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].events.length, 1);
  });
});

describe("generateAggregate (the short report)", () => {
  it("leads with the one number and the walls, and points at DETAIL.md", () => {
    const left = (url: string) =>
      session({
        personaId: "cold",
        exit: { kind: "abandoned", reason: "pricing was hidden", question: "how much?" },
        steps: [{ url: "https://site.com/", confusion: 2, thought: "looking" }, { url, confusion: 7, thought: "no price anywhere" }],
      });
    const out = generateAggregate([
      session({ personaId: "hot", exit: { kind: "completed", summary: "done" } }),
      left("https://site.com/pricing"),
      left("https://site.com/pricing"),
      session({ personaId: "warm", exit: { kind: "guardrail", detail: "stuck" } }),
    ]);
    assert.match(out, /\*\*1 of 4 completed their goal\.\*\* 2 walked out with a reason\. 1 were stopped by the harness/);
    assert.match(out, /### 1\. `site\.com\/pricing` — 2 of 4 walked out here/);
    assert.match(out, /In their words:\*\* "pricing was hidden"/);
    assert.match(out, /Check it yourself:\*\* open `site\.com\/pricing`.*"no price anywhere" → clicked e1/);
    assert.match(out, /DETAIL\.md/);
    assert.match(out, /risk signals, not measured traffic/);
    assert.match(out, /Run more than once:\*\* Momus 2\/2 abandoned/);
  });
});

describe("generateAggregate could-not-run", () => {
  it("counts could-not-run apart from walked out and harness stops, and blames our side", () => {
    const out = generateAggregate([
      session({ personaId: "hot", exit: { kind: "completed", summary: "done" } }),
      session({ personaId: "cold", exit: { kind: "abandoned", reason: "r", question: "q" } }),
      session({ personaId: "warm", exit: { kind: "guardrail", detail: "stuck loop" } }),
      session({ personaId: "edge", exit: { kind: "couldnotrun", detail: "Brain failed at step 1" } }),
    ]);
    assert.match(out, /\*\*1 of 4 completed their goal\.\*\* 1 walked out with a reason\. 1 were stopped by the harness/);
    assert.match(out, /1 could not run at all .* our side, not evidence about the site/);
  });
});

describe("renderVariants (A/B)", () => {
  const done = { kind: "completed", summary: "d" };
  const left = { kind: "abandoned", reason: "no price", question: "cost?" };
  const at = (variant: string, exit: Record<string, unknown>, url = "https://site.com/pricing") =>
    session({ personaId: "cold", exit, variant, steps: [{ url, confusion: 5, thought: "t" }] });

  it("renders nothing for a plain run or a single variant", () => {
    assert.deepEqual(renderVariants(loadSessions([session({ personaId: "cold", exit: done })])), []);
    assert.deepEqual(renderVariants(loadSessions([at("a", done), at("a", left)])), []);
    assert.ok(!generateAggregate([at("a", done)]).includes("Variants compared"));
  });

  it("ranks the leakier variant first, with intervals, and says which pages differ", () => {
    const dirs = [
      at("control", done), at("control", done), at("control", left),
      at("new-pricing", left), at("new-pricing", left), at("new-pricing", left, "https://site.com/signup"),
    ];
    const out = renderVariants(loadSessions(dirs)).join("\n");
    assert.match(out, /## Variants compared \(2\)/);
    assert.match(out, /\| `new-pricing` \| 3 \| 0 \| 3 \| 3\/3 sessions · 100% \[44–100%\] \|/);
    assert.match(out, /\| `control` \| 3 \| 2 \| 1 \| 1\/3 sessions · 33% \[6–79%\] \|/);
    assert.ok(out.indexOf("`new-pricing` |") < out.indexOf("`control` |"), "leakiest variant is not first");
    assert.match(out, /site\.com\/pricing` — new-pricing 2\/3, control 1\/3/);
    assert.match(out, /site\.com\/signup` — new-pricing 1\/3, control 0\/3/);
    assert.match(generateAggregate(dirs), /## Variants compared/);
    assert.match(generateDetail(dirs), /## Variants compared/);
  });

  it("says no meaningful difference when the intervals overlap, and too few when under three each", () => {
    const small = renderVariants(loadSessions([at("a", done), at("a", left), at("b", left), at("b", left)])).join("\n");
    assert.match(small, /too few sessions to call/);
    const close = renderVariants(loadSessions([
      at("a", done), at("a", done), at("a", left),
      at("b", done), at("b", left), at("b", left),
    ])).join("\n");
    assert.match(close, /no meaningful difference between `b` and `a`/);
  });

  it("calls a clear winner when the intervals separate", () => {
    const dirs = [
      ...Array.from({ length: 12 }, () => at("a", done)),
      ...Array.from({ length: 12 }, () => at("b", left)),
    ];
    const out = renderVariants(loadSessions(dirs)).join("\n");
    assert.match(out, /\*\*Verdict:\*\* `b` leaks more — 100 points more/);
  });

  it("leaves could-not-run sessions out of every rate", () => {
    const dirs = [
      at("a", done), at("a", done), at("a", left), at("a", { kind: "couldnotrun", detail: "dns" }),
      at("b", left), at("b", left), at("b", left),
    ];
    const out = renderVariants(loadSessions(dirs)).join("\n");
    assert.match(out, /\| `a` \| 3 \(\+1 could not run\) \| 2 \| 1 \|/);
  });
});

describe("generateDetail", () => {
  it("says so plainly when there is nothing to report", () => {
    assert.match(generateDetail([]), /No valid sessions/);
  });

  it("counts each verdict kind", () => {
    const dirs = [
      session({ personaId: "cold", exit: { kind: "completed", summary: "signed up" } }),
      session({ personaId: "cold", exit: { kind: "abandoned", reason: "too slow", question: "why?" } }),
      session({ personaId: "hot", exit: { kind: "abandoned", reason: "no pricing", question: "cost?" } }),
      session({ personaId: "hot", exit: { kind: "guardrail", detail: "stuck" } }),
    ];
    const out = generateDetail(dirs);
    assert.match(out, /Completed \| 1/);
    assert.match(out, /Abandoned \| 2/);
    assert.match(out, /Guardrail \| 1/);
    assert.ok(!out.includes("Could not run"), "row hidden when nobody was blocked");
    assert.match(out, /\*\*Sessions:\*\* 4/);
    const blocked = generateDetail([...dirs, session({ personaId: "edge", exit: { kind: "couldnotrun", detail: "dns" } })]);
    assert.match(blocked, /Could not run \(our side, not the site\) \| 1/);
    assert.match(blocked, /⏸ could not run/);
    assert.match(out, /^# Session detail — /m);
  });

  it("quotes why people left, verbatim", () => {
    const out = generateDetail([
      session({ personaId: "cold", exit: { kind: "abandoned", reason: "pricing was hidden", question: "cost?" } }),
    ]);
    assert.match(out, /What could make people leave/);
    assert.match(out, /pricing was hidden/);
  });

  it("groups drop-offs by page so the common wall is obvious", () => {
    const at = (url: string) => session({
      personaId: "cold",
      exit: { kind: "abandoned", reason: "r", question: "q" },
      steps: [{ url, confusion: 8, thought: "t" }],
    });
    const out = generateDetail([at("https://site.com/pricing"), at("https://site.com/pricing"), at("https://site.com/signup")]);
    assert.match(out, /most likely to stall/);
    assert.match(out, /\/pricing` — 2 of 3/);
  });

  it("does not report drop points for sessions that completed", () => {
    const out = generateDetail([
      session({ personaId: "hot", exit: { kind: "completed", summary: "done" } }),
    ]);
    assert.ok(!out.includes("most likely to stall"));
    assert.ok(!out.includes("What could make people leave"));
  });

  it("renders the flow funnel across scored sessions and skips it when nobody was scored", () => {
    const cp = (reached1: boolean, reached2: boolean) => [
      { checkpoint: "found signup", reached: reached1, note: "" },
      { checkpoint: "saw dashboard", reached: reached2, note: "" },
    ];
    const out = generateDetail([
      session({ personaId: "cold", exit: { kind: "completed", summary: "d" }, flow: cp(true, true) }),
      session({ personaId: "warm", exit: { kind: "abandoned", reason: "r", question: "q" }, flow: cp(true, false) }),
    ]);
    assert.match(out, /Flow Funnel \(2 scored/);
    assert.match(out, /found signup \| 2\/2/);
    assert.match(out, /saw dashboard \| 1\/2/);
    assert.match(out, /never got here/);

    const none = generateDetail([
      session({ personaId: "cold", exit: { kind: "completed", summary: "d" } }),
    ]);
    assert.ok(!none.includes("Flow Funnel"));
  });

  it("a malformed flow field degrades to unscored instead of discarding the session", () => {
    const out = generateDetail([
      session({ personaId: "cold", exit: { kind: "completed", summary: "d" }, flow: "garbage" }),
    ]);
    assert.match(out, /\*\*Sessions:\*\* 1/);
    assert.ok(!out.includes("Flow Funnel"));
  });

  it("escapes pipes so a quote cannot break the markdown table", () => {
    const out = generateDetail([
      session({ personaId: "cold", exit: { kind: "abandoned", reason: "a | b | c", question: "q" } }),
    ]);
    assert.ok(!/\| a \| b \| c \|/.test(out), "an unescaped pipe split the row into extra columns");
  });
});
