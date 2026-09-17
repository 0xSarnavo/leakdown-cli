#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { BrowserDriver } from "./browser/driver.js";
import { getBrain } from "./brain/index.js";
import { PERSONAS } from "./persona/presets.js";
import {
  PERSONAS_DIR,
  getPersonaRegistry,
  loadCustomPersonas,
  newPersonaFile,
  siteOwnPersonas,
  sitePersonasDir,
  sitesWithPersonas,
} from "./persona/load.js";
import { generatePersonas } from "./persona/generate.js";
import { stringify as stringifyYaml } from "yaml";
import { goalExitCode, runSession } from "./session.js";
import { tmpdir } from "node:os";
import { VERSION } from "./version.js";
import { findFfmpeg } from "./browser/video.js";
import { generateFilmstrip, generateReport, journeySeconds, watermark } from "./log/report.js";
import { generateAggregate, generateDetail, loadSessions, renderVariants } from "./log/aggregate.js";
import { RUNS_ROOT, VARIANT_PATTERN, dirLabel, findSessionDirs, modelSlug, newRunDir, runDirOf, runDirs, seatOf, sessionPath, siteSlug, variantOf, type Seat } from "./runs.js";
import { EXPERTS } from "./experts/index.js";
import type { Assertion, AssertionResult, Brain, ExitReason, Persona, StepEvent } from "./types.js";
import type { MailProvider, Mailbox, MailMessage } from "./mail/types.js";
import { ImapProvider, type ImapConfig } from "./mail/imap.js";
import { extractCodes, extractLinks } from "./mail/types.js";
import { runDoctor, doctorStateExists, recentMailProbe, saveMailProbe, type MailProbe } from "./doctor.js";
import { execa } from "execa";
import { createInterface } from "node:readline/promises";
import { resolveBrainChoice } from "./brain/picker.js";
import {
  PromptCancelled,
  confirmed,
  heading,
  isInteractive,
  multiselect,
  select,
  text,
} from "./ui/prompt.js";
import { arrivalFor, blockedPath, blockedReason, ensureBrief, hasBrief, icpSeed, loadBrief } from "./site/brief.js";
import { ensureMap, loadMap } from "./site/map.js";
import { analyticsPath, loadAnalytics, renderAnalytics } from "./site/analytics.js";
import { htmlToPdf, packetFor, packetHtml } from "./log/pdf.js";
import { getOrder, listOrders, mimeWithAttachment, renderOrders, setOrderStatus } from "./orders.js";
import { collectSightings, replicationTable, topSessions } from "./log/replication.js";
import { draftFlow, loadFlow, scoreFlow, type Flow, type FlowScore } from "./site/flow.js";
import { FLOWS_DIR, loadFlowFile, renderFlowChecks, toFlow, validateFlow, validateFlowDir } from "./site/flow-load.js";

const MAX_RUNS = 10;
/** Stages, in the order they must run. `--stop <stage>` ends after one of these. */
const STAGES = ["site", "map", "personas", "visit", "report", "fix"] as const;
type Stage = (typeof STAGES)[number];
const PROCESS_START = Date.now();

/** Interactive run planner: how many cold/warm/hot, then random order */
async function promptRunPlan(): Promise<string[]> {
  if (!process.stdin.isTTY) {
    console.log("  (non-interactive shell — defaulting to 1 cold run; use --persona or --runs to override)");
    return ["cold"];
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const deadline = Date.now() + 120_000;
  const answer = async (q: string): Promise<string> => {
    // never hang automation: if nobody answers before the deadline, fall back
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "";
    return Promise.race([
      rl.question(q).catch((e) => {
        if ((e as { code?: string }).code === "ABORT_ERR") throw new PromptCancelled();
        throw e;
      }),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), remaining)),
    ]);
  };
  try {
    console.log(`\n  Plan your prospects (max ${MAX_RUNS} total per session):`);
    const ask = async (label: string): Promise<number> => {
      const a = (await answer(`    ${label} runs (0-${MAX_RUNS}): `)).trim();
      const n = parseInt(a || "0", 10);
      return Number.isFinite(n) ? Math.max(0, Math.min(MAX_RUNS, n)) : 0;
    };
    let cold = 0,
      warm = 0,
      hot = 0;
    do {
      cold = await ask("cold");
      warm = await ask("warm");
      hot = await ask("hot");
      if (Date.now() > deadline && cold + warm + hot === 0) {
        console.log("    (no answer — defaulting to 1 cold run)");
        return ["cold"];
      }
      if (cold + warm + hot === 0) console.log("    at least 1 required");
      if (cold + warm + hot > MAX_RUNS) console.log(`    total must be ≤ ${MAX_RUNS}`);
    } while (cold + warm + hot === 0 || cold + warm + hot > MAX_RUNS);

    const queue = [
      ...Array<0>(cold).fill(0).map(() => "cold"),
      ...Array<0>(warm).fill(0).map(() => "warm"),
      ...Array<0>(hot).fill(0).map(() => "hot"),
    ];
    // random order so site sees a natural mix
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    return queue;
  } finally {
    rl.close();
  }
}

/** --runs N: N prospects, persona picked at random each time */
/**
 * `--runs N` draws from the personas built for this site when it has any, and
 * only falls back to cold/warm/hot when it does not. Drawing from the built-ins
 * on a site with its own set would silently ignore the set that was just
 * generated for it.
 */
function randomRunPlan(n: number, url?: string): string[] {
  const site = url ? Object.keys(siteOwnPersonas(url)) : [];
  const pool = site.length ? site : ["cold", "warm", "hot"];
  return Array.from(
    { length: Math.min(n, MAX_RUNS) },
    () => pool[Math.floor(Math.random() * pool.length)],
  );
}

/** Load KEY=VALUE pairs from .env in the cwd (existing env vars win) */
function loadDotEnv() {
  const path = resolve(".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

let warnedMailCompat = false;
function mailEnv(fresh: string, legacy: string): string | undefined {
  const v = process.env[fresh];
  if (v !== undefined) return v;
  const old = process.env[legacy];
  if (old !== undefined) {
    if (!warnedMailCompat) {
      console.warn("CLIENTSIM_* deprecated, use LEAKDOWN_*");
      warnedMailCompat = true;
    }
    return old;
  }
  return undefined;
}

function mailConfig(): ImapConfig | null {
  loadDotEnv();
  const host = mailEnv("LEAKDOWN_IMAP_HOST", "CLIENTSIM_IMAP_HOST");
  const user = mailEnv("LEAKDOWN_IMAP_USER", "CLIENTSIM_IMAP_USER");
  const pass = mailEnv("LEAKDOWN_IMAP_PASS", "CLIENTSIM_IMAP_PASS");
  const domain = mailEnv("LEAKDOWN_MAIL_DOMAIN", "CLIENTSIM_MAIL_DOMAIN");
  if (!host || !user || !pass || !domain) {
    return null;
  }
  const tls = mailEnv("LEAKDOWN_IMAP_TLS", "CLIENTSIM_IMAP_TLS");
  const portRaw = mailEnv("LEAKDOWN_IMAP_PORT", "CLIENTSIM_IMAP_PORT");
  return {
    host,
    user,
    pass,
    domain,
    tls: tls !== "false",
    port: portRaw ? Number(portRaw) : undefined,
  };
}

function setupMail(): { provider: MailProvider } | null {
  const cfg = mailConfig();
  if (!cfg) return null;
  console.log("  mail: IMAP provider configured (ephemeral mailboxes enabled)");
  return { provider: new ImapProvider(cfg) };
}

function printUsage() {
  console.log(`leakdown ${VERSION} — simulated prospects walk your signup and say where they gave up

  Only run it against sites you own or have written permission to test. It creates
  real accounts, triggers real emails and webhooks, and records what it sees.

  leakdown <url> --ladder --yes --headless   the full run, about an hour
  leakdown <url>                             a plain run, one model, menus for the rest
  leakdown <url> --goal "sign up and get an API key" --steps 15 --yes   pass/fail for CI

  Then read runs/<site>/AGGREGATE.md (the one-page report) and REPORT.md beside it.
  leakdown --history shows every run with its one number. Bare "leakdown"
  opens a guided flow.

STAGES, in order:
  site      read the page  -> runs/<site>/SITE.md
  map       crawl 2 clicks -> runs/<site>/MAP.md (pages, booking/payment surfaces)
  personas  build prospects-> runs/<site>/personas/
  visit     send them      -> one session each
  report    the report     -> runs/<site>/<date>/<time>/AGGREGATE.md (copied to runs/<site>/)
  fix       expert panel   -> FIXES.md per session

  --ladder [--wide <spec>]    the full run: haiku visits every persona, the
                              replication filter picks the sessions that agree, sonnet
                              verifies those, opus re-walks the hardest persona and writes
                              its report. --wide "haiku:5,opencode/<model>:5" splits the sweep.
  --stop <stage>              end after that one (default: run them all)
  --flow "<intent>"           the flow to test, e.g. "signup through to the
                              dashboard" — checkpoints are drafted for review,
                              sessions are scored against them (runs/<site>/FLOW.md)
  --flow-file <id|path>       a flow you wrote yourself (flows/<id>.yaml or
                              runs/<site>/flows/): steps scored per session, and a
                              stop_after step ends the run COMPLETED when its text
                              shows. --validate-flow [file] checks flow files, no browser
  --variant <slug>            A/B: label this run ("control", "new-pricing"); run the same
                              personas once per variant, then --compare <site> ranks
                              them — or says "no meaningful difference" when it is
  --plan                      re-read the site and rebuild its personas
  --no-map                    skip the re-crawl that checks whether the site changed
  --force                     regenerate outputs that are already up to date

WHO GOES IN:
  --persona <list>            explicit queue, e.g. cold,warm,hot (max 10)
  --random <n>                n prospects, chosen at random (max 10)
                              omit both and it offers the personas built for this site
  --count <n>                 how many prospects the personas stage builds (2-10, default 10)
  --goal "<text>"             goal test: every queued persona gets this goal, and the
                              process exits 0 only if every session completes it —
                              fits CI ("log in and get an API key")
  --steps <n>                 step cap per session, 1-50 (with --goal; default is
                              each persona's own patience)
  --expect "label=value"      with --goal, repeatable: the page must show the value
                              before a completion counts ("total=$96.00"); the
                              report quotes what it found instead. Exit codes:
                              0 all passed, 1 a session failed, 2 could not run
                              (unreachable URL, brain down — not the site's fault)

HOW IT RUNS:
  --brain <claude|opencode|codex>   which AI CLI plays the client
  --model <name>              pin the model (lists are read live from the CLI)
  --effort <level>            reasoning effort (claude: low..max, codex: low|medium|high)
  --time <minutes>            wall-clock ceiling per session (default 20; waiting
                              on mail and pauses is excluded — slow mail is not
                              the site's fault)
  --headless                  no visible browser window
  --serial | --parallel       queued personas one at a time (default) or all at
                              once — parallel needs a machine that can hold one
                              browser + AI CLI per persona; omit both and it asks
  --mobile                    phone viewport (390x844, touch) instead of desktop
  --yes                       never prompt; take the default for every question
  --version                   print the version (put it in bug reports)

ON ITS OWN — <what> is a site name (its newest run), site/date/time, or a folder:
  --history [site]            every run, one line each: date, one number, seats
  --report [what...]          rebuild the reports for those sessions
  --fix [what...]             expert panel over those sessions -> FIXES.md
  --replication [what...]     element refs cited across sessions: replicated vs single-source
  --orders [--all]            run requests left on the website (new ones, or all)
  --order <id> [--reject "why"]  run one order here: pipeline, PDF, email — or decline it
  --pdf [sites...]            one shareable PDF per site (funnel + all fixes)
  --doctor                    verify the environment
  --list-personas             show every persona, built-in and custom
  --new-persona "Name"        build one by answering a few questions
  --mailtest                  test mailbox create/receive/extract/destroy
  -h, --help                  this

PER SITE, ON DISK:
  runs/<site>/SITE.md         what the page sells, to whom, its walls and tripwires
  runs/<site>/personas/       the prospects built for this product
  runs/<site>/<date>/<time>/  one run: RUN.md, AGGREGATE.md, DETAIL.md, VERIFIED.md, REPORT.md
                              and wide/ verify/ deep/<model>/ for the sessions behind them
  runs/<site>/AGGREGATE.md    a copy of the newest run's report (same for the other four files)

Prior knowledge is rationed by temperature, because that is most of what makes
the three behave differently: cold arrives knowing nothing, warm knows what it
came for, hot already looked up the price and how to sign up.`);
}

interface CommonArgs {
  personas?: string[];
  runs?: number;
  /** undefined until --brain is passed or the picker resolves it */
  brain?: string;
  model?: string;
  effort?: string;
  headless: boolean;
  mobile?: boolean;
  /** wall-clock minutes per session; waiting on mail/`wait` is excluded */
  time?: number;
  /** the flow to test, e.g. "signup through to the dashboard" */
  flow?: string;
  /** an operator-written flow: id from flows/ or a YAML path (skips the AI draft and its review gate) */
  flowFile?: string;
  /** force the site read + persona rebuild on an already-tested site */
  plan?: boolean;
  /** set once the picker has run, so chained stages never ask twice */
  brainResolved?: boolean;
  /** run queued personas concurrently; undefined asks (serial by default) */
  parallel?: boolean;
  /** personas to generate for the site (2-10); undefined asks, default 10 */
  count?: number;
  /** goal test: overrides every queued persona's goal; exit code 1 unless all complete */
  goal?: string;
  /** step cap per session (overrides patience_steps) */
  steps?: number;
  /** goal test: values the page must show before a completion counts (`--expect total=$96.00`) */
  expect?: Assertion[];
  /** never prompt — take the default for every question */
  yes?: boolean;
  /** the ladder's wide sweep: "haiku" or "haiku:5,opencode/muse-spark-1.3-contributor-free:5" */
  wide?: string;
  /** last stage to run; undefined means all three */
  stop?: Stage;
  /** runs/<site>/<date>/<time> for this invocation; minted on the first visit */
  runDir?: string;
  /** which seat the sessions of the next visit fill (wide by default) */
  seat?: Seat;
  /** skip the per-run re-crawl when a map already exists */
  noMap?: boolean;
  /** A/B label: tags every session and the run folder (<time>--<variant>); `--compare <site>` ranks them */
  variant?: string;
}

function parseCommon(argv: string[]): CommonArgs {
  const args: CommonArgs = { headless: false, mobile: false };
  /** Value flags: a trailing `--persona` used to throw a raw TypeError here. */
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`${flag} needs a value. See \`leakdown --help\`.`);
      process.exit(1);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--personas" || a === "--persona")
      args.personas = value(++i, a).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--random" || a === "--runs") args.runs = parseInt(value(++i, a), 10);
    else if (a === "--time") {
      const t = parseInt(value(++i, a), 10);
      if (!Number.isFinite(t) || t < 1 || t > 120) {
        console.error(`--time takes minutes from 1 to 120. Got "${argv[i]}".`);
        process.exit(1);
      }
      args.time = t;
    }
    else if (a === "--flow") args.flow = value(++i, a);
    else if (a === "--flow-file") args.flowFile = value(++i, a);
    else if (a === "--variant") {
      const v = value(++i, a);
      if (!VARIANT_PATTERN.test(v)) {
        console.error(`--variant takes a slug: lowercase letters, digits, dashes, up to 40 characters. Got "${v}".`);
        process.exit(1);
      }
      args.variant = v;
    }
    else if (a === "--wide") args.wide = value(++i, a);
    else if (a === "--goal") {
      const g = value(++i, a).trim();
      if (!g || g.length > 300) {
        console.error(`--goal takes 1 to 300 characters — a paragraph is not a goal.`);
        process.exit(1);
      }
      args.goal = g;
    }
    else if (a === "--expect") {
      const raw = value(++i, a);
      const eq = raw.indexOf("=");
      const label = raw.slice(0, eq).trim();
      const expected = raw.slice(eq + 1).trim();
      if (eq < 1 || !label || !expected || raw.length > 200) {
        console.error(`--expect takes label=value, e.g. --expect "total=$96.00". Got "${raw}".`);
        process.exit(1);
      }
      (args.expect ??= []).push({ label, expected });
    }
    else if (a === "--steps") {
      const n = parseInt(value(++i, a), 10);
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        console.error(`--steps takes 1 to 50. Got "${argv[i]}".`);
        process.exit(1);
      }
      args.steps = n;
    }
    else if (a === "--count") {
      const c = parseInt(value(++i, a), 10);
      if (!Number.isFinite(c) || c < 2 || c > 10) {
        console.error(`--count takes 2 to 10 personas. Got "${argv[i]}".`);
        process.exit(1);
      }
      args.count = c;
    }
    else if (a === "--brain") args.brain = value(++i, a);
    else if (a === "--model") args.model = value(++i, a);
    else if (a === "--effort") args.effort = value(++i, a);
    else if (a === "--stop") {
      const s = value(++i, a);
      if (!(STAGES as readonly string[]).includes(s)) {
        console.error(`--stop takes one of: ${STAGES.join(", ")}. Got "${s}".`);
        process.exit(1);
      }
      args.stop = s as Stage;
    } else if (a === "--parallel") args.parallel = true;
    else if (a === "--serial") args.parallel = false;
    else if (a === "--headless") args.headless = true;
    else if (a === "--mobile") args.mobile = true;
    else if (a === "--plan") args.plan = true;
    else if (a === "--no-map") args.noMap = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
  }
  return args;
}

