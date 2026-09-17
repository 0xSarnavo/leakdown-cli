import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Persona, StepEvent } from "../types.js";
import { generateFilmstrip, generateReport } from "./report.js";

const persona: Persona = {
  name: "Test Tess",
  temperature: "warm",
  goal: "Reach the signup page",
  tech_comfort: "medium",
  patience_steps: 12,
  max_confusion_before_bail: 8,
  otp_patience_seconds: 300,
  traits: [],
};

function event(n: number, thought: string, screenshot?: string): StepEvent {
  return {
    n,
    url: "https://example.com/signup",
    timestamp: new Date(Date.UTC(2026, 8, 15, 0, 0, n)).toISOString(),
    screenshot,
    decision: { thought, emotion: "curious", confusion: 3, action: { type: "click", target: "e1" } },
  };
}

describe("generateFilmstrip", () => {
  it("renders every step with a relative shot path and its thought", () => {
    const html = generateFilmstrip({
      persona,
      url: "https://example.com",
      events: [event(1, "Looks promising", "/tmp/run/shots/step-001.png"), event(2, "Where is signup?", "/tmp/run/shots/step-002.png")],
    });
    assert.match(html, /shots\/step-001\.png/);
    assert.match(html, /shots\/step-002\.png/);
    assert.ok(!html.includes("/tmp/run"), "absolute session paths must not leak into the page");
    assert.match(html, /Looks promising/);
  });

  it("escapes page-influenced text so a hostile page cannot inject markup", () => {
    const html = generateFilmstrip({
      persona,
      url: "https://example.com",
      events: [event(1, 'Nice </figure><script>alert("x")</script>', "/tmp/run/shots/step-001.png")],
    });
    assert.ok(!html.includes("<script>"), "thought text must be inert");
    assert.match(html, /&lt;\/figure&gt;/);
  });

  it("renders a text card when a step has no screenshot", () => {
    const html = generateFilmstrip({ persona, url: "https://example.com", events: [event(1, "Saw it anyway")] });
    assert.match(html, /no screenshot for this step/);
    assert.match(html, /Saw it anyway/);
  });
});

describe("generateReport media", () => {
  const base = {
    persona,
    url: "https://example.com",
    brain: "claude",
    events: [event(1, "Hi", "/tmp/run/shots/step-001.png")],
    exit: { kind: "abandoned", reason: "Too many steps", question: "Is there a trial?" } as const,
  };

  it("links the mp4 when present, with no webm fallback line", () => {
    const md = generateReport({ ...base, media: { filmstrip: "filmstrip.html", videoMp4: "video.mp4", videoWebm: "video.webm" } });
    assert.match(md, /## Evidence/);
    assert.match(md, /video\.mp4 \(plays everywhere\)/);
    assert.match(md, /filmstrip\.html/);
    assert.ok(!md.includes("video.webm"), "mp4 present means the webm needs no mention");
  });

  it("falls back to the webm line with its player warning when no mp4 exists", () => {
    const md = generateReport({ ...base, media: { videoMp4: null, videoWebm: "video.webm" } });
    assert.match(md, /video\.webm \(VP8/);
  });

  it("omits the Evidence section entirely when nothing was recorded", () => {
    const md = generateReport(base);
    assert.ok(!md.includes("## Evidence"));
  });
});

describe("generateReport verdict semantics", () => {
  const base = { persona, url: "https://example.com", brain: "claude", events: [event(1, "Hi")] };

  it("renders a neutral Could not run section that blames our side, not the site", () => {
    const md = generateReport({ ...base, exit: { kind: "couldnotrun", detail: "Session could not run: net::ERR_NAME_NOT_RESOLVED" } });
    assert.match(md, /\*\*Verdict:\*\* COULD NOT RUN - not evidence about the site/);
    assert.match(md, /## Could not run/);
    assert.match(md, /ERR_NAME_NOT_RESOLVED/);
    assert.match(md, /not evidence that the site is broken/);
    assert.ok(!md.includes("Terminated by guardrail"));
  });

  it("lists every assertion with expected vs found", () => {
    const md = generateReport({
      ...base,
      exit: { kind: "abandoned", reason: "wrong total", question: "why?" },
      assertions: [
        { label: "discount", expected: "SAVE20", ok: true, found: "SAVE20" },
        { label: "total", expected: "$96.00", ok: false, found: '"Total: $120.00"' },
      ],
    });
    assert.match(md, /## Assertions \(1\/2 held\)/);
    assert.match(md, /✅ \*\*discount\*\* — expected `SAVE20`/);
    assert.match(md, /❌ \*\*total\*\* — expected `\$96\.00`, found "Total: \$120\.00"/);
  });

  it("omits the Assertions section when none were asked for", () => {
    const md = generateReport({ ...base, exit: { kind: "completed", summary: "done" } });
    assert.ok(!md.includes("## Assertions"));
  });
});
