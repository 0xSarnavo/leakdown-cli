import type { Brain } from "../types.js";
import { modelForKey, type BrainRole, type ModelsByRole } from "./roles.js";
import { createClaudeBrain } from "./adapters/claude.js";
import { createOpencodeBrain } from "./adapters/opencode.js";
import { createCodexBrain } from "./adapters/codex.js";

/**
 * Brains are built per call, never shared.
 *
 * Each adapter keeps a persistent CLI session (claude --resume, opencode -s) in
 * its closure, so a shared instance would let one persona's conversation bleed
 * into the next one's. Every session — each persona run, each expert — gets its
 * own brain and therefore its own clean context.
 */
const FACTORIES: Record<string, (role: BrainRole) => Brain> = {
  claude: createClaudeBrain,
  opencode: createOpencodeBrain,
  codex: createCodexBrain,
};

export interface BrainOptions {
  model?: string;
  effort?: string;
  /** Decides the tool policy — see adapters/claude.ts — and which model answers */
  role?: BrainRole;
  /** Directory the CLI may read despite running outside the project (screenshots) */
  allowDir?: string;
  /**
   * Per-role model overrides (`--model-for persona=sonnet`). The role's own
   * entry wins over `model`; a role with no entry is unchanged by this map, so
   * an empty one leaves every call exactly where `--model` put it.
   */
  models?: ModelsByRole;
  /** Which expert this is, so `--model-for expert:ux=sonnet` can single it out */
  expertId?: string;
}

export function getBrain(name: string, opts: BrainOptions = {}): Brain {
  const make = FACTORIES[name];
  if (!make) {
    throw new Error(`Unknown brain "${name}". Available: ${Object.keys(FACTORIES).join(", ")}`);
  }
  const role = opts.role ?? "persona";
  const brain = make(role);
  const model = modelForKey(opts.models, role, opts.expertId) ?? opts.model;
  if (model) (brain as { model?: string }).model = model;
  if (opts.effort) (brain as { effort?: string }).effort = opts.effort;
  if (opts.allowDir) (brain as { allowDir?: string }).allowDir = opts.allowDir;
  return brain;
}