/** Does this stage run, given --stop? */
function runsThrough(stage: Stage, stop?: Stage): boolean {
  return !stop || STAGES.indexOf(stage) <= STAGES.indexOf(stop);
}

/** A 24-wide ASCII progress bar: `[#########---------------] 3/8 label`. */
function progressBar(done: number, total: number, label = ""): string {
  const w = 24;
  const filled = total > 0 ? Math.round((done / total) * w) : 0;
  return `  [${"#".repeat(filled)}${"-".repeat(w - filled)}] ${done}/${total}${label ? ` ${label}` : ""}`;
}

/** `▸ stage 3/5 · visit` — where we are in the pipeline for this site. */
function stageBanner(stage: Stage, stop?: Stage): void {
  const active = STAGES.filter((s) => runsThrough(s, stop));
  const i = active.indexOf(stage);
  if (i === -1) return;
  console.log(`\n▸ stage ${i + 1}/${active.length} · ${stage}`);
}

/**
 * Make sure `runs/<site>/SITE.md` exists before anyone is sent in.
 *
 * This runs on every visit to a site that has no brief yet — including when
 * --persona was passed. That ordering is the whole point: the brief used to sit
 * behind the interactive planner, so `--persona cold` skipped it and the persona
 * arrived knowing nothing about the product. It then spent its whole patience
 * working out what the site was and the run was filed as a site failure.
 */
async function prepareSite(
  url: string,
  common: CommonArgs,
  brain: Brain & { ask?(prompt: string): Promise<string> },
): Promise<void> {
  // a site already marked blocked is not re-scraped every run; --plan re-checks
  if (common.plan) rmSync(blockedPath(url), { force: true });
  else if (blockedReason(url)) return;

  const fresh = !hasBrief(url);
  if (!fresh && !common.plan) return;

  heading(fresh ? `New site — ${siteSlug(url)}` : `Re-reading ${siteSlug(url)}`);
  process.stdout.write("  \x1b[2mreading the page...\x1b[0m");
  const brief = await ensureBrief(url, brain, { force: common.plan });
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }

  if (!brief) {
    console.log("  (could not read the page — personas will go in cold)\n");
    return;
  }
  // the table rows are the summary worth seeing; the rest is in the file
  for (const line of brief.split("\n")) {
    const row = line.match(/^\| \*\*(.+?)\*\* \| (.+?) \|$/);
    if (row) console.log(`  ${row[1].padEnd(9)} ${row[2]}`);
  }
  console.log(`\n  brief: ${briefPathLabel(url)}\n`);
}

function briefPathLabel(url: string): string {
  return `runs/${siteSlug(url)}/SITE.md`;
}

/**
 * Crawl the site once so the aggregate can say which pages no prospect ever
 * found. No brain involved; `--plan` re-crawls.
 */
async function prepareMap(
  url: string,
  common: CommonArgs,
  brain: Brain & { ask?(prompt: string): Promise<string> },
): Promise<void> {
  // the crawl is free, so every run re-crawls; the brief and personas are only
  // rebuilt when the page list moved and the operator says so
  const before = common.plan ? null : loadMap(url);
  // once per process: the ladder calls visit() four times and the site did not move in between
  if (before && (common.noMap || Date.parse(before.generated) >= PROCESS_START)) return;
  process.stdout.write(`  \x1b[2m${before ? "re-crawling to check for changes" : "crawling the site"}...\x1b[0m`);
  const map = await ensureMap(url, { force: true });
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
  if (!map) return;
  const counts = new Map<string, number>();
  for (const p of map.pages) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  console.log(
    `  ${map.pages.length} pages: ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`,
  );
  for (const p of map.pages.filter((p) => p.kind === "booking" || p.kind === "payment"))
    console.log(`  ${p.kind.padEnd(8)} ${p.url}${p.external ? " (off-site)" : ""} — commit refused by the guard`);
  console.log(`\n  map: runs/${siteSlug(url)}/MAP.md\n`);

  if (before) {
    const was = new Set(before.pages.map((p) => p.url));
    const now = new Set(map.pages.map((p) => p.url));
    const added = [...now].filter((u) => !was.has(u)).length;
    const gone = [...was].filter((u) => !now.has(u)).length;
    if (!added && !gone) return;
    console.log(`  the map changed since ${before.generated.slice(0, 10)}: +${added} page(s), -${gone}`);
    const rebuild =
      !common.yes && isInteractive()
        ? await select({
            message: "The site changed. Rebuild the brief and personas from scratch?",
            choices: [
              { label: "keep the existing brief and personas", value: false },
              { label: "rebuild both from scratch", value: true, hint: "two model calls" },
            ],
          })
        : false;
    if (!rebuild) return void console.log(`  keeping the brief and personas (pass --plan to rebuild)\n`);
    common.plan = true;
    await prepareSite(url, common, brain);
  }
}

/**
 * Resolve the flow under test, with a review gate: the AI drafts checkpoints
 * from the brief, but the operator confirms them before anyone runs — a wrong
 * flow silently poisons persona generation and every score after it.
 */
async function prepareFlow(
  url: string,
  common: CommonArgs,
  brain: Brain & { ask?(prompt: string): Promise<string> },
): Promise<Flow | null> {
  // an operator-written flow needs no draft and no review — they wrote it
  if (common.flowFile) {
    const check = loadFlowFile(common.flowFile, url);
    if (!check.ok) {
      console.error(`  --flow-file: ${check.file} — ${check.error}`);
      process.exit(1);
    }
    const flow = toFlow(check.flow);
    console.log(`\n  flow: ${check.file} (${flow.checkpoints.length} steps${flow.stop ? `, stops after "${flow.stop.label}"` : ""})\n`);
    return flow;
  }
  const existing = loadFlow(url);
  if (existing && !common.plan) return existing;

  let intent = common.flow;
  if (!intent && !common.yes && isInteractive()) {
    intent = (
      await text({
        message: "What flow should they test? (e.g. \"signup through to the dashboard\" — Enter to let prospects wander):",
        fallback: "",
      })
    ).trim();
  }
  if (!intent) return existing; // no flow stated — wander, as before

  process.stdout.write("  \x1b[2mdrafting checkpoints...\x1b[0m");
  let flow = await draftFlow(url, intent, loadBrief(url) ?? "(no brief)", brain);
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
  if (!flow) {
    console.log("  (could not draft checkpoints — running without a flow)\n");
    return null;
  }

  // review gate — skipped by --yes and in automation
  while (!common.yes && isInteractive()) {
    console.log(`\n  Flow: ${flow.intent}`);
    flow.checkpoints.forEach((c, i) => console.log(`    ${i + 1}. ${c}`));
    const choice = await select({
      message: "Use these checkpoints?",
      choices: [
        { value: "use", label: "use these" },
        { value: "redo", label: "regenerate" },
        { value: "edit", label: "edit the file, then continue", hint: flowPathLabel(url) },
        { value: "none", label: "no flow — let them wander" },
      ],
    });
    if (choice === "use") break;
    if (choice === "none") return null;
    if (choice === "edit") {
      await text({ message: `Edit ${flowPathLabel(url)}, then press Enter:`, fallback: "" });
      flow = loadFlow(url) ?? flow;
      break;
    }
    const redone = await draftFlow(url, intent, loadBrief(url) ?? "(no brief)", brain);
    if (redone) flow = redone;
    else console.log("  (regeneration failed — keeping the previous draft)");
  }

  console.log(`\n  flow: ${flowPathLabel(url)} (${flow.checkpoints.length} checkpoints)\n`);
  return flow;
}

function flowPathLabel(url: string): string {
  return `runs/${siteSlug(url)}/FLOW.md`;
}

/**
 * Make sure this site has its own persona set, generating one if it has none.
 * Returns the ids that were generated, or an empty array.
 */
