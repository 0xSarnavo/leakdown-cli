# AGENTS.md — leakdown

Instructions for AI coding agents (and humans) operating **leakdown**: a CLI that sends synthetic client personas through any website's onboarding. Personas think out loud, complete or abandon the flow like real users, and produce drop-off reports.

This is the single source for the repo. Three parts:

| | For | Read it when |
|---|---|---|
| **Part 1 — Operating the tool** | Running it | You want a report out of a website |
| **Part 2 — How the code works** | Changing it | You are about to edit `src/` |
| **Part 3 — Working agreements** | Both | Before your first change, once |

Also read **[DECISIONS.md](DECISIONS.md)** before proposing anything. Its
"Tried and rejected" table lists things that were built, measured and deleted —
it is there so you do not rebuild them.

---

# Part 1 — Operating the tool

## What leakdown does

Simulated prospects visit a target URL in a real browser (Playwright). At each step an AI CLI — playing a persona — sees an accessibility snapshot and decides the next action: click, type, scroll, check email, pause, abandon. Everything is logged. Expert agents then review sessions and produce fix recommendations.

## Environment setup

```bash
npm install
npm run build
npx playwright install chromium   # one time
brew install ffmpeg               # one time — playable video.mp4 per session (else video.webm only)
```

Requirements: Node 20+, and at least one AI CLI logged in via subscription (no API keys):
- `claude` (Claude Code)
- `opencode` (opencode)

**Verify environment (runs automatically on first visit):**

```bash
leakdown --doctor          # deep check incl. live brain call + mailbox test
leakdown --doctor --force  # re-run even if recently verified
```

Results are cached in `.leakdown-state.json` (gitignored) for 7 days — checks don't re-run every time.

**Optional — email verification support (OTP/magic links):** create `.env` in the project root:

```
LEAKDOWN_IMAP_HOST="imap.gmail.com"
LEAKDOWN_IMAP_USER="you@gmail.com"
LEAKDOWN_IMAP_PASS="xxxx xxxx xxxx xxxx"   # Gmail app password
LEAKDOWN_MAIL_DOMAIN="yourdomain.com"      # domain with catch-all → your inbox
```

Legacy `CLIENTSIM_*` vars still work for one minor with a deprecation warning — use `LEAKDOWN_*`.

Requires a domain whose catch-all forwards to the IMAP inbox. Without it, personas treat "check your email" walls as drop-off points (still valid data). Test with `leakdown --mailtest`.

Every run probes the mailbox first (one self-sent message, once a day, up to 5 minutes) and records the result on each session's `meta.json`. A failed probe does not stop the run; it puts an "email verdicts unverified" warning at the top of `AGGREGATE.md`. If two or more prospects in one run give up over email, the probe runs again afterwards and a failure writes `runs/<site>/MAIL-WARNING.md`. Gmail files self-sent mail under All Mail, never INBOX, so the poller scans the `\All` folder where one exists.

## Choosing the AI (brain, model, effort)

Every stage that calls an AI — the site read, persona generation, the visits, the
expert panel, `--doctor` — resolves three things: which CLI plays the client,
which model, and how much reasoning effort. They are resolved once and reused for
the rest of the run. Pass them as flags or let it ask.

```bash
leakdown <url>                                    # menus for all three
leakdown <url> --brain claude                     # menus for model + effort only
leakdown <url> --brain claude --model opus --effort high   # no menus
```

The menus are arrow-key driven and the lists are probed live from the CLI you
pick, not hardcoded here:

| Brain | Models from | Effort from |
|---|---|---|
| `claude` | `claude --help` aliases | `claude --help` (`low`…`max`) |
| `codex` | `codex --help`, else a fallback list | `low\|medium\|high` |
| `opencode` | `opencode models` | none — opencode has no effort knob, so it isn't asked |

