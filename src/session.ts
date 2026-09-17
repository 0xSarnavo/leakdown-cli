import type {
  Assertion,
  AssertionResult,
  BrainContext,
  Decision,
  ExitReason,
  Persona,
  StepEvent,
} from "./types.js";
import type { BrowserDriver } from "./browser/driver.js";
import type { Brain } from "./types.js";
import { appendFileSync } from "node:fs";
import { buildVerificationPrompt } from "./brain/prompt.js";
import { blockedAction } from "./safety.js";
import { parseVerdict } from "./brain/adapters/cli-brain.js";
import type { MailProvider, Mailbox, MailMessage } from "./mail/types.js";
import { extractCodes, stripInvisible } from "./mail/types.js";

export interface SessionOptions {
  url: string;
  persona: Persona;
  brain: Brain & { ask?(prompt: string): Promise<string> };
  driver: BrowserDriver;
  sessionDir: string;
  mail?: { provider: MailProvider; box: Mailbox };
  /** Arrival context from the site brief — see BrainContext.arrival */
  arrival?: string;
  /** Wall-clock ceiling in minutes (default 20). Waiting on mail and `wait` actions do not count. */
  timeBudgetMinutes?: number;
  /**
   * Set when several sessions share one terminal: prefixes the lines that
   * carry no persona name, and suppresses the transient spinner writes —
   * clearLine races between concurrent sessions and shreds the output.
   */
  tag?: string;
  /** `--expect` checks: a completion claim only counts when every one is on the page */
  assertions?: Assertion[];
  /** A flow file's stop point: end COMPLETED as soon as this text is on screen, before spending a step */
  stopWhen?: { label: string; text: string };
}

export interface SessionResult {
  events: StepEvent[];
  exit: ExitReason;
  /** The last assertion check — on the completion claim, or the final page seen */
  assertions?: AssertionResult[];
}

const MAX_CONSECUTIVE_FAILURES = 4;
/**
 * Scroll steps a session may take beyond its patience budget before it is cut
 * off regardless. Sized for a very long landing page (~21 screens at 600px), so
 * a persona can reach the bottom of anything real, and no further.
 */
const MAX_FREE_SCROLLS = 30;
/** Completion claims re-checked per session. Each is one un-retried call. */
export const MAX_VERIFICATIONS = 2;

