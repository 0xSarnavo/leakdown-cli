import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { ExitReason, StepEvent } from "../types.js";
import { ExitReasonSchema, StepEventSchema } from "../types.js";
import { PERSONAS } from "../persona/presets.js";
import { getPersonaRegistry } from "../persona/load.js";
import { FlowScoreSchema, type FlowScore } from "../site/flow.js";
import { broken, guardedSurfaces, loadMap, unreached } from "../site/map.js";
import { fmtDuration, journeySeconds, watermark } from "./report.js";
import { collectSightings, replicationTable } from "./replication.js";
import { confidenceInterval, lift, overlap, strength } from "./stats.js";
import { RUNS_ROOT, siteSlug } from "../runs.js";
export { siteSlug };

export interface SessionMeta {
  url: string;
  personaId: string;
  brain: string;
  exit: ExitReason;
  date?: string;
  flow?: FlowScore | null;
  mailProbe?: { ok: boolean; latencySeconds: number | null; at: string } | null;
  /** `--variant` label; absent on a plain run */
  variant?: string;
}

const MetaSchema = z.object({
  url: z.string(),
  personaId: z.string(),
  brain: z.string(),
  exit: ExitReasonSchema,
  // older sessions have no flow field; a malformed one degrades to "unscored"
  flow: FlowScoreSchema.nullish().catch(null),
  mailProbe: z.object({ ok: z.boolean(), latencySeconds: z.number().nullable(), at: z.string() }).nullish().catch(null),
  variant: z.string().optional().catch(undefined),
});

/**
 * Sessions are shared artifacts — a donated runs/ folder is untrusted input.
 * Validate shape at the boundary: invalid sessions are skipped with a warning
 * instead of crashing stages 2-3 mid-report.
 */
export function loadSessions(dirs: string[]): {
  dir: string;
  meta: SessionMeta;
  events: StepEvent[];
}[] {
  const sessions = [];
  for (const dir of dirs) {
    const metaPath = `${dir}/meta.json`;
    const eventsPath = `${dir}/session.jsonl`;
    if (!existsSync(metaPath) || !existsSync(eventsPath)) continue;
    try {
      const metaRaw = JSON.parse(readFileSync(metaPath, "utf8"));
      const metaRes = MetaSchema.safeParse(metaRaw);
      if (!metaRes.success) {
        console.warn(`  ⚠ skipping ${dir}: meta.json has an unexpected shape`);
        continue;
      }
      const meta = metaRes.data as SessionMeta;

      const events: StepEvent[] = [];
      let badLines = 0;
      for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const res = StepEventSchema.safeParse(JSON.parse(line));
          if (res.success) events.push(res.data);
          else badLines++;
        } catch {
          badLines++;
        }
      }
      if (events.length === 0) {
        console.warn(`  ⚠ skipping ${dir}: no valid step events in session.jsonl`);
        continue;
      }
      if (badLines > 0) {
        console.warn(`  ⚠ ${dir}: dropped ${badLines} malformed event line(s)`);
      }
      sessions.push({ dir, meta, events });
    } catch {
      // skip unreadable session dirs
    }
  }
  return sessions;
}

/**
 * The short report a site owner reads: one number, the walls, what to check.
 * Everything a developer needs is under one heading; everything else is in
 * DETAIL.md. No LLM — counts, the prospects' own words, and the crawler's map.
 */
/** Site-generated personas live in runs/<site>/personas/, so always resolve with the site (invariant 15). */
function personaNamer(url: string): (pid: string) => string {
  const registry = getPersonaRegistry(url).personas;
  return (pid) => registry[pid]?.name ?? PERSONAS[pid]?.name ?? pid;
}