async function prepareSitePersonas(
  url: string,
  common: CommonArgs,
  brain: Brain & { ask?(prompt: string): Promise<string> },
  flow?: Flow | null,
): Promise<{ id: string; name: string; temperature: string }[]> {
  const outDir = sitePersonasDir(url);
  // only this site's own set — a global personas/ directory is not evidence
  // that this product has been thought about
  const existing = Object.entries(siteOwnPersonas(url)).map(([id, p]) => ({
    id,
    name: p.name,
    temperature: p.temperature,
  }));

  if (existing.length > 0 && !common.plan) return existing;

  let count = common.count ?? 10;
  if (common.count === undefined && !common.yes && isInteractive()) {
    const answer = await text({
      message: "How many personas should I build for this site? (2-10, Enter for 10, 0 to skip):",
      fallback: "10",
      validate: (v) =>
        /^\d+$/.test(v) && (+v === 0 || (+v >= 2 && +v <= 10))
          ? undefined
          : "give 0 to skip, or a number from 2 to 10",
    });
    count = Number(answer);
    if (count === 0) return existing;
  }

  // the owner's numbers, when they left any — five lines from a dashboard
  let analyticsContext: string | undefined;
  try {
    const a = loadAnalytics(url);
    if (a) {
      analyticsContext = renderAnalytics(a);
      console.log(`  analytics: calibrating to ${analyticsPath(url)} (${a.exitPages.length} exit pages)`);
    }
  } catch (e) {
    console.error(`  ${(e as Error).message}`);
    process.exit(1);
  }

  try {
    const result = await generatePersonas({
      description: icpSeed(url) ?? undefined,
      count,
      brain,
      site: url,
      analyticsContext,
      // the brief instead of a second scrape: it is both cheaper and better
      // context than a raw accessibility dump of the same page
      siteContext: loadBrief(url) ?? undefined,
      flowContext: flow
        ? `${flow.intent}\nCheckpoints: ${flow.checkpoints.join(" -> ")}`
        : undefined,
      outDir,
    });
    console.log(result.graph);
    return result.written.map((p) => ({ id: p.id, name: p.name, temperature: p.temperature }));
  } catch (e) {
    console.error(`  persona generation failed: ${(e as Error).message.slice(0, 160)}`);
    console.log("  falling back to the built-in personas.\n");
    return existing;
  }
}

/**
 * Resolve the run queue.
 *
 * Explicit flags win, as they always did. What changed is what happens with no
 * flags: the site's own generated personas are offered first, and the built-in
 * cold/warm/hot counts are the fallback rather than the default.
 */
async function resolveRunPlan(
  url: string,
  common: CommonArgs,
  generated: { id: string; name: string; temperature: string }[],
): Promise<string[]> {
  if (common.personas?.length) return common.personas.slice(0, MAX_RUNS);
  if (common.runs && common.runs > 0) return randomRunPlan(common.runs, url);

  if (common.yes || !isInteractive()) {
    // unattended: everything built for this site, else one of each built-in
    return generated.length ? generated.slice(0, MAX_RUNS).map((p) => p.id) : ["cold", "warm", "hot"];
  }

  if (generated.length > 0) {
    const queue = await multiselect({
      message: "Which prospects should visit? (one run each)",
      choices: generated.map((p) => ({
        value: p.id,
        label: p.id,
        hint: `${p.name} — ${p.temperature}`,
      })),
    });
    if (queue.length) return queue.slice(0, MAX_RUNS);
    console.log("  none picked — falling back to the built-ins.\n");
  }
  return promptRunPlan();
}

/**
 * Resolve the brain for a stage, prompting for whatever the flags left open.
 * Mutates `common` so chained stages (all -> fix) reuse the same answers
 * instead of asking again.
 */
async function resolveBrain(common: CommonArgs, purpose?: string) {
  try {
    if (!common.brainResolved) {
      const choice = await resolveBrainChoice(
        { brain: common.brain, model: common.model, effort: common.effort },
        purpose,
      );
      common.brain = choice.brain;
      common.model = choice.model;
      common.effort = choice.effort;
      common.brainResolved = true;
    }
    return getBrain(common.brain ?? "claude", { model: common.model, effort: common.effort });
  } catch (e) {
    if (e instanceof PromptCancelled) throw e;
    console.error((e as Error).message);
    process.exit(1);
  }
}

/** Human-readable summary of the resolved brain config, for run banners. */
function describeRun(common: CommonArgs): string {
  const parts = [`brain: ${common.brain ?? "claude"}`];
  if (common.model) parts.push(`model: ${common.model}`);
  if (common.effort) parts.push(`effort: ${common.effort}`);
  return parts.join(" | ");
}

