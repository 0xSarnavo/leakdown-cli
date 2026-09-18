import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoresExpert } from "./scores.js";
import type { Brain, ExitReason, Persona, StepEvent } from "../types.js";
import type { Judge } from "../brain/judge.js";

const MODEL_CARD = JSON.stringify({
  message_clarity: { score: 6, note: "clear enough" },
  audience_fit: { score: 6, note: "close" },
  action_path: { score: 6, note: "findable" },
  trust: { score: 6, note: "thin" },
  content_depth: { score: 6, note: "adequate" },
});

const brain = (reply = MODEL_CARD) =>
  ({ name: "stub", decide: async () => ({}) as never, ask: async () => reply }) as unknown as Brain;

const ctx = {
  persona: { name: "Ada", goal: "sign up", temperature: "cold", tech_comfort: "high" } as unknown as Persona,
  url: "https://example.com",
  events: [
    { n: 1, url: "https://example.com", timestamp: "", decision: { confusion: 3, emotion: "ok", thought: "looking", action: { type: "scroll" } } },
  ] as unknown as StepEvent[],
  exit: { kind: "abandoned", reason: "gave up", question: "what is it" } as ExitReason,
};

/** A judge that answers with the numbers it was built with, or cannot answer. */
const judge = (scores: Record<string, number> | null): Judge =>
  ({
    verifyGoal: async () => null,
    scoreFlow: async () => null,
    judgeAssertions: async (r: never[]) => r,
    scoreDimensions: async () => scores,
  }) as unknown as Judge;

describe("the conversion scorecard", () => {
  it("uses the model's own numbers when no judge is configured", async () => {
    const out = await scoresExpert.run(ctx, brain());
    assert.match(out ?? "", /\*\*Overall: 6\.0\/10\*\*/);
    assert.doesNotMatch(out ?? "", /scored by the judge/);
  });

  it("takes the judge's numbers and keeps the model's notes", async () => {
    const out = await scoresExpert.run(
      ctx,
      brain(),
      judge({ message_clarity: 0.9, audience_fit: 0.9, action_path: 0.9, trust: 0.9, content_depth: 0.9 }),
    );
    assert.match(out ?? "", /\*\*Overall: 9\.0\/10\*\*/);
    assert.match(out ?? "", /clear enough/); // the note is still the model's
    assert.match(out ?? "", /scored by the judge/); // and the card says so
  });

  /* A card with two judged numbers and three written ones is on two scales at
     once and reads as one, so a partial answer is no answer. */
  it("keeps the model's whole card when the judge answers only part of it", async () => {
    const out = await scoresExpert.run(ctx, brain(), judge({ message_clarity: 0.9 }));
    assert.match(out ?? "", /\*\*Overall: 6\.0\/10\*\*/);
    assert.doesNotMatch(out ?? "", /scored by the judge/);
  });

  it("falls back to the model when the judge cannot answer at all", async () => {
    const out = await scoresExpert.run(ctx, brain(), judge(null));
    assert.match(out ?? "", /\*\*Overall: 6\.0\/10\*\*/);
  });

  it("does not take the panel down when the judge throws", async () => {
    const throwing = { ...judge(null), scoreDimensions: async () => { throw new Error("judge down"); } } as Judge;
    const out = await scoresExpert.run(ctx, brain(), throwing);
    assert.match(out ?? "", /\*\*Overall: 6\.0\/10\*\*/);
  });
});
