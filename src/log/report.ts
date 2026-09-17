import { basename } from "node:path";
import type { AssertionResult, Persona, StepEvent, ExitReason } from "../types.js";
import type { FlowScore } from "../site/flow.js";
import { siteSlug } from "../runs.js";
import { VERSION } from "../version.js";

/** Wall-clock the journey took, from the timestamps already on every event. */
export function journeySeconds(events: StepEvent[]): number | null {
  const stamps = events
    .map((e) => Date.parse(e.timestamp))
    .filter((t) => Number.isFinite(t));
  if (stamps.length < 2) return null;
  return Math.round((Math.max(...stamps) - Math.min(...stamps)) / 1000);
}

function durationSuffix(events: StepEvent[]): string {
  const total = journeySeconds(events);
  if (total === null) return "";
  const avg = Math.round(total / Math.max(events.length - 1, 1));
  return ` over ${fmtDuration(total)} (~${avg}s per step)`;
}

/** Every report carries who made it and how to read it — the same line, everywhere. */
export function watermark(site: string): string {
  return `\n---\n*leakdown ${VERSION} · ${site} · ${new Date().toISOString().slice(0, 10)} · simulated prospects: risk signals, not measured traffic*\n`;
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

export function generateReport(opts: {
  persona: Persona;
  url: string;
  brain: string;
  events: StepEvent[];
  exit: ExitReason;
  /** Which flow checkpoints this journey reached, when a flow was defined */
  flow?: FlowScore;
  /** `--expect` checks against the page at the completion claim (or the last page seen) */
  assertions?: AssertionResult[];
  /** Filenames beside report.md (not paths) — omitted entries are skipped */
  media?: {
    filmstrip?: string | null;
    videoMp4?: string | null;
    videoWebm?: string | null;
  };
}): string {
  const { persona, url, brain, events, exit, flow, media, assertions } = opts;
  const lines: string[] = [];

  const verdict = exitVerdict(exit);
  lines.push(`# Leakdown Report`);
  lines.push("");
  lines.push(`- **Site:** ${url}`);
  lines.push(`- **Persona:** ${persona.name} (${persona.temperature})`);
  lines.push(`- **Brain:** ${brain}`);
  lines.push(`- **Date:** ${new Date().toISOString()}`);
  lines.push(`- **Steps taken:** ${events.length}${durationSuffix(events)}`);
  lines.push(`- **Verdict:** ${verdict}`);
  lines.push(`- **Read as:** one simulated visitor — a risk signal, not measured traffic`);
  lines.push("");

  if (flow && flow.length > 0) {
    lines.push(`## Flow Checkpoints (${flow.filter((c) => c.reached).length}/${flow.length} reached)`);
    lines.push("");
    for (const c of flow) {
      lines.push(`- ${c.reached ? "✅" : "⬜"} ${cell(c.checkpoint)}${c.note ? ` — ${cell(c.note)}` : ""}`);
    }
    lines.push("");
  }

  // Which pages the journey actually reached, and what it took to get there —
  // a page that takes eight steps to find is a finding in itself.
  const firstSeen = new Map<string, StepEvent>();
  for (const e of events) {
    const key = e.url.split("#")[0];
    if (!firstSeen.has(key)) firstSeen.set(key, e);
  }
  if (firstSeen.size > 0) {
    const start = Math.min(...events.map((e) => Date.parse(e.timestamp)).filter(Number.isFinite));
    lines.push(`## Pages Reached (${firstSeen.size})`);
    lines.push("");
    lines.push(`| Page | First reached | Steps in | Time in |`);
    lines.push(`|------|---------------|----------|---------|`);
    for (const [pageUrl, e] of firstSeen) {
      const secs = Number.isFinite(start) ? Math.round((Date.parse(e.timestamp) - start) / 1000) : null;
      lines.push(
        `| ${shorten(pageUrl)} | step ${e.n} | ${e.n} | ${secs === null ? "—" : fmtDuration(secs)} |`,
      );
    }
    lines.push("");
  }

  if (exit.kind === "completed") {
    lines.push(`## Outcome`);
    lines.push("");
    lines.push(`> ${exit.summary}`);
    lines.push("");
  }

  if (exit.kind === "abandoned") {
    const last = events[events.length - 1];
    lines.push(`## Drop-off risk — this prospect walked out`);
    lines.push("");
    lines.push(`- **Walked out at step:** ${last?.n ?? "?"} (${last?.url ?? url})`);
    lines.push(`- **In their own words:** "${exit.reason}"`);
    lines.push(`- **Wanted answered:** "${exit.question}"`);
    lines.push("");
  }

  if (exit.kind === "guardrail") {
    lines.push(`## Terminated by guardrail`);
    lines.push("");
    lines.push(`${exit.detail}`);
    lines.push("");
  }

  if (exit.kind === "couldnotrun") {
    lines.push(`## Could not run`);
    lines.push("");
    lines.push(`${exit.detail}`);
    lines.push("");
    lines.push(`This is our side — an unreachable page, a model that stopped answering, or a setup error. It is not evidence that the site is broken. Fix the cause and rerun this persona.`);
    lines.push("");
  }

  if (assertions?.length) {
    const held = assertions.filter((a) => a.ok).length;
    lines.push(`## Assertions (${held}/${assertions.length} held)`);
    lines.push("");
    for (const a of assertions) {
      lines.push(`- ${a.ok ? "✅" : "❌"} **${cell(a.label)}** — expected \`${cell(a.expected)}\`${a.ok ? "" : `, found ${cell(a.found)}`}`);
    }
    lines.push("");
  }

  lines.push(`## Journey Timeline`);
  lines.push("");
  lines.push(`| # | At | URL | Thought | Emotion | Confusion | Action |`);
  lines.push(`|---|----|-----|---------|---------|-----------|--------|`);
  const start = Math.min(...events.map((e) => Date.parse(e.timestamp)).filter(Number.isFinite));
  for (const e of events) {
    // seconds since the journey began — shows where a persona stalled
    const at = Number.isFinite(Date.parse(e.timestamp)) && Number.isFinite(start)
      ? `+${Math.round((Date.parse(e.timestamp) - start) / 1000)}s`
      : "—";
    lines.push(
      `| ${e.n} | ${at} | ${shorten(e.url)} | ${cell(e.decision.thought)} | ${cell(
        e.decision.emotion,
      )} | ${e.decision.confusion}/10 | ${actionLabel(e.decision.action)} |`,
    );
  }
  lines.push("");

  const confusions = events.map((e) => e.decision.confusion);
  if (confusions.length > 1) {
    lines.push(`## Confusion Curve`);
    lines.push("");
    lines.push("```");
    lines.push(sparkline(confusions));
    lines.push("```");
    lines.push("");
  }

  const evidence: string[] = [];
  if (media?.videoMp4) evidence.push(`- **Video:** ${media.videoMp4} (plays everywhere)`);
  else if (media?.videoWebm) evidence.push(`- **Video:** ${media.videoWebm} (VP8 — open in a browser or VLC)`);
  if (media?.filmstrip) evidence.push(`- **Filmstrip:** ${media.filmstrip} (every step with its thought)`);
  if (evidence.length > 0) {
    lines.push(`## Evidence`);
    lines.push("");
    lines.push(...evidence);
    lines.push("");
  }

  lines.push(watermark(siteSlug(url)));
  return lines.join("\n");
}

function exitVerdict(exit: ExitReason): string {  switch (exit.kind) {
    case "completed":
      return `COMPLETED`;
    case "abandoned":
      return `ABANDONED - ${exit.reason.slice(0, 80)}`;
    case "guardrail":
      return `TERMINATED (guardrail)`;
    case "couldnotrun":
      return `COULD NOT RUN - not evidence about the site`;
  }
}

function actionLabel(a: StepEvent["decision"]["action"]): string {
  switch (a.type) {
    case "click":
      return `click ${a.target}`;
    case "type":
      return `type into ${a.target}`;
    case "select":
      return `select "${a.value}"`;
    case "scroll":
      return `scroll ${a.direction}`;
    case "back":
      return `go back`;
    case "wait":
      return `pause ${a.seconds}s`;
    case "check_email":
      return `check inbox (${a.seconds}s)`;
    case "complete":
      return `COMPLETE`;
    case "abandon":
      return `ABANDON`;
  }
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160);
}