/** STAGE 1 — spawn persona visits. Returns created session dirs. */
async function visit(url: string, common: CommonArgs): Promise<string[]> {
  const planningBrain = await resolveBrain(common, "Which AI plays the client?");

  // first-run initialization check (skipped silently once verified)
  if (!doctorStateExists()) {
    const ok = await runDoctor(common.brain);
    if (!ok) process.exit(1);
  }
  // the one check the weekly cache cannot vouch for: a playwright upgrade wants a
  // new Chromium build, and the cache said "launches OK" while none was installed
  try {
    const { chromium } = await import("playwright");
    await (await chromium.launch({ headless: true })).close();
  } catch (e) {
    console.error(`\n  Chromium will not start: ${(e as Error).message.split("\n")[0].slice(0, 120)}\n  Run: npx playwright install chromium\n`);
    process.exit(1);
  }

  // the brief comes first, and comes even when --persona was passed: it is the
  // ICP the persona set is built from, and the prior knowledge warm/hot arrive with
  stageBanner("site", common.stop);
  await prepareSite(url, common, planningBrain);
  const blocked = blockedReason(url);
  if (blocked) {
    console.log(
      `  ⛔ ${siteSlug(url)} is behind a bot wall (${blocked}) — skipping. Delete runs/${siteSlug(url)}/BLOCKED.md or pass --plan to re-check.\n`,
    );
    return [];
  }
  if (!runsThrough("map", common.stop)) {
    console.log(`  Stopped after the site read. See ${briefPathLabel(url)}\n`);
    return [];
  }
  stageBanner("map", common.stop);
  await prepareMap(url, common, planningBrain);
  if (!runsThrough("personas", common.stop)) {
    console.log(`  Stopped after the map. See runs/${siteSlug(url)}/MAP.md\n`);
    return [];
  }
  const flow = await prepareFlow(url, common, planningBrain);

  stageBanner("personas", common.stop);
  const generated = common.personas?.length
    ? []
    : await prepareSitePersonas(url, common, planningBrain, flow);
  if (!runsThrough("visit", common.stop)) {
    console.log(`  Stopped after building personas. See runs/${siteSlug(url)}/personas/\n`);
    return [];
  }

  const personaIds = await resolveRunPlan(url, common, generated);
  const registry = getPersonaRegistry(url);
  for (const pid of personaIds) {
    if (!registry.personas[pid]) {
      console.error(
        `Unknown persona "${pid}". Available: ${Object.keys(registry.personas).join(", ")} (or add YAML files in personas/)`,
      );
      process.exit(1);
    }
  }

  const dirs: string[] = [];
  const mailCfg = mailConfig();
  // only a run that mints mailboxes needs the mailbox checked
  const mailProbe = mailCfg ? await ensureMailProbe() : null;
  let inboundSeen = false;
  if (!mailCfg) {
    // with a mailbox the harness forces every typed address to the ephemeral
    // one; without it, whatever the brain invents is what real signup forms get
    console.warn(
      `\n  ⚠ no mailbox configured — personas will invent email addresses and may sign real\n` +
        `    inboxes up to ${siteSlug(url)}. Set LEAKDOWN_IMAP_* (see README) to give each run a\n` +
        `    throwaway address the harness enforces, and to let personas read verification mail.`,
    );
  }

  // Serial by default — a browser + AI CLI per persona is heavy enough that
  // running the queue concurrently makes laptops unresponsive. --parallel
  // opts back in for machines that can take it. Each session gets its own
  // browser, brain, mailbox and directory either way; sharing any of those
  // across personas is the bug 646556a fixed.
  const tagged = personaIds.length > 1;
  stageBanner("visit", common.stop);
  const parallel =
    tagged &&
    (common.parallel ??
      (common.yes
        ? false
        : await select({
            message: `How should the ${personaIds.length} sessions run?`,
            choices: [
              { label: "one at a time", value: false, hint: "gentle on the machine" },
              { label: "all at once", value: true, hint: `${personaIds.length} browsers + brains — needs a strong machine` },
            ],
          })));
  console.log(
    `  ${personaIds.length} prospect(s) ${parallel ? "going in together" : "queued, one at a time"}: ${personaIds.join(", ")} | ${describeRun(common)}`,
  );
  console.log(progressBar(0, personaIds.length, "agents finished") + "\n");

  // dirs are minted before anyone launches: sessionPath's same-second suffix
  // check is exists-then-create, which two concurrent starts would race
  common.runDir ??= newRunDir(url, new Date(), RUNS_ROOT, common.variant);
  const runs = personaIds.map((pid, i) => {
    const sessionDir = sessionPath(common.runDir!, common.seat ?? "wide", common.model ?? common.brain, pid);
    mkdirSync(`${sessionDir}/shots`, { recursive: true });
    return { pid, sessionDir, n: i + 1 };
  });

  let done = 0;
  const exits: ExitReason["kind"][] = [];
  // a brain that fails before the first step is down (usage limit, auth, outage),
  // and the next persona will not fare better — eight sessions once burned through
  // a 30-minute limit in minutes, each filed as its own failure
  let brainDown = false;
  const runOne = async ({ pid, sessionDir, n }: (typeof runs)[number]) => {
    if (brainDown) {
      console.log(`  ${tagged ? `[${pid}] ` : ""}skipped — the brain is not answering; rerun this persona later`);
      rmSync(sessionDir, { recursive: true, force: true });
      return;
    }
    const tag = tagged ? pid : undefined;

    // one provider per agent — an IMAP connection is stateful, and concurrent
    // polls through a shared one interleave on a single socket
    const mail = mailCfg ? new ImapProvider(mailCfg) : undefined;
    let box: Mailbox | undefined;

    // session state lives at runOne scope so finally can write the report
    // AFTER the video finalizes — the Evidence section names files that only
    // exist once saveVideo() has run
    const base: Persona = registry.personas[pid];
    // A goal test asks "did it work", not "how did it feel" — same persona,
    // its goal swapped for the asserted one. verifyGoal already judges
    // persona.goal, so completion IS the pass condition.
    // a 7-checkpoint flow (signup, email, workspace, survey…) is not doable in a hot
    // persona's 10 steps; both hot personas ran out today while doing the right thing
    const forFlow = flow ? Math.min(50, flow.checkpoints.length * 2 + 2) : 0;
    const expectLine = common.expect?.length
      ? ` You expect to see: ${common.expect.map((a) => `${a.label} = ${a.expected}`).join(", ")}.`
      : "";
    const persona: Persona = common.goal
      ? { ...base, goal: common.goal + expectLine, patience_steps: common.steps ?? base.patience_steps }
      : { ...base, patience_steps: Math.max(base.patience_steps, forFlow) };
    let events: StepEvent[] = [];
    let exit: ExitReason | undefined;
    let flowScore: FlowScore | null = null;
    let asserted: AssertionResult[] | undefined;

    // fresh brain per persona — a shared one would carry the previous
    // persona's whole conversation into this one's first impression
    const brain = getBrain(common.brain ?? "claude", {
      model: common.model,
      effort: common.effort,
      allowDir: sessionDir, // so the persona can read its own screenshots
    });

    const driver = new BrowserDriver();
    try {
      // EPHEMERAL MAILBOX: created per persona run, destroyed after
      if (mail) box = await mail.create(pid);
      await driver.launch({
        headless: common.headless,
        shotsDir: `${sessionDir}/shots`,
        mobile: common.mobile,
        videoDir: `${sessionDir}/.video`,
      });
      // events, exit and flowScore live at runOne scope (declared above) so
      // finally can write the report after the video finalizes
      try {
        ({ events, exit, assertions: asserted } = await runSession({
          url,
          persona,
          brain,
          driver,
          sessionDir,
          mail: mail && box ? { provider: mail, box } : undefined,
          // cold gets nothing, warm the arrival paragraph, hot also the specifics
          arrival: arrivalFor(url, persona.temperature) ?? undefined,
          timeBudgetMinutes: common.time,
          tag,
          assertions: common.expect,
          stopWhen: flow?.stop,
        }));
      } catch (e) {
        // goto timeout, dead preview, driver crash — our side, not the site's
        const detail = (e as Error).message.split("\n")[0];
        console.log(`\n  ${tag ? `[${tag}] ` : ""}session could not run: ${detail}`);
        exit = { kind: "couldnotrun", detail: `Session could not run: ${detail}` };
      }

      // one un-retried call per session: which flow checkpoints did it reach?
      flowScore = flow && events.length > 0 ? await scoreFlow(flow, events, brain) : null;
      // the stop point is mechanical evidence — it outranks the scorer's reading of the trail
      if (flowScore && flow?.stop && exit.kind === "completed" && exit.summary.startsWith("Reached the flow's stop point"))
        flowScore[flow.stop.index] = { ...flowScore[flow.stop.index], reached: true, note: `page showed "${flow.stop.text}"` };
      if (flowScore) {
        console.log(
          `  ${tag ? `[${tag}] ` : ""}flow: ${flowScore.filter((c) => c.reached).length}/${flowScore.length} checkpoints reached`,
        );
      }

      if (mail?.lastInboundAt) inboundSeen = true;
      if (exit.kind === "couldnotrun" && events.length === 0 && /Brain .* failed at step 1/.test(exit.detail)) {
        brainDown = true;
        const reply = exit.detail.match(/last reply: "(.{0,160})/)?.[1];
        console.log(`\n  ⛔ the brain is not answering${reply ? ` — it said: "${reply}…"` : ""}.\n  A subscription usage limit looks exactly like this; wait for it to reset and rerun the same command.\n`);
      }
    } catch (e) {
      // a setup failure (mailbox, browser launch) must not kill the other runs,
      // and it is our side — filed as could-not-run so CI can tell it apart
      const detail = (e as Error).message.split("\n")[0];
      console.error(`  ${tag ? `[${tag}] ` : ""}run failed before the session started: ${detail}`);
      exit = { kind: "couldnotrun", detail: `Setup failed before the session started: ${detail}` };
    } finally {
      // video first: the report's Evidence section names files that only
      // exist once saveVideo() has run. Report + filmstrip are written here
      // (not above) so mid-session errors still yield both.
      const video = await driver.saveVideo(`${sessionDir}/video.webm`).catch(() => null);
      if (exit) {
        writeFileSync(
          `${sessionDir}/meta.json`,
          JSON.stringify(
            {
              url,
              personaId: pid,
              brain: brain.name,
              version: VERSION,
              model: common.model ?? null,
              effort: common.effort ?? null,
              exit,
              viewport: common.mobile ? "mobile" : "desktop",
              flow: flowScore,
              ...(common.variant ? { variant: common.variant } : {}),
              assertions: asserted ?? null,
              mailProbe,
              // claude reports tokens/cost; opencode does not, so the eval also
              // has steps + wall-clock as a model-agnostic efficiency proxy
              usage: (brain as { usage?: unknown }).usage ?? null,
              steps: events.length,
              durationSeconds: journeySeconds(events),
            },
            null,
            2,
          ),
        );
        dirs.push(sessionDir);
        exits.push(exit.kind);
        printPerCallUsage((brain as { usage?: unknown }).usage);
        printSessionSummary(exit, events, sessionDir, ++done, personaIds.length);
        if (events.length > 0) {
          writeFileSync(`${sessionDir}/filmstrip.html`, generateFilmstrip({ persona, url, events }));
        }
        writeFileSync(
          `${sessionDir}/report.md`,
          generateReport({
            persona,
            url,
            brain: describeRun(common).replace(/^brain: /, ""),
            events,
            exit,
            flow: flowScore ?? undefined,
            assertions: asserted,
            media: {
              filmstrip: events.length > 0 ? "filmstrip.html" : null,
              videoMp4: video?.mp4 ? "video.mp4" : null,
              videoWebm: video?.webm ? "video.webm" : null,
            },
          }),
        );
        if (video?.mp4) console.log(`  ${tag ? `[${tag}] ` : ""}▶ video.mp4 (plays everywhere)`);
      }
      await driver.close();
      if (mail && box) {
        try {
          await mail.destroy(box);
          await mail.close?.();
          console.log(`  ${tag ? `[${tag}] ` : ""}🗑 mailbox destroyed`);
        } catch (e) {
          console.log(`  ${tag ? `[${tag}] ` : ""}🗑 mailbox destroy failed: ${(e as Error).message.slice(0, 100)}`);
        }
      }
    }
  };

  if (parallel) await Promise.all(runs.map(runOne));
  else for (const r of runs) await runOne(r);

  // two prospects blaming email in one run is the pattern that once produced
  // seven false findings. A self-sent probe cannot settle it (Gmail shows us our
  // own Sent copy), so the test is: did ANY session in this run receive mail
  // from someone else? If none did, the mailbox is suspect, not the site.
  const blamedEmail = emailAbandons(dirs);
  if (mailCfg && blamedEmail.length >= 2 && !inboundSeen) {
    const marker = `runs/${siteSlug(url)}/MAIL-WARNING.md`;
    writeFileSync(
      marker,
      `# Email verdicts unverified\n\nIn this run ${blamedEmail.length} session(s) said the email never came, and no session received any mail from another sender. That can be the site, or our mailbox. Confirm the forwarder by sending a message to a persona address from a different account, then delete this file.\n\n${blamedEmail.map((d) => `- ${d}`).join("\n")}\n`,
    );
    console.log(`  ⚠ ${blamedEmail.length} prospects gave up over email and nothing inbound arrived — wrote ${marker}; the report will carry the warning`);
  }
  if (common.goal) {
    const code = goalExitCode(exits, personaIds.length);
    const passes = exits.filter((k) => k === "completed").length;
    const blocked = exits.filter((k) => k === "couldnotrun").length;
    console.log(
      `\n  goal ${code === 0 ? "PASS" : code === 1 ? "FAIL" : "COULD NOT RUN"}: ${passes}/${personaIds.length} session(s) completed "${common.goal}"${blocked ? ` — ${blocked} could not run (our side, not the site's)` : ""}`,
    );
    if (code) process.exitCode = code;
  }
  return dirs;
}

/**
 * Per-call cache behaviour, printed when the CLI reported usage. This is the
 * measurement PIVOT's step 1 asks for: writes high on EVERY call means the
 * prompt prefix keeps breaking (fix prompt.ts); writes tracking each new page
 * snapshot means the growth is legitimate (fix prune.ts). Raw tokens only —
 * subscription and API runs spend the same tokens at different prices, so
 * pricing stays downstream.
 */
function printPerCallUsage(usage: unknown): void {
  const u = usage as {
    reported?: boolean;
    perCall?: { n: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; ms: number }[];
  } | null;
  if (!u?.reported || !u.perCall?.length) return;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  console.log("\n  call  cacheW   cacheR    in    out     ms");
  for (const c of u.perCall) {
    console.log(
      `  ${String(c.n).padStart(4)}  ${k(c.cacheCreateTokens).padStart(6)}  ${k(c.cacheReadTokens).padStart(7)}  ${k(c.inputTokens).padStart(4)}  ${k(c.outputTokens).padStart(5)}  ${String(c.ms).padStart(5)}`,
    );
  }
  const sum = (f: (c: { cacheCreateTokens: number; cacheReadTokens: number; inputTokens: number; outputTokens: number }) => number) =>
    u.perCall!.reduce((a, c) => a + f(c), 0);
  console.log(
    `   sum  ${k(sum((c) => c.cacheCreateTokens)).padStart(6)}  ${k(sum((c) => c.cacheReadTokens)).padStart(7)}  ${k(sum((c) => c.inputTokens)).padStart(4)}  ${k(sum((c) => c.outputTokens)).padStart(5)}`,
  );
}

function printSessionSummary(
  exit: ExitReason,
  events: StepEvent[],
  sessionDir: string,
  n: number,
  total: number,
) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  [${n}/${total}] ${exit.kind.toUpperCase()}`);
  if (exit.kind === "abandoned") {
    const last = events[events.length - 1];
    console.log(`  Where: step ${last?.n} on ${last?.url}`);
    console.log(`  Why: "${exit.reason}"`);
    console.log(`  Wanted answered: "${exit.question}"`);
  }
  if (exit.kind === "completed") console.log(`  ${exit.summary}`);
  if (exit.kind === "guardrail") console.log(`  ${exit.detail}`);
  if (exit.kind === "couldnotrun") console.log(`  ${exit.detail} (our side — says nothing about the site)`);
  console.log(`  Session: ${sessionDir}`);
  // running tally — with concurrent agents this is the one honest progress line
  console.log(progressBar(n, total, "agents finished"));
}

/**
 * What a person may type where sessions are expected: a session folder, a run
 * folder, a site folder, a site name ("site-b.ai" = its newest run), or
 * "site/date/time" for one run.
 */
function resolveTargets(args: string[]): string[] {
  return args.flatMap((a) => {
    if (existsSync(`${a}/meta.json`)) return [a];
    if (existsSync(a)) return findSessionDirs(a);
    const [head, ...rest] = a.split("/");
    const site = siteSlug(head);
    if (rest.length) return findSessionDirs(`${RUNS_ROOT}/${site}/${rest.join("/")}`);
    const latest = runDirs(site).at(-1);
    return latest ? findSessionDirs(latest) : findSessionDirs(`${RUNS_ROOT}/${site}`);
  });
}

/**
 * --compare <site>: the newest run of every variant, side by side. Runs are
 * folders, so two `--variant` invocations never share an aggregate — this is
 * where they meet. Writes runs/<site>/COMPARE.md and prints it.
 */
function compare(site: string): void {
  const newest = new Map<string, string>();
  for (const run of runDirs(site)) {
    const v = variantOf(run);
    if (v) newest.set(v, run); // runDirs is oldest first, so the last wins
  }
  if (newest.size < 2) {
    console.error(`\n  ${site} has ${newest.size} variant run(s); --compare needs two. Run \`leakdown <url> --variant a\` and \`--variant b\` first.\n`);
    process.exit(1);
  }
  const dirs = [...newest.values()].flatMap((run) => findSessionDirs(run));
  const sessions = loadSessions(dirs);
  const body = renderVariants(sessions);
  const md = [`# ${site} — variants compared`, "", `Newest run per variant: ${[...newest.entries()].map(([v, r]) => `\`${v}\` → ${dirLabel(r)}`).join("; ")}.`, "", ...body, watermark(site)].join("\n");
  writeFileSync(`${RUNS_ROOT}/${site}/COMPARE.md`, md);
  console.log("\n" + md.replace(/^## Variants compared.*$/m, "").trim() + `\n\n  Written: runs/${site}/COMPARE.md\n`);
}

/**
 * runs/<site>/VERDICTS.md: one line per wall for the owner to mark `real:` or
 * `false:`. Written once, never overwritten — the aggregate reads the ticks back.
 */
function writeVerdictsStub(site: string, aggregatePath: string): void {
  const path = `${RUNS_ROOT}/${site}/VERDICTS.md`;
  if (existsSync(path)) return;
  const walls = [...readFileSync(aggregatePath, "utf8").matchAll(/^### \d+\. (.+)$/gm)].map((m) => m[1].replace(/`/g, ""));
  if (!walls.length) return;
  writeFileSync(
    path,
    `# ${site} — your verdicts\n\nChange each \`?:\` to \`real:\` (you checked, it is a real problem) or \`false:\` (not a problem). The next report counts them.\n\n${walls.map((w) => `?: ${w}`).join("\n")}\n`,
  );
}

