import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import type { Decision } from "../types.js";
import { CURSOR_SCRIPT } from "./cursor.js";
import { findFfmpeg, transcodeToMp4 } from "./video.js";

/**
 * Pick the recording that is the actual journey.
 *
 * Playwright writes one file per page, so popups and off-screen email renders
 * each produce their own. The main session is always the longest, and file size
 * is a reliable proxy for length at a fixed resolution.
 */
/**
 * Whether text has to be typed as real keystrokes instead of set in one shot.
 *
 * fill() writes the value directly, so a six-box OTP input (maxlength=1 each)
 * keeps only the first character and the page's auto-advance never fires. The
 * persona then spends a step per digit and reports the site as broken for it —
 * which is exactly what happened on both site-d.ai and site-c.com.
 * maxLength is -1 on fields that set no limit.
 */
import { smallTargets, unnamedControls, type PageAudit } from "./audit.js";

export function needsKeystrokes(maxLength: number, textLength: number): boolean {
  return maxLength > 0 && maxLength < textLength;
}

export function chooseRecording<T extends { file: string; size: number }>(
  clips: T[],
): T | null {
  if (clips.length === 0) return null;
  return clips.reduce((best, c) => (c.size > best.size ? c : best));
}

/** Where one ref sits relative to what a visitor can see right now. */
export interface RefVisibility {
  /** transparent or zero-size — in the tree, invisible to a person */
  hidden: boolean;
  /** rendered size in CSS px, for the tap-target audit */
  w?: number;
  h?: number;
  /** starts below the fold; reaching it requires scrolling */
  belowFold: boolean;
  /** intersects the viewport as it is scrolled right now */
  onScreen: boolean;
}

export interface PageSnapshot {
  ariaYaml: string;
  url: string;
  /** what a ruler says about this page; see browser/audit.ts */
  audit: PageAudit;
  /** ref -> where it sits relative to the viewport. See BrowserDriver.measure. */
  visibility: Record<string, RefVisibility>;
  /** How far down the page is scrolled. Distinguishes "still moving" from "stuck at the bottom". */
  scrollY: number;
}

export class BrowserDriver {
  private browser!: import("playwright").Browser;
  private context!: import("playwright").BrowserContext;
  page!: import("playwright").Page;
  shotsDir!: string;
  private videoDir?: string;
  private videoSaved = false;
  /** Visibility from the most recent snapshot — what act() is allowed to touch. */
  private lastVisibility: Record<string, RefVisibility> = {};

  async launch(opts: {
    headless: boolean;
    shotsDir: string;
    mobile?: boolean;
    /** Where Playwright writes raw per-page recordings. Omit to skip recording entirely. */
    videoDir?: string;
  }) {
    const { chromium } = await import("playwright");
    this.shotsDir = opts.shotsDir;
    this.videoDir = opts.videoDir;
    const viewport = opts.mobile
      ? { width: 390, height: 844 }
      : { width: 1280, height: 800 };
    this.browser = await chromium.launch({ headless: opts.headless });
    this.context = await this.browser.newContext({
      viewport,
      // retina screenshots: 1x shots look soft on modern screens and in PDFs.
      // Video is unaffected (recordVideo encodes at `size`, the CSS viewport).
      // The persona reads these shots too, so this trades tokens for legibility.
      deviceScaleFactor: 2,
      // still CSS animations make recordings calmer and stop mid-animation
      // screenshots from reading as broken pages
      reducedMotion: "reduce",
      isMobile: !!opts.mobile,
      hasTouch: !!opts.mobile,
      userAgent: opts.mobile
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        : undefined,
      ...(opts.videoDir
        ? { recordVideo: { dir: opts.videoDir, size: viewport } }
        : {}),
    });
    // only worth injecting when there is a recording to watch
    if (opts.videoDir) await this.context.addInitScript(CURSOR_SCRIPT);

    this.page = await this.context.newPage();

    // Bulletproof popup/new-tab handling: always follow the newest page,
    // return to the previous live page when a popup closes or crashes,
    // and never strand the session on a dead page.
    const pageStack: import("playwright").Page[] = [];
    this.context.on("page", (page) => {
      if (page === this.page || page.isClosed()) return;
      pageStack.push(this.page);
      this.page = page;
      const revert = () => {
        if (this.page !== page) return; // a newer page already took over
        while (pageStack.length > 0) {
          const prev = pageStack.pop()!;
          if (!prev.isClosed()) {
            this.page = prev;
            return;
          }
        }
        // every page is gone — open a fresh one so the session can continue
        this.context
          .newPage()
          .then((p) => {
            this.page = p;
          })
          .catch(() => {});
      };
      page.once("close", revert);
      page.once("crash", revert);
    });
  }

