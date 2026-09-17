import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { VARIANT_PATTERN, dirLabel, findSessionDirs, modelSlug, newRunDir, runDirOf, runDirs, seatOf, sessionPath, siteSlug, variantOf } from "./runs.js";

const scratch = mkdtempSync(join(tmpdir(), "leakdown-runs-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("siteSlug", () => {
  it("uses the hostname", () => {
    assert.equal(siteSlug("https://example.com"), "example.com");
    assert.equal(siteSlug("https://example.com/deep/path?q=1#x"), "example.com");
  });

  it("strips www. so a site does not split across two folders", () => {
    assert.equal(siteSlug("https://www.iana.org"), "iana.org");
    assert.equal(siteSlug("https://iana.org"), "iana.org");
  });

  it("keeps subdomains, which are genuinely different sites", () => {
    assert.equal(siteSlug("https://staging.team1.network/onboard"), "staging.team1.network");
  });

  it("keeps the port so local environments do not collide", () => {
    assert.equal(siteSlug("http://localhost:3000"), "localhost_3000");
    assert.notEqual(siteSlug("http://localhost:3000"), siteSlug("http://localhost:8080"));
  });

  it("assumes https when no scheme is given", () => {
    assert.equal(siteSlug("example.com/pricing"), "example.com");
  });

  it("never returns a path separator or empty string", () => {
    for (const input of ["", "   ", "not a url", "://", "http://", "../../etc/passwd"]) {
      const slug = siteSlug(input);
      assert.ok(slug.length > 0, `empty slug for ${JSON.stringify(input)}`);
      assert.ok(!slug.includes("/"), `slug escapes its folder: ${slug}`);
      assert.ok(!slug.includes(".."), `slug can traverse upward: ${slug}`);
    }
  });
});

describe("sessionPath", () => {
  const when = new Date("2026-08-26T19:04:47.607Z");
  const run = newRunDir("https://example.com", when, `${scratch}/a`);

  it("files a run under site, date, time", () => {
    assert.equal(run, resolve(`${scratch}/a/example.com/2026-08-26/19-04-47`));
  });

  it("files a session under the run, then seat, model, time-persona", () => {
    const p = sessionPath(run, "wide", "haiku", "cold", when);
    assert.equal(p, `${run}/wide/haiku/19-04-47-cold`);
    assert.equal(seatOf(p), "wide");
    assert.equal(runDirOf(p), run);
  });

  it("slugs a model id with a slash and falls back to default", () => {
    assert.equal(modelSlug("opencode/muse-spark-1.3-contributor-free"), "opencode-muse-spark-1.3-contributor-free");
    assert.equal(modelSlug(null), "default");
    assert.ok(sessionPath(run, "deep", undefined, "cold", when).includes("/deep/default/"));
  });

  it("suffixes rather than overwriting when two runs share a second", () => {
    const first = sessionPath(run, "wide", "haiku", "cold", when);
    mkdirSync(first, { recursive: true });
    const second = sessionPath(run, "wide", "haiku", "cold", when);
    assert.notEqual(second, first);
    assert.ok(second.endsWith("19-04-47-cold-2"), second);
  });

  it("separates personas that run in the same second", () => {
    assert.notEqual(sessionPath(run, "wide", "haiku", "cold", when), sessionPath(run, "wide", "haiku", "hot", when));
  });

  it("knows a foreign layout when it sees one", () => {
    assert.equal(seatOf("/x/runs/example.com/2026-08-26/19-04-47-cold"), null);
    assert.equal(runDirOf("/x/runs/example.com/2026-08-26/19-04-47-cold"), null);
  });

  it("lists a site's runs oldest first and ignores site-level files", () => {
    const root = `${scratch}/runs-list`;
    for (const r of ["2026-08-27/09-00-00", "2026-08-26/19-04-47", "2026-08-26/21-00-00"]) mkdirSync(`${root}/example.com/${r}/wide`, { recursive: true });
    mkdirSync(`${root}/example.com/personas`, { recursive: true });
    assert.deepEqual(runDirs("example.com", root).map((r) => r.slice(-19)), ["2026-08-26/19-04-47", "2026-08-26/21-00-00", "2026-08-27/09-00-00"]);
    assert.deepEqual(runDirs("missing.com", root), []);
  });
});