/** "2 of 26 completed their goal." from a run's AGGREGATE.md, or null. */
function oneNumber(run: string): string | null {
  try {
    return readFileSync(`${run}/AGGREGATE.md`, "utf8").match(/\*\*(\d+ of \d+ completed[^*]*)\*\*/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** "wide haiku×20 muse×5 · deep opus×1" from a run's folders. */
function seatsOf(run: string): string {
  const parts: string[] = [];
  for (const seat of ["wide", "verify", "deep"] as const) {
    if (!existsSync(`${run}/${seat}`)) continue;
    const models = readdirSync(`${run}/${seat}`, { withFileTypes: true }).filter((e) => e.isDirectory())
      .map((m) => `${m.name.replace(/^opencode-/, "").split("-")[0]}×${readdirSync(`${run}/${seat}/${m.name}`, { withFileTypes: true }).filter((e) => e.isDirectory()).length}`);
    parts.push(`${seat} ${models.join(" ")}`);
  }
  return parts.join(" · ");
}

/** --history [site]: one line per run, newest last. */
function history(site?: string): void {
  const sites = site ? [siteSlug(site)] : (existsSync(RUNS_ROOT) ? readdirSync(RUNS_ROOT) : []).filter((x) => runDirs(x).length);
  if (!sites.length) return void console.log("\n  No runs yet.\n");
  for (const x of sites) {
    const runs = runDirs(x);
    console.log(`\n  ${x}${runs.length ? "" : " — no runs in the current layout"}`);
    for (const run of runs) {
      const [, date, time] = dirLabel(run).split("/");
      console.log(`    ${date} ${time}  ${(oneNumber(run) ?? "no report yet").padEnd(34)} ${seatsOf(run)}${existsSync(`${run}/REPORT.md`) ? "  REPORT.md" : ""}`);
    }
  }
  console.log(`\n  Open: runs/<site>/<date>/<time>/AGGREGATE.md — or leakdown --fix <site> for the newest run.\n`);
}

/** The result a person came for, in the terminal: the one number and the first wall. */
function printOutcome(run: string | undefined): void {
  if (!run || !existsSync(`${run}/AGGREGATE.md`)) return;
  const md = readFileSync(`${run}/AGGREGATE.md`, "utf8");
  const one = md.match(/## The one number\n\n(.+)/)?.[1];
  const wall = md.match(/### 1\. (.+)/)?.[1];
  const words = md.match(/\*\*In their words:\*\* (.+)/)?.[1];
  console.log("");
  if (one) console.log(`  ${one.replace(/\*\*/g, "")}`);
  if (wall) console.log(`  Fix first: ${wall.replace(/`/g, "")}`);
  if (words) console.log(`  ${words.length > 180 ? words.slice(0, 180) + "…" : words}`);
  console.log(`\n  Full report: ${run}/AGGREGATE.md${existsSync(`${run}/REPORT.md`) ? `, then REPORT.md beside it` : ""}\n`);
}

/** <run>/<seat>/<model>/<leaf>/FIXES.md for every session in a seat, bundled into one file. */
function bundleSeat(run: string, seat: Seat, file: string, title: string): void {
  const parts: string[] = [];
  for (const d of findSessionDirs(`${run}/${seat}`).concat(fixesOnlyDirs(`${run}/${seat}`)))
    if (existsSync(`${d}/FIXES.md`)) parts.push(`<!-- ${dirLabel(d)} -->\n${readFileSync(`${d}/FIXES.md`, "utf8")}`);
  if (parts.length) writeFileSync(`${run}/${file}`, `# ${basename(resolve(run, "../.."))} — ${title}\n\n${parts.join("\n\n---\n\n")}`);
  else rmSync(`${run}/${file}`, { force: true });
}

/** verify/<model>/<leaf>/ holds a FIXES.md and no meta.json, so findSessionDirs skips it. */
function fixesOnlyDirs(seatDir: string): string[] {
  if (!existsSync(seatDir)) return [];
  const out: string[] = [];
  for (const model of readdirSync(seatDir, { withFileTypes: true }).filter((e) => e.isDirectory()))
    for (const leaf of readdirSync(`${seatDir}/${model.name}`, { withFileTypes: true }).filter((e) => e.isDirectory()))
      if (!existsSync(`${seatDir}/${model.name}/${leaf.name}/meta.json`)) out.push(resolve(`${seatDir}/${model.name}/${leaf.name}`));
  return out;
}

/** RUN.md: which model sat in which seat, how the sessions ended, tokens spent. Derived, no bookkeeping. */
function runSummary(run: string, dirs: string[]): string {
  const sessions = loadSessions(dirs);
  const site = basename(resolve(run, "../.."));
  const rows = new Map<string, { n: number; completed: number; abandoned: number; guardrail: number; couldnotrun: number; tokens: number; seconds: number }>();
  for (const s of sessions) {
    const key = `${seatOf(s.dir) ?? "wide"} | ${modelOf(s.dir) ?? s.meta.brain ?? "default"}`;
    const r = rows.get(key) ?? { n: 0, completed: 0, abandoned: 0, guardrail: 0, couldnotrun: 0, tokens: 0, seconds: 0 };
    r.n++;
    r[s.meta.exit.kind]++;
    // the zod meta drops unknown keys, so read usage and duration off the file itself
    const raw = JSON.parse(readFileSync(`${s.dir}/meta.json`, "utf8")) as { usage?: Record<string, number>; durationSeconds?: number };
    const u = raw.usage ?? {};
    r.tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheCreateTokens ?? 0);
    r.seconds += raw.durationSeconds ?? 0;
    rows.set(key, r);
  }
  const verifiers = fixesOnlyDirs(`${run}/verify`);
  const L = [
    `# ${site} — run ${dirLabel(run).split("/").slice(1).join(" ")}`,
    "",
    "| seat | model | sessions | completed | walked out | out of patience or harness | could not run | tokens | minutes |",
    "|---|---|---|---|---|---|---|---|---|",
    ...[...rows.entries()].sort().map(([k, r]) => `| ${k} | ${r.n} | ${r.completed} | ${r.abandoned} | ${r.guardrail} | ${r.couldnotrun} | ${r.tokens ? r.tokens.toLocaleString("en-US") : "—"} | ${Math.round(r.seconds / 60)} |`),
  ];
  if (verifiers.length) L.push("", `Verifier: ${[...new Set(verifiers.map((d) => basename(resolve(d, ".."))))].join(", ")} reviewed ${verifiers.length} session(s) → VERIFIED.md`);
  const files = ["AGGREGATE.md", "DETAIL.md", "VERIFIED.md", "REPORT.md"].filter((f) => existsSync(`${run}/${f}`));
  L.push("", `Files: ${files.join(", ")}. Read AGGREGATE.md first; REPORT.md is what the writer seat produced.`, "");
  return L.join("\n");
}

/** The site level mirrors the newest run's files, so runs/<site>/AGGREGATE.md is always the latest. */
function mirrorLatest(site: string): void {
  const latest = runDirs(site).at(-1);
  if (!latest) return;
  for (const f of ["RUN.md", "AGGREGATE.md", "DETAIL.md", "VERIFIED.md", "REPORT.md"]) {
    if (existsSync(`${latest}/${f}`)) copyFileSync(`${latest}/${f}`, `${RUNS_ROOT}/${site}/${f}`);
    else rmSync(`${RUNS_ROOT}/${site}/${f}`, { force: true });
  }
}

/**
 * STAGE 2 — aggregate per run. A funnel that mixed several websites together
 * would be meaningless, so each run gets its own AGGREGATE.md, each seat/model
 * inside it gets one too, and the site level mirrors the newest run.
 */
async function report(dirs: string[] | undefined, force = false) {
  const targets = dirs?.length ? dirs : findSessionDirs();
  if (targets.length === 0) {
    console.error(
      "Nothing to report on. Stage 2 needs stage 1 output — run `leakdown visit <url>` first.",
    );
    process.exit(1);
  }

  // group by the run each session sits in; a foreign layout groups under its site folder
  const byRun = new Map<string, string[]>();
  for (const s of loadSessions(targets)) {
    const run = runDirOf(s.dir) ?? resolve(`${RUNS_ROOT}/${siteSlug(s.meta.url)}`);
    byRun.set(run, [...(byRun.get(run) ?? []), s.dir]);
  }
  if (byRun.size === 0) {
    console.error("No readable sessions (missing meta.json or session.jsonl).");
    process.exit(1);
  }

  const sites = new Set<string>();
  let written = 0;
  for (const [run, runDirsHere] of byRun) {
    const site = basename(runDirOf(runDirsHere[0]) ? resolve(run, "../..") : run);
    sites.add(site);
    const manifestPath = `${run}/.aggregate-manifest.json`;
    if (!force && existsSync(manifestPath) && existsSync(`${run}/AGGREGATE.md`)) {
      try {
        const prev = JSON.parse(readFileSync(manifestPath, "utf8")) as { dirs: string[] };
        if (prev.dirs.length === runDirsHere.length && prev.dirs.every((d, i) => resolve(d) === resolve(runDirsHere[i]))) {
          console.log(`  ${dirLabel(run)}: up to date (${runDirsHere.length} sessions) — --force to regenerate`);
          continue;
        }
        console.log(`  ${dirLabel(run)}: ${prev.dirs.length} → ${runDirsHere.length} sessions, regenerating...`);
      } catch {
        // corrupt manifest → regenerate
      }
    }

    // one report per seat/model beside those sessions: "how did haiku do" next to "how did the site do"
    const groups = new Map<string, string[]>();
    for (const d of runDirsHere) {
      const seat = seatOf(d);
      if (seat) groups.set(`${seat}/${modelSlug(modelOf(d))}`, [...(groups.get(`${seat}/${modelSlug(modelOf(d))}`) ?? []), d]);
    }
    for (const [sub, mdirs] of groups) {
      writeFileSync(`${run}/${sub}/AGGREGATE.md`, generateAggregate(mdirs));
      writeFileSync(`${run}/${sub}/DETAIL.md`, generateDetail(mdirs));
    }

    mkdirSync(run, { recursive: true });
    writeFileSync(`${run}/AGGREGATE.md`, generateAggregate(runDirsHere));
    writeVerdictsStub(site, `${run}/AGGREGATE.md`);
    writeFileSync(`${run}/DETAIL.md`, generateDetail(runDirsHere));
    if (runDirOf(runDirsHere[0])) {
      bundleSeat(run, "verify", "VERIFIED.md", "verified: the sessions the filter chose, reviewed by the verifier seat");
      bundleSeat(run, "deep", "REPORT.md", "the report: the writer seat re-walked the hardest prospect");
      writeFileSync(`${run}/RUN.md`, runSummary(run, runDirsHere));
    }
    writeFileSync(manifestPath, JSON.stringify({ dirs: runDirsHere }, null, 2));
    console.log(`  ${dirLabel(run)}: ${runDirsHere.length} session(s) → ${run}/AGGREGATE.md`);
    written++;
  }
  for (const site of sites) mirrorLatest(site);

  if (written > 0) console.log("");
}

/** The aggregate that covers a given session. */
function aggregatePathFor(url: string): string {
  return `runs/${siteSlug(url)}/AGGREGATE.md`;
}

/** A session's recorded model, read straight from meta.json. */
function modelOf(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(`${dir}/meta.json`, "utf8")) as { model?: string }).model ?? null;
  } catch {
    return null;
  }
}

/**
 * STANDALONE — one shareable PDF per site (funnel + every expert report).
 * `--pdf` with no args covers every site in runs/; names/URLs scope it.
 */
