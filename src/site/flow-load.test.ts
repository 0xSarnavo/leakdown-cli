import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// FLOWS_DIR resolves from cwd at import time, like personas/
const scratch = mkdtempSync(join(tmpdir(), "leakdown-flows-"));
const cwd = process.cwd();
mkdirSync(join(scratch, "flows"), { recursive: true });
process.chdir(scratch);
const { loadFlowFile, loadFlowFiles, renderFlowChecks, toFlow, validateFlow } = await import("./flow-load.js");
after(() => {
  process.chdir(cwd);
  rmSync(scratch, { recursive: true, force: true });
});

const write = (rel: string, body: string) => {
  const p = join(scratch, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
};

const GOOD = `name: Signup to dashboard
intent: sign up and reach the dashboard
steps:
  - found the signup form
  - name: submitted the form
    expect: "Check your inbox"
  - name: saw the dashboard
    expect: "New project"
stop_after: 2
`;

describe("validateFlow", () => {
  it("loads a valid file, takes the id from the filename, and resolves stop_after to an index", () => {
    const c = validateFlow(write("flows/signup.yaml", GOOD));
    assert.ok(c.ok);
    assert.equal(c.flow.id, "signup");
    assert.equal(c.flow.steps.length, 3);
    assert.equal(c.flow.stopAfter, 1);
    assert.equal(c.flow.steps[0].expect, undefined);
  });

  it("accepts stop_after by step name and defaults intent to name", () => {
    const c = validateFlow(write("flows/byname.yaml", `name: Pricing\nsteps:\n  - name: saw prices\n    expect: "$"\nstop_after: saw prices\n`));
    assert.ok(c.ok);
    assert.equal(c.flow.stopAfter, 0);
    assert.equal(c.flow.intent, "Pricing");
  });

  it("rejects stop_after beyond the steps, with the count in the message", () => {
    const c = validateFlow(write("flows/far.yaml", `name: x\nsteps: [a, b]\nstop_after: 5\n`));
    assert.ok(!c.ok);
    assert.match(c.error, /stop_after.*not one of the 2 step/);
  });

  it("rejects a stop step without expect text — there is nothing mechanical to stop on", () => {
    const c = validateFlow(write("flows/noexpect.yaml", `name: x\nsteps: [a, b]\nstop_after: 1\n`));
    assert.ok(!c.ok);
    assert.match(c.error, /needs `expect`/);
  });

  it("reports schema errors like the persona loader does, and never throws on bad YAML", () => {
    const c = validateFlow(write("flows/broken.yaml", `steps: []\n`));
    assert.ok(!c.ok);
    assert.match(c.error, /name: Required/);
    assert.match(c.error, /steps/);
    const y = validateFlow(write("flows/garbage.yaml", "name: [unclosed\n\tbad: indent:\n"));
    assert.ok(!y.ok);
    assert.match(y.error, /YAML parse error/);
  });

  it("caps steps at 50", () => {
    const c = validateFlow(write("flows/long.yaml", `name: x\nsteps:\n${"  - s\n".repeat(51)}`));
    assert.ok(!c.ok);
    assert.match(c.error, /steps/);
  });
});

describe("loadFlowFiles / loadFlowFile", () => {
  it("lists invalid files with reasons and still loads the valid ones", () => {
    const { flows, errors } = loadFlowFiles();
    assert.ok(flows["signup"]);
    assert.ok(errors.some((e) => e.file === "broken.yaml"));
    assert.ok(!flows["broken"]);
  });

  it("a site-local flow wins an id collision with the global one", () => {
    write("runs/example.com/flows/signup.yaml", `name: Site version\nsteps: [only step]\n`);
    assert.equal(loadFlowFiles("https://example.com").flows["signup"].name, "Site version");
    assert.equal(loadFlowFiles().flows["signup"].name, "Signup to dashboard");
  });

  it("resolves an id or a path, and names the known ids when neither matches", () => {
    assert.ok(loadFlowFile("signup").ok);
    assert.ok(loadFlowFile(join(scratch, "flows/signup.yaml")).ok);
    const miss = loadFlowFile("nope");
    assert.ok(!miss.ok);
    assert.match(miss.error, /no flow "nope"/);
    assert.match(miss.error, /known: .*signup/);
    assert.ok(!loadFlowFile("missing.yaml").ok);
  });
});

describe("toFlow / renderFlowChecks", () => {
  it("folds expect text into the checkpoint the scorer reads and carries the stop point", () => {
    const c = validateFlow(join(scratch, "flows/signup.yaml"));
    assert.ok(c.ok);
    const f = toFlow(c.flow);
    assert.equal(f.checkpoints[1], 'submitted the form (page shows "Check your inbox")');
    assert.deepEqual(f.stop, { index: 1, label: "submitted the form", text: "Check your inbox" });
  });

  it("renders one line per file, ticks and crosses", () => {
    const out = renderFlowChecks([validateFlow(join(scratch, "flows/signup.yaml")), validateFlow(join(scratch, "flows/far.yaml"))]);
    assert.match(out, /✓ signup\.yaml — "Signup to dashboard", 3 step\(s\), stops after step 2/);
    assert.match(out, /✗ far\.yaml — stop_after/);
  });
});
