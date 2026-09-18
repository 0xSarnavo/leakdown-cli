```
          @
        O @ .
      O @ O o .
      @ @ @ O O
    @ @ @ @ O O o
  @ @ @ @ @ O o : .
  O @ @ O O O o : .
  O O O O o o : . .
  : o o o o : . . .
    : : : : . . .
      . . . . .
          .
```

# Leakdown

Simulated prospects walk through your website's signup in a real browser, think out loud, and quit the way people do. You get one page: where they stalled, in their words, with the element and a "check it yourself" line — and an expert layer that proposes the fix.

Alpha. Runs on the AI CLI subscription you already have (Claude Code, opencode, Codex). No API keys needed.

**Only run it against sites you own or have written permission to test.** It creates real accounts on the site, triggers the real emails and webhooks a signup triggers, and records what it sees. Use a staging copy when you can.

```bash
git clone https://github.com/0xSarnavo/leakdown-cli
cd leakdown-cli && npm ci && npm run build
npx playwright install chromium
brew install ffmpeg                                           # playable video.mp4 per session (else video.webm only)
node dist/cli.js --doctor                                  # checks Node, Chromium, your AI CLI, mail
node dist/cli.js your-site.com --ladder --yes --headless   # the whole thing, ~1 hour
```

Then read `runs/your-site.com/AGGREGATE.md`.

(Installed globally? The same commands work as `leakdown --doctor` and `leakdown your-site.com --ladder --yes --headless`. `.env` is read from, and `runs/` is written to, the directory you run it in.)

## What one run does

| Stage | What happens | Writes |
|---|---|---|
| site | reads the landing page: product, audience, walls; detects bot walls | `SITE.md` |
| map | crawls two clicks + sitemap, no AI: pages by kind, booking/payment surfaces, broken links | `MAP.md` |
| personas | builds 10 prospects that fit the product: core, adjacent, edge | `personas/*.yaml` |
| visit | one browser session per persona; each step: snapshot → decide → act | `session.jsonl`, `shots/` (retina), `video.mp4` (`video.webm` without ffmpeg), `filmstrip.html`, `report.md` |
| report | the one-page report, plus every table behind it | `AGGREGATE.md`, `DETAIL.md` |
| fix | expert panel per session | `FIXES.md` |

`--ladder` runs the full run: half the personas on haiku, half on a free opencode model, a mechanical filter keeps only what more than one session cites, sonnet verifies up to three of those sessions, opus re-walks the hardest persona and writes its report. Cheap models vote; only opus writes what you read.

## What the report says

- **The one number** — how many completed, walked out with a reason, ran out of patience; sessions that could not run (our side) are counted apart, never as a drop-off.
- **How sure** — every wall and every replicated finding carries its count with a 95% interval; under three sessions it says "too few to call".
- **Fix these first** — the three pages prospects left from, who, one quote, and what they were doing right before leaving so you can reproduce it in a browser.
- **Measured on the page** — a ruler, not a persona: controls with no accessible name, tap targets under 24px, sideways scroll, missing viewport meta.
- **For developers** — element refs cited by more than one session; refs seen once are listed as unverified, not hidden.
- **Also found by the crawler** — real 404s and unreachable links.
- **Variants compared** — after two `--variant` runs, `--compare <site>` ranks them or says "no meaningful difference".

Read it as risk, not traffic: a simulated prospect stalling is a signal that real visitors could, never a measurement of them.

## What it never does

- Pays, books a meeting, or signs in with Google/GitHub/SSO. Reaching the wall is the finding; the commit is refused by a guard. Best-effort label matching — do not point it at a live checkout and assume it cannot buy.
- Deletes data, invites teammates, publishes anything, opens support chat, or contacts third parties (prompt rule, not mechanical — a "request a demo" form or a free trial that needs no card will be submitted like any other form).
- Runs personas that know your site: cold personas arrive knowing nothing, warm know the pitch, hot know the price and the signup path.

