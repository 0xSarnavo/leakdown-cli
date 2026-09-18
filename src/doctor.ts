import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { detectBrains, installHelp } from "./brain/catalog.js";
import { findFfmpeg } from "./browser/video.js";
import { banner } from "./banner.js";

const STATE_FILE = ".leakdown-state.json";
const STATE_MAX_AGE_MS = 7 * 24 * 3600_000; // re-verify weekly

/**
 * Resolve LEAKDOWN_* with CLIENTSIM_* fallback.
 * Old alpha .env files use the CLIENTSIM_ prefix; they keep working for one
 * minor with a single deprecation warning.
 */
let warnedCompat = false;
function envWithFallback(fresh: string, legacy: string): string | undefined {
  const v = process.env[fresh];
  if (v !== undefined) return v;
  const old = process.env[legacy];
  if (old !== undefined) {
    if (!warnedCompat) {
      console.warn("CLIENTSIM_* deprecated, use LEAKDOWN_*");
      warnedCompat = true;
    }
    return old;
  }
  return undefined;
}

interface DoctorResult {
  name: string;
  ok: boolean;
  detail: string;
  live: boolean;
}

export interface MailProbe {
  at: string;
  ok: boolean;
  /** seconds until the probe landed; null when it never did */
  latencySeconds: number | null;
}

interface StateFile {
  lastCheck: string;
  results: DoctorResult[];
  mailProbe?: MailProbe;
}

function loadState(): StateFile | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    // the file is edited by hand and written by older versions — a wrong shape
    // used to reach stateIsFresh() and crash the command with a stack trace
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.results)) return null;
    return raw as StateFile;
  } catch {
    return null;
  }
}

function stateIsFresh(state: StateFile): boolean {
  return (
    state.results.length > 0 &&
    state.results.every((r) => r && typeof r === "object") &&
    Date.now() - new Date(state.lastCheck).getTime() < STATE_MAX_AGE_MS &&
    state.results.every((r) => r.ok)
  );
}

function saveState(results: DoctorResult[]) {
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ ...loadState(), lastCheck: new Date().toISOString(), results }, null, 2),
  );
}

const MAIL_PROBE_MAX_AGE_MS = 24 * 3600_000;

/** The last mail probe, if it is recent enough to still mean something. */
export function recentMailProbe(): MailProbe | null {
  const p = loadState()?.mailProbe;
  if (!p || typeof p.at !== "string") return null;
  return Date.now() - new Date(p.at).getTime() < MAIL_PROBE_MAX_AGE_MS ? p : null;
}

export function saveMailProbe(probe: MailProbe): void {
  const state = loadState() ?? { lastCheck: new Date(0).toISOString(), results: [] };
  writeFileSync(STATE_FILE, JSON.stringify({ ...state, mailProbe: probe }, null, 2));
}

async function checkNode(): Promise<DoctorResult> {
  const [major] = process.versions.node.split(".").map(Number);
  return {
    name: "Node.js >= 20",
    ok: major >= 20,
    detail: `v${process.versions.node}`,
    live: false,
  };
}

async function checkChromium(): Promise<DoctorResult> {
  try {
    const { chromium } = await import("playwright");
    const b = await chromium.launch({ headless: true });
    await b.close();
    return {
      name: "Playwright chromium",
      ok: true,
      detail: "launches OK",
      live: false,
    };
  } catch (e) {
    return {
      name: "Playwright chromium",
      ok: false,
      detail: `${(e as Error).message.split("\n")[0]} — run: npx playwright install chromium`,
      live: false,
    };
  }
}

/**
 * A run needs *an* AI CLI, not every AI CLI — so all of them are probed but
 * they collapse into a single pass/fail. Missing ones are reported, not failed.
 */
async function checkBrainClis(): Promise<{ result: DoctorResult; installed: string[] }> {
  const available = await detectBrains();
  const installed = available.filter((a) => a.installed).map((a) => a.spec.id);
  return {
    result: {
      name: "AI CLI (any one)",
      ok: installed.length > 0,
      detail: available.map((a) => `${a.spec.id}: ${a.detail}`).join(", "),
      live: false,
    },
    installed,
  };
}

/** Live brain test: one tiny real call through the adapter path */
async function checkBrainLive(brainName: string): Promise<DoctorResult> {
  try {
    const { getBrain } = await import("./brain/index.js");
    const brain = getBrain(brainName);
    if (!brain.ask) {
      return { name: `brain ${brainName}`, ok: false, detail: "no ask()", live: true };
    }
    const reply = await brain.ask('Reply with exactly: ok');
    const ok = reply.toLowerCase().includes("ok");
    return {
      name: `brain ${brainName} (live call)`,
      ok,
      detail: ok ? "responded" : `unexpected reply: ${reply.slice(0, 40)}`,
      live: true,
    };
  } catch (e) {
    return {
      name: `brain ${brainName} (live call)`,
      ok: false,
      detail: (e as Error).message.slice(0, 80),
      live: true,
    };
  }
}