async function pdf(sites: string[], model?: string) {
  const targets = sites.length
    ? sites.map(normalizeUrl)
    : (existsSync(RUNS_ROOT) ? readdirSync(RUNS_ROOT) : [])
        .filter((s) => !s.startsWith(".") && existsSync(`${RUNS_ROOT}/${s}/AGGREGATE.md`))
        .map((s) => `https://${s}`);

  if (targets.length === 0) {
    console.error("Nothing to render. Run a site first, or pass site names: leakdown --pdf site-a.dev");
    process.exit(1);
  }

  for (const url of targets) {
    // --model scopes the fixes to one brain; default is the best model present
    const { files, model: usedModel } = packetFor(url, model);
    if (files.length === 0) {
      console.log(`  ${siteSlug(url)}: no AGGREGATE.md/FIXES.md yet — skipping (run report/fix first)`);
      continue;
    }
    const out = `${RUNS_ROOT}/${siteSlug(url)}/${siteSlug(url)}-report.pdf`;
    process.stdout.write(`  ${siteSlug(url)}: ${files.length} section(s)${model ? `, ${model}` : ""}...`);
    try {
      await htmlToPdf(packetHtml(url, files, model), out);
      console.log(` ${resolve(out)}`);
    } catch (e) {
      console.log(` failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  console.log("");
}

/**
 * The ladder — the fleet the 96-session eval and the site-g retest chose:
 * a cheap wide sweep produces replication votes, the mechanical filter picks
 * the sessions that agree, sonnet (the model that refuses to fabricate)
 * verifies those, and opus (the only one that finds root causes) re-walks the
 * hardest persona and writes the report a founder reads. Cheaper models
 * never write anything a founder sees.
 */
const MUSE = "opencode/muse-spark-1.3-contributor-free";
/** who sits in the verify and deep seats; the layout does not care, RUN.md records it */
const VERIFIER = "sonnet";
const WRITER = "opus";
async function ladder(url: string, common: CommonArgs): Promise<void> {
  const base: CommonArgs = { ...common, yes: true, brainResolved: true, brain: "claude", stop: "visit" };
  const brainFor = (model: string) => (model.includes("/") ? model.split("/")[0] : "claude");
  // default is half haiku, half muse-spark (free): measured 2026-09-14, muse runs
  // full sessions with the harness fixes and its trails are replication votes
  const { detectBrains } = await import("./brain/catalog.js");
  const haveOpencode = (await detectBrains()).some((b) => b.spec.id === "opencode" && b.installed);
  const spec = common.wide ?? (haveOpencode ? `haiku:5,${MUSE}:5` : "haiku");
  const groups = spec.split(",").map((g) => {
    const [model, n] = g.split(":");
    return { model: model.trim(), n: n ? parseInt(n, 10) : undefined };
  });

  // 1. wide: the site's personas, split across the wide models in order
  console.log(`\n  ladder on ${siteSlug(url)}: wide ${groups.map((g) => g.model + (g.n ? ` ×${g.n}` : "")).join(" + ")} → filter → sonnet verifies → opus digs\n`);
  const site = siteSlug(url);
  const dirs: string[] = [];
  // a run from today that never reached REPORT.md is picked up where it stopped:
  // a rerun after a crash or a usage limit does not pay for the sweep twice
  const today = new Date().toISOString().slice(0, 10);
  const unfinished = runDirs(site).filter((r) => r.includes(`/${today}/`) && existsSync(`${r}/.ladder`) && !existsSync(`${r}/REPORT.md`)).at(-1);
  base.runDir = unfinished ?? newRunDir(url);
  mkdirSync(base.runDir, { recursive: true });
  writeFileSync(`${base.runDir}/.ladder`, ""); // marks a ladder run, so a plain run from today is never resumed as one
  const reuse = unfinished ? findSessionDirs(`${unfinished}/wide`).filter((d) => groups.some((g) => modelOf(d) === g.model)) : [];
  if (reuse.length && !common.personas?.length) {
    console.log(`  reusing ${reuse.length} wide session(s) from ${dirLabel(unfinished!)}\n`);
    dirs.push(...reuse);
  } else {
    // the first visit builds the brief, the map and the personas if they are missing
    const first = await visit(url, { ...base, brain: brainFor(groups[0].model), model: groups[0].model, stop: "personas" });
    void first;
    const ids = common.personas?.length ? common.personas : Object.keys(siteOwnPersonas(url));
    let at = 0;
    for (const g of groups) {
      const slice = g.n ? ids.slice(at, at + g.n) : ids.slice(at);
      at += slice.length;
      if (!slice.length) continue;
      dirs.push(...(await visit(url, { ...base, brain: brainFor(g.model), model: g.model, personas: slice })));
    }
  }
  if (!dirs.length) return;

  // 2. filter: which sessions cite what other sessions also cite
  await report(dirs, true);
  const sightings = collectSightings(dirs);
  const rows = replicationTable(sightings);
  let top = topSessions(sightings, rows, 3);
  if (!top.length) {
    // nothing replicated yet: verify the walkouts with reasons, they are the findings
    top = loadSessions(dirs).filter((s) => s.meta.exit.kind === "abandoned").slice(0, 3).map((s) => s.dir);
  }
  const replicated = rows.filter((r) => r.sessions >= 2).length;
  console.log(`\n  filter: ${replicated} replicated ref(s), ${rows.length - replicated} single-source; ${top.length} session(s) go to the verifier\n`);
  if (!top.length) return void console.log("  nothing to verify — no session abandoned or cited a shared element.\n");

  // 3. verify: the verifier's panels land in verify/<model>/, beside the run
  await fix(top, { ...base, brain: "claude", model: VERIFIER }, true, `${base.runDir}/verify/${modelSlug(VERIFIER)}`);

  // 4. deep: the writer re-walks the persona behind the top session, then the panel on that session
  const pid = (JSON.parse(readFileSync(`${top[0]}/meta.json`, "utf8")) as { personaId: string }).personaId;
  const deep = await visit(url, { ...base, brain: "claude", model: WRITER, seat: "deep", personas: [pid] });
  if (deep.length) await fix(deep, { ...base, brain: "claude", model: WRITER }, true);
  await report([...dirs, ...deep], true);
  console.log(`\n  ladder done: ${dirs.length} wide + ${deep.length} deep session(s). VERIFIED.md and REPORT.md sit beside the report, mirrored at runs/${site}/.`);
  printOutcome(base.runDir);
}

/**
 * Run one website order end to end: the normal pipeline, the PDF, one email.
 * Or decline it with a reason. The order is marked only after the email went.
 */
async function runOrder(id: string, common: CommonArgs, reject?: string): Promise<void> {
  const cfg = mailConfig();
  if (!cfg) {
    console.error("orders need mail configured (.env) — the report goes out by email");
    process.exit(1);
  }
  const order = await getOrder(id);
  if (reject !== undefined) {
    const text = `Hi,\n\nWe could not run leakdown against ${order.url}: ${reject || "no reason given"}.\n\n— leakdown`;
    if (!(await smtpSend(order.email, mimeWithAttachment({ from: cfg.user, to: order.email, subject: `leakdown: ${siteSlug(normalizeUrl(order.url))}`, text })))) {
      console.error("  email failed; order left as is");
      process.exit(1);
    }
    await setOrderStatus(id, "rejected", reject);
    return void console.log(`  ${id} rejected, ${order.email} told.\n`);
  }

  const url = normalizeUrl(order.url);
  console.log(`\n  order ${id}: ${url} for ${order.email}\n`);
  common.yes = true;
  common.headless = true;
  await all(url, common);
  await pdf([url]);
  const out = `${RUNS_ROOT}/${siteSlug(url)}/${siteSlug(url)}-report.pdf`;
  if (!existsSync(out)) {
    console.error(`  no PDF at ${out}; order left as is`);
    process.exit(1);
  }
  const text = `Hi,\n\nAttached is what simulated prospects hit on ${url}. Read it as risk signals, not measured traffic: each finding names the page, who walked out, and how to check it yourself.\n\nReply to this email with what was right and what was not — that is how the tool gets better.\n\n— leakdown`;
  if (!(await smtpSend(order.email, mimeWithAttachment({ from: cfg.user, to: order.email, subject: `leakdown report: ${siteSlug(url)}`, text, pdfPath: out })))) {
    console.error("  email failed; order left as new so you can retry");
    process.exit(1);
  }
  await setOrderStatus(id, "done", `sent ${new Date().toISOString().slice(0, 10)}`);
  console.log(`  ${id} done: ${out} sent to ${order.email}\n`);
}

/** STAGE 3 — expert panel over sessions. Requires stage 2 (aggregate) unless forced. */
async function fix(dirs: string[], common: CommonArgs, force = false, outDir?: string) {
  if (dirs.length === 0) {
    console.error(
      "Usage: leakdown fix <dir> [moreDirs...] [--brain ...] [--force]",
    );
    process.exit(1);
  }

  const sessions = loadSessions(dirs);
  if (sessions.length === 0) {
    console.error("No valid sessions (missing meta.json or session.jsonl).");
    process.exit(1);
  }

  const ungated = sessions.filter((s) => !existsSync(aggregatePathFor(s.meta.url)));
  if (!force && ungated.length > 0) {
    const missing = [...new Set(ungated.map((s) => aggregatePathFor(s.meta.url)))];
    console.error(
      `Stage 3 needs stage 2 — missing ${missing.join(", ")}. Run \`leakdown report\` first (or add --force to skip the aggregate).`,
    );
    process.exit(1);
  }

  // resolves the brain/model/effort choice; each expert then gets its own instance
  await resolveBrain(common, "Which AI runs the expert panel?");

  for (const s of sessions) {
    // the verifier seat writes beside the run, not into the session it reviewed
    const target = outDir ? `${outDir}/${basename(s.dir)}` : s.dir;
    if (!force && existsSync(`${target}/FIXES.md`)) {
      console.log(
        `\n  ${dirLabel(s.dir)}: FIXES.md already exists — skipping (--force to re-run experts).`,
      );
      continue;
    }
    // scoped to this session's own site, or a persona generated for it is not
    // in the registry and the panel reviews the run as Momus
    const registry = getPersonaRegistry(s.meta.url);
    const persona = registry.personas[s.meta.personaId] ?? PERSONAS.cold;
    if (!registry.personas[s.meta.personaId]) {
      console.log(
        `  ! persona "${s.meta.personaId}" not found — reviewing as ${PERSONAS.cold.name}, which will skew the advice`,
      );
    }
    console.log(
      `\n  Expert panel: ${persona.name} @ ${s.meta.url} (${s.events.length} steps)`,
    );
    console.log(`  Experts (in parallel): ${EXPERTS.map((e) => e.id).join(", ")}`);
    let panelDone = 0;

    const briefText = loadBrief(s.meta.url) ?? undefined;
    // the experts are independent — each its own brain, each returns one
    // section — so they run at once. No spinner: concurrent clearLine races.
    const results = await Promise.all(
      EXPERTS.map(async (expert) => {
        // fresh brain per expert — independent verdicts, not a group conversation
        const expertBrain = getBrain(common.brain ?? "claude", {
          model: common.model,
          effort: common.effort,
          role: "expert",
          allowDir: s.dir,
        });
        const section = await expert
          .run(
            {
              persona,
              url: s.meta.url,
              events: s.events,
              exit: s.meta.exit,
              viewport: (s.meta as any).viewport,
              // the panel used to review a journey with the destination missing
              brief: briefText,
            },
            expertBrain,
          )
          .catch((e) => {
            console.log(`  [${expert.id}] failed: ${(e as Error).message.split("\n")[0]}`);
            return null;
          });
        console.log(
          `  [${expert.id}] ${section ? "done" : "skipped"}  ${progressBar(++panelDone, EXPERTS.length, "experts").trim()}`,
        );
        return section ? `## ${expert.title} — ${expert.id}\n\n${section}` : null;
      }),
    );
    // keep registry order regardless of which finished first
    const sections = results.filter((x): x is string => x !== null);

    if (sections.length === 0) continue;

    const doc = `# Expert Fixes\n\nSession: \`${s.dir}\`\nSite: ${s.meta.url}\nPersona: ${persona.name} (${persona.temperature})\n\n---\n\n${sections.join("\n---\n\n")}\n`;
    mkdirSync(target, { recursive: true });
    writeFileSync(`${target}/FIXES.md`, doc);
    console.log(`  Fixes → ${target}/FIXES.md`);
  }
}

/**
 * Between-stage gate: what just happened, then continue / redo / settings /
 * stop. Silent under --yes and without a TTY — automation must never hang here.
 */
async function stageGate(
  doneMsg: string,
  nextLabel: string,
  common: CommonArgs,
): Promise<"continue" | "redo" | "stop"> {
  if (common.yes || !isInteractive()) return "continue";
  for (;;) {
    const choice = await select({
      message: `${doneMsg}. Next: ${nextLabel}`,
      choices: [
        { value: "continue", label: `continue — ${nextLabel}` },
        { value: "redo", label: "redo the stage that just ran" },
        { value: "settings", label: "change settings first", hint: "brain, model, effort, time, browser window" },
        { value: "stop", label: "stop here" },
      ],
    });
    if (choice !== "settings") return choice as "continue" | "redo" | "stop";
    await changeSettings(common);
  }
}

/** Re-open the run settings mid-pipeline. The next stage picks them up. */
async function changeSettings(common: CommonArgs) {
  // clearing these makes the picker actually ask instead of accepting the old answers
  common.brain = common.model = common.effort = undefined;
  common.brainResolved = false;
  await resolveBrain(common, "Which AI for what runs next?");

  const t = await text({
    message: `Minutes per session (Enter to keep ${common.time ?? 20}):`,
    fallback: "",
  });
  if (/^\d+$/.test(t.trim())) common.time = Math.min(120, Math.max(1, Number(t)));

  common.headless = await select({
    message: "Browser window?",
    choices: [
      { value: common.headless, label: `keep (${common.headless ? "headless" : "visible"})` },
      { value: !common.headless, label: common.headless ? "visible" : "headless" },
    ],
  });
}

/** PIPELINE — visit → report → fix (pipeline always regenerates: it just made new data) */
/**
 * The whole tool for one URL: read -> personas -> visit -> report -> fix,
 * ending wherever `--stop` says. Interactive runs get a gate between stages.
 */
async function all(url: string, common: CommonArgs) {
  let dirs: string[];
  for (;;) {
    dirs = await visit(url, common);
    if (!dirs.length || !runsThrough("report", common.stop)) {
      if (dirs.length) console.log(`\n  Stopped after visit. ${dirs.length} session(s) on disk.\n`);
      return;
    }
    const g = await stageGate(
      `${dirs.length} session(s) on disk`,
      "report — aggregate this site's funnel",
      common,
    );
    if (g === "stop") {
      console.log(`\n  Stopped after visit. ${dirs.length} session(s) on disk.\n`);
      return;
    }
    if (g !== "redo") break;
  }

  for (;;) {
    stageBanner("report", common.stop);
    await report(dirs, true);
    if (!runsThrough("fix", common.stop)) {
      const sites = [...new Set(loadSessions(dirs).map((x) => siteSlug(x.meta.url)))];
      console.log(
        `\n  Stopped after report. See ${sites.map((x) => `runs/${x}/AGGREGATE.md`).join(", ")}.\n`,
      );
      return;
    }
    const g = await stageGate(
      "aggregate written",
      "fix — expert panel over each session",
      common,
    );
    if (g === "stop") {
      const sites = [...new Set(loadSessions(dirs).map((x) => siteSlug(x.meta.url)))];
      console.log(
        `\n  Stopped after report. See ${sites.map((x) => `runs/${x}/AGGREGATE.md`).join(", ")}.\n`,
      );
      return;
    }
    if (g !== "redo") break;
  }

  // common now carries the resolved brain/model/effort — stage 3 reuses it verbatim
  stageBanner("fix", common.stop);
  await fix(dirs, common, true);

  console.log(`\n  Done: ${dirs.length} session(s), FIXES.md beside each.`);
  printOutcome(common.runDir);
}

/** Mailbox lifecycle test: create -> wait for real mail -> extract -> destroy */
/**
 * Send one email to the test mailbox through the same account's SMTP, via
 * curl — no new dependency for a 20-line health check. Gmail app passwords
 * work for both protocols, and smtp.<host> pairs with imap.<host> everywhere
 * we have seen; anywhere it doesn't, the manual-send fallback still stands.
 */
/** One raw MIME message out through the account's SMTP, via curl. */
async function smtpSend(to: string, mime: string): Promise<boolean> {
  const cfg = mailConfig();
  if (!cfg) return false;
  const smtpHost = cfg.host.replace(/^imap\./, "smtp.");
  try {
    // the password goes through a 0600 config file, never argv (visible to every process in `ps`)
    const conf = `${tmpdir()}/leakdown-smtp-${process.pid}-${Date.now()}.conf`;
    writeFileSync(conf, `user = "${cfg.user}:${cfg.pass.replace(/"/g, '\\"')}"\n`, { mode: 0o600 });
    try {
      await execa(
        "curl",
        ["-sS", "--ssl-reqd", "--config", conf, `smtps://${smtpHost}:465`,
         "--mail-from", cfg.user, "--mail-rcpt", to, "-T", "-"],
        { input: mime, timeout: 60_000 },
      );
      return true;
    } finally {
      rmSync(conf, { force: true });
    }
  } catch {
    return false;
  }
}

async function smtpSelfSend(to: string, label = "probe 1"): Promise<boolean> {
  const cfg = mailConfig();
  if (!cfg) return false;
  return smtpSend(to, mimeWithAttachment({ from: cfg.user, to, subject: `leakdown mailtest ${label}`, text: "Your verification code is 424242." }));
}

/**
 * One probe through the real path: mint a box, SMTP a message to it, poll
 * until it lands. Returns the latency in seconds, or null if it never came.
 */
async function probeMail(mail: ImapProvider, maxMs: number): Promise<number | null> {
  const box = await mail.create("mailprobe");
  const started = Date.now();
  let latency: number | null = null;
  try {
    if (!(await smtpSelfSend(box.address, "probe"))) return null;
    while (Date.now() - started < maxMs) {
      if ((await mail.fetchNew(box)).length) {
        latency = Math.round((Date.now() - started) / 1000);
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  } catch {
    return null;
  } finally {
    await mail.destroy(box).catch(() => {});
    await mail.close?.().catch(() => {});
  }
  return latency;
}

/**
 * The mail path is checked before a run, not trusted. A persona that says "the
 * email never came" is only evidence about the site if our own mail was working
 * that day; seven findings were once filed against a site because it was not.
 * A self-sent probe proves SMTP, credentials and the IMAP box — not that the
 * catch-all forwarder delivers, because Gmail shows us our own Sent copy either
 * way. Inbound delivery is proven only by mail from someone else, which the
 * queue records as it happens (`inboundSeen`). One probe a day, stamped on
 * every session's meta.json.
 */
async function ensureMailProbe(): Promise<MailProbe | null> {
  const cfg = mailConfig();
  if (!cfg) return null;
  const recent = recentMailProbe();
  if (recent) return recent;
  process.stdout.write("  \x1b[2mchecking the mailbox (SMTP + IMAP, up to 5 minutes)...\x1b[0m");
  const latency = await probeMail(new ImapProvider(cfg), 300_000);
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
  const probe: MailProbe = { at: new Date().toISOString(), ok: latency !== null, latencySeconds: latency };
  saveMailProbe(probe);
  console.log(
    probe.ok
      ? `  mail: SMTP and mailbox reachable (${latency}s)`
      : `  ⚠ mail: our own probe never showed up in 5 minutes — SMTP or IMAP is broken (run --mailtest)`,
  );
  return probe;
}

/** Sessions that gave up over email, with a real inbox check behind them. */
function emailAbandons(dirs: string[]): string[] {
  return loadSessions(dirs)
    .filter(
      (s) =>
        s.meta.exit.kind === "abandoned" &&
        /email|inbox|verification (code|link)|magic link|confirmation (email|link)|never (arrived|came|received)/i.test(
          s.meta.exit.reason,
        ) &&
        s.events.some((e) => e.decision.action.type === "check_email"),
    )
    .map((s) => s.dir);
}

async function mailtest() {
  const mail = setupMail();
  if (!mail) {
    console.error(
      "Set LEAKDOWN_IMAP_HOST, LEAKDOWN_IMAP_USER, LEAKDOWN_IMAP_PASS, LEAKDOWN_MAIL_DOMAIN first (see README).",
    );
    process.exit(1);
  }

  const box = await mail.provider.create("mailtest");
  console.log(`\n  ✅ mailbox created: ${box.address}`);

  // Box lifecycle alone proves nothing about delivery — a run once blamed a
  // site for "the magic link never arrived" when the inbox was ours to fix.
  // Send ourselves TWO probes at different times (t=0 and t=60s) and report
  // each one's latency: real deliveries have taken up to 5 minutes, and one
  // lucky email says nothing about whether delivery still works a minute in.
  const smtpOk = await smtpSelfSend(box.address);
  if (smtpOk) {
    console.log(`  ✉ probe 1 sent via SMTP — a second follows at 60s. Waiting up to 5 minutes.`);
    console.log(`  (a self-sent probe proves SMTP + IMAP; to prove the forwarder, also send one to that address from another account now)\n`);
  } else {
    console.log(`\n  → SMTP self-send failed; send any email to that address now (from another account).\n`);
  }

  const started = Date.now();
  const deadline = started + 300_000;
  const wanted = smtpOk ? 2 : 1;
  let secondSent = !smtpOk;
  let msgs: MailMessage[] = [];
  try {
    while (Date.now() < deadline) {
      if (!secondSent && Date.now() - started >= 60_000) {
        secondSent = true;
        if (await smtpSelfSend(box.address, "probe 2")) console.log(`  ✉ probe 2 sent (t=60s)`);
      }
      const fresh = await mail.provider.fetchNew(box);
      for (const m of fresh) {
        console.log(`  📬 arrived after ${Math.round((Date.now() - started) / 1000)}s: ${m.subject}`);
      }
      msgs.push(...fresh);
      if (msgs.length >= wanted && secondSent) break;
      process.stdout.write("  waiting for mail...\r");
      await new Promise((r) => setTimeout(r, 5000));
    }
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`\n\n  ❌ inbox check failed: ${msg.slice(0, 200)}`);
    if (msg.includes("AUTHENTICATIONFAILED")) {
      console.log(`
  Gmail says the credentials are wrong. Checklist:
    1. IMAP enabled: mail.google.com → gear → See all settings → Forwarding and POP/IMAP → Enable IMAP
    2. LEAKDOWN_IMAP_PASS must be a 16-char APP PASSWORD (not your login password)
       → myaccount.google.com/apppasswords (requires 2-Step Verification)
    3. Paste it without extra characters, e.g. "abcd efgh ijkl mnop"`);
    }
    process.exit(1);
  }
  console.log("");

  if (msgs.length === 0) {
    console.log("  ⏱ mail not reached within 5 minutes — do NOT trust email verdicts from runs until this passes.");
    process.exitCode = 1; // so `--mailtest && <sweep>` stops here
  } else {
    if (msgs.length < wanted)
      console.log(`  ⚠ only ${msgs.length}/${wanted} probes arrived within 5 minutes.`);
    for (const m of msgs) {
      console.log(`  📩 from: ${m.from}`);
      console.log(`     subject: ${m.subject}`);
      console.log(`     codes: ${extractCodes(m.subject, m.text).join(", ") || "none"}`);
      console.log(`     links: ${extractLinks(m.text).join(", ") || "none"}`);
    }
  }

  await mail.provider.destroy(box);
  const after = await mail.provider.fetchNew(box);
  console.log(`\n  🗑 mailbox destroyed. messages remaining addressed to it: ${after.length}\n`);
  await (mail.provider as ImapProvider).close?.();
}

/** Generate a persona graph from a description (+ optional site scrape) */
async function personasGenerate(rest: string[]) {
  const brain = await resolveBrain(parseCommon(rest), "Which AI writes your personas?");

  const flagValue = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  let description = flagValue("--from");
  let site = flagValue("--site");
  let count = flagValue("--count") ? parseInt(flagValue("--count")!, 10) : undefined;

  const interactive = !description || !site;
  if (interactive && !process.stdin.isTTY) {
    // automation: require flags
  } else if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const deadline = Date.now() + 180_000;
    const ask = async (q: string): Promise<string> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "";
      return Promise.race([
        rl.question(q),
        new Promise<string>((res) => setTimeout(() => res(""), remaining)),
      ]);
    };
    try {
      if (!site) {
        site = (await ask("  Target site (optional, scraped to learn the product): ")).trim();
      }
      if (!description) {
        description = (
          await ask("  Who is this for? (optional if a site was given — Enter to infer): ")
        ).trim();
      }
    } finally {
      rl.close();
    }
  }

  // a scraped site is enough on its own — the audience is inferred from the page
  if (!description && !site) {
    console.error(
      '\n  Need either a site to scrape or a description of who this is for:\n    leakdown personas generate --site https://yoursite.com\n    leakdown personas generate --from "CTOs at Series B startups"',
    );
    process.exit(1);
  }

  const effectiveCount = count && count > 0 ? Math.min(count, 10) : 4;
  console.log(`\n  generating ${effectiveCount} personas with ${brain.name}...`);

  try {
    const { written, graph } = await generatePersonas({
      description,
      count: effectiveCount,
      brain: brain as typeof brain & { ask?: (p: string) => Promise<string> },
      site: site || undefined,
    });
    console.log(graph);
    console.log(`\n  ✓ ${written.length} persona file(s) written to personas/:`);
    for (const p of written) console.log(`    ${p.id}.yaml — ${p.name} (${p.temperature})`);
    console.log(`\n  Run them:`);
    console.log(`    leakdown visit <url> --persona ${written.map((p) => p.id).join(",")}\n`);
  } catch (e) {
    console.error(`\n  generation failed: ${(e as Error).message.slice(0, 200)}\n`);
    process.exit(1);
  }
}

