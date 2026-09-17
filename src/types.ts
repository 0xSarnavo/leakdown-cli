import { z } from "zod";

export interface Persona {
  name: string;
  temperature: "cold" | "warm" | "hot";
  goal: string;
  tech_comfort: "low" | "medium" | "high";
  patience_steps: number;
  max_confusion_before_bail: number;
  /** How long this persona will keep checking email for a code/link before giving up (seconds) */
  otp_patience_seconds: number;
  traits: string[];
}

/**
 * Told to the persona. The first two are also enforced mechanically in
 * safety.ts — the harness refuses those actions whatever the model decides.
 * The third is prompt-only, so do not describe it as guaranteed.
 */
export const SAFETY_RULES = `- You may LOOK at pricing, billing and checkout pages — seeing them is useful. But you NEVER actually pay: no card details, and never the final "Pay"/"Place order" button. The system blocks it anyway.
- You NEVER sign in with Google/GitHub/Apple/SSO. Use email signup, or walk away. The system blocks it anyway.
- You may open a demo/meeting scheduler and look at slots, but you NEVER finish booking — never the final "Confirm"/"Schedule event" button. A real person would have to attend that meeting. Seeing that signup is demo-gated IS your finding. The system blocks it anyway.
- You NEVER delete data, invite teammates, publish or post anything public, open a support chat, or send anything to a third party. You are a visitor looking, not a customer acting on their behalf.`;

export const DecisionSchema = z.object({
  thought: z.string().describe("First-person inner monologue about what you see"),
  emotion: z.string().describe("Current emotional state, one or two words"),
  confusion: z.number().min(0).max(10).describe("Confusion level 0-10"),
  action: z.union([
    z.object({ type: z.literal("click"), target: z.string() }),
    z.object({ type: z.literal("type"), target: z.string(), text: z.string() }),
    z.object({
      type: z.literal("select"),
      target: z.string(),
      value: z.string(),
    }),
    z.object({ type: z.literal("scroll"), direction: z.enum(["up", "down"]) }),
    z.object({ type: z.literal("back") }),
    z.object({ type: z.literal("wait"), seconds: z.number().min(1).max(10) }),
    z.object({
      type: z.literal("check_email"),
      seconds: z.number().min(5).max(60),
    }),
    z.object({
      type: z.literal("complete"),
      summary: z.string(),
    }),
    z.object({
      type: z.literal("abandon"),
      reason: z.string(),
      question: z.string(),
    }),
  ]),
});

export type Decision = z.infer<typeof DecisionSchema>;
export type DecisionAction = Decision["action"];

/** Schema for a line of session.jsonl — shared artifacts are untrusted input. */
export const StepEventSchema = z.object({
  n: z.number(),
  url: z.string(),
  timestamp: z.string(),
  screenshot: z.string().optional(),
  decision: DecisionSchema,
  note: z.string().optional(),
  scrollY: z.number().optional(),
  /** mechanical checks, recorded the first time a session lands on a URL */
  audit: z
    .object({
      unnamed: z.array(z.string()),
      small: z.array(z.string()),
      overflowX: z.boolean(),
      viewportMeta: z.boolean(),
    })
    .optional(),
});

export const ExitReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed"), summary: z.string() }),
  z.object({ kind: z.literal("abandoned"), reason: z.string(), question: z.string() }),
  z.object({ kind: z.literal("guardrail"), detail: z.string() }),
  // our side failed (unreachable URL, brain down, setup error) — says nothing about the site
  z.object({ kind: z.literal("couldnotrun"), detail: z.string() }),
]);

/** `--expect label=value`: the page must show `expected` before a completion counts. */
export const AssertionSchema = z.object({ label: z.string().min(1), expected: z.string().min(1) });
export type Assertion = z.infer<typeof AssertionSchema>;
export type AssertionResult = Assertion & { ok: boolean; found: string };

export const VerdictSchema = z.object({
  achieved: z.boolean(),
  note: z.string().describe("What is missing or what confirms completion"),
});

export type StepEvent = {
  n: number;
  url: string;
  timestamp: string;
  screenshot?: string;
  decision: Decision;
  /** e.g. why a "complete" claim was rejected by verification */
  note?: string;
  /** mechanical checks from browser/audit.ts, recorded the first time a session lands on a URL */
  audit?: { unnamed: string[]; small: string[]; overflowX: boolean; viewportMeta: boolean };
  /**
   * Scroll offset when this decision was made. Lets stuckPattern tell a persona
   * working its way down a long page from one wedged at the bottom still
   * scrolling: same action, but only the second one repeats a position.
   */
  scrollY?: number;
};

export type ExitReason =
  | { kind: "completed"; summary: string }
  | { kind: "abandoned"; reason: string; question: string }
  | { kind: "guardrail"; detail: string }
  | { kind: "couldnotrun"; detail: string };

export interface BrainContext {
  persona: Persona;
  ariaYaml: string;
  screenshotPath: string;
  url: string;
  stepNumber: number;
  /** Full journey so far — recent steps rendered in detail by the prompt builder */
  history: StepEvent[];
  /** Set when the previous action failed, so the brain can change approach */
  failedHint?: string;
  /** The persona's ephemeral mailbox address (when mail is configured) */
  emailAddress?: string;
  /** Result of the last check_email action, rendered for the next think step */
  emailResult?: string;
  /** False (default) when this brain cannot read files — prompts then omit screenshot pointers */
  readsFiles?: boolean;
  /**
   * What this visitor already knew before clicking through — rationed by
   * temperature in `arrivalFor()`: cold gets nothing, warm gets the arrival
   * paragraph, hot also gets what it does, costs, and how signup works.
   */
  arrival?: string;
  /**
   * ref -> where it sits relative to the viewport, from `driver.snapshot()`.
   * `buildPrompt` uses it to show only what a person could see. Empty means
   * unmeasured, and the whole tree is shown as before.
   */
  visibility?: Record<string, { hidden: boolean; belowFold: boolean; onScreen: boolean }>;
}

export interface Brain {
  name: string;
  decide(ctx: BrainContext): Promise<Decision>;
  /** Free-form question inside the same persistent session (verification etc.) */
  ask?(prompt: string): Promise<string>;
  /**
   * Whether the persona can actually read files (page/email screenshots).
   * claude can (--add-dir opts the session dir in); opencode and codex
   * personas get their reads permission-rejected in non-interactive mode.
   * Prompts must never tell a brain to do something it cannot do — a
   * rejected tool call makes some models stall instead of replying.
   */
  readsFiles?: boolean;
}
