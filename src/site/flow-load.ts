/**
 * Operator-written flows: `flows/*.yaml` (global) and `runs/<site>/flows/*.yaml`
 * (this site's own; wins on an id collision). The id is the filename.
 *
 * A flow is the journey you want checked, as ordered steps. Sessions are still
 * personas deciding for themselves — nothing here scripts clicks. After each
 * session the existing scorer says which steps the journey reached; a step with
 * `expect` text can also end the session mechanically (`stop_after`).
 *
 *   # flows/signup.yaml
 *   name: Signup to first project          # required
 *   intent: sign up and create a project   # optional, defaults to name; shapes generated personas
 *   steps:                                 # 1-50, in order; a string or {name, expect}
 *     - found the signup form
 *     - name: submitted email and password
 *       expect: "Check your inbox"         # page text that proves the step (whitespace-insensitive substring)
 *     - name: saw the dashboard
 *       expect: "New project"
 *   stop_after: 2                          # optional: step number or name; that step needs `expect`
 *                                          # — the session ends COMPLETED the moment its text is on screen
 *
 * `leakdown --validate-flow [file]` checks files without launching anything.
 * `leakdown <url> --flow-file <id|path>` runs against one.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { RUNS_ROOT, siteSlug } from "../runs.js";
import type { Flow } from "./flow.js";

export const FLOWS_DIR = resolve("flows");
export const siteFlowsDir = (url: string) => resolve(`${RUNS_ROOT}/${siteSlug(url)}/flows`);

const Step = z.union([
  z.string().min(1).max(200),
  z.object({ name: z.string().min(1).max(200), expect: z.string().min(1).max(200).optional() }),
]);
const FlowFileSchema = z.object({
  name: z.string().min(1).max(120),
  intent: z.string().min(1).max(300).optional(),
  steps: z.array(Step).min(1).max(50),
  stop_after: z.union([z.number().int().min(1), z.string().min(1)]).optional(),
});

export interface FlowFile {
  id: string;
  name: string;
  intent: string;
  steps: { name: string; expect?: string }[];
  /** 0-based index into steps, when the file names a stop point */
  stopAfter?: number;
}

export type FlowCheck = { file: string; ok: true; flow: FlowFile } | { file: string; ok: false; error: string };

/** Validate one file: schema, then the cross-field rules zod cannot state. Never throws. */
export function validateFlow(path: string): FlowCheck {
  const file = basename(path);
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { file, ok: false, error: `YAML parse error: ${(e as Error).message.slice(0, 100)}` };
  }
  const res = FlowFileSchema.safeParse(raw);
  if (!res.success) {
    return {
      file,
      ok: false,
      error: res.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    };
  }
  const d = res.data;
  const steps = d.steps.map((s) => (typeof s === "string" ? { name: s } : s));
  let stopAfter: number | undefined;
  if (d.stop_after !== undefined) {
    stopAfter = typeof d.stop_after === "number" ? d.stop_after - 1 : steps.findIndex((s) => s.name === d.stop_after);
    if (stopAfter < 0 || stopAfter >= steps.length)
      return { file, ok: false, error: `stop_after: "${d.stop_after}" is not one of the ${steps.length} step(s)` };
    if (!steps[stopAfter].expect)
      return { file, ok: false, error: `stop_after: step ${stopAfter + 1} needs \`expect\` text — the run stops when that text is on screen` };
  }
  return { file, ok: true, flow: { id: file.replace(/\.ya?ml$/, ""), name: d.name, intent: d.intent ?? d.name, steps, stopAfter } };
}

/** Every *.yaml in a directory, valid or not. Missing directory means none. */
export function validateFlowDir(dir: string): FlowCheck[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => validateFlow(`${dir}/${f}`));
}

/** Global flows/ plus this site's own, site winning on id. Invalid files are listed, never fatal. */
export function loadFlowFiles(url?: string): { flows: Record<string, FlowFile>; errors: { file: string; error: string }[] } {
  const checks = [...validateFlowDir(FLOWS_DIR), ...(url ? validateFlowDir(siteFlowsDir(url)) : [])];
  const flows: Record<string, FlowFile> = {};
  const errors: { file: string; error: string }[] = [];
  for (const c of checks) {
    if (c.ok) flows[c.flow.id] = c.flow;
    else errors.push({ file: c.file, error: c.error });
  }
  return { flows, errors };
}

/** `--flow-file <id|path>`: a path to a YAML file, or an id from the registry. */
export function loadFlowFile(idOrPath: string, url?: string): FlowCheck {
  if (/\.ya?ml$/.test(idOrPath) || existsSync(idOrPath)) {
    if (!existsSync(idOrPath)) return { file: idOrPath, ok: false, error: "no such file" };
    return validateFlow(idOrPath);
  }
  const { flows, errors } = loadFlowFiles(url);
  const flow = flows[idOrPath];
  if (flow) return { file: `${idOrPath}.yaml`, ok: true, flow };
  const known = Object.keys(flows);
  return {
    file: idOrPath,
    ok: false,
    error: `no flow "${idOrPath}" in flows/${url ? ` or runs/${siteSlug(url)}/flows/` : ""}${known.length ? ` — known: ${known.join(", ")}` : ""}${errors.length ? ` (${errors.length} file(s) invalid — run --validate-flow)` : ""}`,
  };
}

/** The shape the scorer and persona generator already consume. `expect` text rides along in the checkpoint name. */
export function toFlow(f: FlowFile): Flow {
  const stop = f.stopAfter === undefined ? undefined : { index: f.stopAfter, label: f.steps[f.stopAfter].name, text: f.steps[f.stopAfter].expect! };
  return {
    intent: f.intent,
    checkpoints: f.steps.map((s) => (s.expect ? `${s.name} (page shows "${s.expect}")` : s.name)),
    stop,
  };
}

export function renderFlowChecks(checks: FlowCheck[]): string {
  if (!checks.length) return "  no flow files found\n";
  return checks
    .map((c) =>
      c.ok
        ? `  ✓ ${c.file} — "${c.flow.name}", ${c.flow.steps.length} step(s)${c.flow.stopAfter === undefined ? "" : `, stops after step ${c.flow.stopAfter + 1}`}`
        : `  ✗ ${c.file} — ${c.error}`,
    )
    .join("\n") + "\n";
}
