/**
 * Brain discovery: which AI CLIs are installed, and what models / reasoning
 * efforts each one actually offers.
 *
 * Everything here is probed live from the CLI rather than hardcoded, so the
 * picker stays correct as the vendors ship new models. Curated lists exist
 * only as a fallback for when a probe fails or a CLI has no way to enumerate.
 */
import { execa } from "execa";

export interface BrainSpec {
  id: string;
  label: string;
  command: string;
  /** CLI exposes a reasoning-effort knob we can prompt for */
  hasEffort: boolean;
}

export const BRAIN_SPECS: BrainSpec[] = [
  { id: "claude", label: "claude", command: "claude", hasEffort: true },
  { id: "codex", label: "codex", command: "codex", hasEffort: true },
  { id: "opencode", label: "opencode", command: "opencode", hasEffort: false },
];

const DESCRIPTIONS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex (ChatGPT)",
  opencode: "opencode",
};

/**
 * How to get each one, so "not installed" is an instruction rather than a name
 * to go and search for. Each still needs a login of its own afterwards.
 */
export const INSTALL_COMMANDS: Record<string, string> = {
  claude: "npm i -g @anthropic-ai/claude-code",
  codex: "npm i -g @openai/codex",
  opencode: "npm i -g opencode-ai",
};

/** One line per CLI: what to run to install it. */
export function installHelp(ids: string[] = BRAIN_SPECS.map((s) => s.id)): string {
  return ids
    .filter((id) => INSTALL_COMMANDS[id])
    .map((id) => `    ${DESCRIPTIONS[id] ?? id}: ${INSTALL_COMMANDS[id]}`)
    .join("\n");
}

/** Used only when a live probe returns nothing usable. */
const FALLBACK_MODELS: Record<string, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-5.2-codex", "gpt-5.2"],
  opencode: [],
};

const FALLBACK_EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high"],
  opencode: [],
};

export interface BrainAvailability {
  spec: BrainSpec;
  installed: boolean;
  /** Version string, or the reason it is unavailable */
  detail: string;
}

async function probe(command: string, args: string[], timeout: number): Promise<string | null> {
  try {
    const r = await execa(command, args, { timeout, reject: false, stdin: "ignore" });
    if (r.failed && !r.stdout) return null;
    return `${r.stdout}\n${r.stderr}`;
  } catch {
    return null;
  }
}

let availabilityCache: BrainAvailability[] | null = null;

/** Probe every known CLI in parallel. Cached for the life of the process. */
export async function detectBrains(): Promise<BrainAvailability[]> {
  if (availabilityCache) return availabilityCache;
  availabilityCache = await Promise.all(
    BRAIN_SPECS.map(async (spec) => {
      const out = await probe(spec.command, ["--version"], 15_000);
      const version = out?.split("\n").find((l) => l.trim())?.trim().slice(0, 32);
      return {
        spec,
        installed: Boolean(out),
        detail: out ? version || "installed" : "not installed",
      };
    }),
  );
  return availabilityCache;
}

export function describeBrain(id: string): string {
  return DESCRIPTIONS[id] ?? id;
}

const modelCache = new Map<string, string[]>();

/**
 * Ask the CLI what models it can run.
 *  - opencode ships a real `models` subcommand
 *  - claude only documents its aliases in --help, so we parse the --model block
 *  - codex has no enumeration; we parse --help opportunistically, else fall back
 */
export async function listModels(brainId: string): Promise<string[]> {
  const cached = modelCache.get(brainId);
  if (cached) return cached;

  let models: string[] = [];

  if (brainId === "opencode") {
    const out = await probe("opencode", ["models"], 25_000);
    models = (out ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.includes(" ") && l.includes("/"));
  } else {
    const help = await probe(brainId, ["--help"], 20_000);
    if (help) {
      const block = help.match(/--model[\s<>\w]*?\n?([\s\S]{0,400}?)(?:\n\s+-{1,2}[a-zA-Z])/);
      const quoted = block ? [...block[1].matchAll(/'([a-z0-9.\-]+)'/g)].map((m) => m[1]) : [];
      models = [...new Set(quoted)];
    }
  }

  if (models.length < 2) models = FALLBACK_MODELS[brainId] ?? [];
  modelCache.set(brainId, models);
  return models;
}

const effortCache = new Map<string, string[]>();

/** Reasoning-effort levels the CLI accepts. Empty means the brain has no such knob. */
export async function listEfforts(brainId: string): Promise<string[]> {
  const spec = BRAIN_SPECS.find((b) => b.id === brainId);
  if (!spec?.hasEffort) return [];

  const cached = effortCache.get(brainId);
  if (cached) return cached;

  let efforts: string[] = [];
  const help = await probe(brainId, ["--help"], 20_000);
  if (help) {
    const m = help.match(/--effort\s+<[^>]+>[\s\S]{0,200}?\(([a-z0-9,\s]+)\)/);
    if (m) {
      efforts = m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  if (efforts.length === 0) efforts = FALLBACK_EFFORTS[brainId] ?? [];
  effortCache.set(brainId, efforts);
  return efforts;
}
