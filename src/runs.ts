/**
 * Run-directory layout:
 *
 *   runs/<site>/                          what is known about the site: SITE.md, MAP.md, personas/
 *   runs/<site>/<YYYY-MM-DD>/<HH-MM-SS>/  one CLI invocation — "a run"
 *     <seat>/<model>/<HH-MM-SS>-<persona>/  a session; seat is wide, verify or deep
 *     RUN.md AGGREGATE.md DETAIL.md         what the run produced (report writes these)
 *     VERIFIED.md REPORT.md                 the verifier's and the writer's panels, bundled
 *
 * The site level also carries a copy of the newest run's five files, so
 * runs/<site>/AGGREGATE.md is always the latest report.
 *
 * Kept in its own module rather than in cli.ts so it can be imported — and
 * tested — without executing the CLI's main().
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export const RUNS_ROOT = "runs";

/** The three seats of a run. Which model sits in each is the run's business, not the layout's. */
export const SEATS = ["wide", "verify", "deep"] as const;
export type Seat = (typeof SEATS)[number];

/**
 * Folder name for a target site: host minus www., filesystem-safe.
 * The port is kept, so localhost:3000 and localhost:8080 stay separate.
 */
export function siteSlug(url: string): string {
  try {
    const host = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).host;
    const slug = host.replace(/^www\./, "").replace(/[^a-zA-Z0-9._-]/g, "_");
    // "." and ".." survive the character filter but would escape runs/
    return !slug || /^\.+$/.test(slug) ? "unknown-site" : slug;
  } catch {
    return "unknown-site";
  }
}

/** Model id → folder-safe slug (opencode/big-pickle → opencode-big-pickle). */
export function modelSlug(model: string | null | undefined): string {
  return (model || "default").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

const stamp = (now: Date) => ({ date: now.toISOString().slice(0, 10), time: now.toISOString().slice(11, 19).replace(/:/g, "-") });

/** `--variant` slugs: lowercase letters, digits, dashes, up to 40 — readable as a folder suffix. */
export const VARIANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The folder for one CLI invocation: runs/<site>/<date>/<time>, or <time>--<variant> for an A/B run. */
export function newRunDir(url: string, now: Date = new Date(), root: string = RUNS_ROOT, variant?: string): string {
  const { date, time } = stamp(now);
  return resolve(`${root}/${siteSlug(url)}/${date}/${time}${variant ? `--${variant}` : ""}`);
}

/** The variant a run folder was tagged with, or null for a plain run. */
export function variantOf(runDir: string): string | null {
  return resolve(runDir).split("/").at(-1)?.match(/^\d{2}-\d{2}-\d{2}--(.+)$/)?.[1] ?? null;
}

/** Every run folder under a site, oldest first. */
export function runDirs(site: string, root: string = RUNS_ROOT): string[] {
  const siteDir = `${root}/${site}`;
  if (!existsSync(siteDir)) return [];
  const out: string[] = [];
  for (const date of readdirSync(siteDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))
    for (const time of readdirSync(`${siteDir}/${date}`).filter((t) => /^\d{2}-\d{2}-\d{2}(--[a-z0-9-]+)?$/.test(t)))
      out.push(resolve(`${siteDir}/${date}/${time}`));
  return out.sort();
}

/**
 * Where a new session's artifacts go: <run>/<seat>/<model>/<time>-<persona>.
 * Two runs of the same persona within one second get a numeric suffix rather
 * than overwriting each other.
 */
export function sessionPath(
  runDir: string,
  seat: Seat,
  model: string | null | undefined,
  personaId: string,
  now: Date = new Date(),
): string {
  const base = resolve(`${runDir}/${seat}/${modelSlug(model)}`);
  let dir = `${base}/${stamp(now).time}-${personaId}`;
  for (let n = 2; existsSync(dir); n++) dir = `${base}/${stamp(now).time}-${personaId}-${n}`;
  return dir;
}

/** The seat a session sits in, or null when the folder is not <run>/<seat>/<model>/<leaf>. */
export function seatOf(sessionDir: string): Seat | null {
  const seat = resolve(sessionDir).split("/").at(-3);
  return (SEATS as readonly string[]).includes(seat ?? "") ? (seat as Seat) : null;
}

/** The run folder a session belongs to, or null for a foreign layout. */
export function runDirOf(sessionDir: string): string | null {
  return seatOf(sessionDir) ? resolve(sessionDir).split("/").slice(0, -3).join("/") : null;
}

/**
 * Every session directory under the runs root, at any depth.
 *
 * Identity is "contains a meta.json", not position, so the nesting is not
 * load-bearing — sites can be reorganised into subfolders and stages 2-3 still
 * find everything.
 */
export function findSessionDirs(root: string = RUNS_ROOT): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "shots") continue;
      const child = `${dir}/${entry.name}`;
      if (existsSync(`${child}/meta.json`)) found.push(resolve(child));
      else walk(child);
    }
  };
  walk(root);
  return found.sort();
}

/** Session identity for humans: the path relative to runs/. */
export function dirLabel(dir: string): string {
  const parts = resolve(dir).split("/").filter(Boolean);
  const i = parts.lastIndexOf(RUNS_ROOT);
  return i >= 0 ? parts.slice(i + 1).join("/") : (parts.pop() ?? dir);
}
