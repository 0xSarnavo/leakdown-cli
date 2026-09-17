# PLAN.md

What is settled, what is next, and what has been ruled out.

[AGENTS.md](AGENTS.md) is how to run and change the tool. [DECISIONS.md](DECISIONS.md)
is why each past choice was made. This file is only the forward view — if you are
about to propose work, read the two lists below first.

---

## Settled

Shipped and not up for renegotiation without a reason written into DECISIONS.md.

| Area | Note |
|---|---|
| Six stages, one command | `site → map → personas → visit → report → fix`; `--ladder` runs the measured fleet, `--stop` ends early; interactive runs get a continue/redo/settings/stop gate between stages |
| Site brief + per-site persona sets | `runs/<site>/SITE.md`, `runs/<site>/personas/` (default set: 10) |
| Bot-wall scout | the brief's scrape detects Cloudflare/captcha walls, writes `runs/<site>/BLOCKED.md`, and runs skip the site until it is deleted or `--plan` re-checks |
| Flow under test | stated intent → reviewed checkpoints in `runs/<site>/FLOW.md` → per-session scoring → funnel in the aggregate. Optional; no flow file means wander |
| Concurrent visits | queued personas run at once, each fully isolated; output lines tagged by persona id |
| Time budget | `--time` minutes per session (default 20), waiting on mail/`wait` excluded |
| Risk framing | reports warn what real visitors *could* hit; they never claim measured behaviour |
| Temperature is prior knowledge | cold knows nothing, warm the arrival context, hot the specifics |
| A persona sees one viewport | plus a headings outline; scrolling costs no patience |
| Sessions are immutable evidence | reports and expert advice regenerate from them |
| Ephemeral mailboxes | OTP codes and magic links, per run, moved to Trash after (purged by the mail provider's own schedule) |
| Brains | claude, opencode, codex — any brain, any stage |
| Safety | payment and third-party auth, by action not URL. Best-effort, not a guarantee |
| Expert panel | 7 experts, one `FIXES.md` per session |
| Goal runs are checks | `--expect label=value` must be on the page for a completion to count; exit 0 pass, 1 the site failed somebody, 2 could not run (our side) |
| Could-not-run is neutral | unreachable page, brain down, setup failure: its own verdict, never read as a guardrail or a drop-off |
| Counts carry intervals | every wall and replicated ref: "3/5 sessions · 60% [23–88%]"; under 3 sessions, "too few to call" |
| Flows you write | `flows/*.yaml`, validated with `--validate-flow`, run with `--flow-file`; a `stop_after` step with `expect` text ends the session COMPLETED |
| A/B on one laptop | `--variant` per run, `--compare <site>` ranks two with intervals or says "no meaningful difference" |

## Next

In order. Each is stated as the problem; the solution deserves an argument
when it is picked up. Measured answers from 2026-09-14 are in DECISIONS.md.

**1. Nobody outside has used it.** Three sites have reports; no owner has
said which findings were right. Alpha: send the reports, collect
`runs/<site>/VERDICTS.md` ticks, run `--ladder` on their next release.

**2. The verifier has only ever seen supporting evidence.** Sonnet verifies
from the three sessions that best support a finding. Feed it the three worst;
if the verdict flips, verification is theatre.

**3. False-positive rate on a clean site is unmeasured.** One sweep of a
site everyone agrees is fine gives the number every skeptic asks for.

**4. Edge personas are half-stable (2.5/4 retest).** They get through the
funnel and explore. The report now says so; whether that is signal or noise
needs an owner's ticks.

**5. Muse-spark never leaves with a reason.** Full sessions now, but every
exit is patience. A compact prompt with one worked abandon may fix it.

**6. Does calibration help?** `analytics.json` exists; nobody has run
calibrated vs synthetic on one site.

**7. Mobile is a flag, not a trait.** `--mobile` applies to a whole run.

**8. Frames are measured in their own coordinate space.** No page has needed
the fix yet.

## Ruled out

Full list with evidence: [DECISIONS.md → Tried and rejected](DECISIONS.md#tried-and-rejected--do-not-re-propose).
The two that get re-proposed most:

- **Screenshots plus model-estimated click coordinates.** Playwright already
  clicks with a real mouse at real coordinates and hit-tests first. Guessed pixels
  trade an exact target for an approximate one, and a missed click reads as a
  broken button — the tool would invent drop-offs.
- **Returning-visitor memory.** Personas that recall previous runs. Cut during
  refinement; revisit only if real use demands it.