  async goto(url: string) {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.page.waitForTimeout(1500); // let hydration settle
  }

  async snapshot(): Promise<PageSnapshot> {
    let ariaYaml: string;
    try {
      ariaYaml = await this.page
        .locator("body")
        .ariaSnapshot({ mode: "ai", timeout: 5000 });
    } catch {
      ariaYaml = "(failed to capture accessibility snapshot)";
    }
    if (!ariaYaml.trim()) ariaYaml = "(page appears blank)";

    // one round trip for the page-level numbers, in parallel with the per-ref measurement — all read-only
    const [visibility, layout] = await Promise.all([
      this.measure(ariaYaml),
      this.page
        .evaluate(() => ({
          scrollY: Math.round(window.scrollY),
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
          viewportMeta: !!document.querySelector('meta[name="viewport"]'),
        }))
        .catch(() => ({ scrollY: 0, overflowX: false, viewportMeta: true })),
    ]);
    this.lastVisibility = visibility;
    const { scrollY, ...rest } = layout;
    const layoutOnly = rest;
    const audit: PageAudit = {
      unnamed: unnamedControls(ariaYaml, this.lastVisibility),
      small: smallTargets(ariaYaml, this.lastVisibility),
      ...layoutOnly,
    };
    return { ariaYaml, url: this.page.url(), visibility: this.lastVisibility, scrollY, audit };
  }

  /**
   * Refuse to act on something the persona was never shown.
   *
   * The prompt only carries refs that were on screen, but `aria-ref=` resolves
   * against the whole document, and refs are sequential and appear in the
   * rendered history — so a persona could name a footer link it never scrolled
   * to and the driver would happily scroll down and click it. That would make
   * the viewport limit a suggestion rather than a rule, which is the exact
   * thing 712adcd corrected elsewhere: do not describe a prompt-only rule as
   * enforced.
   *
   * An unmeasured ref is allowed through. It is either an older snapshot with
   * no visibility data or a stale ref, and both fail honestly at click time.
   */
  private requireOnScreen(target: string): void {
    const v = this.lastVisibility[target];
    if (!v) return;
    if (v.hidden) {
      throw new Error(`${target} is not visible on the page — a person could not act on it`);
    }
    if (!v.onScreen) {
      throw new Error(`${target} is not on screen — scroll to it before acting on it`);
    }
  }

