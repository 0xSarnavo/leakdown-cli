/**
 * Interactive brain/model/effort selection.
 *
 * Any value supplied as a CLI flag is respected and never re-asked; only the
 * gaps get a prompt. With no TTY every gap falls back to a sane default so
 * automation behaves exactly as it did before the picker existed.
 */
import {
  BRAIN_SPECS,
  describeBrain,
  detectBrains,
  installHelp,
  listEfforts,
  listModels,
} from "./catalog.js";
import { confirmed, isInteractive, select, text, type Choice } from "../ui/prompt.js";

export interface BrainChoice {
  brain: string;
  model?: string;
  effort?: string;
}

const DEFAULT_BRAIN = "claude";

const USE_DEFAULT = " default";
const USE_CUSTOM = " custom";

/**
 * A brain named by flag was never checked for existence, so `--brain codex` on a
 * machine without Codex launched a browser, minted a mailbox, and only then
 * failed — one dead CLI call per retry, 60s of backoff, and a session recorded
 * as a guardrail exit. The same `--version` probe the picker menu uses decides
 * it up front.
 */
/**
 * Codex takes the effort as `-c model_reasoning_effort="<value>"`, so a value
 * carrying a quote or a newline would set unrelated config keys. Every real
 * level is a bare word; anything else is a typo or an injection attempt.
 */
function assertEffortShape(effort: string | undefined): void {
  if (effort !== undefined && !/^[a-z0-9_-]{1,20}$/i.test(effort)) {
    throw new Error(
      `Invalid --effort "${effort}". Use a single word like low, medium or high.`,
    );
  }
}

async function assertInstalled(brain: string): Promise<void> {
  const available = await detectBrains();
  const found = available.find((a) => a.spec.id === brain);
  if (found && !found.installed) {
    const others = available.filter((a) => a.installed).map((a) => a.spec.id);
    throw new Error(
      `Brain "${brain}" is not installed (no \`${found.spec.command} --version\` in PATH).` +
        (others.length
          ? ` Installed: ${others.join(", ")} — pass --brain <one of those>.`
          : `\nInstall one, then log in:\n${installHelp()}`),
    );
  }
}

/** Transient status line while we shell out to the CLIs. */
async function withStatus<T>(message: string, work: () => Promise<T>): Promise<T> {
  if (!isInteractive()) return work();
  process.stdout.write(`  \x1b[2m${message}\x1b[0m`);
  try {
    return await work();
  } finally {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
}

async function pickModel(brainId: string): Promise<string | undefined> {
  const models = await withStatus(`asking ${brainId} which models it can run...`, () =>
    listModels(brainId),
  );

  const choices: Choice<string>[] = [
    { value: USE_DEFAULT, label: "default", hint: `whatever ${brainId} is already set to` },
    ...models.map((m) => ({ value: m, label: m })),
    { value: USE_CUSTOM, label: "custom...", hint: "type a model id" },
  ];

  const picked = await select({ message: "Model?", choices });
  if (picked === USE_DEFAULT) {
    confirmed("model", `${brainId} default`);
    return undefined;
  }
  if (picked === USE_CUSTOM) {
    const typed = await text({ message: "Model id:", fallback: "" });
    if (!typed) {
      confirmed("model", `${brainId} default`);
      return undefined;
    }
    confirmed("model", typed);
    return typed;
  }
  confirmed("model", picked);
  return picked;
}

async function pickEffort(brainId: string): Promise<string | undefined> {
  const efforts = await withStatus(`checking ${brainId} reasoning levels...`, () =>
    listEfforts(brainId),
  );
  if (efforts.length === 0) return undefined; // brain has no effort knob — nothing to ask

  const choices: Choice<string>[] = [
    { value: USE_DEFAULT, label: "default", hint: `whatever ${brainId} is already set to` },
    ...efforts.map((e) => ({ value: e, label: e })),
  ];

  const picked = await select({ message: "Reasoning effort?", choices });
  if (picked === USE_DEFAULT) {
    confirmed("effort", `${brainId} default`);
    return undefined;
  }
  confirmed("effort", picked);
  return picked;
}

/**
 * Resolve brain + model + effort, prompting only for what the flags left open.
 * `purpose` is the question shown above the brain menu.
 */
export async function resolveBrainChoice(
  given: { brain?: string; model?: string; effort?: string },
  purpose = "Which AI plays the client?",
  /** doctor sets this: reporting a missing CLI is the whole point of that command */
  opts: { requireInstalled?: boolean } = {},
): Promise<BrainChoice> {
  const requireInstalled = opts.requireInstalled ?? true;
  assertEffortShape(given.effort);
  if (!isInteractive()) {
    const brain = given.brain ?? DEFAULT_BRAIN;
    if (requireInstalled) await assertInstalled(brain);
    return { brain, model: given.model, effort: given.effort };
  }

  let brain = given.brain;
  if (!brain) {
    const available = await withStatus("detecting installed AI CLIs...", detectBrains);
    if (!available.some((a) => a.installed)) {
      throw new Error(
        `No AI CLI found in PATH. Install one, log in, then re-run:\n${installHelp()}`,
      );
    }

    const choices: Choice<string>[] = available.map((a) => ({
      value: a.spec.id,
      label: a.spec.label,
      hint: `${describeBrain(a.spec.id).padEnd(16)} ✓ ${a.detail}`,
      disabled: a.installed
        ? undefined
        : `${describeBrain(a.spec.id).padEnd(16)} ✗ not installed`,
    }));

    const preferredIndex = choices.findIndex((c) => c.value === DEFAULT_BRAIN && !c.disabled);
    brain = await select({ message: purpose, choices, initial: Math.max(preferredIndex, 0) });
    const detail = available.find((a) => a.spec.id === brain)?.detail;
    confirmed("brain", brain, detail);
  }

  if (!BRAIN_SPECS.some((s) => s.id === brain)) {
    throw new Error(
      `Unknown brain "${brain}". Available: ${BRAIN_SPECS.map((s) => s.id).join(", ")}`,
    );
  }
  if (requireInstalled) await assertInstalled(brain);

  const model = given.model ?? (await pickModel(brain));
  const effort = given.effort ?? (await pickEffort(brain));
  return { brain, model, effort };
}
