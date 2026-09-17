# Security

## Reporting

Report via GitHub Security Advisories (https://github.com/0xSarnavo/leakdown-cli/security/advisories).

You will get a reply within 72 hours and a fix or a plan within 14 days for
anything confirmed. Please do not open a public issue for a vulnerability
until it is fixed.

## What is in scope

- The CLI in this repository: the browser driver, the action guard
  (`src/safety.ts`), the mail reader, the orders client, anything that touches
  a target site or a mailbox.
- The website and its request API (the
  [leakdown-website](https://github.com/0xSarnavo/leakdown-website) repo,
  deployed separately): the static server, the `/request` endpoint, the
  token-protected `/orders` routes.

## What the tool does on your behalf, and its limits

- Run it only against sites you own or have written permission to test. It
  creates accounts, submits forms and triggers whatever those trigger.
- A guard refuses payments, booking confirmations and third-party sign-in at
  the action, on any page. It matches labels and is best effort. Do not point
  the tool at a live checkout and rely on it never buying anything.
- The persona's brain reads whatever the target page shows. Text on a page can
  try to steer it. The brain runs with a restricted tool set, outside this
  repository, with only the session folder writable, so a hostile page can
  waste a session but should not reach your files. Treat any run against a site
  you do not control as untrusted input.
- Verification emails go to throwaway addresses on a domain you configure.
  Whoever controls that mailbox can read them.
- Reports and recordings stay on the machine that ran them. A plain run sends
  nothing anywhere but the target site and your AI CLI. The operator-only
  `--orders` / `--order` commands are the exception: they read requests from
  the project's website, post an order's status back, and email the PDF report
  from the configured mailbox.

## Out of scope

Rate limits on your own AI subscription, findings in sites the tool was run
against, and denial of service against the free request form beyond what the
per-IP limit covers.