## Email walls

Signup flows send codes and magic links. With a catch-all domain forwarded to an IMAP inbox, every persona gets its own address and reads its own mail. Copy `.env.example` to `.env` and fill it in (never commit `.env`):

```
LEAKDOWN_IMAP_HOST="imap.gmail.com"
LEAKDOWN_IMAP_USER="you@gmail.com"
LEAKDOWN_IMAP_PASS="xxxx xxxx xxxx xxxx"   # app password
LEAKDOWN_MAIL_DOMAIN="yourdomain.com"      # catch-all → that inbox
LEAKDOWN_IMAP_PORT="993"                   # optional, for a non-Gmail host
LEAKDOWN_IMAP_TLS="false"                  # optional, and only this exact word turns TLS off
```

> The old `CLIENTSIM_*` names still work but are deprecated — use `LEAKDOWN_*`.

Each persona's mail is moved to that mailbox's Trash when its session ends (Gmail keeps Trash for about 30 days); it is not purged.

`--mailtest` proves the SMTP and IMAP side. Every run checks the mailbox once a day and marks its sessions; if two prospects blame email and nothing inbound arrived, the report says the verdicts are unverified rather than blaming your site.

## Other ways to run it

```bash
leakdown <url>                                   # plain pipeline, menus for brain, model, who visits
leakdown <url> --goal "sign up and get an API key" --steps 15 --yes   # pass/fail for CI: exit 0 pass, 1 fail, 2 could not run
leakdown <url> --goal "apply SAVE20" --expect "total=$96.00" --yes     # the page must show the value; the report quotes what it found
leakdown <url> --flow "signup through to the dashboard"               # checkpoints, scored per session
leakdown <url> --flow-file signup                                     # your own flows/signup.yaml; --validate-flow checks it first
leakdown <url> --persona marcus,marcus,marcus    # same persona three times
leakdown <url> --variant control --yes && leakdown <url2> --variant new --yes && leakdown --compare <site>   # A/B, ranked with intervals
leakdown --history                               # every run, one line each, with its one number
leakdown --report | --fix | --replication <site>  # a site name means its newest run; site/date/time names one
```

Drop `runs/<site>/analytics.json` (top exit pages, device mix, entry sources) and the personas are weighted toward your real visitors.

## What it stores, and how to delete it

Everything lands under `runs/<site>/` on the machine that ran it — nothing is uploaded. Per session: `session.jsonl` (every thought and every string the persona typed, including the names and passwords it invents), `verifications.jsonl` (the page text behind every completion claim, so a verdict can be checked afterwards), `shots/` (a screenshot per step, plus a render of every email received), `video.mp4`, `filmstrip.html`, `report.md`, `meta.json`. Screenshots and video show whatever the page showed — sign in past a signup and your own dashboard is on film. Delete a site with `rm -rf runs/<site>`.

After a run, `runs/<site>/VERDICTS.md` lists each wall with a `?:`; change it to `real:` or `false:` and the next report counts your verdicts.

## Requirements

Node 20+, Chromium via Playwright, one AI CLI logged in: `claude` (Claude Code), `opencode`, or `codex`. A personal subscription hits usage limits on a long sweep; the queue stops and tells you to rerun later — nothing is lost. `leakdown --version` prints the version to put in a bug report.

The tool drives your AI CLI as a subprocess, one call per step (up to three attempts each). Automated use of a consumer subscription is between you and that provider's terms and rate limits; check them. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and their `*_BASE_URL` are passed through to the CLIs if you set them, but that path is untested here.

## Docs

`AGENTS.md` is the full operating and code guide. `DECISIONS.md` is why the code looks the way it does, including the ideas that were built, measured and thrown away. `CONTRIBUTING.md` is how to contribute. `CHANGELOG.md` is the release notes.

[MIT](LICENSE) — Sarnavo Saha Sardar.