/** List available personas (built-in + custom YAML) */
/** Free-text answer with a hard ceiling — a 4,000-word "goal" is not a goal. */
const limited = (max: number, what: string) => (v: string) => {
  const t = v.trim();
  if (!t) return `${what} cannot be empty`;
  if (t.length > max) return `keep it under ${max} characters (currently ${t.length})`;
  return undefined;
};

/**
 * Build a persona by asking, rather than scaffolding a file to hand-edit.
 *
 * Saves either globally or into one site's set, so a persona written for one
 * product does not turn up on every other site you test.
 */
async function newPersonaInteractive(name: string): Promise<void> {
  heading(`New persona — ${name}`);

  const sites = sitesWithPersonas().map((s) => s.site);
  const knownSites = [...new Set([...sites, ...(existsSync(RUNS_ROOT) ? readdirSync(RUNS_ROOT) : [])])]
    .filter((s) => !s.startsWith("."))
    .sort();

  const scope = await select({
    message: "Where should it live?",
    choices: [
      { value: "", label: "everywhere", hint: "personas/ — offered on every site" },
      ...knownSites.map((s) => ({
        value: s,
        label: `only ${s}`,
        hint: `runs/${s}/personas/`,
      })),
    ],
  });

  const temperature = await select({
    message: "How much do they already know when they arrive?",
    choices: [
      { value: "cold", label: "cold", hint: "never heard of it — gets no site context at all" },
      { value: "warm", label: "warm", hint: "knows what they came looking for" },
      { value: "hot", label: "hot", hint: "already looked up the price and how to sign up" },
    ],
  });

  const goal = await text({
    message: "What did they come to do? (one or two sentences, max 300)",
    validate: limited(300, "the goal"),
  });

  const tech = await select({
    message: "Tech comfort?",
    choices: [
      { value: "medium", label: "medium" },
      { value: "low", label: "low", hint: "put off by code samples and jargon" },
      { value: "high", label: "high" },
    ],
  });

  const patience = await text({
    message: "How many decisions before they give up? (1-50, Enter for 12)",
    fallback: "12",
    validate: (v) =>
      /^\d+$/.test(v.trim()) && +v >= 1 && +v <= 50 ? undefined : "a number from 1 to 50",
  });

  console.log(
    "\n  Traits are the personality lever — short, first-person habits the model copies.",
  );
  const traits: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const t = await text({
      message: `  trait ${i}${i > 2 ? " (Enter to finish)" : ""} (max 120 chars):`,
      fallback: i > 2 ? "" : undefined,
      validate: (v) =>
        i > 2 && !v.trim() ? undefined : limited(120, "a trait")(v),
    });
    if (!t.trim()) break;
    traits.push(t.trim());
  }

  const dir = scope ? resolve(`${RUNS_ROOT}/${scope}/personas`) : PERSONAS_DIR;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${id}.yaml`;
  if (existsSync(path)) {
    console.error(`\n  ${path} already exists — pick another name.\n`);
    process.exit(1);
  }

  writeFileSync(
    path,
    `# ${name}${scope ? ` — built for ${scope}` : ""}\n` +
      `# Edit freely; delete the file to remove.\n\n` +
      stringifyYaml({
        name,
        temperature,
        goal: goal.trim(),
        tech_comfort: tech,
        patience_steps: Number(patience),
        traits,
      }) +
      "\n",
  );

  console.log(`\n  ✓ ${path}`);
  console.log(
    scope
      ? `  It will be offered automatically when you test ${scope}.\n`
      : `  Use it anywhere:  leakdown <url> --persona ${id}\n`,
  );
}

