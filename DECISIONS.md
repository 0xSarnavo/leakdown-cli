# DECISIONS.md

Why the code looks the way it does. Newest first.

**Read the "Tried and rejected" table at the bottom before proposing anything.** It
exists so nobody spends an afternoon rebuilding something that was already measured
and thrown away.

**When to add an entry:** a session made a real choice — rejected an alternative,
hit a constraint that shaped the design, or reversed an earlier decision. Not for
mechanical work. If you cannot fill in **Why**, there is no entry to write.

**Format:**

```markdown
## YYYY-MM-DD — one line, what changed
**Decided:** what was done.
**Why:** the problem, with the evidence that proved it.
**Rejected:** what else was tried, and what killed it. Omit if nothing was.
**Files:** paths.
**Ref:** commit hash, or "uncommitted".
```

---

## 2026-09-17 — Alpha hygiene: honest docs, a version everywhere, and the cheap speed-ups that cost no evidence
**Decided:** `--version`, and an unknown `--flag` is an error (a typo like `--headles` used to run a headed browser silently). README, `--help` and SECURITY.md say: only test sites you own or have permission to test. README gains "What it stores, and how to delete it" (every typed string is in session.jsonl; every received email is rendered to shots/; mailbox destroy MOVES mail to Trash). The persona rule now also forbids publishing, support chat and third-party contact (prompt-only, said so). `VERDICTS.md` is written once per site with a `?:` line per wall. Version in every watermark and meta.json. SMTP password moves from curl's argv to a 0600 config file. `prepare: tsc` so a git install has a `dist/`. Optimisations: scroll/wait settle 300ms instead of domcontentloaded + networkidle(6s) + 1s; per-ref measurement runs in parallel with one page evaluate; screenshot in parallel with the snapshot; `video.webm` deleted once the mp4 exists; tsc incremental.
**Why:** three read-only audits before the alpha (launch readiness, legal, performance) — full text in `local/LAUNCH-AUDIT-2026-09-17.md`. Measured 2026-09-17: a long page takes ~14 scrolls and each waited up to 7s for a networkidle that never fires on pages with beacons; the mp4 is 60% of the webm and every player opens it, so keeping both was 1.6× the video per session; the snapshot's four round trips were independent.
**Rejected (for now, need a measured before/after on one persona since they change what the persona reads):** capping older-step thoughts in the history (−8–12% cache-write per session); pruning the verification snapshot (adjacent to a rejected row); trimming resent inbox text after the code was used (a vanishing code once broke a magic-link flow); 1x screenshots for the persona.
**Files:** `src/version.ts` (new), `src/cli.ts`, `src/types.ts`, `src/doctor.ts`, `src/browser/driver.ts`, `src/session.ts`, `src/log/report.ts`, `package.json`, `tsconfig.json`, README, SECURITY.md, AGENTS.md.
**Ref:** uncommitted (0.7.0).