describe("findSessionDirs", () => {
  const root = `${scratch}/discovery`;
  const session = (rel: string) => {
    mkdirSync(`${root}/${rel}/shots`, { recursive: true });
    writeFileSync(`${root}/${rel}/meta.json`, "{}");
    return resolve(`${root}/${rel}`);
  };

  it("returns nothing when the root does not exist", () => {
    assert.deepEqual(findSessionDirs(`${scratch}/definitely-missing`), []);
  });

  it("finds sessions across sites and dates, sorted", () => {
    const a = session("example.com/2026-08-26/19-04-47-cold");
    const b = session("example.com/2026-08-27/09-00-00-hot");
    const c = session("iana.org/2026-08-26/19-05-10-cold");
    assert.deepEqual(findSessionDirs(root), [a, b, c].sort());
  });

  it("ignores folders without a meta.json, including partial runs", () => {
    mkdirSync(`${root}/example.com/2026-08-28/broken-run/shots`, { recursive: true });
    const found = findSessionDirs(root);
    assert.ok(!found.some((d) => d.includes("broken-run")), "picked up a run with no meta.json");
  });

  it("does not descend into shots/, which can hold many files", () => {
    writeFileSync(`${root}/example.com/2026-08-26/19-04-47-cold/shots/meta.json`, "{}");
    const found = findSessionDirs(root);
    assert.ok(!found.some((d) => d.endsWith("/shots")), "walked into a shots directory");
  });

  it("is depth-agnostic, so sites can be reorganised", () => {
    const nested = session("archive/2025/old-site.com/2025-01-01/12-00-00-warm");
    assert.ok(findSessionDirs(root).includes(nested));
  });
});

describe("dirLabel", () => {
  it("shows the path under runs/ rather than just the leaf", () => {
    assert.equal(
      dirLabel("/Users/x/proj/runs/example.com/2026-08-26/19-04-47/wide/haiku/19-04-47-cold"),
      "example.com/2026-08-26/19-04-47/wide/haiku/19-04-47-cold",
    );
  });

  it("falls back to the leaf when there is no runs/ segment", () => {
    assert.equal(dirLabel("/tmp/somewhere/else"), "else");
  });
});

describe("variants", () => {
  const when = new Date("2026-09-17T10:00:00.000Z");

  it("a plain run's folder is byte-identical to before — no variant, no suffix", () => {
    assert.equal(newRunDir("https://example.com", when, `${scratch}/v`), resolve(`${scratch}/v/example.com/2026-09-17/10-00-00`));
    assert.equal(variantOf(newRunDir("https://example.com", when, `${scratch}/v`)), null);
  });

  it("suffixes the run folder with the variant and reads it back", () => {
    const run = newRunDir("https://example.com", when, `${scratch}/v`, "new-pricing");
    assert.ok(run.endsWith("/2026-09-17/10-00-00--new-pricing"), run);
    assert.equal(variantOf(run), "new-pricing");
    const session = sessionPath(run, "wide", "haiku", "cold", when);
    assert.equal(runDirOf(session), run, "a variant run is still a run: seat/model/session below it");
  });

  it("runDirs lists plain and variant runs together, oldest first", () => {
    const root = `${scratch}/v2`;
    for (const [t, v] of [["2026-09-17T10:00:00Z", undefined], ["2026-09-17T10:05:00Z", "a"], ["2026-09-17T10:10:00Z", "b"]] as const) {
      mkdirSync(newRunDir("https://example.com", new Date(t), root, v), { recursive: true });
    }
    const runs = runDirs("example.com", root).map((r) => r.split("/").at(-1));
    assert.deepEqual(runs, ["10-00-00", "10-05-00--a", "10-10-00--b"]);
  });

  it("accepts slugs and rejects anything that would not survive as a folder suffix", () => {
    for (const ok of ["a", "control", "new-pricing", "v2", "x".repeat(40)]) assert.ok(VARIANT_PATTERN.test(ok), ok);
    for (const bad of ["", "New", "has space", "-lead", "a/b", "x".repeat(41), "ünï"]) assert.ok(!VARIANT_PATTERN.test(bad), bad);
  });
});
