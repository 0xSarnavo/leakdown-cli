import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCliBrain } from "./cli-brain.js";
import { toolPolicy, type BrainRole } from "../roles.js";

/**
 * Personas ingest hostile page/email content, so their tool surface is denied
 * outright via a config file (verified: opencode honours OPENCODE_CONFIG
 * permission denies in non-interactive `run`). Experts read a transcript
 * quoting that same content, so they lose the shell too — they keep webfetch,
 * which their prompts need to pull the page's raw text.
 */
const DENY_CONFIG = {
  persona: {
    $schema: "https://opencode.ai/config.json",
    permission: { edit: "deny", bash: "deny", webfetch: "deny" },
  },
  expert: {
    $schema: "https://opencode.ai/config.json",
    permission: { edit: "deny", bash: "deny" },
  },
} as const;

type Policy = keyof typeof DENY_CONFIG;

const configPaths: Partial<Record<Policy, string>> = {};

/** Keyed by tool policy, not by role: there are two configs, however many roles. */
function writeDenyConfig(role: BrainRole): string {
  const policy: Policy = toolPolicy(role);
  // one shared config per policy per process (unique 0700 dir: another local user
  // must not be able to pre-plant this file)
  let path = configPaths[policy];
  if (!path) {
    const dir = mkdtempSync(join(tmpdir(), "leakdown-oc-"));
    path = join(dir, `${policy}-permissions.json`);
    writeFileSync(path, JSON.stringify(DENY_CONFIG[policy]));
    configPaths[policy] = path;
  }
  return path;
}

export function createOpencodeBrain(role: BrainRole = "persona") {
  return makeCliBrain({
    name: "opencode",
    // no -s: stateless per call, same as the other adapters — journey memory
    // comes from the tiered history the prompt builder renders
    command: "opencode",
    // reads outside the CLI's cwd are permission-rejected in non-interactive
    // `run` (there is no --add-dir equivalent), so prompts must never point
    // this brain at screenshot files — a rejected read stalls some models
    readsFiles: false,
    args: (prompt, { model }) => [
      "run",
      "--print-logs",
      ...(model ? ["--model", model] : []),
      // opencode has no effort flag; reasoning depth follows the model config
      prompt,
    ],
    // deny config is only honoured through the environment, not a CLI flag
    env: { OPENCODE_CONFIG: writeDenyConfig(role) },
    extractText: (stdout) => stdout,
    timeoutMs: 300_000,
  });
}
