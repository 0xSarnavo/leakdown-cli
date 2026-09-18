/**
 * An optional external judge for the yes/no rulings.
 *
 * Three of this tool's questions have a yes or no answer rather than prose —
 * was the goal reached, which flow checkpoints were reached, does the page show
 * an expected value in other words. The brain answers them by default. Set
 * `LEAKDOWN_JUDGE` to a module path and that module answers them instead.
 *
 * The module exports `createJudge(): Judge`. Anything it cannot answer comes
 * back null and the caller takes the path it takes with no judge at all, so a
 * judge that is missing, broken or slow can never end a session or change a
 * verdict on its own. Nothing about it is shared between sessions: one is built
 * per session, which is what keeps `--parallel` safe.
 */
import type { AssertionResult } from "../types.js";

export interface Judge {
  /** Was the goal actually reached, judging by this page? Null: could not say. */
  verifyGoal(goal: string, ariaYaml: string): Promise<{ achieved: boolean; note: string } | null>;
  /** Which checkpoints did this journey reach? One entry per checkpoint, or null. */
  scoreFlow(
    checkpoints: string[],
    trail: string,
  ): Promise<{ checkpoint: string; reached: boolean; note: string }[] | null>;
  /**
   * A second look at the assertions the substring match missed — the page may
   * say "Total: $96" where "$96.00" was expected. Returns the full list, so a
   * judge that cannot answer returns it unchanged.
   */
  judgeAssertions(results: AssertionResult[], ariaYaml: string): Promise<AssertionResult[]>;
  /** Whatever the judge wants recorded on the session, written to meta.json as `usageJudge`. */
  usage?: unknown;
}

/**
 * Load the judge named by `LEAKDOWN_JUDGE`, or null when there is none.
 *
 * A judge that fails to load is reported once and then ignored: the run
 * continues on the brain path rather than stopping over an optional extra.
 */
export async function loadJudge(): Promise<Judge | null> {
  const path = process.env.LEAKDOWN_JUDGE;
  if (!path) return null;
  try {
    const mod = (await import(path)) as { createJudge?: () => Judge };
    if (typeof mod.createJudge !== "function") {
      console.warn(`  ⚠ ${path} has no createJudge() export — running without a judge`);
      return null;
    }
    return mod.createJudge();
  } catch (e) {
    console.warn(`  ⚠ could not load LEAKDOWN_JUDGE (${(e as Error).message.slice(0, 80)}) — running without a judge`);
    return null;
  }
}
