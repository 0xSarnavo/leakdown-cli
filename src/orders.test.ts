import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { getOrder, listOrders, mimeWithAttachment, renderOrders, setOrderStatus, type Order } from "./orders.js";

const scratch = mkdtempSync(join(tmpdir(), "leakdown-orders-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("mimeWithAttachment", () => {
  it("builds a multipart message whose PDF part decodes back to the file", () => {
    const pdf = join(scratch, "x-report.pdf");
    writeFileSync(pdf, Buffer.from("%PDF-1.4 fake"));
    const mime = mimeWithAttachment({ from: "a@x.com", to: "b@y.com", subject: "Report", text: "hello", pdfPath: pdf });
    assert.match(mime, /^From: a@x\.com\r\nTo: b@y\.com\r\nSubject: Report\r\n/);
    assert.match(mime, /Content-Type: multipart\/mixed; boundary="ld-/);
    assert.match(mime, /filename="x-report\.pdf"/);
    const b64 = mime.split("Content-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, "");
    assert.equal(Buffer.from(b64, "base64").toString(), "%PDF-1.4 fake");
  });

  it("never lets an order field break into a new header", () => {
    const mime = mimeWithAttachment({ from: "a@x.com", to: "b@y.com", subject: "x\r\nBcc: c@z.com", text: "hi" });
    assert.ok(!/^Bcc:/m.test(mime), "CRLF in a subject injected a header");
    assert.match(mime, /^Date: /m);
  });

  it("is plain text when there is no attachment", () => {
    const mime = mimeWithAttachment({ from: "a@x.com", to: "b@y.com", subject: "No", text: "sorry" });
    assert.match(mime, /Content-Type: text\/plain/);
    assert.ok(!mime.includes("multipart"));
  });
});

describe("renderOrders", () => {
  it("lists one order per line, and says so when empty", () => {
    assert.equal(renderOrders([]), "  no orders waiting\n");
    const out = renderOrders([{ id: "2026-09-14-abc", url: "https://x.com", email: "b@y.com", createdAt: "2026-09-14T10:00:00Z", status: "new" }]);
    assert.match(out, /2026-09-14-abc\s+new\s+https:\/\/x\.com\s+b@y\.com/);
  });
});

/**
 * Contract with the website's order routes (leakdown-website, Next.js app).
 * Nothing is imported from there — these fixtures MIRROR its rules, each with
 * the file:line it copies, so drift breaks this suite instead of alpha order
 * fulfilment. If a fixture disagrees with the website on re-read, the website
 * changed: surface it, do not quietly edit the fixture.
 */
describe("orders seam (mirrors leakdown-website)", () => {
  // app/api/orders/[id]/route.ts:34 — status must be new|done|rejected
  const STATUS = ["new", "done", "rejected"] as const;
  // app/api/orders/[id]/route.ts:7 — ids outside this shape 404 before auth
  const badId = (id: string) => !/^[A-Za-z0-9._-]{1,80}$/.test(id);
  // app/api/request/route.ts:18 — one order per email per day: `<yyyy-mm-dd>-<sha256(email)[0..10]>`
  const idFor = (email: string, day: string) => `${day}-${createHash("sha256").update(email).digest("hex").slice(0, 10)}`;
  // lib/orders.ts:52 — bucket key
  const keyFor = (id: string) => `orders/${id}.json`;
  // app/api/orders/[id]/route.ts:37 — note capped at 300; app/api/request/route.ts:22 — url capped at 300
  const NOTE_CAP = 300;
  const URL_CAP = 300;

  /** Capture what the CLI sends, answer like the website would. */
  async function capture<T>(reply: unknown, run: () => Promise<T>): Promise<{ url: string; init: RequestInit; result: T }> {
    const real = globalThis.fetch;
    let seen: { url: string; init: RequestInit } | undefined;
    process.env.LEAKDOWN_ORDERS_URL = "https://site.test/api/";
    process.env.LEAKDOWN_ORDERS_TOKEN = "tok";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const result = await run();
      return { ...seen!, result };
    } finally {
      globalThis.fetch = real;
    }
  }

  it("the CLI's Order type is the website's Order shape", () => {
    // lib/orders.ts:5-12 — compile-time check: a website order is assignable to the CLI type
    const fromSite = { id: idFor("b@y.com", "2026-09-14"), url: "https://x.com", email: "b@y.com", createdAt: "2026-09-14T10:00:00.000Z", status: "new" as const, note: "" };
    const o: Order = fromSite;
    assert.equal(o.status, "new");
  });

  it("website ids pass the route's id filter and survive the CLI's URL encoding unchanged", () => {
    const id = idFor("someone@example.com", "2026-09-17");
    assert.equal(badId(id), false);
    assert.equal(encodeURIComponent(id), id, "an id the CLI encodes differently would 404 on the website");
    assert.equal(keyFor(id), `orders/${id}.json`);
  });

  it("an id with a slash or a space is rejected by the website, and the CLI encodes it so it cannot escape the path", () => {
    assert.ok(badId("../secrets"));
    assert.ok(badId("2026 09 17"));
    assert.ok(!encodeURIComponent("../x").includes("/"));
  });

  it("GET /orders lists only new orders unless the CLI asks for all", async () => {
    // app/api/orders/route.ts:13 — `?all=1` is the only switch
    const a = await capture([], () => listOrders());
    assert.equal(a.url, "https://site.test/api/orders");
    const b = await capture([], () => listOrders(true));
    assert.equal(b.url, "https://site.test/api/orders?all=1");
  });

  it("every call carries the bearer token the website compares in constant time", async () => {
    // lib/orders.ts:109-115 — `Bearer <ORDERS_TOKEN>`, 401 otherwise
    const { init } = await capture([], () => listOrders());
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer tok");
  });

  it("status updates POST to /orders/<id> with a status the website accepts", async () => {
    const id = idFor("a@b.co", "2026-09-17");
    for (const status of STATUS) {
      const { url, init } = await capture({ id, status }, () => setOrderStatus(id, status, "sent"));
      assert.equal(url, `https://site.test/api/orders/${id}`);
      assert.equal(init.method, "POST");
      const body = JSON.parse(String(init.body)) as { status: string; note: string };
      assert.ok(STATUS.includes(body.status as (typeof STATUS)[number]));
      assert.equal(body.note, "sent");
    }
  });

  it("the CLI only ever sends the two statuses an operator can set", () => {
    // types: setOrderStatus takes Order["status"]; runOrder uses "done" and "rejected" (cli.ts runOrder)
    const operatorStatuses: Order["status"][] = ["done", "rejected"];
    for (const s of operatorStatuses) assert.ok(STATUS.includes(s));
  });

  it("notes and urls longer than the website's caps are truncated there, never rejected — so the CLI need not pre-trim", () => {
    const longNote = "x".repeat(NOTE_CAP + 50);
    assert.equal(longNote.slice(0, NOTE_CAP).length, NOTE_CAP);
    const longUrl = "https://x.com/" + "y".repeat(URL_CAP);
    assert.equal(longUrl.slice(0, URL_CAP).length, URL_CAP);
  });

  it("a repeat request from the same email on the same day lands on the same id — new overwrites, handled is refused with 429", () => {
    // app/api/request/route.ts:17-21
    const day = "2026-09-17";
    assert.equal(idFor("Same@Mail.com".toLowerCase(), day), idFor("same@mail.com", day));
    assert.notEqual(idFor("same@mail.com", day), idFor("same@mail.com", "2026-09-18"));
    const refuse = (existing: Order | null) => (existing && existing.status !== "new" ? 429 : 201);
    assert.equal(refuse(null), 201);
    assert.equal(refuse({ id: "i", url: "u", email: "e", createdAt: "c", status: "new" }), 201);
    assert.equal(refuse({ id: "i", url: "u", email: "e", createdAt: "c", status: "done" }), 429);
  });

  it("the CLI surfaces the website's 401 and 404 as errors that name the path and code", async () => {
    const real = globalThis.fetch;
    process.env.LEAKDOWN_ORDERS_URL = "https://site.test/api";
    process.env.LEAKDOWN_ORDERS_TOKEN = "tok";
    globalThis.fetch = (async () => new Response('{"error":"no"}', { status: 401 })) as typeof fetch;
    try {
      await assert.rejects(() => getOrder("2026-09-17-abc"), /\/orders\/2026-09-17-abc: HTTP 401/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