function personasCommand(args: string[]) {
  if (args.includes("--new")) {
    const nameIdx = args.indexOf("--new");
    const name = args[nameIdx + 1];
    if (!name || name.startsWith("--")) {
      console.error("Usage: leakdown --new-persona \"Persona Name\"");
      process.exit(1);
    }
    try {
      const path = newPersonaFile(name);
      console.log(`\n  ✓ created ${path}`);
      console.log(`  Edit it, then use: leakdown <url> --persona ${path.split("/").pop()?.replace(/\.yaml$/, "")}\n`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    return;
  }

  // grouped by where they live, because a flat list hid site sets entirely and
  // left you wondering where the personas you just generated had gone
  const { errors } = getPersonaRegistry();
  const rows = (personas: Record<string, Persona>) => {
    for (const [id, p] of Object.entries(personas)) {
      // ids and names are both user-supplied; truncate so one long one cannot
      // shunt every other column out of line
      const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);
      console.log(
        `    ${fit(id, 32)} ${fit(p.name, 34)} ${p.temperature.padEnd(6)} ${String(p.patience_steps).padStart(2)} steps`,
      );
    }
  };

  console.log(`\n  Personas  (use with --persona <id>)`);

  console.log(`\n  Built in`);
  rows(PERSONAS);

  const { personas: global } = loadCustomPersonas();
  if (Object.keys(global).length > 0) {
    console.log(`\n  Yours — personas/  (available on every site)`);
    rows(global);
  }

  for (const { site, dir, personas } of sitesWithPersonas()) {
    console.log(`\n  Built for ${site} — ${dir}/`);
    rows(personas);
  }

  if (errors.length > 0) {
    console.log(`\n  ⚠ invalid persona files (not loaded):`);
    for (const e of errors) console.log(`    ${e.file}: ${e.error}`);
  }
  console.log(
    `\n  New one:  leakdown --new-persona "My Persona"   (asks a few questions)` +
      `\n  Or let it build a set for a site:  leakdown <url> --stop personas\n`,
  );
}

/** Normalize whatever the user typed into a fetchable URL. */
async function askUrl(): Promise<string> {
  const raw = await text({
    message: "Site URL:",
    validate: (v) =>
      /^(https?:\/\/)?[^\s.\/]+\.[^\s]+$/.test(v) ? undefined : "that doesn't look like a URL",
  });
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

/**
 * Zero-argument entry point: a guided wizard over every stage, so nothing has
 * to be memorised. Falls back to the usage text when there is no TTY.
 */
async function wizard() {
  if (!isInteractive()) {
    printUsage();
    process.exit(1);
  }

  heading("leakdown");
  const action = await select({
    message: "What do you want to do?",
    choices: [
      { value: "ladder", label: "the full run", hint: "about an hour: cheap models sweep, a verifier checks, a strong model writes" },
      { value: "test", label: "a plain run", hint: "one model plays every prospect; pick how far it goes" },
      { value: "history", label: "past runs", hint: "one line per run, with its one number" },
      { value: "fix", label: "review a past session", hint: "expert panel -> FIXES.md" },
      { value: "personas", label: "personas", hint: "list every persona you have" },
      { value: "doctor", label: "doctor", hint: "verify your environment" },
    ],
  });

  const common: CommonArgs = { headless: false, mobile: false };

  switch (action) {
    case "ladder": {
      const url = await askUrl();
      common.headless = await select({
        message: "Show the browser windows?",
        choices: [
          { value: true, label: "no, run headless", hint: "faster, nothing pops up" },
          { value: false, label: "yes, watch them" },
        ],
      });
      await ladder(url, common);
      break;
    }
    case "test": {
      const url = await askUrl();
      const stop = await select<Stage | "">({
        message: "How far should it go?",
        choices: [
          { value: "", label: "all the way", hint: "read -> personas -> visit -> report -> panel" },
          { value: "report", label: "stop after the report", hint: "no expert panel" },
          { value: "visit", label: "stop after the runs", hint: "no report, no panel" },
          { value: "personas", label: "just read it and build prospects", hint: "nobody visits yet" },
        ],
      });
      if (stop) common.stop = stop;
      await all(url, common);
      break;
    }
    case "history":
      history();
      break;
    case "fix": {
      const run = await pickRun();
      if (!run) break;
      const dirs = findSessionDirs(run);
      const dir = await select({
        message: "Which session?",
        choices: [...dirs].reverse().map((d) => ({ value: d, label: dirLabel(d).split("/").slice(3).join("/") })),
      });
      // stage 3 is gated on stage 2; in a guided flow just produce it
      await report(dirs, false);
      await fix([dir], common, false);
      break;
    }
    case "personas":
      personasCommand([]);
      break;
    case "doctor": {
      const choice = await resolveBrainChoice({}, "Which AI should I health-check?", {
        requireInstalled: false,
      });
      if (!(await runDoctor(choice.brain, true))) process.exitCode = 1;
      break;
    }
  }
}

/** Site, then run — newest first. Null when nothing has run yet. */
async function pickRun(): Promise<string | null> {
  const sites = (existsSync(RUNS_ROOT) ? readdirSync(RUNS_ROOT) : []).filter((x) => runDirs(x).length);
  if (!sites.length) {
    console.error("\n  No runs yet — test a site first.\n");
    return null;
  }
  const site = sites.length === 1 ? sites[0] : await select({ message: "Which site?", choices: sites.map((x) => ({ value: x, label: x })) });
  const runs = runDirs(site).reverse();
  return runs.length === 1
    ? runs[0]
    : select({
        message: "Which run?",
        choices: runs.map((r) => ({ value: r, label: dirLabel(r).split("/").slice(1).join(" "), hint: oneNumber(r) ?? seatsOf(r) })),
      });
}

const VALUE_FLAGS = new Set([
  "--persona",
  "--personas",
  "--brain",
  "--runs",
  "--random",
  "--wide",
  "--time",
  "--flow",
  "--model",
  "--effort",
  "--stop",
  "--new-persona",
  "--from",
  "--site",
  "--count",
  "--goal",
  "--steps",
  "--expect",
  "--flow-file",
  "--variant",
  "--validate-flow",
  "--order",
  "--reject",
]);

/** Every flag the CLI understands. A typo used to be ignored and the run went ahead without it. */
const KNOWN_FLAGS = new Set([
  ...VALUE_FLAGS,
  "--all", "--compare", "--doctor", "--fix", "--force", "--headless", "--help", "-h", "--history", "--ladder",
  "--list-personas", "--mailtest", "--mobile", "--no-map", "--orders", "--parallel", "--pdf", "--plan",
  "--replication", "--report", "--serial", "--version", "-v", "--yes", "-y", "--new",
]);

/** Everything that is not a flag or a flag's value. */
function positionalsOf(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("-")) {
      if (VALUE_FLAGS.has(argv[i])) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

/** Subcommands from before the single-command surface. Still dispatch; not in --help. */
const LEGACY = new Set(["visit", "report", "fix", "all", "doctor", "personas", "mailtest"]);

async function main() {
  loadDotEnv();
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    await wizard();
    return;
  }
  if (argv.includes("-h") || argv.includes("--help")) {
    printUsage();
    process.exit(0);
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`leakdown ${VERSION}`);
    process.exit(0);
  }
  const unknown = argv.filter((a) => /^--?[a-z]/i.test(a) && !KNOWN_FLAGS.has(a));
  if (unknown.length) {
    console.error(`Unknown flag${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. See \`leakdown --help\`.`);
    process.exit(1);
  }

  // legacy subcommand form, kept so nothing anyone typed before breaks
  if (LEGACY.has(argv[0])) {
    await legacy(argv[0], argv.slice(1));
    return;
  }

  const common = parseCommon(argv);
  const force = argv.includes("--force");
  const positionals = positionalsOf(argv);

  // standalone modes — each ends the run
  if (argv.includes("--doctor")) {
    const choice = await resolveBrainChoice(
      { brain: common.brain, model: common.model, effort: common.effort },
      "Which AI should I health-check?",
      { requireInstalled: false },
    );
    if (!(await runDoctor(choice.brain, force))) process.exitCode = 1;
    return;
  }
  if (argv.includes("--mailtest")) return void (await mailtest());
  if (argv.includes("--list-personas")) return personasCommand([]);
  if (argv.includes("--validate-flow")) {
    const file = flagValue(argv, "--validate-flow");
    const checks = file ? [validateFlow(file)] : validateFlowDir(FLOWS_DIR);
    console.log("\n" + renderFlowChecks(checks));
    if (checks.some((c) => !c.ok)) process.exit(1);
    return;
  }
  if (argv.includes("--new-persona")) {
    const name = flagValue(argv, "--new-persona");
    if (!name) {
      console.error('--new-persona needs a name, e.g. --new-persona "Budget Bianca"');
      process.exit(1);
    }
    return void (isInteractive()
      ? await newPersonaInteractive(name)
      : personasCommand(["--new", name]));
  }
  if (argv.includes("--history")) return history(positionals[0]);
  if (argv.includes("--fix")) {
    const dirs = positionals.length ? resolveTargets(positionals) : findSessionDirs();
    if (!dirs.length) {
      console.error("\n  No sessions to review yet — run a visit first.\n");
      process.exit(1);
    }
    return void (await fix(dirs, common, force));
  }
  if (argv.includes("--compare")) {
    const site = positionals[0];
    if (!site) {
      console.error("--compare needs a site: leakdown --compare <site> (after two runs with --variant)");
      process.exit(1);
    }
    return void compare(siteSlug(site));
  }
  if (argv.includes("--report")) {
    return void (await report(positionals.length ? resolveTargets(positionals) : undefined, force));
  }
  if (argv.includes("--replication")) {
    const { collectSightings, replicationTable, renderReplication } = await import("./log/replication.js");
    // a site or date folder expands to the sessions under it; a session dir is itself
    const dirs = positionals.length ? resolveTargets(positionals) : findSessionDirs();
    if (!dirs.length) {
      console.error("\n  No sessions to analyse yet — run a visit first.\n");
      process.exit(1);
    }
    const rows = replicationTable(collectSightings(dirs));
    if (!rows.length) {
      console.log("\n  No element refs cited in any FIXES.md or session trail.\n");
      return;
    }
    console.log("\n" + renderReplication(rows));
    return;
  }
  if (argv.includes("--pdf")) {
    return void (await pdf(positionals));
  }
  if (argv.includes("--ladder")) {
    const url = positionals[0];
    if (!url) {
      console.error("--ladder needs a site: leakdown <url> --ladder");
      process.exit(1);
    }
    return void (await ladder(normalizeUrl(url), common));
  }
  if (argv.includes("--orders")) {
    loadDotEnv();
    return void console.log("\n" + renderOrders(await listOrders(argv.includes("--all"))));
  }
  if (argv.includes("--order")) {
    loadDotEnv();
    const id = flagValue(argv, "--order");
    if (!id) {
      console.error("--order needs an id from --orders");
      process.exit(1);
    }
    return void (await runOrder(id, common, flagValue(argv, "--reject")));
  }

  const url = positionals[0];
  if (!url) {
    console.error("Give me a URL: leakdown <url>. See --help.");
    process.exit(1);
  }
  await all(normalizeUrl(url), common);
}

function normalizeUrl(raw: string): string {
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

/** Pre-single-command dispatch. Undocumented, unchanged in behaviour. */
async function legacy(command: string, rest: string[]) {
  const common = parseCommon(rest);
  const force = rest.includes("--force");
  const positionals = positionalsOf(rest);
  const needUrl = (usage: string) => {
    if (!positionals[0]) {
      console.error(usage);
      process.exit(1);
    }
    return normalizeUrl(positionals[0]);
  };

  switch (command) {
    case "visit":
      await visit(needUrl("Usage: leakdown <url> [--persona cold,warm,hot]"), common);
      break;
    case "all":
      await all(needUrl("Usage: leakdown <url> [--persona cold,warm,hot]"), common);
      break;
    case "report":
      await report(positionals.length ? positionals : undefined, force);
      break;
    case "fix":
      await fix(positionals, common, force);
      break;
    case "mailtest":
      await mailtest();
      break;
    case "doctor": {
      const choice = await resolveBrainChoice(
        { brain: common.brain, model: common.model, effort: common.effort },
        "Which AI should I health-check?",
        { requireInstalled: false },
      );
      if (!(await runDoctor(choice.brain, force))) process.exitCode = 1;
      break;
    }
    case "personas":
      if (rest[0] === "generate") await personasGenerate(rest.slice(1));
      else personasCommand(rest);
      break;
  }
}

main().catch((e) => {
  if (e instanceof PromptCancelled) {
    console.log("\n  cancelled.\n");
    process.exit(130);
  }
  console.error(e);
  process.exit(1);
});