export function generateAggregate(dirs: string[]): string {
  const sessions = loadSessions(dirs);
  if (sessions.length === 0) return "# Aggregate Report\n\nNo valid sessions found.\n";
  const site = siteSlug(sessions[0].meta.url);
  const name = personaNamer(sessions[0].meta.url);
  const L: string[] = [];

  const done = sessions.filter((s) => s.meta.exit.kind === "completed");
  const left = sessions.filter((s) => s.meta.exit.kind === "abandoned");
  const guard = sessions.filter((s) => s.meta.exit.kind === "guardrail");
  const blocked = sessions.filter((s) => s.meta.exit.kind === "couldnotrun").length;
  // patience running out is the prospect's own budget spent on the site — a real signal;
  // the rest (stuck loop, clock) is the harness and says nothing about the site
  const tired = guard.filter((s) => /patience/i.test((s.meta.exit as { detail: string }).detail)).length;
  const stopped = guard.length - tired;
  L.push(`# ${site} — what ${sessions.length} simulated prospects hit`, "");
  L.push(`Read as: risk signals about where real visitors could stall, not measured traffic. Full session table and every quote: DETAIL.md.`, "");
  const mailBad = sessions.some((s) => s.meta.mailProbe?.ok === false) || existsSync(`${RUNS_ROOT}/${site}/MAIL-WARNING.md`);
  if (mailBad) L.push(`> ⚠ **Email verdicts unverified.** Our own mailbox probe failed around this run. Anything below about "the email never came" may be our fault, not the site's. See MAIL-WARNING.md, run \`--mailtest\`.`, "");
  L.push(`## The one number`, "");
  L.push(`**${done.length} of ${sessions.length} completed their goal.** ${left.length} walked out with a reason.${tired ? ` ${tired} ran out of patience still trying.` : ""}${stopped ? ` ${stopped} were stopped by the harness (stuck loop, clock) — those say nothing about the site.` : ""}${blocked ? ` ${blocked} could not run at all (unreachable page, model down, setup error) — our side, not evidence about the site.` : ""}`, "");

  // a persona run more than once: say how much its runs agree, so one wandering
  // edge run is read as one run (retest: hot 3.8/4 stable, edge 2.5/4)
  const byPersona = new Map<string, typeof sessions>();
  for (const s of sessions) byPersona.set(s.meta.personaId, [...(byPersona.get(s.meta.personaId) ?? []), s]);
  const repeats = [...byPersona.entries()].filter(([, r]) => r.length >= 2);
  if (repeats.length) {
    L.push(`**Run more than once:** ${repeats
      .map(([pid, r]) => {
        const kinds = new Map<string, number>();
        for (const x of r) kinds.set(x.meta.exit.kind, (kinds.get(x.meta.exit.kind) ?? 0) + 1);
        const [kind, n] = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];
        return `${name(pid)} ${n}/${r.length} ${kind}`;
      })
      .join("; ")}. A persona whose runs disagree is exploring, not stuck — read each run as one visit.`, "");
  }

  // the owner's own verdicts, if they left any (runs/<site>/VERDICTS.md: lines starting "real:" or "false:")
  const verdictsPath = `${RUNS_ROOT}/${site}/VERDICTS.md`;
  if (existsSync(verdictsPath)) {
    const v = readFileSync(verdictsPath, "utf8");
    const real = (v.match(/^real:/gim) ?? []).length;
    const wrong = (v.match(/^false:/gim) ?? []).length;
    if (real + wrong) L.push(`**Owner review:** ${real} finding(s) confirmed real, ${wrong} marked false (VERDICTS.md).`, "");
  }

  // the walls: pages where prospects walked out, most first
  const byPage = new Map<string, typeof sessions>();
  for (const s of left) {
    const u = hostPath(s.events.at(-1)?.url ?? s.meta.url);
    byPage.set(u, [...(byPage.get(u) ?? []), s]);
  }
  const walls = [...byPage.entries()].sort((a, b) => b[1].length - a[1].length);
  if (walls.length) {
    L.push(`## Fix these first`, "");
    walls.slice(0, 3).forEach(([page, hits], i) => {
      const who = [...new Set(hits.map((s) => name(s.meta.personaId)))].join(", ");
      // the shortest reason, and that same prospect's last two thoughts — one voice, not a collage
      const best = [...hits].sort(
        (a, b) => (a.meta.exit as { reason: string }).reason.length - (b.meta.exit as { reason: string }).reason.length,
      )[0];
      const quote = (best.meta.exit as { reason: string }).reason;
      const last = best.events.slice(-2);
      L.push(`### ${i + 1}. \`${page}\` — ${hits.length} of ${sessions.length} walked out here`, "");
      L.push(`**How sure:** ${strength(hits.length, sessions.length)} — the interval is what a count this small can support.`, "");
      L.push(`**Who:** ${who}`, "");
      L.push(`**In their words:** "${cell(quote, 320)}"`, "");
      L.push(`**Check it yourself:** open \`${page}\`. Right before leaving they were thinking: ${last.map((e) => `"${cell(e.decision.thought, 160)}" → ${describe(e.decision.action)}`).join("; then ")}.`, "");
    });
  }

  const reached = sessions.flatMap((s) => s.events.map((e) => e.url));
  const map = loadMap(sessions[0].meta.url);
  const dead = map ? broken(map) : [];
  if (dead.length) {
    L.push(`## Also found by the crawler`, "");
    L.push(`${dead.length} link(s) on the site lead to a 404 or no page:`, "");
    for (const p of dead.slice(0, 6)) L.push(`- \`${hostPath(p.url)}\``);
    if (dead.length > 6) L.push(`- … ${dead.length - 6} more in DETAIL.md`);
    L.push("");
  }

  if (walls.length > 3) {
    L.push(`## Where else they left`, "");
    for (const [page, hits] of walls.slice(3)) L.push(`- \`${page}\` — ${hits.length}`);
    L.push("");
  }

  const scored = sessions.filter((s) => s.meta.flow?.length);
  const checkpoints = scored[0]?.meta.flow;
  if (checkpoints?.length) {
    L.push(`## The flow under test (${scored.length} scored)`, "");
    checkpoints.forEach((c, i) => {
      const n = scored.filter((s) => s.meta.flow?.[i]?.reached).length;
      L.push(`${i + 1}. ${cell(c.checkpoint)} — ${n}/${scored.length} got here`);
    });
    L.push("");
  }

  // developer page: element refs from the expert panel, tiered by how many sessions cite them
  L.push(`## For developers`, "");
  const rows = replicationTable(collectSightings(sessions.map((s) => s.dir))).filter((r) => r.inFindings);
  const replicated = rows.filter((r) => r.sessions >= 2);
  const once = rows.filter((r) => r.sessions === 1);
  if (replicated.length) {
    L.push(`**Element refs cited by more than one session** (run \`--fix\` first if empty):`, "");
    for (const r of replicated.slice(0, 10)) L.push(`- \`${r.ref}\` — ${strength(r.sessions, sessions.length)}, ${r.models.length} model(s)`);
    L.push("");
  }
  if (once.length) {
    L.push(`**Seen once, not counted** — one session cited these; treat as unverified until a second run agrees:`, "");
    L.push(once.slice(0, 15).map((r) => `\`${r.ref}\``).join(", "), "");
  }
  if (!rows.length) L.push(`No expert findings yet — run \`--fix\` to get element-level findings here.`, "");

  // what a ruler measured, unioned per page across sessions — no opinion involved
  const measured = new Map<string, { unnamed: Set<string>; small: Set<string>; overflowX: boolean; noViewport: boolean }>();
  for (const s of sessions)
    for (const e of s.events) {
      if (!e.audit) continue;
      const key = hostPath(e.url);
      const m = measured.get(key) ?? { unnamed: new Set(), small: new Set(), overflowX: false, noViewport: false };
      e.audit.unnamed.forEach((r) => m.unnamed.add(r));
      e.audit.small.forEach((r) => m.small.add(r));
      m.overflowX ||= e.audit.overflowX;
      m.noViewport ||= !e.audit.viewportMeta;
      measured.set(key, m);
    }
  const flagged = [...measured.entries()].filter(([, m]) => m.unnamed.size || m.small.size || m.overflowX || m.noViewport);
  if (flagged.length) {
    L.push(`**Measured on the page** (a ruler, not a persona):`, "");
    for (const [page, m] of flagged) {
      const parts: string[] = [];
      if (m.unnamed.size) parts.push(`${m.unnamed.size} control(s) with no accessible name (${[...m.unnamed].slice(0, 6).join(", ")}${m.unnamed.size > 6 ? ", …" : ""})`);
      if (m.small.size) parts.push(`${m.small.size} tap target(s) under 24px (${[...m.small].slice(0, 6).join(", ")}${m.small.size > 6 ? ", …" : ""})`);
      if (m.overflowX) parts.push("page scrolls sideways");
      if (m.noViewport) parts.push("no viewport meta tag");
      L.push(`- \`${page}\`: ${parts.join("; ")}`);
    }
    L.push("");
  }
  if (map) {
    const surfaces = guardedSurfaces(map, reached);
    if (surfaces.length) {
      L.push(`**Booking and payment surfaces** (the guard refuses the commit on each):`, "");
      for (const { page, reached: r } of surfaces) L.push(`- ${page.kind}: \`${page.url}\` — ${r ? "reached" : "no prospect got here"}`);
      L.push("");
    }
    const missed = unreached(map, reached).filter((p) => !dead.includes(p));
    if (missed.length) {
      const kinds = new Map<string, number>();
      for (const p of missed) kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
      L.push(`**Pages no prospect found:** ${missed.length} of ${map.pages.length} mapped (${[...kinds.entries()].map(([k, n]) => `${k} ${n}`).join(", ")}). List in DETAIL.md.`, "");
    }
  }
  L.push(...renderVariants(sessions));
  L.push(watermark(site));
  return L.join("\n");
}

