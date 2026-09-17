# Contributing to Leakdown

Thanks for stopping by. Bug reports and small, focused pull requests are
welcome; big redesigns are better as an issue first so nobody builds
something the maintainer will not take.

## Setup

```bash
git clone https://github.com/0xSarnavo/leakdown-cli
cd leakdown-cli
npm ci
npm run build
npx playwright install chromium   # one time, for browser-driven runs
```

Requirements: Node 20+, Chromium via Playwright, and at least one AI CLI
logged in (`claude`, `opencode`, or `codex`).

## Verifying a change

```bash
npm run typecheck    # tsc --noEmit
npm test             # tsc, then node --test on every dist/**/*.test.js (listed by find, so Node 20 works)
```

Run both before opening a PR. `dist/` is build output — never edit it by
hand. Tests live beside their source as `src/**/*.test.ts` on Node's
built-in runner (no test framework). For anything touching the session
loop, the driver, or a prompt, do a real headed run too:

```bash
node dist/cli.js --doctor                              # environment check
node dist/cli.js <url> --persona cold --headless --stop visit
```

## How to contribute

1. Fork, branch, keep the diff narrow — one change per PR.
2. Add or update tests beside the source when you touch pure logic.
3. Add a line under **Unreleased** in `CHANGELOG.md`, in plain words a
   person running the tool would recognise.
4. Read `AGENTS.md` (operating guide and working agreements) and
   `DECISIONS.md` (why the code looks the way it does) before proposing
   anything the log already decided.

## Writing docs

README, AGENTS.md, DECISIONS.md, commit bodies, and website copy follow a
no-AI-slop house style: plain words, no inflated claims, no sales language,
no vague sourcing. Say what the tool does and what it cannot do — the
safety section's honesty is the tone to match.

## Never commit

- `.env` (your mail credentials and order tokens) — copy `.env.example`
  and fill in your own values locally.
- `runs/`, `personas/`, `.leakdown-state.json`, `local/` — machine-local
  state, all gitignored.
- Recordings or session mail — reports stay on the machine that ran them.

License: contributions land under the [MIT](LICENSE) license.
