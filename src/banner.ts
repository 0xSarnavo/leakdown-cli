import { VERSION } from "./version.js";

/* The Leakdown mark, in monospace.

   The same drop as the favicon and the site logo — 69 dots plus the drip, the
   light still coming from the top left, five characters standing in for dot
   radius. It is pasted, not computed: the geometry lives in leakdown-docs
   (lib/mark.ts), and a CLI that ships with no runtime dependencies has no
   business importing brand geometry to draw a banner. Regenerate with
   `npm run ascii` in leakdown-docs and paste the output here — that is what
   keeps these three marks the same mark rather than three drawings of one. */
const DROP = [
  "        @",
  "      O @ .",
  "    O @ O o .",
  "    @ @ @ O O",
  "  @ @ @ @ O O o",
  "@ @ @ @ @ O o : .",
  "O @ @ O O O o : .",
  "O O O O o o : . .",
  ": o o o o : . . .",
  "  : : : : . . .",
  "    . . . . .",
  "        .",
];

const WIDTH = Math.max(...DROP.map((l) => l.length));

/* The wordmark sits beside the drop, not under it: stacked, the banner runs
   past twenty lines and pushes the thing you actually ran off the screen. */
const SAYS = [
  "",
  "",
  `leakdown ${VERSION}`,
  "",
  "Simulated prospects walk your signup",
  "in a real browser, think out loud, and",
  "quit the way people do.",
  "",
  "Alpha. Only run it against sites you own",
  "or have written permission to test.",
];

export function banner(): string {
  const rows = DROP.map((art, i) => {
    const said = SAYS[i] ?? "";
    return said ? `  ${art.padEnd(WIDTH)}    ${said}` : `  ${art}`;
  });
  return rows.join("\n");
}

/** The mark alone, for places that already say the name. */
export function mark(): string {
  return DROP.map((l) => `  ${l}`).join("\n");
}