type Loaded = ReturnType<typeof loadSessions>;

/** Someone who gave up on the site: walked out, or spent all their patience trying. */
const leaked = (s: Loaded[number]) =>
  s.meta.exit.kind === "abandoned" || (s.meta.exit.kind === "guardrail" && /patience/i.test(s.meta.exit.detail));

/**
 * A/B: the same personas under two `--variant` labels. Rendered only when at
 * least two variants each have a session. Exactly two are compared; more are
 * listed. Could-not-run sessions are left out of every rate — they say nothing.
 */
export function renderVariants(sessions: Loaded): string[] {
  const byVariant = new Map<string, Loaded>();
  for (const s of sessions) if (s.meta.variant) byVariant.set(s.meta.variant, [...(byVariant.get(s.meta.variant) ?? []), s]);
  if (byVariant.size < 2) return [];
  const rows = [...byVariant.entries()].map(([variant, ss]) => {
    const ran = ss.filter((s) => s.meta.exit.kind !== "couldnotrun");
    return { variant, n: ran.length, hits: ran.filter(leaked).length, done: ran.filter((s) => s.meta.exit.kind === "completed").length, blocked: ss.length - ran.length };
  });
  // leakiest first: the highest share of visitors who gave up
  rows.sort((a, b) => (b.n ? b.hits / b.n : 0) - (a.n ? a.hits / a.n : 0));
  const L: string[] = [`## Variants compared (${rows.length})`, ""];
  L.push(`Same personas, different experience. "Leaked" = walked out or ran out of patience; the interval is what a count this small can support.`, "");
  L.push(`| variant | sessions | completed | leaked | how sure |`, `|---|---|---|---|---|`);
  for (const r of rows) L.push(`| \`${r.variant}\` | ${r.n}${r.blocked ? ` (+${r.blocked} could not run)` : ""} | ${r.done} | ${r.hits} | ${strength(r.hits, r.n)} |`);
  L.push("");
  const [a, b] = rows;
  const diff = Math.round(lift(b, a) * 100);
  if (a.n < 3 || b.n < 3) L.push(`**Verdict:** too few sessions to call — run at least 3 per variant.`, "");
  else if (overlap(a, b)) L.push(`**Verdict:** no meaningful difference between \`${a.variant}\` and \`${b.variant}\` — the intervals overlap.`, "");
  else L.push(`**Verdict:** \`${a.variant}\` leaks more — ${diff} points more of its visitors gave up than in \`${b.variant}\` (${pct(confidenceInterval(a.hits, a.n))} vs ${pct(confidenceInterval(b.hits, b.n))}).`, "");
  // where each variant lost people, side by side
  const pages = new Map<string, Map<string, number>>();
  for (const [variant, ss] of byVariant)
    for (const s of ss.filter(leaked)) {
      const page = hostPath(s.events.at(-1)?.url ?? s.meta.url);
      const m = pages.get(page) ?? new Map<string, number>();
      m.set(variant, (m.get(variant) ?? 0) + 1);
      pages.set(page, m);
    }
  if (pages.size) {
    L.push(`**Where they gave up, per variant:**`, "");
    for (const [page, m] of [...pages.entries()].sort((x, y) => sum(y[1]) - sum(x[1])))
      L.push(`- \`${page}\` — ${rows.map((r) => `${r.variant} ${m.get(r.variant) ?? 0}/${r.n}`).join(", ")}`);
    L.push("");
  }
  return L;
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const pct = ([lo, hi]: [number, number]) => `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`;

function describe(a: StepEvent["decision"]["action"]): string {
  switch (a.type) {
    case "click": return `clicked ${a.target}`;
    case "type": return `typed into ${a.target}`;
    case "select": return `selected "${a.value}"`;
    case "scroll": return `scrolled ${a.direction}`;
    case "check_email": return "checked email";
    default: return a.type;
  }
}

/** Every session, every table — the appendix behind AGGREGATE.md. */
export function generateDetail(dirs: string[]): string {
  const sessions = loadSessions(dirs);
  if (sessions.length === 0) {
    return "# Aggregate Report\n\nNo valid sessions found.\n";
  }
  const name = personaNamer(sessions[0].meta.url);

  const lines: string[] = [];
  lines.push(`# Session detail — ${siteSlug(sessions[0].meta.url)}`);
  lines.push("");
  lines.push(`- **Sessions:** ${sessions.length}`);
  lines.push(`- **Generated:** ${new Date().toISOString()}`);
  lines.push(`- **Read as:** simulated prospects — risk signals about where real visitors could stall, not measured traffic`);
  lines.push("");

  // verdict summary
  const byKind = { completed: 0, abandoned: 0, guardrail: 0, couldnotrun: 0 };
  for (const s of sessions) byKind[s.meta.exit.kind]++;
  lines.push(`## Verdict Summary`);
  lines.push("");
  lines.push(`| Outcome | Count |`);
  lines.push(`|---------|-------|`);
  lines.push(`| ✅ Completed | ${byKind.completed} |`);
  lines.push(`| ❌ Abandoned | ${byKind.abandoned} |`);
  lines.push(`| ⚠️ Guardrail | ${byKind.guardrail} |`);
  if (byKind.couldnotrun) lines.push(`| ⏸ Could not run (our side, not the site) | ${byKind.couldnotrun} |`);
  lines.push("");

  // flow funnel: how far along the tested flow each simulated prospect got.
  // Checkpoint order comes from the first scored session — they all share one FLOW.md.
  const scored = sessions.filter((s) => s.meta.flow?.length);
  const checkpoints = scored[0]?.meta.flow;
  if (checkpoints?.length) {
    lines.push(`## Flow Funnel (${scored.length} scored session(s))`);
    lines.push("");
    lines.push(`| # | Checkpoint | Reached | Risk |`);
    lines.push(`|---|-----------|---------|------|`);
    checkpoints.forEach((c, i) => {
      const reached = scored.filter((s) => s.meta.flow?.[i]?.reached).length;
      const risk =
        reached === scored.length
          ? "—"
          : `${scored.length - reached} prospect(s) never got here — real visitors may stall before it`;
      lines.push(`| ${i + 1} | ${cell(c.checkpoint)} | ${reached}/${scored.length} | ${risk} |`);
    });
    lines.push("");
  }

  // per-persona breakdown
  lines.push(`## By Persona`);
  lines.push("");
  lines.push(`| Persona | Runs | Completed | Abandoned | Avg Confusion | Avg Steps |`);
  lines.push(`|---------|------|-----------|-----------|---------------|-----------|`);
  const personas = new Set(sessions.map((s) => s.meta.personaId));
  for (const pid of personas) {
    const runs = sessions.filter((s) => s.meta.personaId === pid);
    const label = name(pid);
    const completed = runs.filter((r) => r.meta.exit.kind === "completed").length;
    const avgConf =
      runs.reduce((a, r) => a + (r.events.at(-1)?.decision.confusion ?? 0), 0) /
      runs.length;
    lines.push(
      `| ${label} (${pid}) | ${runs.length} | ${completed} | ${runs.length - completed} | ${(avgConf).toFixed(1)}/10 | ${(runs.reduce((a, r) => a + r.events.length, 0) / runs.length).toFixed(1)} |`,
    );
  }
  lines.push("");

  // per-session table
  lines.push(`## Session Detail`);
  lines.push("");
  lines.push(`| Session | Persona | Verdict | Steps | Time | Drop Point | Reason |`);
  lines.push(`|---------|---------|---------|-------|------|------------|--------|`);
  for (const s of [...sessions].sort((a, b) => a.dir.localeCompare(b.dir))) {
    const last = s.events.at(-1);
    const drop =
      s.meta.exit.kind === "abandoned"
        ? `step ${last?.n} on ${shortUrl(last?.url ?? "")}`
        : "—";
    const reason =
      s.meta.exit.kind === "abandoned"
        ? s.meta.exit.reason
        : s.meta.exit.kind === "completed"
          ? s.meta.exit.summary
          : s.meta.exit.detail;
    lines.push(
      `| \`${dirName(s.dir)}\` | ${name(s.meta.personaId)} | ${verdictIcon(s.meta.exit)} | ${s.events.length} | ${journeySeconds(s.events) === null ? "—" : fmtDuration(journeySeconds(s.events)!)} | ${drop} | ${cell(reason)} |`,
    );
  }
  lines.push("");

  // common drop pages
  const dropPages = new Map<string, number>();
  for (const s of sessions) {
    if (s.meta.exit.kind !== "abandoned") continue;
    const u = shortUrl(s.events.at(-1)?.url ?? "");
    dropPages.set(u, (dropPages.get(u) ?? 0) + 1);
  }
  if (dropPages.size > 0) {
    lines.push(`## Where visitors are most likely to stall`);
    lines.push("");
    for (const [page, count] of [...dropPages.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${page}\` — ${count} of ${sessions.length} simulated prospect(s) walked out here; real visitors may too`);
    }
    lines.push("");
  }

  // the crawler's map against where prospects actually went
  const map = loadMap(sessions[0].meta.url);
  if (map) {
    const reached = sessions.flatMap((s) => s.events.map((e) => e.url));
    const surfaces = guardedSurfaces(map, reached);
    if (surfaces.length) {
      lines.push(`## Booking and payment surfaces`);
      lines.push("");
      lines.push(`The guard refuses the commit on each; reaching one is the finding.`);
      lines.push("");
      for (const { page, reached } of surfaces)
        lines.push(`- ${page.kind}: \`${page.url}\` — ${reached ? "reached" : "no prospect got here"}`);
      lines.push("");
    }
    const dead = broken(map);
    if (dead.length) {
      lines.push(`## Broken links (${dead.length})`);
      lines.push("");
      lines.push(`Linked from the site; the crawler got a 404 or no page. A prospect who clicks one is stuck.`);
      lines.push("");
      for (const p of dead) lines.push(`- \`${hostPath(p.url)}\` — ${p.title}`);
      lines.push("");
    }
    const missed = unreached(map, reached).filter((p) => !dead.includes(p));
    if (missed.length) {
      const byKind = new Map<string, string[]>();
      for (const p of missed) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p.url]);
      lines.push(`## Pages no prospect found (${missed.length} of ${map.pages.length} mapped)`);
      lines.push("");
      lines.push(`A crawler reaches these by link or sitemap; ${sessions.length} simulated prospect(s) never did. Real visitors may not either.`);
      lines.push("");
      for (const [kind, urls] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const shown = urls.slice(0, 8).map((u) => `\`${hostPath(u)}\``).join(", ");
        lines.push(`- ${kind} (${urls.length}): ${shown}${urls.length > 8 ? ", …" : ""}`);
      }
      lines.push("");
    }
  }

  // verbatim wall of complaints
  const quotes = sessions
    .filter((s) => s.meta.exit.kind === "abandoned")
    .map((s) => `- "${(s.meta.exit as { reason: string }).reason}"`);
  if (quotes.length > 0) {
    lines.push(`## What could make people leave (in the prospects' own words)`);
    lines.push("");
    lines.push(...quotes);
    lines.push("");
  }

  lines.push(...renderVariants(sessions));
  lines.push(watermark(siteSlug(sessions[0].meta.url)));
  return lines.join("\n");
}

function verdictIcon(exit: ExitReason): string {
  switch (exit.kind) {
    case "completed":
      return "✅ completed";
    case "abandoned":
      return "❌ abandoned";
    case "guardrail":
      return "⚠️ guardrail";
    case "couldnotrun":
      return "⏸ could not run";
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search || "/";
  } catch {
    return url;
  }
}

/** `docs.example.com/faq` — subdomains matter in the map, so keep the host. */
function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "/" : u.pathname.replace(/\/$/, ""));
  } catch {
    return url;
  }
}

/** Within a per-site report the site is implicit, so show <seat>/<model>/<run>. */
function dirName(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts.slice(-3).join("/") || dir;
}

function cell(s: string, max = 120): string {
  const t = s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "") + "…" : t;
}
