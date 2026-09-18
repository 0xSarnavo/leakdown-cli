# Changelog

Every user-visible change gets a line under **Unreleased** in the same commit.
Cutting a release moves that block under a version heading, bumps `package.json`,
tags `v<version>`, and publishes the same text as a GitHub Release.

## Unreleased

## 0.8.0 — 2026-09-18

**The yes/no rulings can come from somewhere else.** Three of this tool's
questions have a yes or no answer rather than prose: was the goal reached, which
flow checkpoints were reached, and does the page show an expected value in other
words. Point `LEAKDOWN_JUDGE` at a module that exports `createJudge()` and it
answers those instead of the AI CLI; its tokens are recorded apart from the
brain's, as `usageJudge` in `meta.json`. Unset, which is the default, nothing
changes. A judge that is missing, broken or slow never ends a session — the
ruling falls back to the same "inconclusive" path a failed model call takes.

**Every completion claim now leaves its page behind.** A session that claims it
is done writes `verifications.jsonl` — the page the judge read, the verdict it
gave, and any `--expect` results. A rejected completion used to say only that it
was rejected; now you can read the page and see whether the judge was right, and
past runs can be replayed against a new judge without re-visiting the site.

## 0.7.0 — 2026-09-17

**Goal tests can assert values.** `--expect "total=$96.00"` (repeatable, with
`--goal`) makes a completion count only when the page really shows the value;
the report's Assertions section quotes what it found instead.

**"Could not run" is its own verdict.** An unreachable page, a model that stops
answering, or a setup error now ends a session as *could not run* — a neutral
section in `report.md`, its own count in `AGGREGATE.md`, `DETAIL.md` and
`RUN.md` — instead of reading as a guardrail stop. `--goal` exit codes are now
0 (all passed), 1 (a session failed on the site), 2 (could not run), so CI can
tell the app from the infrastructure.

**Write your own flows.** `flows/<id>.yaml` (or `runs/<site>/flows/`) holds a
journey as ordered steps; `leakdown --validate-flow [file]` checks them without
a browser and lists what is wrong, file by file. `leakdown <url> --flow-file <id>`
runs against one: every session is scored step by step, and a `stop_after` step
with `expect` text ends the session COMPLETED the moment that text is on screen.
See `flows/example-signup.yaml`.

**A/B on your laptop.** `--variant <slug>` labels a run ("control",
"new-pricing"); run the same personas once per variant, then
`leakdown --compare <site>` puts the newest run of each side by side in
`runs/<site>/COMPARE.md`: sessions, completed, leaked, an interval per variant,
where each lost people, and one verdict — which leaks more, or "no meaningful
difference" when the intervals overlap. Plain runs are unchanged.

**Ready for outside testers.** `leakdown --version`; a typo'd flag is now an
error instead of being ignored (`--headles` used to run a headed browser).
Every report and `meta.json` carries the version. After a report,
`runs/<site>/VERDICTS.md` is written once with a `?:` line per wall for you to
mark `real:` or `false:`. `--doctor` says whether `ffmpeg` was found. The
persona rule now also forbids publishing, support chat and contacting third
parties. `video.webm` is deleted once `video.mp4` exists (37% less disk per
session). Scrolling no longer waits for the network to go idle — a long page
is up to a minute faster per session. README says what is stored, how to delete
it, and that you may only test sites you own or have permission to test.

**Reports say how sure they are.** Every wall in `AGGREGATE.md` and every
element ref cited by more than one session now carries its count with a 95%
interval ("3/5 sessions · 60% [23–88%]"). Under three sessions it says "too
few to call" instead of a number.

## 0.6.0 — 2026-09-15

**Sharper evidence: retina screenshots, calmer recordings, playable video, filmstrip.**
Step screenshots are now retina (2560px) with settled webfonts and no cursor
flicker; recordings run with reduced motion. Every session also saves
`video.mp4` (plays in QuickTime/Safari — needs `ffmpeg` installed, else `.webm`
as before) and `filmstrip.html` (every step with its thought, no video needed);
`report.md` links both under Evidence.

**Rebrand to Leakdown.** The bin is `leakdown` (was `client-simulator`).
Env vars are `LEAKDOWN_*` — `LEAKDOWN_IMAP_HOST/USER/PASS`,
`LEAKDOWN_MAIL_DOMAIN`, `LEAKDOWN_ORDERS_URL/TOKEN` — with the old
`CLIENTSIM_*` names still working for one minor with a deprecation
warning. Machine-local state moved to `.leakdown-state.json`.
`package-lock.json` is committed, so installs are reproducible.

## 0.5.0 — 2026-09-14

**Where runs land.** One folder per CLI invocation: `runs/<site>/<date>/<time>/`,
with three seats inside — `wide/`, `verify/`, `deep/` — and one folder per model
in each. Every run writes `RUN.md` (seat, model, sessions, exits, tokens,
minutes), `AGGREGATE.md`, `DETAIL.md`, and, after `--ladder`, `VERIFIED.md`
(the verifier's panels) and `REPORT.md` (the writer's). The site level keeps
`SITE.md`, `MAP.md`, personas, and a copy of the newest run's five files.
Sessions from any older layout are still found.

**Getting around.** `--history [site]` lists runs with their one number.
`--report`, `--fix` and `--replication` take a site name (its newest run) or
`site/date/time`. A run ends by printing the one number and the first wall.
The wizard leads with the ladder and picks a run before a session. `--help`
opens with the three commands people run.

**Runs.** Every run re-crawls the site once and asks whether to rebuild the brief
and personas when the page list changed; `--no-map` skips it. `--ladder` resumes
only an unfinished ladder run from the same day. The verifier's panels go to
`verify/<model>/`, not into the sessions it reviewed. `--random <n>` replaces
`--runs <n>` (the old spelling still works). `--by-model` is gone: per-model
reports are always written.

**Personas.** Generated prospects and the three presets carry one-word,
lesser-known Greek or Roman mythological names (Momus, Egeria, Felicitas), so a
report never reads as if it quotes a real person.

**Fixed.** `--wide`'s value could be read as the site URL. A stray dash at the
start of a prompt no longer trips the claude CLI.

**Website** (deployed separately, not in this repo): privacy and terms pages, a
strict Content-Security-Policy, a real 404, robots and sitemap, corrected form
copy, and a measured note that Railway puts the real client address first in
`x-forwarded-for`.

## 0.4.0 — 2026-09-14

`map` stage (crawler's view of the site, broken links, pages nobody found), the
one-page `AGGREGATE.md` with `DETAIL.md` behind it, mechanical page checks beside
every persona, the mail watchdog (probe before every run, All Mail scanning,
unverified-verdict warnings), website orders (`--orders`, `--order`),
`analytics.json` calibration, the cached system prompt, `--ladder`, and the
alpha hardening: Chromium checked live, patience follows the flow, a usage limit
stops the queue and names itself.

## Earlier

`--goal` pass/fail runs for CI, `--mailtest` with staggered probes, log
replication, shareable PDFs, per-model funnels, stage banners and progress bars,
the expert panel in parallel, and the guard that never finishes booking a
meeting. See `DECISIONS.md` for the why behind each.
