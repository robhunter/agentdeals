import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkLiveness, nextRecord } from "../scripts/check-liveness.js";
import { reverifyBatch } from "../scripts/reverify.js";

let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/head-404-get-200") {
      res.writeHead(req.method === "HEAD" ? 404 : 200).end();
      return;
    }
    if (path === "/head-502-get-200") {
      res.writeHead(req.method === "HEAD" ? 502 : 200).end();
      return;
    }
    if (path === "/gone") {
      res.writeHead(410).end();
      return;
    }
    if (path === "/missing") {
      res.writeHead(404).end();
      return;
    }
    if (path === "/refused") {
      res.writeHead(403).end();
      return;
    }
    if (path === "/rate-limited") {
      res.writeHead(429).end();
      return;
    }
    res.writeHead(200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("#1046 a non-2xx HEAD is not evidence until GET has been asked", () => {
  it("calls a host that answers HEAD with 404 and GET with 200 reachable", async () => {
    const result = await checkLiveness(`${base}/head-404-get-200`);
    assert.equal(result.outcome, "reachable");
    assert.equal(result.detail, "GET 200");
  });

  it("calls a host that answers HEAD with 502 and GET with 200 reachable", async () => {
    const result = await checkLiveness(`${base}/head-502-get-200`);
    assert.equal(result.outcome, "reachable");
  });

  it("reaches the same verdict through the re-verifier, which shares the fallback", async () => {
    const entries = [
      { index: 0, offer: { vendor: "Head404", url: `${base}/head-404-get-200`, category: "Test" } },
      { index: 1, offer: { vendor: "Missing", url: `${base}/missing`, category: "Test" } },
    ];
    const results = await reverifyBatch(entries);
    assert.deepEqual(results.verified.map((v: { vendor: string }) => v.vendor), ["Head404"]);
    assert.deepEqual(results.flagged.map((f: { vendor: string }) => f.vendor), ["Missing"]);
  });

  it("confirms a 404 with GET before calling it unreachable", async () => {
    const result = await checkLiveness(`${base}/missing`);
    assert.equal(result.outcome, "unreachable");
    assert.equal(result.detail, "GET 404");
    assert.equal(result.terminal, false);
  });

  it("marks a 410 terminal", async () => {
    const result = await checkLiveness(`${base}/gone`);
    assert.equal(result.outcome, "unreachable");
    assert.equal(result.terminal, true);
  });

  it("records being refused as unknown, not as a dead link", async () => {
    assert.equal((await checkLiveness(`${base}/refused`)).outcome, "unknown");
    assert.equal((await checkLiveness(`${base}/rate-limited`)).outcome, "unknown");
  });

  it("records a hostname that does not resolve as unreachable", async () => {
    const result = await checkLiveness("https://this-name-does-not-resolve.invalid/pricing");
    assert.equal(result.outcome, "unreachable");
    assert.match(result.detail, /ENOTFOUND/);
  });
});

describe("#1046 how a check updates a link's history", () => {
  const target = { url: "https://example.test/pricing", latestVerified: "2026-05-23", vendors: ["Example"] };

  it("seeds last reachable from the record's verification date the first time a link fails", () => {
    const next = nextRecord(target, undefined, { outcome: "unreachable", detail: "GET 404", terminal: false }, "2026-08-25");
    assert.equal(next.last_reachable, "2026-05-23");
    assert.equal(next.consecutive_unreachable, 1);
  });

  it("advances last reachable to today whenever the link answers", () => {
    const next = nextRecord(target, undefined, { outcome: "reachable", detail: "HEAD 200", terminal: false }, "2026-08-25");
    assert.equal(next.last_reachable, "2026-08-25");
    assert.equal(next.consecutive_unreachable, 0);
  });

  it("clears a failure streak as soon as the link answers again", () => {
    const previous = { url: target.url, checked: "2026-08-24", outcome: "unreachable" as const, detail: "GET 404", terminal: false, last_reachable: "2026-05-23", consecutive_unreachable: 9 };
    const next = nextRecord(target, previous, { outcome: "reachable", detail: "GET 200", terminal: false }, "2026-08-25");
    assert.equal(next.consecutive_unreachable, 0);
    assert.equal(next.last_reachable, "2026-08-25");
  });

  it("leaves the history untouched when we could not check, so being refused never ages a link toward delisting", () => {
    const previous = { url: target.url, checked: "2026-08-24", outcome: "unreachable" as const, detail: "GET 404", terminal: false, last_reachable: "2026-05-23", consecutive_unreachable: 3 };
    const next = nextRecord(target, previous, { outcome: "unknown", detail: "GET 403", terminal: false }, "2026-08-25");
    assert.equal(next.outcome, "unknown");
    assert.equal(next.consecutive_unreachable, 3);
    assert.equal(next.last_reachable, "2026-05-23");
  });

  it("does not let a refusal reset a link that a server has already said is gone", () => {
    const previous = { url: target.url, checked: "2026-08-24", outcome: "unreachable" as const, detail: "GET 410", terminal: true, last_reachable: "2026-05-23", consecutive_unreachable: 3 };
    const next = nextRecord(target, previous, { outcome: "unknown", detail: "GET 429", terminal: false }, "2026-08-25");
    assert.equal(next.terminal, true);
  });
});