export async function runSession(opts: SessionOptions): Promise<SessionResult> {
  const { driver, persona, brain } = opts;
  const jsonlPath = `${opts.sessionDir}/session.jsonl`;
  const events: StepEvent[] = [];
  const tag = opts.tag ? `[${opts.tag}] ` : "";

  console.log(`\n  ${persona.name} (${persona.temperature}) is visiting ${opts.url}`);
  console.log(`  brain: ${brain.name} | patience: ${persona.patience_steps} steps\n`);

  await driver.goto(opts.url);

  let exit: ExitReason | null = null;
  let consecutiveFailures = 0;
  let failedHint: string | undefined;
  /**
   * Stuck-loop nudges. The detector used to terminate on first detection; the
   * sweep showed most of those sessions (haiku 4, sonnet 2) would have become
   * real in-character abandons if told to stop repeating. Now the persona is
   * nudged up to MAX_NUDGES times; only a loop that survives every nudge is a
   * guardrail kill. Detection runs on the full trail, so one more repetition
   * after a nudge re-fires it — an ignored nudge costs one step, not a window.
   */
  const MAX_NUDGES = 3;
  let nudgesUsed = 0;
  let nudgeHint: string | undefined;
  let verificationsUsed = 0;
  let emailResult: string | undefined;
  /** The last mail that actually landed — it stays in the inbox after later checks */
  let arrivedMail: string | undefined;
  let emailWaitSeconds = 0;
  if (opts.mail) {
    console.log(`  ${tag}mailbox: ${opts.mail.box.address}`);
  }

  /**
   * Patience counts decisions, not travel.
   *
   * The snapshot now shows one viewport instead of the whole document, so
   * reaching the bottom of a 21-screen landing page takes ~14 scrolls. Charging
   * a step for each would exhaust a 12-step persona halfway down and file it as
   * a drop-off the site did not cause. Looking around is not the thing patience
   * measures — a person who scrolls a page has not yet given up on it.
   */
  let spent = 0;
  /** Hard ceiling so a persona that only ever scrolls still terminates. */
  const maxSteps = persona.patience_steps + MAX_FREE_SCROLLS;

  /**
   * Wall-clock ceiling, so one session cannot run forever. patience_steps stays
   * the in-character "I give up" limit; this is infrastructure. Time spent
   * waiting — mail polls, deliberate `wait` actions — is excluded, the same
   * logic that made scrolling free: slow mail is not the site's fault.
   */
  const budgetMs = (opts.timeBudgetMinutes ?? 20) * 60_000;
  const startedAt = Date.now();
  let waivedMs = 0;
  let lastSnapshot = "";
  let asserted: AssertionResult[] | undefined;

  for (let step = 1; spent < persona.patience_steps && step <= maxSteps; step++) {
    const elapsedMs = Date.now() - startedAt - waivedMs;
    if (elapsedMs > budgetMs) {
      exit = {
        kind: "guardrail",
        detail: `Time budget exhausted at step ${step}: ${Math.round(elapsedMs / 60_000)}m active (budget ${budgetMs / 60_000}m, ${Math.round(waivedMs / 1000)}s of waiting/thinking excluded)`,
      };
      break;
    }
    let snap;
    let screenshotPath: string;
    try {
      // both only read the page; the screenshot no longer waits for the measurement
      [snap, screenshotPath] = await Promise.all([driver.snapshot(), driver.screenshotPath(step)]);
    } catch (e) {
      exit = {
        kind: "guardrail",
        detail: `Page became unreadable at step ${step}: ${(e as Error).message}`,
      };
      break;
    }
    lastSnapshot = snap.ariaYaml;

    // the approved flow's boundary — checked before thinking, so it costs no call
    if (opts.stopWhen && checkAssertions([{ label: opts.stopWhen.label, expected: opts.stopWhen.text }], snap.ariaYaml)[0].ok) {
      console.log(`  ${tag}■ stop point reached: "${opts.stopWhen.label}"`);
      exit = { kind: "completed", summary: `Reached the flow's stop point: ${opts.stopWhen.label} (page shows "${opts.stopWhen.text}")` };
      break;
    }

    const ctx: BrainContext = {
      persona,
      ariaYaml: snap.ariaYaml,
      screenshotPath,
      url: snap.url,
      stepNumber: step,
      history: events,
      failedHint: nudgeHint ?? failedHint,
      emailAddress: opts.mail?.box.address,
      emailResult,
      readsFiles: opts.brain.readsFiles ?? false,
      arrival: opts.arrival,
      visibility: snap.visibility,
    };

    // THINK
    // patience, not step count — scrolls are free, so the raw step number runs
    // past the budget and printing it read as "[9/8]"
    if (!opts.tag) process.stdout.write(`  [${spent + 1}/${persona.patience_steps}] thinking...`);
    let decision: Decision;
    const thinkStart = Date.now();
    try {
      decision = await brain.decide(ctx);
      // Brain latency is the CLI's speed, not the site's friction — waive it
      // from the wall clock the same way mail polling is waived. A slow model
      // now buys fewer steps only through its own patience, not the timer.
      waivedMs += Date.now() - thinkStart;
    } catch (e) {
      console.log(`${tag ? `  ${tag}brain` : ""} failed`);
      // the model, not the site: a usage limit or outage is not evidence about the page
      exit = {
        kind: "couldnotrun",
        detail: `Brain "${brain.name}" failed at step ${step}: ${(e as Error).message}`,
      };
      break;
    }
    if (!opts.tag) {
      if (process.stdout.isTTY) {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
      } else {
        process.stdout.write("\n");
      }
    }
    console.log(
      `  ${tag}[${spent + 1}/${persona.patience_steps} · ${decision.confusion}/10 confusion] ${persona.name}: "${trim(decision.thought, 100)}"`,
    );

    const event: StepEvent = {
      n: step,
      url: snap.url,
      timestamp: new Date().toISOString(),
      screenshot: screenshotPath || undefined,
      decision,
      scrollY: snap.scrollY,
      // the ruler's view of a page, once per page — the aggregate unions them
      audit: events.some((e) => e.url === snap.url) ? undefined : snap.audit,
    };

    // Looking around is not an attempt. Only decisions draw down patience.
    if (decision.action.type !== "scroll") spent++;

    // EXIT DECISIONS — complete requires verification first
    if (decision.action.type === "complete") {
      // free check first, so a wrong claim never spends a verification call
      if (opts.assertions?.length) {
        asserted = checkAssertions(opts.assertions, snap.ariaYaml);
        const failed = asserted.filter((a) => !a.ok);
        if (failed.length) {
          const note = failed.map((a) => `expected ${a.label}=${a.expected}, found ${a.found}`).join("; ");
          console.log(`  ${tag}✗ assertion failed: ${trim(note, 120)}`);
          event.note = `claimed complete but ${note}`;
          events.push(event);
          appendFileSync(jsonlPath, JSON.stringify(event) + "\n");
          continue;
        }
      }
      if (verificationsUsed < MAX_VERIFICATIONS && brain.ask) {
        verificationsUsed++;
        const verdict = await verifyGoal(brain, persona.goal, snap.ariaYaml);
        if (!verdict || !verdict.achieved) {
          const note =
            verdict?.note ??
            "verification was inconclusive — do not trust it as done";
          console.log(`  ${tag}✗ goal NOT verified complete: ${trim(note, 120)}`);
          event.note = `claimed complete but verification said: ${note}`;
          events.push(event);
          appendFileSync(jsonlPath, JSON.stringify(event) + "\n");
          continue; // keep going — the persona was wrong about being done
        }
        console.log(`  ${tag}✓ goal verified complete`);
      }
      events.push(event);
      appendFileSync(jsonlPath, JSON.stringify(event) + "\n");
      exit = { kind: "completed", summary: decision.action.summary };
      break;
    }

    if (decision.action.type === "abandon") {
      events.push(event);
      appendFileSync(jsonlPath, JSON.stringify(event) + "\n");
      exit = {
        kind: "abandoned",
        reason: decision.action.reason,
        question: decision.action.question,
      };
      break;
    }

    // GUARDRAIL: repeating action pattern — nudge before killing
    const loop = stuckPattern([...events, event]);
    if (loop) {
      if (nudgesUsed < MAX_NUDGES) {
        nudgesUsed++;
        nudgeHint = `You have repeated yourself (${loop}) and it is not working. Do something DIFFERENT — another element, scroll somewhere new, go back — or leave in character with \`abandon\` and say why.`;
        event.note = [event.note, `stuck loop (${loop}) — nudged ${nudgesUsed}/${MAX_NUDGES}, action not executed`]
          .filter(Boolean)
          .join(" | ");
        events.push(event);
        appendFileSync(jsonlPath, JSON.stringify(event) + "\n");
        console.log(`  ${tag}⚠ stuck loop (${loop}) — nudge ${nudgesUsed}/${MAX_NUDGES}`);
        continue; // the action is another lap of the loop; don't execute it
      }
      events.push(event);
      appendFileSync(jsonlPath, JSON.stringify(event) + "\n");
      exit = {
        kind: "guardrail",
        detail: `Stuck loop detected at step ${step}: ${loop} on ${snap.url} — persisted through ${MAX_NUDGES} nudges`,
      };
      break;
    }
    nudgeHint = undefined; // a non-looping decision means the nudge landed

    // Fix 3: the JSONL line is written at the END of the step, so overrides and
    // action failures recorded below actually reach the file the experts read.
    events.push(event);
    const commit = () => appendFileSync(jsonlPath, JSON.stringify(event) + "\n");

    // ACT — check_email is handled by the mail layer, not the browser
    if (decision.action.type === "check_email") {
      const waitSeconds = decision.action.seconds;
      const pollStart = Date.now();
      const check = await checkInbox(opts, waitSeconds, () => {
        emailWaitSeconds += waitSeconds;
        return emailWaitSeconds > (persona.otp_patience_seconds ?? 300);
      });
      waivedMs += Date.now() - pollStart;
      if (check.mail) arrivedMail = check.mail;
      emailResult = mergeInbox(check, arrivedMail);
      consecutiveFailures = 0;
      commit();
      continue; // no page change; next think sees the inbox result
    }

    // TRUST BOUNDARY: the brain must never invent an email address.
    // Any email it types is forced to the assigned ephemeral mailbox.
    if (
      decision.action.type === "type" &&
      opts.mail &&
      /@/.test(decision.action.text) &&
      decision.action.text.trim() !== opts.mail.box.address
    ) {
      event.note = `brain tried to use invented email "${trim(decision.action.text, 60)}" — overridden with the assigned mailbox`;
      console.log(
        `  ${tag}⚠ email override: invented address replaced with ${opts.mail.box.address}`,
      );
      decision = {
        ...decision,
        action: { ...decision.action, text: opts.mail.box.address },
      };
    }

    // SAFETY BOUNDARY: looking at a checkout page is fine, acting on it is not.
    const refusal = blockedAction(decision.action, snap.ariaYaml, snap.url);
    if (refusal) {
      event.note = [event.note, `blocked: ${refusal}`].filter(Boolean).join(" | ");
      failedHint = `The system ${refusal}. Find another way or walk out — do not retry it.`;
      console.log(`  ${tag}🛑 blocked: ${trim(refusal, 90)}`);
      commit();
      continue;
    }

    try {
      await driver.act(decision);
      if (decision.action.type === "wait") waivedMs += decision.action.seconds * 1000;
      consecutiveFailures = 0;
      failedHint = undefined;
    } catch (e) {
      consecutiveFailures++;
      failedHint = `${actionSummary(decision)} — ${trim((e as Error).message, 120)}`;
      // failures were previously invisible to stages 2-3: only the next prompt saw them
      event.note = [event.note, `action failed: ${failedHint}`].filter(Boolean).join(" | ");
      console.log(`  ${tag}⚠ action failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${trim(failedHint, 90)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        commit();
        exit = {
          kind: "guardrail",
          detail: `${consecutiveFailures} consecutive actions failed ending at step ${step} — page or element appears broken`,
        };
        break;
      }
    }
    commit();
  }

  if (!exit) {
    exit = {
      kind: "guardrail",
      detail: `Ran out of patience after ${persona.patience_steps} steps without completing the goal`,
    };
  }

  // never claimed complete: still say what the last page showed
  if (opts.assertions?.length && !asserted && lastSnapshot) asserted = checkAssertions(opts.assertions, lastSnapshot);
  return { events, exit, assertions: asserted };
}

/**
 * `--goal` exit code: 0 every session completed, 1 the site failed somebody
 * (walked out, stuck, out of patience), 2 nothing failed but not everyone ran
 * (unreachable URL, brain down, setup error) — so CI can tell app from infra.
 */
export function goalExitCode(exits: ExitReason["kind"][], expected: number): 0 | 1 | 2 {
  if (exits.some((k) => k === "abandoned" || k === "guardrail")) return 1;
  if (exits.length < expected || exits.some((k) => k === "couldnotrun")) return 2;
  return 0;
}

/**
 * Dumb substring match against the full snapshot (invariant 3: a value scrolled
 * out of view still counts). `found` quotes the snapshot line that mentions the
 * label, so a mismatch reads "expected total=$96.00, found 'Total: $120.00'".
 */
export function checkAssertions(assertions: Assertion[], ariaYaml: string): AssertionResult[] {
  const flat = ariaYaml.replace(/\s+/g, " ");
  return assertions.map((a) => {
    const ok = flat.includes(a.expected.replace(/\s+/g, " ").trim());
    if (ok) return { ...a, ok, found: a.expected };
    // whole word first ("Total" before "Subtotal"), then any mention
    const lines = ariaYaml.split("\n");
    const word = new RegExp(`\\b${a.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const line = lines.find((l) => word.test(l)) ?? lines.find((l) => l.toLowerCase().includes(a.label.toLowerCase()));
    return { ...a, ok, found: line ? `"${trim(line.replace(/^[\s-]+/, ""), 160)}"` : `nothing mentioning "${a.label}" on the page` };
  });
}

async function verifyGoal(
  brain: Brain & { ask?(prompt: string): Promise<string> },
  goal: string,
  ariaYaml: string,
): Promise<{ achieved: boolean; note: string } | null> {
  try {
    const text = await brain.ask!(buildVerificationPrompt({ goal, ariaYaml }));
    return parseVerdict(text);
  } catch {
    return null; // verification infrastructure failed → treat as inconclusive
  }
}

export interface InboxCheck {
  /** What to show when nothing has ever arrived (empty inbox, failure, no mailbox) */
  text: string;
  /** Rendered messages, set only when this check found new mail */
  mail?: string;
}

/**
 * What the persona sees in their inbox on the next step.
 *
 * The provider reports only NEW messages, so a second check after the code
 * already landed comes back empty — and the code would vanish from the prompt,
 * which is exactly how a working magic-link flow got abandoned as broken. Mail
 * that arrived stays visible, and the "give up waiting" nudge is suppressed
 * once there is something to act on.
 */
export function mergeInbox(check: InboxCheck, arrived?: string): string {
  if (check.mail) return check.mail;
  if (!arrived) return check.text;
  return `${arrived}\n\n(you checked again — nothing NEW arrived, but the message above is still sitting in your inbox. Use it instead of waiting for another one.)`;
}

/** Poll the persona's mailbox, waiting up to `seconds` for something new to arrive. */
async function checkInbox(
  opts: SessionOptions,
  seconds: number,
  onWaited: () => boolean,
): Promise<InboxCheck> {
  if (!opts.mail) {
    return { text: "(no mailbox is configured in this environment — you cannot receive email)" };
  }

  const deadline = Date.now() + seconds * 1000;
  if (opts.tag) console.log(`  [${opts.tag}] 📬 checking inbox (${seconds}s)...`);
  else process.stdout.write(`  📬 checking inbox (${seconds}s)...`);
  let msgs: MailMessage[] = [];
  while (Date.now() < deadline) {
    try {
      msgs = await opts.mail.provider.fetchNew(opts.mail.box);
    } catch (e) {
      console.log(` failed`);
      return { text: `inbox check failed: ${trim((e as Error).message, 120)}` };
    }
    if (msgs.length > 0) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!opts.tag) {
    if (process.stdout.isTTY) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    } else {
      process.stdout.write("\n");
    }
  }

  if (msgs.length === 0) {
    const exhausted = onWaited();
    return {
      text: `(no new mail after waiting ${seconds}s)${
        exhausted ? " — you have now waited longer than your patience allows. You are done waiting; abandon or find another way." : ""
      }`,
    };
  }

  // every email format is different — render each message and let the brain see it
  const canReadFiles = opts.brain.readsFiles ?? false;
  const parts: string[] = [`${msgs.length} new message(s):`];
  for (let i = 0; i < Math.min(msgs.length, 2); i++) {
    const m = msgs[i];
    const codes = extractCodes(m.subject, m.text);
    parts.push(`mail #${i + 1} from ${m.from} — subject: ${m.subject}`);
    if (codes.length) parts.push(`  candidate codes (may include junk): ${codes.join(", ")}`);
    // The body text always ships. A screenshot is a bonus, never the only copy:
    // one email rendered as a blank PNG and the persona, told to read it, saw
    // nothing and walked out of a login flow that was working fine.
    const body = stripInvisible(m.text).replace(/\s+/g, " ").trim();
    if (body) parts.push(`  body: ${trim(body, 600)}`);
    if (canReadFiles) {
      const shot = `${opts.sessionDir}/shots/email-${i + 1}.png`;
      const saved = await opts.driver.emailScreenshot(m.html ?? m.text, shot);
      if (saved) {
        parts.push(`  screenshot of this email (may be blank — trust the text above if so): ${saved}`);
      }
    }
  }
  const mail = parts.join("\n");
  return { text: mail, mail };
}

/**
 * Detect a repeating action pattern, not just an identical one.
 *
 * The old check only caught the same action three times running, so an A-B-A-B
 * ping-pong between two pages ran until patience was exhausted — every step
 * paying for a full page snapshot. Cycle lengths up to 3 are checked, each
 * needing enough repetitions that ordinary exploration cannot trip it.
 */
export function stuckPattern(events: StepEvent[]): string | null {
  /**
   * A scroll's signature includes where the page was when it happened.
   *
   * Since the snapshot became viewport-sized, working down a long page means
   * scrolling several times in a row, and "same action 3x" would call that a
   * loop and kill the session. Folding the position in separates the two cases
   * without a special rule: three scrolls at 0 / 600 / 1200 are three different
   * signatures, three at the bottom of the page are one repeated.
   */
  const sigs = events.map((e) => {
    const sig = JSON.stringify(e.decision.action);
    return e.decision.action.type === "scroll" ? `${sig}@${e.scrollY ?? "?"}` : sig;
  });
  // period -> repetitions required before we call it a loop
  const PATTERNS: [number, number][] = [
    [1, 3], // same action 3x
    [2, 3], // A-B-A-B-A-B
    [3, 2], // A-B-C-A-B-C
  ];
  for (const [period, reps] of PATTERNS) {
    const span = period * reps;
    if (sigs.length < span) continue;
    const tail = sigs.slice(-span);
    const first = tail.slice(0, period);
    if (tail.every((sig, i) => sig === first[i % period])) {
      return period === 1
        ? `same action repeated ${reps} times`
        : `${period}-step loop repeated ${reps} times`;
    }
  }
  return null;
}

function actionSummary(d: Decision): string {
  switch (d.action.type) {
    case "click":
      return `clicking ${d.action.target}`;
    case "type":
      return `typing into ${d.action.target}`;
    case "select":
      return `selecting "${d.action.value}"`;
    case "scroll":
      return `scrolling ${d.action.direction}`;
    case "back":
      return `going back`;
    case "wait":
      return `pausing`;
    case "check_email":
      return `checking your inbox`;
    default:
      return d.action.type;
  }
}

function trim(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}
