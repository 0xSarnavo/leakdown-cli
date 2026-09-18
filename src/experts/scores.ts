import type { Expert, ExpertContext } from "./types.js";
import { exitSummary, trailSummary, siteContext } from "./types.js";
import { parseJsonObject } from "./copywriter.js";
import type { Judge } from "../brain/judge.js";

interface Scores {
  message_clarity: { score: number; note: string };
  audience_fit: { score: number; note: string };
  action_path: { score: number; note: string };
  trust: { score: number; note: string };
  content_depth: { score: number; note: string };
}

const DIMENSIONS = [
  "message_clarity",
  "audience_fit",
  "action_path",
  "trust",
  "content_depth",
] as const;

/**
 * What each dimension asks, in one line.
 *
 * Written once and used twice: inside the prompt as the definitions block, and
 * as the questions a judge is handed. Two wordings would make a judged run and
 * an unjudged one incomparable, which is the opposite of the point.
 */
const DEFINITIONS: Record<(typeof DIMENSIONS)[number], string> = {
  message_clarity: "could they tell what the product is and who it's for?",
  audience_fit: "does the page speak to THIS persona's needs?",
  action_path: "how clear and friction-free was the path to the main action?",
  trust: "proof, pricing transparency, social evidence, absence of dark patterns",
  content_depth:
    "enough substance to evaluate claims without being a wall of text",
};

/**
 * Ask a judge for the five numbers.
 *
 * A prose model re-reads the same journey and scores it 6 one day and 8 the
 * next, which is what makes two `--variant` runs unrankable: the difference
 * between the arms is smaller than the scorer's own drift. A judge answers on a
 * calibrated scale, so the numbers can be subtracted. Null anywhere and the
 * caller keeps the model's own scores.
 */
async function judgedScores(
  judge: Judge,
  trail: string,
): Promise<Record<string, number> | null> {
  if (!judge.scoreDimensions) return null;
  const dimensions = DIMENSIONS.map((id) => ({ id, question: DEFINITIONS[id] }));
  const p = await judge.scoreDimensions(dimensions, trail).catch(() => null);
  if (!p) return null;
  // all five or none: a card with two judged numbers and three written ones is
  // on two scales at once and reads as one
  if (DIMENSIONS.some((d) => typeof p[d] !== "number")) return null;
  return p;
}

export const scoresExpert: Expert = {
  id: "scores",
  title: "Conversion Scorecard",
  async run(ctx: ExpertContext, brain, judge) {
    if (!brain.ask) return null;
    const trail = trailSummary(ctx.events);
    // asked before the model, not after: a note written to justify a 6 and then
    // printed beside the judge's 1 reads as a contradiction on the page
    const judged = judge ? await judgedScores(judge, trail) : null;

    const prompt = `You are a conversion analyst. A simulated client just went through a website. Score the experience on 5 dimensions from THEIR perspective.

${siteContext(ctx)}
Persona: ${ctx.persona.name} (${ctx.persona.temperature}, tech comfort: ${ctx.persona.tech_comfort})
Goal: ${ctx.persona.goal}
Outcome: ${exitSummary(ctx.exit)}

Journey trail:
${trail}

${
      judged
        ? `These scores are already settled. Write the one-sentence justification for
each, explaining what in the journey puts it THERE — a low score needs what went
wrong, a high one what went right. Do not dispute a score or propose another.

${DIMENSIONS.map((d) => `- ${d}: ${(judged[d] * 10).toFixed(0)}/10`).join("\n")}

Reply ONLY with JSON:
{
${DIMENSIONS.map((d) => `  "${d}": { "score": ${(judged[d] * 10).toFixed(0)}, "note": "one sentence" }`).join(",\n")}
}`
        : `Reply ONLY with JSON:
{
  "message_clarity": { "score": 0-10, "note": "one sentence justification" },
  "audience_fit":    { "score": 0-10, "note": "..." },
  "action_path":     { "score": 0-10, "note": "..." },
  "trust":           { "score": 0-10, "note": "..." },
  "content_depth":   { "score": 0-10, "note": "..." }
}`
    }

Definitions:
${DIMENSIONS.map((d) => `- ${d}: ${DEFINITIONS[d]}`).join("\n")}`;

    try {
      const text = await brain.ask(prompt);
      const parsed = extractScores(text);
      if (!parsed) return null;
      if (!judged) return renderScorecard(parsed);
      // the note was written against the judge's number, but the model may still
      // have echoed its own — the judge's is the one on the card either way
      const merged: Scores = { ...parsed };
      for (const d of DIMENSIONS) merged[d] = { score: judged[d] * 10, note: parsed[d].note };
      return renderScorecard(merged, "scored by the judge; notes by the model");
    } catch (e) {
      console.error(
        `  [${this.id}] expert failed: ${(e as Error).message.slice(0, 160)}`,
      );
      return null;
    }
  },
};

function extractScores(text: string): Scores | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  const valid = DIMENSIONS.every(
    (d) =>
      parsed[d] &&
      typeof parsed[d].score === "number" &&
      typeof parsed[d].note === "string",
  );
  return valid ? parsed : null;
}

export function renderScorecard(scores: Scores, provenance?: string): string {
  const lines = [
    `| Dimension | Score | Notes |`,
    `|-----------|-------|-------|`,
  ];
  let total = 0;
  for (const d of DIMENSIONS) {
    // models occasionally answer outside the range they were given; an
    // unclamped bar calls repeat() with a negative count, throws RangeError,
    // and the caller's catch silently discards the entire scorecard
    const score = Math.max(0, Math.min(10, Math.round(scores[d].score)));
    total += score;
    const bar = "█".repeat(score) + "░".repeat(10 - score);
    lines.push(`| ${d.replace(/_/g, " ")} | \`${bar}\` ${score}/10 | ${scores[d].note} |`);
  }
  lines.push("");
  lines.push(`**Overall: ${(total / DIMENSIONS.length).toFixed(1)}/10**`);
  // two runs are only comparable if they were scored the same way — say which
  if (provenance) lines.push(`\n<sub>${provenance}</sub>`);
  lines.push("");
  return lines.join("\n");
}
