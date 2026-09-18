import { makeCliBrain } from "./cli-brain.js";
import { toolPolicy, type BrainRole } from "../roles.js";

interface ClaudeJsonOutput {
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Tools cost ~5k tokens of schema on every call and widen what the model can do.
 *
 * A persona keeps only Read, so it can look at its own screenshot but cannot
 * shell out, fetch the URL directly, or read the project it is running against.
 *
 * Experts read a transcript quoting the site under review, so their input is
 * attacker-influenced too — they lose the shell for the same reason. WebFetch
 * stays: their prompts need the page's raw text, and fetching a URL is the
 * narrow tool for that, where Bash was a general-purpose one.
 */
const PERSONA_DISALLOWED = [
  "Bash", "BashOutput", "KillShell", "Write", "Edit", "NotebookEdit",
  "WebFetch", "WebSearch", "Task", "Glob", "Grep", "TodoWrite", "SlashCommand",
];

const EXPERT_DISALLOWED = [
  "Bash", "BashOutput", "KillShell",
  "Write", "Edit", "NotebookEdit", "Task", "TodoWrite", "SlashCommand",
];

export function createClaudeBrain(role: BrainRole = "persona") {
  const disallowed = toolPolicy(role) === "expert" ? EXPERT_DISALLOWED : PERSONA_DISALLOWED;
  return makeCliBrain({
    name: "claude",
    // --add-dir opts the session dir in, so Read reaches the screenshots
    readsFiles: true,
    systemPrompt: true,
    command: "claude",
    // no --resume: each call is self-contained and the prompt carries the
    // journey, so context cannot grow without bound across a run
    args: (prompt, { model, effort, allowDir, system }) => [
      "-p",
      // a prompt starting with "-" is parsed as a flag ("unknown option") and
      // the whole session dies at step 1 — a leading space keeps it positional
      prompt.startsWith("-") ? ` ${prompt}` : prompt,
      // the static persona half rides in the system prompt so the CLI's prompt
      // cache covers it; the user half is what changes per step
      ...(system ? ["--append-system-prompt", system] : []),
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
      // the CLI runs outside the project, so the session dir must be opted in
      // explicitly or Read cannot reach the screenshots
      ...(allowDir ? ["--add-dir", allowDir] : []),
      "--disallowed-tools",
      disallowed.join(","),
      "--output-format",
      "json",
    ],
    extractText: (stdout) => {
      try {
        const parsed = JSON.parse(stdout) as ClaudeJsonOutput;
        if (parsed.result) return parsed.result;
      } catch {
        // fall through to raw stdout
      }
      return stdout;
    },
    extractUsage: (stdout) => {
      try {
        const p = JSON.parse(stdout) as ClaudeJsonOutput;
        if (!p.usage) return null;
        return {
          inputTokens: p.usage.input_tokens ?? 0,
          outputTokens: p.usage.output_tokens ?? 0,
          cacheReadTokens: p.usage.cache_read_input_tokens ?? 0,
          cacheCreateTokens: p.usage.cache_creation_input_tokens ?? 0,
          costUsd: p.total_cost_usd ?? 0,
        };
      } catch {
        return null;
      }
    },
  });
}
