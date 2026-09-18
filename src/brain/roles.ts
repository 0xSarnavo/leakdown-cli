/**
 * What a brain is being used for.
 *
 * Two things key off this. Tool policy, which is why the type existed: a persona
 * pretending to be a naive visitor must not be able to shell out or fetch the
 * page directly, while the expert panel legitimately needs both. And, through the
 * per-role model map, which model answers the call: the persona loop's reasoning
 * is what the report is made of, while a schema-validated JSON reply is the same
 * reply from any model that can hold the shape.
 */
export const BRAIN_ROLES = [
  /** the session loop: one call per step, and the only prose a reader sees */
  "persona",
  /** the prose experts of `leakdown fix` */
  "expert",
  /** the Conversion Scorecard — numbers plus a sentence each */
  "scores",
  /** one cached call per site: read the landing page into SITE.md */
  "brief",
  /** one call: draft a flow's checkpoints from an intent */
  "flow",
  /** one call per site: write the persona set */
  "personagen",
] as const;

export type BrainRole = (typeof BRAIN_ROLES)[number];

export function isBrainRole(s: string): s is BrainRole {
  return (BRAIN_ROLES as readonly string[]).includes(s);
}

/**
 * Which of the two tool policies a role gets.
 *
 * There are still exactly two, and they are unchanged: the panel reads a
 * transcript quoting the site under review, so its input is attacker-influenced
 * and it keeps WebFetch for the raw page text; everything else is persona-grade.
 * Roles added here must be classified deliberately — defaulting a new role to
 * "expert" widens what site text can reach (invariant 5).
 */
export function toolPolicy(role: BrainRole): "persona" | "expert" {
  return role === "expert" || role === "scores" ? "expert" : "persona";
}

/**
 * A key in the model map: a role, or one named expert.
 *
 * The panel is seven agents behind one role. `expert:ux` pins that expert alone
 * and leaves the other six on `expert`, which is what lets the two sections a
 * client actually reads sit above the four checklist ones without giving every
 * expert an enum entry — a new expert inherits `expert` and needs no change here.
 */
export type ModelKey = BrainRole | `expert:${string}`;

/** Per-role model overrides. A key with no entry falls back to `--model`. */
export type ModelsByRole = Partial<Record<ModelKey, string>>;

/** `expert:ux` first, then `expert`, then whatever `--model` said. */
export function modelForKey(
  models: ModelsByRole | undefined,
  role: BrainRole,
  expertId?: string,
): string | undefined {
  if (!models) return undefined;
  if (expertId && models[`expert:${expertId}`]) return models[`expert:${expertId}`];
  return models[role];
}