Both menus always offer **default** (leave the CLI's own setting alone) and, for
models, **custom…** to type any id.

**Automation:** with no TTY nothing is ever prompted — `--brain` falls back to
`claude` and model/effort to the CLI's defaults. Always pass the flags explicitly
in scripts and CI so runs are reproducible; a session records the brain, model,
and effort it used in `meta.json`.

**Zero-argument wizard:** running bare `leakdown` opens a guided flow
(what to do → url → how far to go → brain → model → effort → who visits).
`--help` still prints the flag reference. Ctrl-C out of any menu exits cleanly
with status 130.

## One command

```bash
leakdown <url>                          # the lot
leakdown site-a.dev --yes            # the lot, asking nothing
leakdown site-a.dev --stop personas  # just read it and build prospects
```

Point it at a site and five stages run in order:

| Stage | Does | Writes |
|---|---|---|
| `site` | Scrapes the landing page: what it sells, to whom, its CTA, signup path, visible pricing, walls, what a first-timer trips on | `runs/<site>/SITE.md` |
| `map` | Crawls two clicks from the landing page plus `sitemap.xml`, no brain: every internal page tagged by kind, and every booking or payment surface, on-site or off. The aggregate later lists pages no prospect found | `runs/<site>/MAP.md`, `map.json` |
| `personas` | Builds a prospect set fitted to that product (`--count`, default 10), spread across core / adjacent / edge; `--flow "<intent>"` drafts the checkpoints the set is shaped around | `runs/<site>/personas/`, `FLOW.md` |
| `visit` | One session per persona — one at a time by default (`--serial`; `--parallel` runs a multi-persona queue all at once; omit both flags and it asks), desktop unless `--mobile` — live thought stream (lines prefixed by persona id), ending COMPLETED / ABANDONED / GUARDRAIL / COULD NOT RUN | `session.jsonl`, `report.md`, `video.mp4` (+ `video.webm`), `filmstrip.html` |
| `report` | The short report an owner reads — one number, the walls with quotes and "check it yourself" steps, a developer section — plus every table behind it | `runs/<site>/AGGREGATE.md`, `DETAIL.md` |
| `fix` | Expert panel over each session | `FIXES.md` per session |

`--stop <stage>` ends after that one. `site` is written once per site and
`personas` is skipped when a set already exists — `--plan` redoes both. Re-running
a later stage with no new data is a no-op ("up to date"); `--force` regenerates
anyway.

**`site` and `personas` gate on nothing.** A site with no brief gets one whatever
flags were passed, including `--persona`. That ordering is the whole reason this
was reorganised — see [DECISIONS.md](DECISIONS.md), 2026-08-31.

**A persona only ever sees one viewport.** The snapshot is cut to what is on
screen, plus a headings outline of what lies below. On a 21-screen page that is
40 elements instead of 776. Scrolling is free — it does not spend patience.

### The ladder

```bash
leakdown <url> --ladder --yes --headless
leakdown <url> --ladder --wide "haiku:5,opencode/muse-spark-1.3-contributor-free:5"
```

The fleet the model eval chose, as one command: the site's personas are
visited half by haiku and half by muse-spark (free, when opencode is
installed; `--wide` changes the split, `--wide haiku` is haiku only), the
replication filter picks the sessions that cite what other sessions also
cite, sonnet runs the expert panel on those three, opus re-walks the persona
behind the top session and gets its own panel, and the report is regenerated
over everything. Cheaper models produce votes; only sonnet verifies and only
opus writes what a founder reads. Wide sessions from the same day are reused,
so a rerun after a crash or a usage limit does not pay for the sweep twice.
About $12 and an hour per site on the measured runs. Retest measured haiku at 3.8/4 agreement on a hot persona and
2.5/4 on an edge one, so one wide run per persona is the default and a
single-source finding earns a second run before it counts.

### Goal tests

```bash
leakdown <url> --goal "log in and get an API key" --steps 15 --yes --headless
```

`--goal` swaps every queued persona's goal for the asserted one and turns the
run into a pass/fail test. Exit codes: 0 when every session ends `completed`
(verification included); 1 when any session walked out or hit a guardrail —
the site failed somebody; 2 when nothing failed but a session *could not run*
(unreachable URL, brain down, setup error) — our side, not the site's, so CI
can tell the two apart. `--steps` (1-50) caps each session's patience for the
test. Everything else is unchanged: same personas, same reports, same artifacts.

`--expect "label=value"` (repeatable) adds value checks: a completion claim
counts only when the page shows every expected value (dumb substring over the
full snapshot, whitespace-insensitive). A failed check never spends a
verification call; the session continues with a note, and `report.md` gets an
Assertions section quoting expected vs. found ("expected total=$96.00, found
'Total: $120.00'"). The expectations are appended to the persona's goal, so the
persona and the verifier both read them.

### Flows you write

```bash
leakdown --validate-flow flows/signup.yaml      # no browser; lists what is wrong, exits 1 on errors
leakdown <url> --flow-file signup --yes         # runs against flows/signup.yaml (or runs/<site>/flows/)
```

A flow file is the journey you want checked, as ordered steps — a string, or
`{name, expect}` where `expect` is page text that proves the step. Sessions are
still personas deciding for themselves; the file scripts nothing. After each
session `scoreFlow()` judges which steps were reached. A `stop_after` step
(which must carry `expect`) ends the session COMPLETED the moment its text is on
screen, before the next step is spent — the local "approved this far" boundary.
That step is then marked reached mechanically, whatever the scorer says.
Format and an example: `src/site/flow-load.ts` (top comment) and
`flows/example-signup.yaml`. Site-local flows win an id collision with global
ones, like personas.

### A/B on one laptop

```bash
leakdown <url-a> --variant control --yes --headless
leakdown <url-b> --variant new-pricing --yes --headless
leakdown --compare <site>                        # runs/<site>/COMPARE.md
```

`--variant` labels every session (`meta.variant`) and the run folder
(`<time>--<slug>`). Runs are folders, so two variant runs never share an
aggregate; `--compare` takes the newest run of each variant under a site and
renders `renderVariants()`: sessions, completed, leaked (walked out or out of
patience), a Wilson interval per variant, where each lost people, and one
verdict — which leaks more, or "no meaningful difference" when the intervals
overlap, or "too few" under three sessions a side. Could-not-run sessions are
excluded from every rate. Exactly two variants are compared; more are listed.
The same section appears inside AGGREGATE.md when one aggregate happens to hold
two variants.

### On its own

```bash
leakdown --report [dirs...]     # aggregate past sessions
leakdown --fix <dirs...>        # expert panel over past sessions
leakdown --doctor               # verify the environment
leakdown --list-personas        # every persona, built-in and custom
leakdown --new-persona "Name"   # build one by answering questions
leakdown --mailtest             # mailbox lifecycle test
leakdown <url> --persona marcus,marcus,marcus   # the same persona three times (test-retest); --random <n> draws random ones
leakdown --history [site]       # one line per run: date, the one number, who sat in which seat
leakdown --fix site-b.ai   # a site name means its newest run; site/date/time names one run
leakdown --orders [--all]       # run requests left on the website (new ones, or every status)
leakdown --order <id>           # run one here, email the PDF; --reject "why" declines it
```

Orders are the website's request form. The site only stores them (a private
bucket behind the leakdown-website repo, separate, deploys to Vercel); nothing runs until you pick one with
`--order`, on this machine and this subscription, so a spammed form costs
nothing. Needs `LEAKDOWN_ORDERS_URL` (the site) and `LEAKDOWN_ORDERS_TOKEN`
(the site's `ORDERS_TOKEN`) in `.env`, and mail configured — the report goes
out as a PDF attachment.

Sessions are grouped by the URL recorded in each `meta.json`, not by where they
sit on disk, so a session moved between folders still lands in the right funnel.
The panel is gated on the aggregate for that session's own site.

The seven old subcommands (`visit`, `report`, `fix`, `all`, `doctor`, `personas`,
`mailtest`) still dispatch, unchanged. They are not in `--help` and are not the
documented surface.

## Brains

| `--brain` | CLI | Notes |
|---|---|---|
| `claude` (default) | Claude Code | Fastest per step |
| `opencode` | opencode | Slower (~2–3×); needs `--print-logs` |
| `codex` | Codex CLI | Varies by model |

Any brain can run any stage. You can visit with one brain and run experts with another.

### How brains are isolated

Every session gets its own brain instance, and every call is stateless — journey
memory comes only from the tiered history the prompt builder renders. This matters
for correctness, not just cost: brains used to be module-level singletons holding a
persistent CLI session, so persona 2 inherited persona 1's entire conversation and
was no longer a first-time visitor.

Calls run with the working directory outside the repo, so the CLI does not load
this project's own `AGENTS.md` into a persona that is supposed to know nothing
about it. The session directory is opted back in via `--add-dir` so screenshots
stay readable.

Tools are restricted by role (`src/brain/adapters/claude.ts`):

| Role | Tools | Why |
|---|---|---|
| `persona` | `Read` only | It must judge the page from the snapshot and its own screenshot — not shell out or fetch the URL directly |
| `expert` | `Read`, `WebFetch`, search | Experts read screenshots and fetch the page for raw HTML. No shell: their input is a transcript quoting the site under review, so it is attacker-influenced too, and `WebFetch` is the narrow tool for the one thing the prompts actually need |

Unused tool schemas cost roughly 5k tokens on every single call, so this is a
substantial saving as well as a correctness boundary.

## Personas

| Preset | Client | Behavior | Arrives knowing |
|---|---|---|---|
| `cold` | Momus | First visit, low tech comfort, skims, distrusts forms/jargon, low patience | **nothing** |
| `warm` | Egeria | Comparing options, wants pricing/features, tolerates minor friction | the arrival paragraph from `SITE.md` |
| `hot` | Felicitas | Decided to buy, goes straight to signup, bails only when truly blocked | that, plus what it does, costs, and how signup works |

That last column is `arrivalFor()` in `src/site/brief.ts`, and it is load-bearing.
The three temperatures are three amounts of prior research, which is most of what
makes them behave differently. Giving a cold persona any of the brief turns it
into a warm one, and whatever it then fails to notice stops being evidence about
the page. Giving a hot persona none of it produces a "decided buyer" who
rediscovers the pricing page, which no real hot prospect does.

Each persona has `otp_patience_seconds` — waiting too long for a verification email is in-character abandonment.

### Where personas come from

| Source | Path | Scope |
|---|---|---|
| Built-in presets | `src/persona/presets.ts` | everywhere |
| Yours | `personas/*.yaml` | everywhere |
| Generated for one site | `runs/<site>/personas/*.yaml` | that site only |

Most specific wins on an id collision. **`siteOwnPersonas()` reads only the third
row** — it decides whether generation runs and what an unattended run queues, so
defining it as "anything that is not a built-in" silently promotes your global
personas into every site's run. A set built for a scraping API is noise
when you test a checkout, which is why generated sets live beside their site's
runs rather than in the flat global directory.

### Custom personas (YAML)

```bash
leakdown --list-personas               # list all (built-in, custom, per-site)
leakdown --new-persona "My Persona"    # asks: scope, temperature, goal, traits
leakdown <url> --stop personas         # AI-build a set for that site
```

#### Calibrating to real visitors (optional)

Drop `runs/<site>/analytics.json` beside the brief and the generator weights
the set toward what the owner's dashboard says. Five lines is enough:

```json
{
  "exitPages": [{ "path": "/pricing", "share": 0.38 }, { "path": "/", "share": 0.31 }],
  "devices": { "mobile": 0.55, "desktop": 0.45 },
  "entry": ["google organic", "product hunt"],
  "note": "Most signups come through the docs, not the homepage."
}
```

Shares are fractions of 1. No file means fully synthetic, which is the
default; `--plan` rebuilds the set after you add one. Whether calibrated sets
find more true problems than synthetic ones is an open question (Q6 in the
local notes) — this file is how that test gets run.

#### Persona generator (AI-built persona sets)

```bash
leakdown <url> --stop personas        # read the site, build a set, stop
leakdown <url> --stop personas --plan # rebuild the set for a known site
```

How it works:
1. Optionally scrapes the target site's landing page (a11y text) to learn what the product is and who it serves
2. Sends the page context plus your description (optional when `--site` is given) to the brain
3. Returns a set spread across three tiers, roughly a third each:
   - `core` — the ideal customers, most likely to convert
   - `adjacent` — different roles, seniorities, company sizes, industries
   - `edge` — people who land on the site but are not the target: no budget, wrong
     use case, a competitor evaluating, an enterprise buyer in a self-serve flow.
     These expose whether onboarding qualifies people fast or wastes their time.
4. Writes each as `personas/<id>.yaml` (review/edit freely; delete to remove) and prints a coverage summary

The set is also spread across circumstances that decide whether onboarding works
at all — tech comfort (at least one `low`), urgency, trust posture, price
sensitivity, skim-reading, and (at `--count` 4+) at least one persona with a real
accessibility constraint.

Anti-similarity is enforced in the prompt: any two personas differ on at least
three axes, no trait repeats, each goal has its own COMPLETE condition, and
temperatures are mixed.

Any `.yaml`/`.yml` in `personas/` is auto-loaded; the filename becomes the persona id (custom overrides built-in on collision). Only `name`, `temperature`, `goal` are required — everything else has defaults:

```yaml
# personas/my-persona.yaml
name: "Budget Bianca"
temperature: warm            # cold | warm | hot
goal: >-
  Find a tool under $20/mo that does X. Sign up for a free trial,
  bail the moment pricing is not visible.
tech_comfort: medium         # low | medium | high (default medium)
patience_steps: 12           # max steps (default 12, max 50)
max_confusion_before_bail: 8 # confusion that pushes toward abandoning (default 8)
otp_patience_seconds: 300    # email verification wait (default 300 — real mail has taken 5 min)
traits:                      # free-text personality lines — these steer the LLM
  - "checks price before features"
  - "leaves immediately if a credit card is required for a trial"
```

Traits are the personality lever — write them like a character brief, first-person reactions the LLM should mimic. Invalid files are listed with reasons by `leakdown --list-personas` and skipped (never crash runs).

## Safety

Personas may go anywhere, including pricing, billing docs and checkout pages —
reaching the wall is the finding. What is blocked is the *action*, not the page.

Enforced in `src/safety.ts`, before every action in `src/session.ts`. **This is
a best-effort label match, not a guarantee.** A label it has not seen — an
unusual phrasing, a language not listed below, a control with no accessible name
— will pass. Do not point this at a live commerce site and assume it cannot buy.

Every label is read several ways before it is judged, because the page chooses
its own spelling: accents folded, Latin lookalikes mapped in ("Googlе" with a
Cyrillic е), letter-spacing collapsed ("G o o g l e"). Every reading is checked
and any dangerous one blocks — injected text can add a label, never mask one.
That last part matters: a page can print "[ref=e12]" in its own copy, and taking
the first matching snapshot line let one hidden div relabel every control on the
page as "Continue".

- **Payment.** Card-number fields (by label), anything passing a Luhn check, and
  commit controls: "Pay", "Pay now", "Buy it now", "Place your order",
  "Complete your order", "Confirm & pay", PayPal/Apple Pay/Google Pay, "Donate",
  "Start (paid) subscription". A bare "Subscribe" is deliberately NOT blocked:
  Stripe Checkout uses it as its commit button, but a newsletter "Subscribe" is
  far commoner and a wanted action (`src/safety.ts:91`). "Upgrade" and "See
  pricing" pass — they open a checkout the persona should be able to reach and
  describe. Beyond English: es/pt/fr/de/
  it/nl commit phrasings ("Pagar", "Payer", "Kostenpflichtig bestellen",
  "Finalizar compra", "Valider la commande"), plus ru/ja/zh/ko ("Оплатить",
  "今すぐ購入", "立即购买", "결제하기"). Bare verbs count only as the WHOLE label,
  so "Métodos de pago" stays readable.
- **Meeting bookings.** The commit controls of schedulers: "Schedule Event"
  (Calendly), "Confirm meeting", "Book this slot", "Book now" — and a bare
  "Confirm"/"Schedule"/"Book" when the URL or page chrome says scheduler
  (cal.com, Calendly, timezone pickers). "Book a demo" and "Request access"
  stay clickable: they open the scheduler, and seeing that signup is
  demo-gated is the finding. Filling the form is looking; only the commit is
  refused. This guard exists because two sessions put real 20-minute meetings
  on a real founder's calendar.
- **Third-party auth.** "Sign in with X", bare provider-icon buttons whose whole
  label is "Google", "Use SSO", "Enterprise login", "Log in with your work
  account", and the same in other languages, verb-first or verb-last
  ("Continuar con Google", "Mit Google anmelden", "Googleでログイン").
  "Continue with email" is not SSO; neither is "Share via Slack".
- **Email is always the assigned mailbox** — invented addresses are overridden.

Page text reaches a model as data, never as instruction: the snapshot goes into
the persona and verification prompts with backticks stripped, so a page cannot
close the ```yaml fence around it, and the session transcript reaches the expert
panel inside an explicit untrusted-data block.

Two structural defences back the label matching: every session runs in a fresh
`browser.newContext()` (no saved cards, no logged-in provider), and `type` uses
`fill()` and never presses Enter (no implicit submit).

**There used to be a third, and it was not true.** This section claimed the
snapshot was main-frame only, so iframed Stripe/Adyen/Braintree card fields "cannot
be targeted at all". Measured on 2026-08-31: `ariaSnapshot` descends into **every**
frame, cross-origin included, and a `Card number` field inside one appears in the
snapshot with a targetable ref. The label guards do still refuse it — a framed
card field and a framed "Pay now" are both blocked, and a Luhn-passing string is
blocked whatever the field is called — but that is the regex working, not a
structural ceiling. Do not point this at a live commerce site believing the card
form is unreachable.

A refusal does not end the session. The persona is told why, and either routes
around it or walks out — which is the behaviour you want recorded.

Enforced via persona prompt only (strict, but not mechanical):
- Never deletes data, invites teammates, publishes anything, opens support chat, or contacts third parties

### Why this replaced the URL blocklist

The previous guard matched URL substrings and was wrong in both directions. It
killed two `deep-evaluator` sessions for opening `docs.site-d.ai/support/billing-and-credits`
and `platform.site-e.ai/docs/billing` — help articles, not payment
pages — while a checkout at a path without those words walked straight past it.
Judging the action instead of the address fixes both failure modes.

## Output layout

```
runs/
  <site>/                        # hostname, www. stripped (e.g. example.com)
    SITE.md                      # what the page sells, its walls, its tripwires
    MAP.md, map.json             # crawler's view: pages by kind, booking/payment surfaces
    personas/                    # the prospects generated for this product
    FLOW.md, analytics.json      # the flow under test; the owner's real-visitor numbers (optional)
    flows/                       # this site's hand-written flows (--flow-file); global ones live in ./flows/
    COMPARE.md                   # --compare: the newest run of each --variant, side by side
    RUN.md, AGGREGATE.md, DETAIL.md, VERIFIED.md, REPORT.md   # copies of the newest run's files
    <YYYY-MM-DD>/<HH-MM-SS>/     # one run = one CLI invocation (<HH-MM-SS>--<variant> for an A/B run)
      RUN.md                     # which model sat in which seat, how sessions ended, tokens, minutes
      AGGREGATE.md               # the short report over the run: one number, the walls, developer refs
      DETAIL.md                  # every session, every table, every quote — the appendix
      VERIFIED.md                # --ladder: the verifier seat's panels over the sessions the filter chose
      REPORT.md                  # --ladder: the writer seat's panel over its own deep session
      .aggregate-manifest.json   # stage-2 up-to-date check
      wide/<model>/              # the sweep, one folder per model (haiku, opencode-muse-spark-…)
        AGGREGATE.md, DETAIL.md  # the same two reports over this model's sessions only
        <HH-MM-SS>-<persona>/
          session.jsonl          # one event per step: url, thought, emotion, confusion, action
          shots/                 # step screenshots
          video.mp4              # playable recording (H.264, needs ffmpeg) + video.webm fallback
          filmstrip.html           # every step's screenshot with its thought, no video needed
          report.md              # verdict + drop-off analysis + timeline + confusion curve
          meta.json              # metadata for stages 2-3, incl. brain/model/effort
          FIXES.md               # expert panel findings (after stage 3)
      verify/<model>/            # the verifier's FIXES.md per chosen session (no sessions of its own)
        <HH-MM-SS>-<persona>/FIXES.md
      deep/<model>/              # the writer's own session, same files as a wide one
.leakdown-state.json  # doctor verification cache (gitignored)
.env                   # mail config (gitignored)
```

Three seats, any model in each: `wide` is the sweep, `verify` reviews what the
replication filter chose, `deep` re-walks the hardest prospect and writes what a
founder reads. A plain run fills only `wide`; `--ladder` fills all three
(haiku + muse-spark, sonnet, opus today — `VERIFIER` and `WRITER` in `cli.ts`).
Every run re-crawls the site once per process; when the page list changed since
`map.json` was written it asks whether to rebuild the brief and personas,
otherwise reuses them. `--no-map` skips the check. A run ends by printing the
one number and the first wall from its AGGREGATE.md, so the file is for sharing,
not for finding out. `--ladder` marks its run folder with `.ladder` and resumes
only such a run from the same day when it has no REPORT.md yet.

Session directories are found by walking `runs/` for any folder containing a
`meta.json`, so the nesting depth is not load-bearing — stages 2-3 find sessions
in any layout, and `--report` groups them by run folder (or by site when there is
none).

`video.mp4` is H.264 with faststart: plays in QuickTime, Safari, browsers, VLC. It is
transcoded after each session when `ffmpeg` is installed (`brew install ffmpeg`) and the
`video.webm` is then deleted (the mp4 is 60% of its size); without ffmpeg, or when the
transcode fails, `video.webm` (VP8) is kept. Failures never fail the run.

## Useful commands

```bash
leakdown --doctor    # verify environment
leakdown --mailtest  # mailbox create/receive/extract/destroy lifecycle test
npm run build                # compile — source is TypeScript in src/
```

Changing the code rather than running it? Build, typecheck and test commands are in
[Verifying a change](#verifying-a-change).

## Tips for agents operating this tool

1. Always run `leakdown --doctor` first on a new machine.
2. Pass `--brain`, `--model`, and `--effort` explicitly — an agent has no TTY, so
   omitting them silently accepts defaults rather than prompting.
3. Prefer `--headless` in CI/automation; headed mode is better for watching behavior live.
4. Read `runs/<site>/AGGREGATE.md` before individual reports — verdict summary first, details second.
5. `FIXES.md` sections are independent per expert; cite evidence lines when discussing fixes.
6. Sessions are immutable artifacts — re-run `fix` with `--force` to regenerate advice, never re-visit to "fix" a report.
7. A GUARDRAIL verdict is still valid data: it means the site blocked the client (stuck loop, broken page, payment wall), not that the tool failed.

---

# Part 2 — How the code works

TypeScript in `src/`, compiled to `dist/` by `tsc`. No framework, five runtime
dependencies (`playwright`, `execa`, `imapflow`, `yaml`, `zod`). The bin is
`dist/cli.js`.

## Data flow

```
cli.ts  ──►  BrowserDriver + Brain + optional MailProvider
                    │
                    ▼
              runSession()  ──►  session.jsonl  +  shots/  +  video.mp4
                    │
                    ▼
            generateReport()  ──►  report.md  +  meta.json
                    │
                    ▼
          generateAggregate()  ──►  runs/<site>/AGGREGATE.md
                    │
                    ▼
              expert panel   ──►  FIXES.md
```

Each arrow is a stage boundary and each artifact is the next stage's only input.
Stage 2 reads `meta.json` and `session.jsonl` off disk — it never sees a live
`Session` object. That is why a lost JSONL line is a lost finding.

## The session loop

`runSession()` in `src/session.ts:35`. One `for` over `persona.patience_steps`:

1. `driver.snapshot()` — accessibility YAML for the page **and all its frames**, the URL, `scrollY`, and where every ref sits relative to the viewport
2. `driver.screenshotPath(step)`
3. `brain.decide(ctx)` — the persona picks one action
4. `blockedAction()` — safety runs on the *decision*, before anything touches the page
5. act, then append the `StepEvent` to `session.jsonl` **at the end of the step**,
   so the email override and any action failure make it into the file

Four exits:

| Exit | Trigger |
|---|---|
| `completed` | `complete` action, then `verifyGoal()` agrees (`MAX_VERIFICATIONS = 2`) |
| `abandoned` | `abandon` action — the persona gives its reason |
| `guardrail` | `stuckPattern()` fires, the page becomes unreadable, or the brain fails |
| `guardrail` | patience runs out, or the wall-clock budget does (`--time`, default 20m — waiting on mail and `wait` actions is excluded, the same logic that made scrolling free) |

A persona claiming `complete` without verification does not end the session — the
loop `continue`s with a note, because personas are wrong about being done.

## Module map

| Path | Owns | Touch it when |
|---|---|---|
| `src/cli.ts` | Flag parsing, the wizard, `prepareSite`/`prepareSitePersonas`, and every stage wired end to end. The only file that knows about every other. | Adding a flag or changing the run order |
| `src/session.ts` | The step loop, exit conditions (`completed`, `abandoned`, `guardrail`, `couldnotrun`), `checkAssertions()`, the flow stop point, `goalExitCode()`, `stuckPattern()`, inbox merging | Changing how a journey runs or ends |
| `src/types.ts` | `Persona`; the `Decision` / `StepEvent` / `Verdict` zod schemas; the `Brain` and `BrainContext` interfaces; `SAFETY_RULES` prompt text | Changing the decision contract |
| `src/safety.ts` | `blockedAction()` — label extraction, Luhn, payment and SSO matching | Adding or relaxing a guard |
| `src/runs.ts` | The `runs/` layout: `siteSlug()`, `sessionPath()`, `findSessionDirs()`, the `--variant` run-folder suffix | Changing where sessions land |
| `src/doctor.ts` | Environment verification and its 7-day state cache; the daily mail-probe record | Adding a preflight check |
| `src/orders.ts` | Website orders: list, fetch, set status; `mimeWithAttachment()` for the emailed PDF | Changing how an order is fulfilled |
| `src/browser/driver.ts` | Playwright wrapper: `snapshot()` and its per-ref visibility measurement, actions, screenshots, video, popup following, `needsKeystrokes()`, `chooseRecording()` | Anything the browser does |
| `src/browser/cursor.ts` | Injected pointer and click ripple for recordings | Changing what recordings show |
| `src/browser/audit.ts` | Mechanical page checks per snapshot: controls with no accessible name, tap targets under 24px, sideways overflow, viewport meta. Recorded once per URL on the step event; the report unions them per page | Adding a measurable check |
| `src/browser/prune.ts` | `pruneSnapshot()` machine-noise removal, and `splitByViewport()` — what a person can see vs an outline of what is below | Changing what the persona perceives of a page |
| `src/brain/index.ts` | `getBrain()` — name to adapter | Registering a brain |
| `src/brain/prompt.ts` | `buildSystemPrompt()` (static, cached by the CLI) and `buildUserPrompt()` (per step); `fenceSafe()`, repair and verification prompts, history tiering | Changing what a persona sees — keep per-step facts out of the system half |
| `src/brain/catalog.ts` | `BRAIN_SPECS`, live model and effort probing | Making a new brain appear in the picker |
| `src/brain/picker.ts` | Resolving brain/model/effort from flags or menus, and validating them | Adding a brain-related flag |
| `src/brain/roles.ts` | Per-role tool restrictions | Changing what a persona or expert may do |
| `src/brain/adapters/cli-brain.ts` | The shared CLI-spawn brain: retries, `spawnEnv()`, `extractJson()`, `MAX_DECIDE_ATTEMPTS` | Changing how any CLI brain is called |
| `src/brain/adapters/{claude,codex,opencode}.ts` | Per-CLI argv and sandbox flags | Adding or fixing one brain |
| `src/persona/load.ts` | YAML discovery and validation, the `personas/` + preset registry | Changing persona loading |
| `src/persona/presets.ts` | Built-in cold / warm / hot | Tuning a preset |
| `src/persona/generate.ts` | AI-built persona sets, the core/adjacent/edge spread | Changing generation |
| `src/mail/types.ts` | The `MailProvider` interface and `MailMessage` | Adding a mail provider |
| `src/mail/imap.ts` | `ImapProvider` — mailbox lifecycle, UID-addressed reads | Changing mailbox behaviour |
| `src/mail/mime.ts` | Part picking, base64 and quoted-printable decoding, code and link extraction | Changing OTP extraction |
| `src/site/brief.ts` | `runs/<site>/SITE.md`: writing it, and `arrivalFor()` / `icpSeed()` reading it back | Changing what a site read produces, or who sees it |
| `src/site/map.ts` | `runs/<site>/map.json`: the crawl, `classify()`, and `unreached()` / `guardedSurfaces()` the aggregate reads | Changing what counts as a page, or a booking/payment surface |
| `src/site/analytics.ts` | `runs/<site>/analytics.json`: the owner's real-visitor numbers, validated and rendered for persona generation | Changing what calibration reads |
| `src/site/flow.ts` | `runs/<site>/FLOW.md`: drafting checkpoints from an intent, and `scoreFlow()` judging a finished session against them | Changing what a flow is or how sessions are scored |
| `src/site/flow-load.ts` | Hand-written flows: `flows/*.yaml` discovery and validation (`--validate-flow`), `toFlow()` into the scorer's shape, the `stop_after` stop point the session loop honours | Changing the flow file format |
| `src/log/stats.ts` | Pure counts math: Wilson `confidenceInterval()`, `lift()`, `strength()`, `overlap()`; under 3 sessions nothing is quantified | Changing how sure a report claims to be |
| `src/log/report.ts` | Per-session `report.md` and its timing | Changing a session report |
| `src/log/aggregate.ts` | `loadSessions()` (zod-validated), `generateAggregate()` (the short report), `generateDetail()` (the appendix), `renderVariants()` (the A/B section, also behind `--compare`) | Changing what an owner or a developer reads |
| `src/log/replication.ts` | Element refs cited across sessions: `collectSightings()`, `replicationTable()`; `--replication` | Changing what counts as replicated |
| `src/log/pdf.ts` | `--pdf`: one send-ready PDF per site from AGGREGATE.md + one model's FIXES.md | Changing the packet |
| `src/experts/index.ts` | The `EXPERTS` registry | Registering an expert |
| `src/experts/{ux,copywriter,reviewers,discoverability,scores}.ts` | One expert each, plus its renderer | Changing panel output |
| `src/ui/prompt.ts` | Zero-dependency `select` / `multiselect` / `text` over a raw-mode TTY | Adding a menu |

## Invariants and tripwires

Seventeen things that will bite you. Most were paid for once already — see
[DECISIONS.md](DECISIONS.md).

1. **`dist/` is build output.** Never edit it. `npm test` runs `tsc` first and then
   `dist/**/*.test.js`, so an unbuilt change tests green against stale code.
2. **Site text is untrusted input.** Any new path that quotes page text goes through
   `fenceSafe()` (`src/brain/prompt.ts:40`) and `pruneSnapshot()`. A page that prints
   ` ``` ` will otherwise close the fence and have the rest read as instruction.
3. **Shape the page in `buildPrompt`, never in `driver.snapshot()`.** The driver
   *measures* (visibility, `scrollY`); `pruneSnapshot` and `splitByViewport`
   *decide what is shown*, at prompt time. `verifyGoal` reads the full
   `ariaYaml`, or a confirmation scrolled out of view becomes a false drop-off.
4. **Sessions are immutable artifacts.** Regenerate with `--force`. Never re-visit
   a site to "fix" a bad report.
5. **The three structural defences under [Safety](#safety) carry more weight than
   the label regexes do.** They read as incidental in the driver. Breaking one
   quietly removes the real ceiling on what a persona can do to a live site.
6. **Short-maxlength fields need real keystrokes.** `needsKeystrokes()`
   (`src/browser/driver.ts:21`) — `fill()` puts the whole string in a six-box OTP
   input and only the first digit survives.
7. **`extendEnv: false` is mandatory** when spawning a brain. execa v9 silently
   re-merges the parent env without it, and `spawnEnv()`'s allowlist stops meaning
   anything.
8. **IMAP is addressed by UID everywhere.** Mixing in sequence numbers gives you
   correct envelopes with empty bodies — and, in `destroy()`, trashes unrelated mail.
9. **Validate a new flag in `src/brain/picker.ts`.** Unvalidated, it fails *after*
   launching a browser and minting a mailbox.
10. **Nothing gates the site brief.** `prepareSite()` runs before the queue is
    resolved, on purpose. Putting it behind a flag check is the bug that made
    `--persona cold` send an uninformed persona into an unread site.
11. **`arrivalFor()` decides who sees the brief, and cold sees none of it.** If you
    add a consumer, ration it there — not by reading `SITE.md` directly.
12. **A persona only ever sees one viewport, and `act()` enforces it.** 776 refs
    on site-a.dev against 37 a visitor could see. `requireOnScreen()` refuses a
    target that was not visible — without it `aria-ref=` resolves against the whole
    document and the limit is only a suggestion.
13. **Scrolling is free and must stay free.** It does not spend `patience_steps`,
    and its stuck-loop signature carries `scrollY`. Charging for it, or dropping
    the position, makes every long page guardrail while scrolling. The step
    counter prints `spent`, not the raw step, which now runs past the budget.
14. **A ref may carry a frame prefix — `f5e27`, not `e27`.** Match
    `REF_ID_PATTERN` from `prune.ts`, never a bare `e\d+`. Signup forms are
    routinely iframed, and on a page with both kinds the narrow pattern drops
    every control inside the form.
15. **Always resolve a persona with its site: `getPersonaRegistry(url)`.** Without
    it, personas generated into `runs/<site>/personas/` are missing and the
    `?? PERSONAS.cold` fallback silently reviews the run as somebody else.
16. **Queued personas may run concurrently (`--parallel`), so nothing may be shared across them.**
    Each gets its own brain, browser, `ImapProvider` and directory — an IMAP
    connection is stateful, and concurrent polls through a shared one interleave
    on a single socket. Session dirs are minted serially before launch because
    `sessionPath()`'s same-second suffix check is exists-then-create.
17. **Reports say risk, not measurement.** A simulated prospect stalling is a
    signal that real visitors could; render it that way ("people may stall
    here"), never as observed traffic. The framing lives in the renderers and
    the expert prompts — the exit kinds on disk are unchanged, so old sessions
    stay readable.

## Where to add things

- **A persona** — drop YAML in `personas/`, or add a preset in `src/persona/presets.ts`
- **An expert** — implement `Expert` in `src/experts/`, register in `src/experts/index.ts`
- **A brain** — adapter in `src/brain/adapters/` (build on `makeCliBrain`), wire into
  `src/brain/index.ts`, and add a `BrainSpec` to `src/brain/catalog.ts` or it will not
  show up in the picker
- **A mail provider** — implement `MailProvider` from `src/mail/types.ts`
- **A menu** — `select` / `multiselect` / `text` from `src/ui/prompt.ts`. They return
  silent defaults when there is no TTY, so nothing hangs in CI
- **A step-level action** — extend the `Decision` union in `src/types.ts`, handle it in
  the loop, and decide what `blockedAction()` should say about it

## Verifying a change

```bash
npm run typecheck    # tsc --noEmit
npm test             # tsc, then node --test dist/**/*.test.js

node scripts/verify-frames.mjs   # iframe measurement, needs a build + Chromium
```

`verify-frames.mjs` is deliberately outside `npm test`: it launches Chromium and
serves its own page. Run it after touching `measure()`, `splitByViewport()`, or any
ref pattern — a live site is not a reliable way to reproduce framed refs.

Tests sit beside their source as `src/**/*.test.ts` on Node's built-in runner — no
test framework. They cover the pure logic every stage depends on: run-directory
layout and discovery, the stuck-loop detector, JSON extraction from noisy CLI output,
video-clip selection, MIME decoding, expert rendering, persona loading, prompt
building, aggregation.

**What they deliberately do not cover: brains, browsers, network.** The suite runs in
well under a second and a green run is not end-to-end proof. For anything touching
the loop, the driver or a prompt, do a real run:

```bash
leakdown <url> --persona cold --brain claude --headless --stop visit
```

---

# Part 3 — Working agreements

## Skills

| Situation | Skill | Who turns it on |
|---|---|---|
| Any code change in this repo | `ponytail` | the model, by default |
| README, AGENTS, DECISIONS, commit bodies, website copy | `no-ai-slop` | the model |
| Output should cost fewer tokens | `caveman` | either |
| Output should lead with the next action, number the steps, and restate state each turn | `i-have-adhd` | **you only** — the skill blocks model invocation, so type `/i-have-adhd` |

`ponytail` as the default describes this repo rather than adding a rule to it.
`810cf44` shipped a call budget with no new flag because the ceiling already existed
structurally. `e5d15ce` deleted two working optimisations for carrying real risk at
~0% benefit. That is already the house style.

## Precedence, when more than one is on

They conflict by construction — `caveman` compresses, `i-have-adhd` expands into
numbered structure. Resolve in this order:

1. **Correctness beats brevity.** Never drop a command, path, flag, or error string
   to save tokens.
2. **`i-have-adhd` wins on structure, `caveman` wins on wording.** Keep the numbered
   steps and the next-action-first opening; compress the words inside them.
3. **`caveman` shapes chat only, never file contents.** Anything committed stays full
   English under `no-ai-slop`.
4. **`ponytail` governs the code; `no-ai-slop` governs the writing about it.** Neither
   one gets a say in the other's territory.

## Releases

`CHANGELOG.md` is the release notes and it is written as you go: every commit
with a user-visible change adds a line under **Unreleased**, in plain words a
person running the tool would recognise. Cutting a release:

```bash
# move the Unreleased block under "## <version> — <date>" in CHANGELOG.md, bump package.json, then
git add CHANGELOG.md package.json && git commit -m "<version>: <one line>"
git tag -a v<version> -m "<version>"
git push && git push --tags
gh release create v<version> --title "<version>" --notes-file <(awk '/^## <version>/{f=1;next} /^## /{f=0} f' CHANGELOG.md)
```

The GitHub Release carries the same text as the file; nothing is written twice
by hand. Layout changes under `runs/` and renamed flags are always a minor bump.
Standing rule: every push that changes behavior ships a version bump (minor for
features, flag renames, layout changes) with its CHANGELOG entry — no exceptions.

## The decisions log

[DECISIONS.md](DECISIONS.md) is where the *why* lives. Read it before proposing;
append to it when you decide.

**Append an entry** when a session rejected an alternative, hit a constraint that
shaped the design, or reversed an earlier decision. Nothing for mechanical work — if
you cannot fill in **Why**, there is no entry to write.

**When you reject something after actually trying it, add a row to "Tried and
rejected" too.** That table is the reason a fresh agent does not spend an afternoon
rebuilding the URL blocklist.

The format is at the top of the file. Newest first.