/** Live mail test: create + destroy an ephemeral mailbox */
async function checkMailLive(): Promise<DoctorResult> {
  const host = envWithFallback("LEAKDOWN_IMAP_HOST", "CLIENTSIM_IMAP_HOST");
  const user = envWithFallback("LEAKDOWN_IMAP_USER", "CLIENTSIM_IMAP_USER");
  const pass = envWithFallback("LEAKDOWN_IMAP_PASS", "CLIENTSIM_IMAP_PASS");
  const domain = envWithFallback("LEAKDOWN_MAIL_DOMAIN", "CLIENTSIM_MAIL_DOMAIN");
  if (!host || !user || !pass || !domain) {
    return {
      name: "mailbox (live)",
      ok: true, // optional feature — absence is fine
      detail: "not configured (optional — see README for OTP signups)",
      live: true,
    };
  }
  try {
    const { ImapProvider } = await import("./mail/imap.js");
    const tls = envWithFallback("LEAKDOWN_IMAP_TLS", "CLIENTSIM_IMAP_TLS");
    const portRaw = envWithFallback("LEAKDOWN_IMAP_PORT", "CLIENTSIM_IMAP_PORT");
    const p = new ImapProvider({
      host,
      user,
      pass,
      domain,
      tls: tls !== "false",
      port: portRaw ? Number(portRaw) : undefined,
    });
    const box = await p.create("doctortest");
    await p.destroy(box);
    await p.close();
    return { name: "mailbox (live)", ok: true, detail: `created+destroyed ${box.address}`, live: true };
  } catch (e) {
    return {
      name: "mailbox (live)",
      ok: false,
      detail: (e as Error).message.slice(0, 80),
      live: true,
    };
  }
}

function printQuickStart() {
  console.log(`
  ${"─".repeat(58)}
  Ready. Common commands:

  leakdown <url> --ladder --yes --headless   the measured fleet: wide, verify, dig, report
  leakdown <url>                              the plain pipeline, menus for every choice
  leakdown <url> --goal "sign up and get an API key" --steps 15   pass/fail, exit 0/1
  leakdown --report | --fix <dirs> | --pdf    rerun a stage on past sessions
  leakdown --orders / --order <id>            requests left on the website

  Sessions land in runs/<site>/<date>/<time>-<persona>/
  Brains: --brain claude (default) | --brain opencode | --brain codex
  Full guide: AGENTS.md
  ${"─".repeat(58)}
`);
}

export async function runDoctor(brainName = "claude", force = false): Promise<boolean> {
  // the first command most people run after cloning, so it is where the CLI
  // gets to look like the rest of the product for the first time
  console.log(banner());
  console.log("");
  const state = loadState();

  if (!force && state && stateIsFresh(state)) {
    console.log(
      `  ✓ environment already verified ${state.lastCheck.slice(0, 10)} (skipping re-checks, --force to redo)`,
    );
    return true;
  }

  console.log(`\n  checking your setup...`);

  const results: DoctorResult[] = [];
  results.push(await checkNode());
  results.push(await checkChromium());

  const { result: clis, installed } = await checkBrainClis();
  results.push(clis);

  if (installed.length === 0) {
    results.forEach((r) => console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}`));
    console.error(`\n  ✗ No AI CLI found. Install one, then log in:\n${installHelp()}\n`);
    return false;
  }

  // live check — only ever against a brain the user actually has
  if (!installed.includes(brainName)) {
    const fallback = installed[0];
    console.log(`  ! ${brainName} is not installed — health-checking ${fallback} instead`);
    brainName = fallback;
  }

  results.push(await checkBrainLive(brainName));
  results.push(await checkMailLive());

  let allOk = true;
  // informational, never a failure: without it sessions keep video.webm only
  const ffmpeg = await findFfmpeg().catch(() => null);
  console.log(`  ${ffmpeg ? "✓" : "·"} ffmpeg: ${ffmpeg ? `${ffmpeg} — sessions get a playable video.mp4` : "not found — sessions keep video.webm only (brew install ffmpeg)"}`);
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}`);
    if (!r.ok) allOk = false;
  }

  if (allOk) {
    saveState(results);
    printQuickStart();
  } else {
    console.error(`\n  ✗ Fix the ✗ items above, then run: leakdown --doctor --force\n`);
  }
  return allOk;
}

export function doctorStateExists(): boolean {
  return existsSync(STATE_FILE);
}