## 2026-09-17 — Verdicts a CI can trust: asserted values, a neutral could-not-run, and how sure a count is
**Decided:** (1) `--expect label=value` on goal runs: a completion claim counts only when every expected value is a whitespace-insensitive substring of the full snapshot; a failed check costs no verification call, the session continues with a note, and `report.md` gets an Assertions section quoting expected vs. the snapshot line that mentions the label (whole word first, so "Total" is not "Subtotal"). The expectations are appended to the persona's goal — persona and verifier both read them, no prompt change. (2) A fourth exit kind, `couldnotrun`: unreachable URL, a brain that fails at any step, a setup failure before the session (mailbox, browser). Rendered neutral everywhere, counted apart, exit code 2 for `--goal` (1 stays "the site failed somebody"). Setup failures used to leave no meta.json at all; the tally now lives in `finally` so every session gets a verdict. (3) `src/log/stats.ts`: Wilson 95% intervals and `lift()` as pure functions; every wall and replicated ref carries "3/5 sessions · 60% [23–88%]"; under 3 sessions "too few to call". (4) Hand-written flows as YAML (`flows/`, `runs/<site>/flows/`), validated without a browser; `stop_after` must name a step with `expect` text, and that text on screen ends the session COMPLETED and marks the step reached mechanically. (5) `--variant` + `--compare <site>` → `runs/<site>/COMPARE.md`.
**Why:** a goal run that "felt done" is not a check; CI needs to tell "the page shows $120 not $96" from "the model was down". Brain failures at step 7 were filed as guardrail — the site never got a chance, so they are not evidence about it either. Counts of 2 and 3 were read as rates; the interval says what they can support. Flows drafted by the model need a review gate; a flow the operator wrote does not. Runs are folders (2026-09-14), so two variant runs cannot share an aggregate — the comparison needed a place to meet.
**Rejected:** regex or numeric parsing in `--expect` (substring is predictable; a founder can read it); per-step AI checks for the stop point (one call per step — the stop needs page text instead); an N-variant matrix (exactly two are ranked; more are listed); marking the stop step reached only when the scorer agrees (the page showing the text is better evidence than the model's reading of a trail); mirroring the website's routes by importing them (the public repo must not depend on the sibling repo — fixtures carry file:line instead).
**Files:** `src/types.ts`, `src/session.ts`, `src/cli.ts`, `src/log/report.ts`, `src/log/aggregate.ts`, `src/log/stats.ts`, `src/site/flow.ts`, `src/site/flow-load.ts`, `src/runs.ts`, `src/experts/types.ts`, `flows/example-signup.yaml`, tests beside each.
**Ref:** uncommitted (0.7.0).

## 2026-09-15 — Evidence quality: retina shots, calm recordings, mp4 via any ffmpeg, filmstrip per session
**Decided:** `deviceScaleFactor: 2` screenshots (2560px) with `fonts.ready` wait and hidden caret; `reducedMotion: reduce` on every context; `saveVideo()` also writes H.264 `video.mp4` (faststart) next to `video.webm` using system ffmpeg first, else Playwright's bundled copy; every session gets `filmstrip.html` (each step with its thought, self-contained, no server) linked from a new Evidence section in `report.md`. `report.md` is now written after the video finalizes. All ffmpeg failures fall back to webm-only, never fail the run.
**Why:** screenshots looked soft on modern screens and in PDFs (1x capture, not a browser defect); VP8 webm opens nowhere outside browsers/VLC; founders needed a no-video way to see journeys. Measured: 2560x1600 PNG, mp4 with moov before mdat (faststart verified byte-level).
**Rejected:** hosted browser services for quality (same Chromium renders same pixels — sharpness is capture settings, not the binary; hosted only earns its place for fleet scale/geo/stealth, parked for the Pro era); system-ffmpeg prerequisite (rejected as a hard dep — probed, not bundled, bundled copy can't encode H.264 anyway: Playwright's build is VP8/PNG-only); reusing the system `ffmpeg` name blindly (PATH checked first, bundled second, both covered by tests).
**Files:** `src/browser/driver.ts`, `src/browser/video.ts`, `src/browser/video.test.ts`, `src/log/report.ts`, `src/log/report.test.ts`, `src/cli.ts`.
**Ref:** uncommitted.

## 2026-09-14 — The site is a real application: policies, strict CSP, and a CLI that names things by site

**Decided:** the website has `/privacy` and `/terms` (operator named as an
individual in India, retention until the requester asks, the AI provider named
as a recipient of page content), a real 404, `robots.txt`, `sitemap.xml`, and a
Content-Security-Policy of `'self'` only — the page's script moved to `app.js`
to make that possible. Malformed JSON on `/request` answers 400 instead of 500.
The design went back to the earlier dark monospace frame, with the report as
the hero panel beside a terminal. In the CLI, `--report`, `--fix` and
`--replication` accept a site name (its newest run) or `site/date/time`;
`--history` lists runs with their one number and seats; a run ends by printing
the one number and the first wall; the wizard leads with the ladder and picks
runs before sessions; `--runs` is `--random` (the old spelling still parses);
`--no-map` skips the change check; the ladder marks its run folder and resumes
only marked runs.

**Why:** the request form collects email addresses from strangers, and a page
that does that without saying who holds them and how to get them deleted is not
one to send people to. Paths under the new layout are six segments deep, and
typing them after every run was the first thing that hurt.

**Measured, and reverted:** rate limiting by the *last* `x-forwarded-for` entry
looked like the textbook fix for header spoofing. On Railway it opened the hole
instead — 13 requests with rotating spoofed headers all passed, where the
first-entry code had blocked at 10 — because Railway's edge writes the real
client address first and appends the client's own header after it. The
first-entry code stays, with that measurement in the comment.

**Files:** `website/server.mjs`, `website/public/*` (untracked; deployed),
`src/cli.ts`, `AGENTS.md`

**Ref:** uncommitted

## 2026-09-14 — A run is a folder: `runs/<site>/<date>/<time>/<seat>/<model>/`

**Decided:** every CLI invocation that visits gets `runs/<site>/<date>/<time>/`.
Inside it three seats — `wide/`, `verify/`, `deep/` — each holding one folder
per model. `--report` groups sessions by run, writes `AGGREGATE.md` and
`DETAIL.md` for the run and for each `seat/model`, derives `VERIFIED.md` from
the verify seat's `FIXES.md` files and `REPORT.md` from the deep seat's, and
writes `RUN.md` (seat, model, sessions, exits, tokens, minutes) from the
sessions' own `meta.json`. The site level keeps what is known about the site
(brief, map, personas, flow, analytics) plus a copy of the newest run's five
files, so `runs/<site>/AGGREGATE.md` is always the latest report. `--by-model`
is gone; per-model reports are the default. The ladder's verifier writes into
`verify/<model>/` instead of into the sessions it reviewed, and `VERIFIER` /
`WRITER` are two constants. Every run re-crawls the site; a changed page list
asks whether to rebuild brief and personas. Presets and generated personas
carry one-word, lesser-known Greek or Roman mythological names.

**Why:** after today's ladder one site folder held 25 haiku sessions, 5 muse
sessions and one opus session in the same date folders, three sonnet panels
indistinguishable from haiku's own, and a `--by-model` flag nobody remembered
to pass. The operator wants each run readable as a unit — who sat where, what
came out — and the seats named by role because the models in them will change.
Rebuilding the brief on every run costs two model calls for a page that rarely
moves; the crawl is free, so it is the change detector. Persona names like
"Priya Desai" read as real people in a report sent to a stranger; a one-word
mythological name cannot be mistaken for one.

**Rejected:** `data/<model>/` at the site level (built earlier today, moved
away the same evening): it answered "how did haiku do" but not "what did this
run produce", and mixed runs from different days under one model. Also
rejected: a folder per day — two runs on one day would merge, and the ladder's
"pick up where it stopped" is a rule about an unfinished run, not a date.

**Files:** `src/runs.ts`, `src/runs.test.ts`, `src/cli.ts`, `src/log/pdf.ts`,
`src/log/aggregate.ts`, `src/persona/presets.ts`, `src/persona/generate.ts`,
`src/brain/prompt.test.ts`, `src/log/aggregate.test.ts`, `AGENTS.md`

**Ref:** uncommitted

## 2026-09-14 — Alpha hardening: Chromium checked live, patience follows the flow, repeats read as repeats

**Decided:** every visit launches and closes Chromium once before anything
else, whatever the doctor cache says. A persona's patience is at least
`2 × checkpoints + 2` when a flow is under test. A queue that stops on a
step-1 brain failure prints the reply text and says a usage limit looks like
this. The one-page report says, for any persona run more than once, how many
runs agreed, and counts owner verdicts from `runs/<site>/VERDICTS.md` (lines
starting `real:` or `false:`). `RESEARCH-oss-eval.md` moved to `local/` — it
was a personal dependency survey, not part of the tool.

**Why:** each is a thing that bit today. The doctor cache said Chromium
launched while playwright 1.63 wanted a build that was not installed. Both
hot personas ran out of a 10-step patience while correctly working through a
7-checkpoint signup. Eight sessions died on a usage limit that printed as
"no JSON". The edge persona's five runs disagreed 2.5/4 and a report that
shows one of them as the truth would mislead.

**Files:** `src/cli.ts`, `src/doctor.ts`, `src/log/aggregate.ts`,
`src/log/aggregate.test.ts`, `PLAN.md`, `README.md`, `package.json`

**Ref:** uncommitted

## 2026-09-14 — `--ladder`: the measured fleet as one command

**Decided:** `--ladder` runs the wide sweep (haiku by default, `--wide` to
split it, e.g. half muse-spark), `--report`, `topSessions()` over the
replication table (sessions citing the most refs that other sessions also
cite; walkouts with reasons when nothing replicates yet), the expert panel
on those three with sonnet, one opus visit as the persona behind the top
session plus its panel, and the report again over everything.

**Why:** the 96-session eval settled the seats (opus drives, haiku
corroborates, sonnet verifies, free models parked) and the site-g
retest settled the counts: haiku agreed with itself 3.80/4 on the hot
persona (5/5 same exit, same page) and 2.50/4 on the low-tech edge persona
(all signed up, then wandered). One wide run per persona is enough when the
filter demands a second citation before a finding counts. Until today the
ladder was a sequence of hand-typed commands in a local handoff file.

**Wide default is half haiku, half muse-spark**, the operator's call after
the measurement: with the harness fixes muse ran 5/5 full sessions on
site-g (0 brain failures, 0 timeouts, 0 stuck-loop kills, three nudges
all recovered, 4–12 minutes each, one reached the dashboard), where before
45% of its sessions were harness kills. Its limit is that every exit is
patience — it never leaves with a reason — so its half of the sweep gives
votes and trails, and haiku's half gives the quotes. `--wide haiku` restores
the single-model sweep.

**Files:** `src/cli.ts`, `src/log/replication.ts`, `src/log/replication.test.ts`, `AGENTS.md`

**Ref:** uncommitted

## 2026-09-14 — Calibration is a five-line file, not a connector

**Decided:** `runs/<site>/analytics.json` — exit pages with shares, device
mix, entry sources, one note — validated by zod and rendered into the
persona-generation prompt as "what real visitors do". Absent means fully
synthetic. No PostHog or Clarity code yet.

**Why:** the open question is whether calibrated personas find more true
problems than synthetic ones (Q6). That test needs one site's numbers, and a
founder can type five lines from a dashboard in two minutes; a connector is
a week of plumbing that would be built before knowing whether the numbers
change anything. The file is also the exact shape a connector would write,
so nothing is thrown away if the answer is yes.

**Files:** `src/site/analytics.ts` (new), `src/site/analytics.test.ts` (new),
`src/persona/generate.ts`, `src/cli.ts`, `AGENTS.md`

**Ref:** uncommitted

## 2026-09-14 — Orders: the website stores requests, the operator runs them by hand

**Decided:** the site gets a form (URL, email, consent). `POST /request`
writes one JSON object per order into a private Railway bucket, keyed by day
and email hash so a repeat the same day overwrites instead of piling up.
`GET /orders` and `POST /orders/:id` sit behind a bearer token. The CLI
lists them (`--orders`) and fulfils one at a time (`--order <id>`): the
normal pipeline, `--pdf`, one email with the PDF attached through the same
curl SMTP path `--mailtest` uses, then the order is marked done. `--reject`
sends one line instead. No poller, no worker, nothing runs on its own.

**Why:** the operator has no API key and a laptop; the website is on
Railway. A poller that runs whatever arrives makes every spam request cost
a real run on a personal subscription. A stored order costs a row. The
S3 signer is 30 lines of `node:crypto` in the server rather than an SDK
because the site has no dependencies and the bucket is one prefix of small
JSON files.

**Rejected:** a Railway volume with `orders.json` — the operator chose the
bucket (survives redeploys and service moves). Also rejected: running the
order automatically after approval; approval and running are the same
command on purpose.

**Files:** `src/orders.ts` (new), `src/orders.test.ts` (new), `src/cli.ts`,
`website/server.mjs`, `website/public/index.html`, `website/public/styles.css`
(the last three are untracked; the site deploys straight to Railway)

**Ref:** uncommitted

## 2026-09-14 — The mailbox is probed before every run, and the poller reads All Mail

**Decided:** `ensureMailProbe()` runs once a day, only for runs that mint
mailboxes: mint a box, SMTP one message to it, poll up to 5 minutes, record
`{ok, latency}` in the state file and on every session's `meta.json`. That
probe proves SMTP, credentials and the IMAP box — **not** that the catch-all
forwarder delivers, because Gmail keeps our own Sent copy in All Mail and the
poller finds it either way (the second review caught this). Inbound delivery
is proven only by mail from another sender, which `ImapProvider` records as
`lastInboundAt` whenever a session receives one. After a queue, two or more
sessions that gave up over email with no inbound mail seen by anyone writes
`runs/<site>/MAIL-WARNING.md`, and `AGGREGATE.md` opens with an "email
verdicts unverified" warning. `--mailtest` now exits 1 when nothing
lands, so `--mailtest && <sweep>` stops. `ImapProvider.foldersToScan` uses
the `\\All` special-use folder instead of INBOX where the server has one.

**Why:** the first site-g re-run today failed its mailtest — both probes
were delivered but sat in Gmail's All Mail, because Gmail files a message you
send to your own address through a forwarder as Sent and never shows it in
INBOX. The poller scanned INBOX and Junk only, so the check reported "not
reached within 5 minutes" against a working mailbox, and the chain went on
to spend a sweep whose email verdicts would have been meaningless. With the
folder fix the same probes land in 6s and 70s. The probe-before-run exists
so that this class of failure is stamped on the sessions it affects rather
than discovered afterwards.

**Rejected:** editing session meta after the run to mark them unverified.
Sessions are immutable; the marker file and the pre-run stamp carry the same
information without touching them.

**Also, found by the re-run:** the ImapFlow client had no `error` listener,
so a socket Gmail dropped between polls (`read ETIMEDOUT`) was an uncaught
exception that killed the whole process at alex's first inbox check. One
listener; `withClient` already reconnects on the next call.

**Also:** the per-call brain timeout went 180s → 300s for every CLI (the
free models sit near 2 min/step). With three attempts and brain time waived
from the session clock, a hung CLI can now cost 15 minutes per step with no
session ceiling; acceptable until a run shows it, then cap total waived time.

**Files:** `src/mail/imap.ts`, `src/doctor.ts`, `src/cli.ts`,
`src/brain/adapters/cli-brain.ts`, `src/log/aggregate.ts`, `AGENTS.md`

**Ref:** uncommitted

## 2026-09-14 — A ruler next to every persona: mechanical page checks

**Decided:** every snapshot now carries an audit — controls the accessibility
tree exposes with no name, visible controls under 24px on a side (WCAG 2.5.8),
whether the document is wider than the viewport, whether a viewport meta tag
exists. `measure()` already resolved every ref's rect, so sizes cost nothing
extra; the layout facts are one `page.evaluate`. The session records the audit
on the first step that lands on each URL, and the short report unions them
per page under "Measured on the page". No dependency added.

**Why:** the eval's strongest finding — site-c' four unnamed signup buttons —
took 14 sessions across 5 models to establish, and a screen-reader persona to
notice at all. A ruler finds it on the first page load, and a finding with a
measurement beside it ("28×28px, minimum 24") is the tier the owner can
verify without trusting any persona. It is also what separates "the persona
felt lost" from "the button is too small to tap".

**Rejected:** axe-core. One dependency for ~90 rules, most of which produce
noise the report would then have to filter; the four checks here are the
ones the sweep actually needed. Add it when a check is wanted that a few
lines cannot do.

**Files:** `src/browser/audit.ts` (new), `src/browser/audit.test.ts` (new),
`src/browser/driver.ts`, `src/session.ts`, `src/types.ts`,
`src/log/aggregate.ts`, `AGENTS.md`

**Ref:** uncommitted

## 2026-09-14 — The persona prompt is two halves, and AGGREGATE.md is one page

**Decided:** `buildPrompt` is now `buildSystemPrompt` + `buildUserPrompt`. The
system half — who the persona is, how to behave, the rules, the reply schema —
never changes within a session; claude gets it through `--append-system-prompt`
so the CLI's prompt cache covers it, and brains without a system flag get the
two halves joined as before. The user half is what changes per step: URL, step
number, screenshot path, inbox, failed-action hint, history, the page.

`AGGREGATE.md` became the short report a site owner reads: one number, the
top three pages prospects walked out of with who, one quote and a "check it
yourself" line built from the last two thoughts, the crawler's broken links, a
developer section with element refs tiered by how many sessions cite them
(and a "seen once, not counted" list), and the map's unreached count. Every
table that used to be the aggregate is `DETAIL.md`. Every rendered file ends
with the same watermark line; PDFs carry it in the footer. Nothing here calls
a model.

**Why:** one opus session measured 92% of its cost in cache writes and 2% in
output; the whole prompt was one user message that changed every step, so
none of ours was ever cached. A live call confirmed the appended system prompt
is written once (`cache_creation_input_tokens` 5596, 1h TTL) and read after.
On reports: the operator's own judgement of the old aggregate was "data
dump"; the three hand-written BRIEF.md files were what a founder actually got
sent, and their shape is what the short report copies. The "seen once" list
is there so the owner sees what was filtered, not just what survived.

**Paid for twice:** the retest run hit the subscription's usage limit mid-queue.
Every call for ~30 minutes returned a notice instead of JSON; the harness
filed it as "no JSON object found", three attempts, next persona — eight
sessions gone in minutes, each recorded as its own brain failure. Now a
brain that fails before step 1 stops the rest of the queue ("the brain is not
answering; rerun later"), and the error carries the first 200 characters of
the reply, so the next outage names itself.

**Paid for once already:** the first user half began with `- Current URL:`,
and `claude -p "<prompt>"` read the leading dash as an option (`unknown
option`). Ten sessions died at step 1 with zero calls before anyone noticed.
The user half now opens with a heading, the claude adapter prefixes a space
to any dash-leading prompt, and a test asserts neither half starts with `-`.

**Rejected:** an LLM-written brief as the default report. It is the paid
deliverable and it can invent; the mechanical page is always true. Also
rejected: schema instructions repeated in the user half for small models —
one line pointing at the system half costs nothing and the schema stays
cached.

**Files:** `src/brain/prompt.ts`, `src/brain/adapters/cli-brain.ts`,
`src/brain/adapters/claude.ts`, `src/log/aggregate.ts`, `src/log/report.ts`,
`src/log/pdf.ts`, `src/cli.ts`, `AGENTS.md`

**Ref:** uncommitted

## 2026-09-14 — A `map` stage: the crawler's view of the site, so the aggregate can say what nobody found

**Decided:** a new stage between `site` and `personas`. `mapSite()` crawls two
clicks from the landing page plus `sitemap.xml`, same registrable domain only,
200 pages at most, no brain. Every page is tagged by kind (booking, payment,
auth, app, pricing, legal, docs, blog, marketing) from its URL, and off-site
booking or payment links are recorded without being crawled. `runs/<site>/
map.json` is the machine copy, `MAP.md` the readable one. The aggregate then
adds three sections: booking and payment surfaces and whether any prospect
reached them, links the crawler found broken (404 or no page), and pages no
prospect ever landed on, grouped by kind.

**Why:** the reports could say where prospects walked out but not what they
never saw. On site-c.com the first crawl listed 104 of 116 pages that 28
sessions never touched, and 9 docs links that return 404 — a prospect who
clicks one is stuck, and no session had happened to. Booking and payment pages
are the ones the guard refuses to commit on, so knowing they exist before a run
says what "reached the wall" will look like.

**Paid for on the first real site:** site-g's sitemap alone filled the
200-page cap, so the crawl found nothing new and the console, privacy and
terms pages were dropped — the crawl now runs first and the sitemap fills what
is left. And 24 pages the crawler could not render in 15s were reported as
broken links; a page that failed to render now gets one plain request, and
only a 4xx/5xx or an unreachable host counts as broken. A docs page whose path
says `/billing` is documentation, not a checkout — the same confusion the URL
blocklist died of.

**Known limit, accepted:** the crawler follows `<a href>`. A control that
navigates from JavaScript (site-c' "Book a Demo" is not an anchor in headless
Chromium) is invisible to it, and to `sitemap.xml`. The personas run in the same
browser, so the map and the sessions disagree only where a human would see
something neither does.

**Rejected:** giving the map to personas. A prospect who knows the site's page
list is not a first-time visitor — the same reason cold personas never see the
brief.

**Files:** `src/site/map.ts` (new), `src/site/map.test.ts` (new), `src/cli.ts`,
`src/log/aggregate.ts`, `AGENTS.md`

**Ref:** uncommitted

## 2026-09-09 — Email patience raised to 5 minutes; mailtest sends staggered probes

**Decided:** persona email patience now defaults to 300s (presets 300/330/360,
was 120/180/240), and `--mailtest` sends two SMTP probes at t=0 and t=60s,
prints each arrival's latency, and waits 5 minutes before declaring mail
"not reached within 5 minutes".

**Why:** real deliveries have taken up to 5 minutes. A persona that gives up
at 2–4 minutes files "the email never arrived" against a site whose email was
in flight — the exact false positive that produced seven wrong findings once
already. One probe at t=0 also proves nothing about whether delivery still
works a minute in; two staggered probes with measured latency do.

**Files:** `src/persona/presets.ts`, `src/persona/load.ts`, `src/session.ts`,
`src/cli.ts`, `AGENTS.md`

**Ref:** uncommitted

## 2026-09-08 — `--goal`: pass/fail instead of "how did it feel"

**Decided:** `--goal "<text>"` runs the queue as a goal test: every queued
persona gets the asserted goal in place of its own, `--steps <n>` caps the
session, and the process exits 0 only when every session ends `completed` —
which already requires `verifyGoal` to agree, so the pass condition costs no
new machinery. Output stays a persona session (thoughts, video, report); only
the goal and the exit code change.

**Why:** a persona run ends in "confusion 6/10, felt lost" — not falsifiable,
no reason to re-run. "Log in and get an API key: FAIL at step 9" is, and an
exit code is what CI consumes. Personas already carried a `goal` field the
verifier judged; the flag was the missing 30 lines, not a new subsystem.

**Rejected:** a separate goal-test mode with its own loop. The session loop
already terminates on complete/abandon/guardrail; a second loop would drift.

**Files:** `src/cli.ts`

**Ref:** uncommitted

## 2026-09-08 — mailtest sends itself the test email

**Decided:** `--mailtest` now SMTP-sends one message (via `curl`, same
credentials, `smtp.` swapped for `imap.`) to the mailbox it just created,
instead of only waiting for the operator to send one. Manual send remains the
fallback when SMTP fails.

**Why:** the 2026-09-08 preflight "passed" by creating and destroying a box —
while proving nothing about inbound delivery, which is the exact thing seven
"the magic link never arrived" findings depend on. A health check that skips
the failure mode it exists for is decoration.

**Rejected:** an SMTP library. curl does SMTP, execa is already a dependency,
and this is a health check, not a mail stack.

**Files:** `src/cli.ts`

**Ref:** uncommitted

## 2026-09-04 — Shareable PDFs, per-model funnels, live progress

**Decided:** three operator-facing additions from a real batch session.
- `--pdf [sites]` renders one send-ready PDF per site (the funnel plus one
  model's expert reports) via Chromium's `page.pdf()` — no new dependency, and
  a ~100-line known-subset markdown→HTML renderer rather than a markdown engine
  for a page read once. Scoped to one model (best present, or `--model`) because
  a full sweep bundles 40+ sessions into 268 pages nobody sends to a founder.
- `--report --by-model` writes `AGGREGATE-<model>.md` next to the combined
  `AGGREGATE.md`, so a sweep reads both "how did the site do" and "how did opus
  do vs haiku".
- Every run prints stage banners (`▸ stage 3/5 · visit`) and progress bars;
  the concurrent agents and the parallel expert panel each advance a bar as
  they finish — the only honest progress signal once work runs in parallel.

**Why:** the model sweep made all three necessary. Markdown reports are not
something you hand a client; a single combined funnel hides which model to
trust; and a headless run of 6 concurrent agents was an unreadable wall of
interleaved thoughts.

**Not built (parked in local/EVAL-PROMPT.md, untracked):** a fable-judged eval that
scores each model's completion, finding quality, guardrail behaviour and report
usefulness. Left as a prompt to run later, deliberately — the judge model is
kept out of the swept set so it scores neutrally.

**Files:** `src/log/pdf.ts` (new), `src/log/pdf.test.ts` (new), `src/cli.ts`

**Ref:** uncommitted

## 2026-09-04 — Booking commits join payment and SSO in the action guard

**Decided:** `blockedAction` refuses scheduler commit controls — "Schedule
Event", "Confirm meeting", "Book this slot", "Book now" — and a bare
"Confirm"/"Schedule"/"Book" when the URL or the snapshot says scheduler
(cal.com, Calendly, SavvyCal, Chili Piper, timezone chrome). `blockedAction`
gained an optional `url` parameter for that context. Openers ("Book a demo",
"Request access") stay clickable and the booking form stays fillable — only
the commit is refused, mirroring how checkout is handled.

**Why:** not hypothetical. During the model sweep, two sessions on site-b.so
completed real cal.com bookings — "Site B Discovery 20m", a real founder's
calendar, a fake name, an ephemeral email. The demo-gate was already the
finding by the time the calendar loaded; finishing the booking added nothing
to the report and put a meeting on a human's schedule.

**Rejected:** blocking bare "Confirm" everywhere. It is the standard button on
OTP screens, and refusing it would break the mail flow the same way blocking
"Security code" once did — hence the scheduler-context gate.

**Files:** `src/safety.ts`, `src/session.ts`, `src/types.ts`, `AGENTS.md`

**Ref:** uncommitted

## 2026-09-04 — One malformed persona no longer discards the generated set

**Decided:** persona generation validates per element: bad entries are dropped
with a printed reason, and only an all-bad reply fails.

**Why:** the first multi-model sweep caught it in minutes. haiku answered
`tech_comfort: "medium-high"` on 4 of 10 personas and `z.array(...).parse`
threw the whole set away — the run silently fell back to 3 built-ins, which is
exactly the wrong queue for a sweep comparing models on identical prospects.
Same failure class as the expert scorecard (`24de073`): weaker models bend
enums, and the harness's job is to keep the valid majority.

**Files:** `src/persona/generate.ts`

**Ref:** `6322ef9`

## 2026-09-04 — The brief's scrape doubles as a bot-wall scout

**Decided:** `botWallMarker()` checks the scraped page text for known walls —
Cloudflare's "Just a moment", browser checks, captcha, "verify you are human",
PerimeterX, DDoS-Guard. A hit writes `runs/<site>/BLOCKED.md` and every run
skips the site with one line until the marker is deleted or `--plan` re-checks.
Default persona set went 5 → 10 in the same session (operator request, for
whole-portfolio batch runs; `MAX_RUNS` was already 10).

**Why:** batch-running ten sites at ten agents each, a bot-walled site would
send every persona into the same interstitial — ten identical GUARDRAILs at
full patience cost, filed as findings about a page nobody ever saw. One scout
read is enough to know; the scrape for the site brief already is that read, so
detection costs nothing new.

**Files:** `src/site/brief.ts`, `src/cli.ts`

**Ref:** uncommitted

## 2026-09-04 — Reports warn about risk; they do not claim measurement

**Decided:** every rendered surface says what a simulation can say: "N simulated
prospect(s) walked out here; real visitors may too", never "users dropped here".
Both reports carry a "Read as: risk signal, not measured traffic" line, and the
expert panel is told the same in `trailSummary` — one edit that reaches all
seven prompts, since every expert renders the trail through it.

**Why:** the operator shows these reports to site owners. A tool that has sent
five language models through a page has evidence of risk, not of user
behaviour, and phrasing it as the latter is the report over-claiming — the same
class of error as describing a prompt-only rule as enforced.

**Deliberately narrow:** the exit kinds (`completed`/`abandoned`/`guardrail`)
and every schema are untouched. Renaming them would make every session on disk
— including the 931MB backup — unreadable. Framing lives in the renderers.

**Files:** `src/log/report.ts`, `src/log/aggregate.ts`, `src/experts/types.ts`

**Ref:** uncommitted

## 2026-09-04 — A session has a wall-clock ceiling, and waiting is not charged

**Decided:** `--time <minutes>` (default 20, max 120) hard-stops a session as a
guardrail. Time spent polling mail and in deliberate `wait` actions is
excluded from the clock; the exit detail says how much was excluded.

**Why:** sessions had no time bound at all — only step bounds — so a slow site
plus a slow brain could run indefinitely. But charging the clock for mail
delivery would recreate the bug paid for twice already (OTP keystrokes,
quoted-printable codes): the site being blamed for the harness's mail path.
Same logic that made scrolling free. `patience_steps` is untouched — it stays
the in-character "I give up", the clock is infrastructure.

**Files:** `src/session.ts`, `src/cli.ts`

**Ref:** uncommitted

## 2026-09-04 — The flow under test is stated, reviewed, and scored once per session

**Decided:** `--flow "<intent>"` (or the interactive question) has the brain
draft 2–8 ordered checkpoints from the site brief into `runs/<site>/FLOW.md`,
behind a review gate — use / regenerate / edit the file / no flow. The flow
shapes persona *generation* (goals become personal variations of it). After a
session, ONE un-retried call judges which checkpoints were reached, into
`meta.json`, the session report, and a funnel table in `AGGREGATE.md`
("checkpoint 3: 1/5 reached"). No flow file → the tool behaves exactly as
before.

**Why:** the operator knows what they want tested; the tool only knew
temperatures. And the aggregate could count verdicts but not say *where along
the journey* prospects fell out — the funnel is the first cross-session view
of the same wall (PLAN.md's top open problem, partially).

**Rejected:** overriding persona goals at run time with the flow — a hot
persona whose goal contradicts what it supposedly already researched is
incoherent. Also rejected: per-step checkpoint assertion, which would triple
the call count and pollute the persona's own decision loop; scoring reads the
finished trail instead.

**Files:** `src/site/flow.ts` (new), `src/cli.ts`, `src/persona/generate.ts`,
`src/log/report.ts`, `src/log/aggregate.ts`

**Ref:** uncommitted

## 2026-09-04 — Queued personas run concurrently; the queue is the cap

**Decided:** every queued persona launches at once (`Promise.all`), default
generated set is 5. Per agent: its own brain, browser, `ImapProvider`, and a
session dir minted serially before launch. When more than one runs, session
output lines are prefixed `[persona-id]` and the transient spinner writes are
suppressed. One persona's setup failure does not kill the others.

**Why:** with a 15–30 minute wall-clock budget per agent, five serial sessions
are 75–150 minutes of operator time for work that is embarrassingly parallel —
every session was already isolated (646556a did the hard part). The two things
that were actually shared: the IMAP provider (one stateful connection —
concurrent polls interleave on one socket) and stdout (clearLine/cursorTo races
shred interleaved output). `sessionPath()`'s same-second dedupe is
exists-then-create, so dirs are created before anything runs concurrently.

**Files:** `src/cli.ts`, `src/session.ts`

**Ref:** uncommitted

## 2026-09-04 — A gate between stages: continue, redo, change settings, stop

**Decided:** interactive runs pause after `visit` and after `report`: continue /
redo the stage that just ran / change settings (reopens the brain-model-effort
picker, minutes per session, browser visibility) / stop. `--yes` and non-TTY
runs never see it. "Change settings" clears the resolved brain choice so the
picker actually asks again — the caching in `resolveBrain` was built to prevent
double-asking, and this is the one deliberate exception.

**Why:** the pipeline was fire-and-forget: by the time the aggregate revealed a
model was too weak or a run too short, the only option was starting over from
the command line. Redo re-runs a stage with new sessions — sessions stay
immutable.

**Files:** `src/cli.ts`

**Ref:** uncommitted

## 2026-09-04 — Cost accounting is out until the numbers are re-derived

**Decided:** every token, dollar and call-count figure is removed — `BrainUsage`
and its accumulation in `cli-brain.ts`, claude's `extractUsage`, the `usage` field
in `meta.json`, the `**Cost:**` line in `report.md`, `fmtTokens`, the pre-run
"stage 1 budget" banner, and the expert-panel call count.

**Why:** the figures are being recalculated from scratch. Leaving the old ones in
place while that happens means every report written in the meantime carries a
number nobody currently stands behind, and `report.md` is a durable artifact —
stages 2 and 3 read it back long after the run.

**This is parked, not rejected.** It reverses part of `e18bc89` and all of
`810cf44`, and both were good decisions for the reasons written there: a run with
no visible spend was the original problem, and a step is not one call because
`decide()` retries. Whatever replaces this needs to answer both again. No row in
"Tried and rejected" — nothing here was measured and found wanting.

**Kept:** journey duration and per-step `+Ns` offsets in `report.md`. They come
from event timestamps, not from usage reporting, and they were never cost figures.

**Files:** `src/brain/adapters/cli-brain.ts`, `src/brain/adapters/claude.ts`,
`src/log/report.ts`, `src/cli.ts`, `AGENTS.md`

**Ref:** uncommitted

## 2026-08-31 — The snapshot is not main-frame only, and the docs said it was

**Decided:** the safety section now says what is actually true: two structural
defences, not three. `scripts/verify-frames.mjs` proves the frame behaviour against
a real iframe on demand.

**Why:** verifying the frame-ref fix on a live page turned up a false claim that
had been in `AGENTS.md` since `11c5651`. It said the snapshot was main-frame only,
"so iframed Stripe/Adyen/Braintree card fields cannot be targeted at all."

Measured: `ariaSnapshot` descends into **every** frame, cross-origin included. A
`Card number` field inside a cross-origin iframe appears in the snapshot with a
targetable ref. The claimed ceiling never existed.

The protection itself holds — a framed card field, a framed "Pay now", and a
Luhn-passing string in any field are all still refused, verified directly against
`blockedAction`. What was wrong was the *reason*: that is the label matching
working, not a structural impossibility. The distinction matters because the docs
told you it was safe to point at a live commerce site.

This is the same failure `712adcd` fixed elsewhere — describing a best-effort guard
as mechanically guaranteed — and it survived because nobody had tested a framed
page. Hence the script.

**Also learned:** a fresh load of site-a.dev's pages produces no framed refs at
all, though four sessions used them mid-journey. Live pages are not a reliable way
to reproduce this; the checked-in script serves its own iframe instead.

**Files:** `AGENTS.md`, `DECISIONS.md`, `scripts/verify-frames.mjs` (new)

**Ref:** uncommitted

## 2026-08-31 — The expert panel reviews the persona who actually visited

**Decided:** `fix()` calls `getPersonaRegistry(s.meta.url)`, scoped to the site the
session belongs to. When the id still does not resolve it says so on stdout instead
of substituting quietly.

**Why:** the end-to-end run caught it in the output. The panel printed
`Expert panel: Skeptical Sam` for every session, whoever had visited. The registry
was built with no url, so a persona generated into `runs/<site>/personas/` was not
in it, and `?? PERSONAS.cold` swallowed the miss. Kenji is a warm, high-tech-comfort
data engineer at a 4,000-person Japanese enterprise; seven experts were told he was
a skeptical low-tech first-timer who skims and distrusts forms, and every
recommendation was calibrated to that. `FIXES.md` is the tool's actual deliverable,
so this was wrong output rather than a cosmetic slip.

The silent `??` fallback is what let it run for a full session before anyone noticed.
A missing persona now prints a warning naming the substitution and its consequence.

**Files:** `src/cli.ts`

**Ref:** uncommitted

## 2026-08-31 — Ref patterns must match framed refs, or signup forms disappear

**Decided:** every ref pattern matches `(?:f\d+)?e\d+`, not `e\d+`. One
`REF_ID_PATTERN` in `prune.ts` is the source; `driver.measure()` matches the same
shape.

**Why:** the end-to-end run found it. An element inside an iframe carries a frame
prefix — `f5e27`, not `e27` — and site-a.dev's signup form is framed. Four of
five sessions used framed refs, and Priya's mixed both in one session. The old
pattern produced two different wrong behaviours depending on the page:

- **only framed refs** — nothing measured, `visibility` empty, `splitByViewport`
  early-returns the whole tree. The viewport limit silently does not apply.
- **a mix** — `visibility` is non-empty so there is no early return, and every
  framed line fails the "is it visible" test and is dropped from the prompt. The
  persona cannot see the signup form at all.

The second is the dangerous one: a control vanishing is much worse than the limit
not applying, and it only happens on exactly the pages that matter — the ones with
a form in them.

**Known limit, accepted:** a framed element's rect and `innerHeight` belong to its
frame, so it reads as visible whenever it is visible *within* that frame, even if
the frame itself is scrolled off. Walking the frame chain would fix it; nothing
seen so far needs it, and the failure mode is a false "visible", which merely
restores the old behaviour for one element rather than hiding a real control.

**Files:** `src/browser/prune.ts`, `src/browser/driver.ts`

**Ref:** uncommitted

## 2026-08-31 — The step counter shows patience, not steps

**Decided:** the thinking line prints `spent + 1` of `patience_steps`.

**Why:** scrolls stopped drawing down patience, so the raw step number now runs
past the budget and the run printed `[9/8] thinking...`, which reads as a broken
counter. Patience is the number that means something to a reader.

**Files:** `src/session.ts`

**Ref:** uncommitted

## 2026-08-31 — "This site's personas" means the site's directory, nothing else

**Decided:** `siteOwnPersonas(url)` reads only `runs/<site>/personas/`. It is what
decides whether generation runs and what an unattended run queues.

**Why:** the first end-to-end run caught this. `prepareSitePersonas` and
`randomRunPlan` both defined "this site's set" as *everything in the registry that
is not a built-in preset* — which sweeps in the global `personas/` directory. So
`client-simulator site-a.dev --yes` queued ten machine-local personas built for
entirely different products (`cp-hunter-impatient`, `dana-whitmore-revops-head`)
and never touched the six generated for site-a.dev. Worse, `existing.length > 0`
was the check that skips generation, so any machine with a global `personas/`
directory would never generate a set for a new site at all.

**Rejected:** "not a built-in" as the definition. It is the tempting one — the
registry is already merged by then — and it is wrong in both directions: a
hand-written global persona counts as this site's work, and a site with none looks
like it has some.

The full registry still includes global personas, so hand-written ones remain
usable by name; only the *automatic* selection is scoped.

**Files:** `src/persona/load.ts`, `src/cli.ts`

**Ref:** uncommitted

## 2026-08-31 — The viewport limit is enforced, not just described

**Decided:** `driver.act()` refuses a target that was not on screen in the last
snapshot, with a message telling the persona to scroll to it first.

**Why:** `buildPrompt` only carries visible refs, but `aria-ref=` resolves against
the whole document and `act()` auto-scrolled to anything it was given. Refs are
sequential and appear in the rendered history, so a persona could name a footer
link it had never scrolled to and the driver would scroll down and click it —
making the viewport limit a suggestion. `712adcd` already corrected this exact
class of mistake elsewhere: do not describe a prompt-only rule as enforced.

An unmeasured ref is still allowed through — it is either an old snapshot with no
visibility data or a stale ref, and both fail honestly at click time.

**Files:** `src/browser/driver.ts`

**Ref:** uncommitted

## 2026-08-31 — A persona sees one viewport, not the whole document

**Decided:** `driver.snapshot()` measures where every ref sits relative to the
viewport. `buildPrompt` then shows only what is on screen, plus a headings-first
outline of what lies further down, without refs — you cannot click what you have
not scrolled to. Transparent and zero-size nodes are dropped outright. Scrolling
no longer draws down `patience_steps`, and a scroll's stuck-loop signature now
includes `scrollY`.

**Why:** measured on site-a.dev, which is 21 screens tall. The snapshot handed
the persona **776 refs; a visitor at the top of the page can see 37.** So a
persona could click a footer link at step 1 without ever scrolling, and read a
hero CTA and a legal link as equal peers — the largest visible element is
13,493× the area of the smallest, and the YAML renders them identically.

The suspicion that started this was invisible buttons. That turned out to be 2
elements out of 776, and covered elements were zero — Playwright's "receives
events" check already handles those. The real distortion was 93% below the fold.

**Measured after:** 774 refs → 40, prompt 63,977 → 6,150 chars (**90% smaller**),
at ~840ms per snapshot to resolve every ref. For scale, `e5d15ce` fought hard for
14% on the same page.

**Two things this broke, and how:**
- `stuckPattern`'s "same action 3×" rule. Working down a long page now means
  scrolling several times in a row, which it would have called a loop and killed
  every session. Folding `scrollY` into the scroll signature separates "moving
  down the page" from "wedged at the bottom" with no special case.
- The patience budget. ~14 scrolls to reach the bottom of a 12-step persona's
  page would have exhausted it halfway and filed a drop-off the site did not
  cause. Scrolling is looking around, not an attempt, so it is free — bounded by
  `MAX_FREE_SCROLLS` so a persona that only scrolls still terminates.

**Rejected:** screenshot-plus-coordinates, which is where this started. Playwright
already clicks with a real mouse at real coordinates *and* hit-tests first, so
model-estimated pixels would replace an exact target with a guessed one — and a
missed click reads as "this button is broken", manufacturing exactly the false
drop-off `11c5651` exists to prevent. It also costs an image per step and rules
out `opencode`, which has no vision (`readsFiles: false`).

Also rejected: taking the outline in document order. That filled all 15 slots
from one demo widget sitting just under the fold, and "Pricing" further down never
appeared. Headings get the slots first.

**Files:** `src/browser/driver.ts`, `src/browser/prune.ts`, `src/brain/prompt.ts`,
`src/session.ts`, `src/types.ts`

**Ref:** uncommitted

## 2026-08-31 — One command, and a site brief that gates on nothing

**Decided:** `client-simulator <url>` is the whole tool — read the page, write
`runs/<site>/SITE.md`, build personas into `runs/<site>/personas/`, visit, report,
fix. `--stop <stage>` ends it early, `--yes` silences every question, and the other
six subcommands became flags (`--report`, `--fix`, `--doctor`, `--list-personas`,
`--new-persona`, `--mailtest`). Prior knowledge is rationed by temperature:
**cold gets nothing, warm gets the arrival paragraph, hot also gets what it does,
what it costs, and how signup works.**

**Why:** `resolveRunPlan` returned an explicit `--persona` queue before it ever
reached the first-visit branch, so `--persona cold` silently skipped both the site
read and persona generation. A site-a.dev run did exactly that: Skeptical Sam
arrived knowing nothing, spent all 12 steps working out what the product was
("I'm still confused about what Site A actually does for a regular person"),
and the run was filed as a GUARDRAIL — a generic persona failing, recorded as the
site failing. Reading the page is also the only way to build an ICP, so the scrape
had to stop being optional.

Temperature tiering is the part that makes this safe. Handing every persona the
brief would have fixed the confusion by destroying the signal: a cold persona who
knows what the product is has stopped being a first-time visitor, and whatever it
then fails to notice is no longer evidence about the page. The three temperatures
are three amounts of prior research, and that is most of what makes them behave
differently.

**Rejected:** Giving `readSite()`'s three fields to every persona equally — that
was the shape the code was already reaching for, and it is the version that
quietly invalidates cold runs. Also rejected: a second scrape inside
`generatePersonas`. The brief is cheaper and better context than a raw
accessibility dump of the same page, so it is passed through as `siteContext`.

**Removed:** `src/site/read.ts`. `ensureBrief` supersedes it.

**Files:** `src/site/brief.ts` (new), `src/cli.ts`, `src/persona/load.ts`,
`src/persona/generate.ts`, `src/brain/prompt.ts`, `src/types.ts`, `src/session.ts`

**Ref:** uncommitted

## 2026-08-30 — Every path that reads site-controlled text got hardened

**Decided:** Safety label matching covers es/pt/fr/de/it/nl/sv/ru/ja/ko/zh against
accent-stripped labels. The page snapshot's ```yaml fence is escape-proof. The
expert transcript is marked as data, not instruction. The MIME tag regex is bounded.
Flag validation moved ahead of the browser launch.

**Why:** A persona and the expert panel both read text the site under review writes,
and several paths trusted it further than they should. A non-English SSO button
walked past the guard. A page printing ``` closed the fence early, so whatever
followed read as harness instruction. `<[^>]+>` is quadratic on an unclosed `<` — a
256KB body at the fetch cap burned 33s of event loop mid-session. Separately,
`--brain` was never checked for existence, so a missing CLI launched a browser and
minted a mailbox before failing.

**Files:** `src/safety.ts`, `src/brain/prompt.ts`, `src/experts/`, `src/mail/mime.ts`,
`src/brain/picker.ts`, `src/cli.ts`, `src/doctor.ts`

**Ref:** `8f114d4`

## 2026-08-26 — Per-character inputs get real keystrokes, not fill()

**Decided:** `needsKeystrokes()` routes short-maxlength fields to one keypress per
character. Email screenshots that render to nothing are dropped.

**Why:** `fill()` sets the value in one shot, so a six-box OTP input keeps only the
first digit and the page's auto-advance never fires. Personas recovered by typing
one digit per step, burned a quarter of their patience doing it, and filed the
result as a fault of the site under test.

**Files:** `src/browser/driver.ts`

**Ref:** `7df266b`

## 2026-08-26 — IMAP is addressed by UID everywhere

**Decided:** Every read and move passes `{uid: true}`. Delivered mail stays visible
across later inbox checks. Body text always ships, rather than relying on a
screenshot. Cue-anchored alphanumeric codes are recognised.

**Why:** `search()` returns sequence numbers unless `{uid:true}` is passed, but
every read and move below it addressed messages by UID. `fetchOne` read by sequence
and got the right envelope; `download` read by UID and got nothing. So every message
arrived with a correct subject and an empty body, personas had no code to act on,
and they abandoned working login flows and reported the sites as broken. The same
mismatch in `destroy()` moved messages to Bin by UID using sequence numbers — on a
catch-all inbox that could trash unrelated mail.

**Files:** `src/mail/imap.ts`, `src/mail/mime.ts`

**Ref:** `d0db6d3`

## 2026-08-26 — Safety judges the action, not the URL

**Decided:** Personas may reach any page — pricing, billing, a full checkout —
because reaching the wall is the finding. The *action* is what gets refused: card
fields, anything passing Luhn, the payment-commit labels of the major platforms,
third-party auth including bare provider-icon buttons, enterprise SSO phrasing.

**Why:** The URL blocklist it replaced was wrong in both directions. It killed two
`deep-evaluator` sessions for opening `docs.site-d.ai/support/billing-and-credits`
and `platform.site-e.ai/docs/billing` — help articles — while a checkout
at a path lacking those substrings walked straight through.

**Rejected:** Blocking a bare "Subscribe". A newsletter CTA is far commoner than
Stripe's identically-labelled commit button, which cannot succeed without a card
anyway. Also deliberately allowed: "Purchase history", a "Donate" nav link,
"Create organization" — a false positive there manufactures a drop-off the
customer's site did not cause.

**Also:** a refusal does not end the session. The persona is told why and either
routes around it or walks out, which is the behaviour worth recording. The docs
state this as best-effort label matching, not a guarantee; the real ceiling is
structural (fresh context per session, `fill()` never pressing Enter, main-frame-only
snapshots).

> **Corrected 2026-08-31.** "Main-frame-only snapshots" was wrong — see the entry
> for that date. `ariaSnapshot` descends into every frame, cross-origin included,
> so a framed card field *is* targetable. The label guards still refuse it; the
> structural ceiling was two defences, not three.

**Files:** `src/safety.ts`, `src/session.ts`

**Ref:** `11c5651`

## 2026-08-26 — The saved video is the page the journey ended on

**Decided:** Save `this.page.video()`. Largest-clip survives only as a fallback for
a crash before first paint.

**Why:** `chooseRecording` picked the largest file, on the theory that the main
journey produces the most footage. It does not — a heavy animated landing page left
open in tab one outweighs the signup tab the persona actually finished in. Confirmed
on the site-f.ai `tomas-lindqvist` run: the saved video's last frame was the site-f.ai
homepage while step 14 was on `studio.site-f.ai/auth/sign-up`.

**Rejected:** A duration check. 374s of video against a 344s journey passes fine —
only comparing frames against the step screenshots catches it.

**Files:** `src/browser/driver.ts`

**Ref:** `123cb85`

## 2026-08-26 — Snapshot pruning drops machine-only noise, and nothing else

**Decided:** One rule: drop COinS metadata and percent-encoded blobs no visitor
could read. Applied in `buildPrompt`, not `driver.snapshot()`.

**Why:** A citation-heavy page costs ~64k tokens per step. The rule takes it to
54,844 with all 1,754 refs kept, and three captured ordinary pages come out
byte-identical. It lives in `buildPrompt` because `verifyGoal` must judge the real
page — a truncated confirmation becomes a false drop-off in the report.

**Rejected:** Two more rules, built and then deleted. Truncating long text removed
the tail of consent copy, where "your card will be charged $49 per month" lives —
the exact thing `presets.ts` personas exist to notice. Dropping `#fragment` link
targets anonymised links whose only identity was that fragment. Together they saved
~7% of one page and 0% of every other, carrying all the risk.

**Files:** `src/browser/prune.ts`, `src/brain/prompt.ts`, `fixtures/`

**Ref:** `e5d15ce`

## 2026-08-26 — Persona brains are sandboxed; email HTML renders in a throwaway context

**Decided:** opencode personas run under `OPENCODE_CONFIG` permission denies, codex
under `--sandbox read-only`. Untrusted email HTML renders with JS disabled and all
network aborted. Brain CLIs get an env allowlist instead of full inheritance.
`loadSessions` zod-validates `meta.json` and `session.jsonl`.

**Why:** Only claude personas were restricted. The popup-hijack path through email
rendering was live. Hostile `meta.json` shapes crashed `report`/`fix` instead of
skipping with a warning.

**Gotcha worth keeping:** `extendEnv: false` is mandatory — execa v9 silently
re-merges the parent env without it.

**Files:** `src/brain/adapters/`, `src/browser/driver.ts`, `src/log/aggregate.ts`

**Ref:** `712adcd`

## 2026-08-26 — Runs record cost, duration, and which pages they reached

**Decided:** The claude adapter accumulates tokens and cost across a session
(retries included — they are real calls) into `meta.json` and the report header.
Reports show total journey time and per-step `+Ns` offsets. A new section lists each
distinct URL with the step and elapsed time it was first reached.

**Why:** `claude -p --output-format json` returns a usage block on every call and
`extractText` was discarding all of it. Every event already carried a timestamp and
nothing surfaced it. A page that takes eight steps to find is a finding in itself —
on site-f.ai only 2 of 10 personas ever reached `/control-plane/`.

**Rejected:** Showing zero for opencode and codex. They do not report usage, so
`reported` stays false rather than displaying a misleading number.

**Files:** `src/brain/adapters/claude.ts`, `src/log/report.ts`, `src/log/aggregate.ts`

**Ref:** `e18bc89`

## 2026-08-26 — Recordings show a cursor

**Decided:** Inject a tracking dot and a red click-ripple as an init script, so it
survives navigation and reinstalls in every frame. Only when a `videoDir` is set.

**Why:** Playwright drives a real mouse but renders no pointer, so the videos gave
no clue where a persona was looking or clicking.

**Constraint that shaped it:** everything injected is `aria-hidden` with
`role=presentation` and `pointer-events: none`, verified absent from the
accessibility snapshot the persona reads and unable to intercept a click meant for
the page.

**Files:** `src/browser/cursor.ts`, `src/browser/driver.ts`

**Ref:** `42c73ca`

## 2026-08-26 — The stage-1 call budget is shown before a run

**Decided:** Print two numbers — the step count, and 3× it.
`MAX_DECIDE_ATTEMPTS` is exported from `cli-brain.ts` and shared by the retry loop,
the backoff guard, the error message and the banner, so they cannot drift apart.

**Why:** A ceiling already existed structurally (`MAX_RUNS` personas,
`patience_steps` capped at 50 by the schema). It was only invisible. Two numbers
rather than one because a step is normally a single call, but `decide()` retries a
malformed reply and each attempt is its own CLI spawn — one optimistic number
understates spend by ~3×, one pessimistic number is wrong on nearly every run and
gets ignored.

**Rejected:** A second cap, a flag, or a config knob. Nothing was added; only the
existing worst case was surfaced.

**Files:** `src/cli.ts`, `src/brain/adapters/cli-brain.ts`

**Ref:** `810cf44`

## 2026-08-26 — One malformed field stops discarding a whole expert section

**Decided:** Scores are clamped to 0–10. Missing recommendation priorities default,
and only entries carrying neither a problem nor a fix are dropped. Renders are
exported so they can be tested directly.

**Why:** Both failures were caught by the caller's try/catch and logged as "expert
failed", so a section vanished silently rather than degrading.
`'░'.repeat(10 - Math.round(score))` throws `RangeError` when a model answers
outside the range it was given, losing the entire scorecard.
`r.priority.toUpperCase()` threw on a missing field, taking all six recommendations
with it.

**Files:** `src/experts/scores.ts`, `src/experts/ux.ts`

**Ref:** `24de073`

## 2026-08-26 — Mail is read decoded, not as raw MIME

**Decided:** Ask the server for the decoded body part (`bodyStructure` + `download`)
— imapflow already decodes, so no new dependency. `src/mail/mime.ts` adds a part
picker (largest candidate, attachments skipped) and a raw-MIME fallback decoder,
capped at 256KB per body. Codes rank by a cue word appearing before the number.

**Why:** `fetchNew` ran the code and link regexes over raw RFC822 source. Most
transactional mail is base64 or quoted-printable, so base64 HTML found nothing and
quoted-printable was worse than nothing — a soft line break split `4839=\r\n20` and
the persona typed a wrong 4-digit code. Either way the run burns its `otp_patience`,
abandons, and reports that the site's verification email never sends: a false
accusation from a tool whose job is telling you what is broken.

**Knock-ons from the same root cause:** `emailScreenshot` was handed raw MIME and
rendered headers and base64 gibberish. When no code was found the persona was shown
an excerpt of `Received:` and `Delivered-To:` headers — useless to it, and it leaked
mail infrastructure into the prompt.

**Files:** `src/mail/imap.ts`, `src/mail/mime.ts`

**Ref:** `ce58e83`

## 2026-08-26 — Publishing uses an allowlist, not an ignore file

**Decided:** `package.json` `files` lists what ships. `npm pack` reports 38 files —
no secrets, no tests, bin present.

**Why:** An `.npmignore` added earlier the same day made npm stop consulting
`.gitignore`, so `npm pack` listed `.env` (IMAP password, API key), both state files,
and `fixtures/`.

**Rejected:** The `.npmignore` blocklist. An allowlist is leak-safe by construction;
a blocklist is only as good as memory.

**Files:** `package.json`

**Ref:** `02dfb58`

## 2026-08-26 — Oscillating loops are caught, and events stop vanishing from JSONL

**Decided:** `stuckPattern` detects cycles up to length 3, with repetition
thresholds tuned so ordinary exploration cannot trip it. The JSONL write moved to
the end of the step.

**Why:** `isStuck` only matched three identical consecutive actions, so an A-B-A-B
ping-pong ran until patience ran out, paying for a full page snapshot every step.
And the line was written before the email-override and action-failure handling ran,
so neither reached the file — since `fix` reloads from JSONL, the expert panel never
saw that an action had failed.

**Files:** `src/session.ts`

**Ref:** `b64797d`

## 2026-08-26 — Brains are per-session; runs are filed by site and date

**Decided:** Adapters became factories — each session gets its own brain, every call
self-contained. Tools restricted by role. Calls run outside the repo, with
`--add-dir` opting the session directory back in. Retries reformat the bad reply
instead of resending the step prompt. Runs live at
`runs/<site>/<date>/<time>-<persona>/`, with per-site `AGGREGATE.md`.

**Why:** Adapters were module-level singletons holding a persistent CLI session, so
every persona in a run shared one conversation and persona 2 was no longer a
first-time visitor. Running inside the repo meant the CLI loaded this project's own
`AGENTS.md` into a persona that is supposed to know nothing about it. A funnel
mixing several websites was not meaningful.

**Measured:** 20,421 → 14,950 tokens of fixed overhead per call. Retry prompts are
~94% smaller.

**Rejected:** `--resume`/`-s`. Dropping it is what keeps context from growing
without bound across a run.

**Files:** `src/brain/`, `src/runs.ts`, `src/cli.ts`, `src/browser/driver.ts`

**Ref:** `646556a`

## 2026-08-26 — A unit suite for the pure logic stages 1–3 depend on

**Decided:** Node's built-in runner, no new dependency, no LLM or network calls.
Covers run-directory layout and discovery, the stuck-loop detector, JSON extraction
from noisy CLI output, video-clip selection, MIME decoding, expert rendering,
persona loading, prompt building, and aggregation.

**Why:** These are the paths every stage sits on and none of them were covered.
Writing the tests caught real bugs: a path-traversal in `siteSlug` (`new URL()`
parses `../../etc/passwd` with host `..`, which the character filter preserved, so
`sessionPath` would have written outside `runs/`); a quoted-printable decoder using
`String.fromCharCode` per byte that mangled UTF-8; and code ranking that still
preferred an order number over the verification code.

**Worth copying:** the prompt-tiering assertion is deliberately split-and-assert-
absence. An earlier version used a top-level alternation that reduced to "both
strings appear somewhere" and would have passed a regression collapsing the tiers.

**Files:** `src/**/*.test.ts`

**Ref:** `73ec76e`, `8e74d0b`, `618ffb2`

## 2026-08-26 — personas/ is machine-local

**Decided:** Gitignored. `load.ts` recreates the directory on demand and falls back
to the built-in cold/warm/hot presets when it is absent.

**Why:** Personas are generated per-machine by `personas generate` or hand-written
for one investigation, so a shared copy is noise for everyone else.

**Files:** `.gitignore`, `src/persona/load.ts`

**Ref:** `d0ba76c`, `3f303d1`

## 2026-08-25 — Brains never invent contact details

**Decided:** Any email the brain types is overridden with the assigned ephemeral
mailbox. The prompt carries an explicit never-invent-email rule.

**Why:** `runSession()` stopped receiving the mailbox after a headless-field
cleanup, so every session since had run mailless and brains invented addresses to
fill forms. The override is the trust boundary; the prompt rule is the belt.

**Files:** `src/session.ts`, `src/brain/prompt.ts`, `src/cli.ts`

**Ref:** `72f5a5b`

---

## Earlier

| Date | What | Ref |
|---|---|---|
| 2026-08-26 | Version bumped to 0.3.0 — `package.json` still said 0.1.0, with 11 commits and a breaking `runs/` layout change since "v0.2" | `6d4b23d` |
| 2026-08-26 | Interactive brain/model/effort picker and zero-arg wizard; menus probe the CLI live instead of hardcoding lists; model/effort recorded in `meta.json` | `c4dae96` |
| 2026-08-25 | `--model` flag pins any model per brain; the default stays the CLI's own | `2b7534b` |
| 2026-08-25 | Emails render as screenshots so brains read any OTP format; brain retry with backoff; hot patience 20→26 (split-box digit entry eats steps) | `01c286f` |
| 2026-08-25 | Popup/new-tab following made crash-safe on revert | `2caa1ff` |
| 2026-08-25 | Renamed to client-simulator; codex brain added; README rewritten shorter | `2789dc9` |
| 2026-08-25 | Testing-your-own-site checklist: bot blockers, mail allow-list, known walls | `6097c4a` |
| 2026-08-25 | First release: synthetic client agents that test website onboarding | `8c22abd` |

---

## Tried and rejected — do not re-propose

| Idea | Why it is dead | Ref |
|---|---|---|
| Resolving a persona without its site (`getPersonaRegistry()`) | Site-generated personas are absent, `?? PERSONAS.cold` swallows the miss, and the expert panel advises on the wrong person entirely | 2026-08-31 |
| Matching refs as `e\d+` | Misses framed refs (`f5e27`); on a page with both, every control inside the iframe is dropped from the prompt — and signup forms are routinely framed | 2026-08-31 |
| Defining "this site's personas" as "not a built-in" | Sweeps in the global `personas/` directory: a new site never generates a set, and unattended runs queue personas built for other products | 2026-08-31 |
| Letting `act()` resolve any ref on the page | `aria-ref=` hits the whole document, so a persona could click a footer link it never scrolled to — the viewport limit has to be enforced, not described | 2026-08-31 |
| Screenshot + model-estimated click coordinates | Playwright already clicks with a real mouse and hit-tests; guessed pixels would replace an exact target with an approximate one, and a miss reads as a broken button | 2026-08-31 |
| Building the below-fold outline in document order | One dense widget under the fold took all 15 slots; headings further down never appeared | 2026-08-31 |
| Giving every persona the site brief | A cold persona that knows what the product is has stopped being a first-time visitor; what it then fails to notice is no longer evidence | 2026-08-31 |
| A second scrape inside `generatePersonas` | The brief is cheaper and better context than a raw a11y dump of the same page — pass it as `siteContext` | 2026-08-31 |
| URL-substring blocklist for payment pages | Wrong in both directions: killed two sessions on billing *help articles*, let a checkout at a plain path walk through | `11c5651` |
| Blocking a bare "Subscribe" | A newsletter CTA is far commoner than Stripe's identically-labelled commit, which cannot succeed without a card | `11c5651` |
| Truncating long text in the snapshot | Deleted the tail of consent copy, where "your card will be charged $49 per month" lives | `e5d15ce` |
| Dropping `#fragment` link targets | Anonymised links whose only identity was the fragment; ~7% on one page, 0% on every other | `e5d15ce` |
| Pruning inside `driver.snapshot()` | `verifyGoal` must judge the real page, or a truncated confirmation becomes a false drop-off | `e5d15ce` |
| Largest video file = the main journey | A heavy animated landing page outweighed the signup tab the persona finished in | `123cb85` |
| A duration check to catch the wrong video | 374s video against a 344s journey passes fine; only frame comparison catches it | `123cb85` |
| `.npmignore` to keep secrets out of the package | Made npm stop consulting `.gitignore`; `npm pack` then listed `.env` | `02dfb58` |
| A second step-cap flag or config | The ceiling already exists structurally; only surfacing it was needed | `810cf44` |
| Showing token cost for opencode/codex | They do not report usage; `reported: false` beats a misleading zero | `e18bc89` |
| `--resume`/`-s` on brain CLIs | Persistent sessions are what let context grow without bound across a run | `646556a` |
| Committing `personas/` | Generated per-machine; `load.ts` recreates it and falls back to presets | `d0ba76c` |
| A memory provider interface | Removed from the roadmap | `PLAN.md` |
