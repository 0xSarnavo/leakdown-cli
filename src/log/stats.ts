/**
 * The two numbers a replicated finding earns, as pure functions over counts.
 * Nothing here is a claim about real traffic (invariant 17): "3/5 sessions"
 * stays "3 of 5 simulated prospects", and the interval says how much a count
 * that small can be trusted. Below MIN_N nothing is quantified at all.
 */

/** Fewer sessions than this and a rate is noise — render "too few to call". */
export const MIN_N = 3;

/** Rate difference variant − base, in [-1, 1]. Positive means the variant hits more often. */
export function lift(base: { hits: number; n: number }, variant: { hits: number; n: number }): number {
  if (base.n === 0 || variant.n === 0) return 0;
  return variant.hits / variant.n - base.hits / base.n;
}

/** Wilson score interval at 95%, as [lo, hi] rates. Sane at 0/n and n/n, unlike the normal approximation. */
export function confidenceInterval(hits: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const z = 1.96;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** `3/5 sessions · 60% [23–88%]`, or `2/2 sessions · too few to call` under MIN_N. */
export function strength(hits: number, n: number): string {
  if (n < MIN_N) return `${hits}/${n} sessions · too few to call`;
  const [lo, hi] = confidenceInterval(hits, n);
  return `${hits}/${n} sessions · ${pct(hits / n)} [${Math.round(lo * 100)}–${pct(hi)}]`;
}

/** Do two rates overlap at 95%? If so, no honest ranking between them. */
export function overlap(a: { hits: number; n: number }, b: { hits: number; n: number }): boolean {
  const [alo, ahi] = confidenceInterval(a.hits, a.n);
  const [blo, bhi] = confidenceInterval(b.hits, b.n);
  return alo <= bhi && blo <= ahi;
}

function pct(r: number): string {
  return `${Math.round(r * 100)}%`;
}