function shorten(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search || "/";
  } catch {
    return url;
  }
}

function sparkline(values: number[]): string {
  const blocks = " ▁▂▃▄▅▆▇█";
  return values
    .map((v) => blocks[Math.min(blocks.length - 1, Math.round((v / 10) * (blocks.length - 1)))])
    .join("");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * One self-contained page per session: every step's screenshot with its
 * thought, so a founder sees the journey without opening the video.
 * No external assets (opens from disk, no server), shot paths are
 * `shots/<file>` relative to the session dir. Steps without a screenshot
 * (screenshot failed that step) render as a text card rather than a
 * broken image — a missing shot is still a step worth reading.
 */
export function generateFilmstrip(opts: { persona: Persona; url: string; events: StepEvent[] }): string {
  const { persona, url, events } = opts;
  const cards = events.map((e) => {
    const shot = e.screenshot ? `shots/${basename(e.screenshot)}` : null;
    const caption = `Step ${e.n} · ${e.decision.emotion} · confusion ${e.decision.confusion}/10`;
    const visual = shot
      ? `<a href="${escHtml(shot)}"><img src="${escHtml(shot)}" alt="Step ${e.n} screenshot" loading="lazy"></a>`
      : `<div class="missing">no screenshot for this step</div>`;
    return `<figure><figcaption><strong>${escHtml(caption)}</strong><br><span class="url">${escHtml(e.url)}</span></figcaption>${visual}<blockquote>${escHtml(e.decision.thought)}</blockquote></figure>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Filmstrip — ${escHtml(persona.name)} — ${escHtml(url)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:24px;background:#fff;color:#111}
figure{border:1px solid #ddd;border-radius:8px;padding:12px;margin:0 0 16px}
img{max-width:100%;border:1px solid #eee}
.missing{padding:24px;background:#f6f6f6;color:#666;text-align:center}
.url{color:#555;font-size:.85em;overflow-wrap:anywhere}
blockquote{margin:8px 0 0;padding-left:12px;border-left:3px solid #888;color:#333}
</style>
</head>
<body>
<h1>Filmstrip — ${escHtml(persona.name)} (${escHtml(persona.temperature)})</h1>
<p>${escHtml(url)} · ${events.length} steps · simulated prospect: risk signal, not measured traffic</p>
${cards.join("\n")}
</body>
</html>`;
}