  /**
   * Where each ref sits relative to what a visitor can actually see.
   *
   * The accessibility tree is the whole document at once. On a 21-screen landing
   * page that is 776 refs, of which a person looking at the top can see 37 — so
   * without this the persona clicks footer links it never scrolled to and treats
   * a hero CTA and a legal link as equals. Measured here rather than in
   * pruneSnapshot because it needs the live layout, not the YAML.
   *
   * Playwright keeps the ref-to-element mapping internal, so there is no way to
   * do this in one page.evaluate. Resolving every ref concurrently costs ~840ms
   * on the page above, against an AI call of 5-30s.
   *
   * Known limit: for a ref inside an iframe the rect and innerHeight are the
   * frame's, so it reads as visible whenever it is visible *within its frame*,
   * even if the frame itself is scrolled off. Walking the frame chain would fix
   * it; no page seen so far needs that, and a false "visible" only restores the
   * old behaviour for one element rather than hiding a real control.
   */
  private async measure(ariaYaml: string): Promise<Record<string, RefVisibility>> {
    // `f5e27` is a ref inside frame 5 — signup forms are routinely iframed, and
    // a pattern matching only `eN` leaves every control in them unmeasured
    const refs = [...new Set([...ariaYaml.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map((m) => m[1]))];
    if (refs.length === 0) return {};

    const probe = (node: Element) => {
      const r = node.getBoundingClientRect();
      // a transparent ancestor hides its children too, so walk up
      let opacity = 1;
      for (let n: Element | null = node; n && n !== document.documentElement; n = n.parentElement) {
        opacity *= parseFloat(getComputedStyle(n).opacity || "1");
      }
      return {
        hidden: (r.width === 0 && r.height === 0) || opacity < 0.05,
        w: Math.round(r.width),
        h: Math.round(r.height),
        belowFold: r.top >= window.innerHeight,
        onScreen: r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth,
      };
    };

    const results = await Promise.all(
      refs.map((ref) =>
        this.page
          .locator(`aria-ref=${ref}`)
          .evaluate(probe)
          .catch(() => null),
      ),
    );

    const out: Record<string, RefVisibility> = {};
    refs.forEach((ref, i) => {
      // an unresolvable ref is treated as visible: guessing it away would hide a
      // real control, and a stale ref simply fails at click time instead
      out[ref] = results[i] ?? { hidden: false, belowFold: false, onScreen: true };
    });
    return out;
  }

  async screenshotPath(stepNumber: number): Promise<string> {
    const path = `${this.shotsDir}/step-${String(stepNumber).padStart(3, "0")}.png`;
    try {
      // crisp text, no caret lottery: webfonts swap mid-shot otherwise, and a
      // blinking cursor lands randomly across evidence screenshots
      await this.page.evaluate(() => document.fonts?.ready).catch(() => {});
      await this.page.screenshot({ path, fullPage: false, caret: "hide" });
      return path;
    } catch {
      return "";
    }
  }

  async act(decision: Decision): Promise<void> {
    const a = decision.action;
    if ("target" in a) this.requireOnScreen(a.target);

    switch (a.type) {
      case "click": {
        const el = this.page.locator(`aria-ref=${a.target}`);
        try {
          await el.click({ timeout: 10_000 });
        } catch {
          // it passed requireOnScreen, so it was visible when the page was read
          // — a sticky bar may have moved over it since. Nudge and retry once.
          await el.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
          await el.click({ timeout: 10_000 });
        }
        break;
      }
      case "type": {
        const el = this.page.locator(`aria-ref=${a.target}`);
        const maxLength = await el
          .evaluate((node) => (node as HTMLInputElement).maxLength ?? -1)
          .catch(() => -1);
        if (needsKeystrokes(maxLength, a.text.length)) {
          // One box per character. Click in, then let the page's own key
          // handlers move focus along as each character lands.
          await el.click({ timeout: 10_000 });
          await this.page.keyboard.type(a.text, { delay: 30 });
        } else {
          await el.fill(a.text, { timeout: 10_000 });
        }
        break;
      }
      case "select": {
        const el = this.page.locator(`aria-ref=${a.target}`);
        try {
          await el.selectOption({ label: a.value }, { timeout: 10_000 });
        } catch {
          await el.selectOption(a.value, { timeout: 10_000 });
        }
        break;
      }
      case "scroll": {
        await this.page.mouse.wheel(0, a.direction === "down" ? 600 : -600);
        break;
      }
      case "back": {
        await this.page.goBack({ timeout: 15_000 }).catch(() => {});
        break;
      }
      case "wait": {
        await this.page.waitForTimeout(a.seconds * 1000);
        break;
      }
      default:
        break; // complete / abandon handled by session loop
    }

    // a scroll or a pause never navigates: a short settle for lazy content, not a
    // network wait — networkidle never fires on pages with beacons, and a long page
    // takes ~14 scrolls, which was up to 7s of waiting each (measured 2026-09-17)
    if (a.type === "scroll" || a.type === "wait") {
      await this.page.waitForTimeout(300);
      return;
    }
    // settle after navigation-triggering actions
    await this.page
      .waitForLoadState("domcontentloaded", { timeout: 15_000 })
      .catch(() => {});
    // let XHR/fetch traffic finish before we snapshot
    await this.page
      .waitForLoadState("networkidle", { timeout: 6_000 })
      .catch(() => {});
    await this.page.waitForTimeout(1000);
  }

  /**
   * Finalize the session video. Safe to call from a `finally` — it runs at most
   * once and tolerates an already-closed context.
   *
   * Playwright writes one recording per page, so popups and off-screen email
   * renders each produce their own file. The main journey is always the longest
   * one, so that is the file we keep; the rest are discarded. The winner is
   * *moved* rather than copied, so no duplicate is left behind.
   *
   * Playwright records VP8 `.webm`, which QuickTime and Safari refuse to open,
   * so the winner is also transcoded to H.264 `.mp4` (faststart) beside it.
   * No new dependency: system ffmpeg first, else the copy Playwright itself
   * downloaded. No ffmpeg anywhere means `.webm` only — never a failed run.
   *
   * Returns which artifacts exist afterwards (both null when nothing recorded).
   */
  async saveVideo(path: string): Promise<{ webm: string | null; mp4: string | null }> {
    if (this.videoSaved || !this.videoDir) return { webm: null, mp4: null };
    this.videoSaved = true;

    // The journey is whatever page it ENDED on: popups are followed, and when
    // one closes the stack reverts, so this.page is always the live journey.
    // Size is not a proxy for this — a heavy landing page left open in tab one
    // outweighs the signup tab the persona actually finished in.
    const journeyVideo = this.page?.video?.();

    await this.context?.close().catch(() => {}); // recordings finalize on context close
    if (!existsSync(this.videoDir)) return { webm: null, mp4: null };

    let saved = false;
    if (journeyVideo) {
      saved = await journeyVideo
        .saveAs(path)
        .then(() => true)
        .catch(() => false);
    }

    if (!saved) {
      // no page video (crashed before first paint) — keep the longest clip we have
      const clips = readdirSync(this.videoDir)
        .filter((f) => f.endsWith(".webm"))
        .map((f) => `${this.videoDir}/${f}`)
        .map((file) => ({ file, size: statSync(file).size }));
      const main = chooseRecording(clips);
      if (main) {
        try {
          renameSync(main.file, path);
          saved = true;
        } catch {
          return { webm: null, mp4: null }; // cross-device or racing writer — leave the raw dir rather than lose it
        }
      }
    }
    rmSync(this.videoDir, { recursive: true, force: true });
    if (!saved || !existsSync(path)) return { webm: null, mp4: null };

    // playable copy; the webm is kept only when ffmpeg is nowhere to be found
    // (the mp4 is 60% of its size and every player opens it — measured 2026-09-17)
    const mp4 = path.replace(/\.webm$/, ".mp4");
    const ffmpeg = await findFfmpeg().catch(() => null);
    const playable = ffmpeg ? await transcodeToMp4(ffmpeg, path, mp4).catch(() => false) : false;
    if (playable) {
      rmSync(path, { force: true });
      return { webm: null, mp4 };
    }
    return { webm: path, mp4: null };
  }

  /**
   * Render an email's HTML off-screen and screenshot it — lets the brain SEE any OTP format.
   *
   * Email content is untrusted: render it in a throwaway context with JavaScript
   * disabled and all network requests aborted, so a hostile mail cannot run
   * scripts, beacon the operator, or hijack the journey via popup promotion.
   */
  async emailScreenshot(html: string, path: string): Promise<string> {
    let context: import("playwright").BrowserContext | null = null;
    try {
      context = await this.browser.newContext({ javaScriptEnabled: false });
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load", timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(500);
      // Some mail renders to nothing here — content behind blocked remote CSS,
      // or a layout that needs the scripts we refuse to run. Offering a blank
      // white PNG is worse than offering no picture: a persona told to read it
      // reads nothing, disbelieves the text, and walks out of a working flow.
      const visible = ((await page.textContent("body").catch(() => "")) ?? "").trim();
      if (!visible) {
        await page.close();
        return "";
      }
      await page.screenshot({ path, fullPage: true });
      await page.close();
      return path;
    } catch {
      return "";
    } finally {
      await context?.close().catch(() => {});
    }
  }

  async close() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}
