import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const { runHealthCheck, collectReferralUrls, isUrlSuspended, getLastReport, resetHealthState, getFailureCount } = await import("../dist/referral-health.js");
const { loadOffers } = await import("../dist/data.js");

let target: Server;
let base = "";
let flakyAnswers = 404;
const requests: string[] = [];

function linkTo(pathname: string, vendor = "Local Vendor") {
  return { vendor, url: `${base}${pathname}`, source: "curated" as const };
}

describe("referral-health", () => {
  before(async () => {
    target = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === "/live") res.writeHead(200);
      else if (req.url === "/moved") res.writeHead(302, { location: "/live" });
      else if (req.url === "/head-refused") res.writeHead(req.method === "HEAD" ? 405 : 200);
      else if (req.url === "/flaky") res.writeHead(flakyAnswers);
      else res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  });

  after(() => {
    target.close();
  });

  beforeEach(() => {
    resetHealthState();
    requests.length = 0;
    flakyAnswers = 404;
  });

  it("runHealthCheck returns a report with expected shape", async () => {
    const report = await runHealthCheck([linkTo("/live"), linkTo("/gone")]);
    assert.ok(report.checked_at);
    assert.strictEqual(report.total, 2);
    assert.strictEqual(report.valid, 1);
    assert.strictEqual(report.invalid, 1);
    assert.strictEqual(report.total, report.valid + report.invalid);
  });

  it("each result has vendor, url, status, valid, source", async () => {
    const report = await runHealthCheck([linkTo("/live", "Live Vendor"), linkTo("/gone", "Gone Vendor")]);
    assert.deepStrictEqual(
      report.results.map((r: any) => [r.vendor, r.url, r.status, r.valid, r.source]),
      [
        ["Live Vendor", `${base}/live`, 200, true, "curated"],
        ["Gone Vendor", `${base}/gone`, 404, false, "curated"],
      ],
    );
  });

  it("follows a redirect, and asks with GET when a link refuses HEAD", async () => {
    const report = await runHealthCheck([linkTo("/moved"), linkTo("/head-refused")]);
    assert.deepStrictEqual(report.results.map((r: any) => [r.status, r.valid]), [[200, true], [200, true]]);
    assert.deepStrictEqual(requests, ["HEAD /moved", "HEAD /live", "HEAD /head-refused", "GET /head-refused"]);
  });

  it("reaches only the links it is given", async () => {
    await runHealthCheck([linkTo("/live")]);
    assert.deepStrictEqual(requests, ["HEAD /live"]);
  });

  it("checks every curated referral link the catalogue holds when given no list", () => {
    const curated = loadOffers().filter((o: any) => o.referral?.url).map((o: any) => o.referral.url);
    assert.ok(curated.length > 0, "the catalogue holds no referral link, so this check reads nothing");
    assert.deepStrictEqual(collectReferralUrls().filter((e: any) => e.source === "curated").map((e: any) => e.url), curated);
  });

  it("suspends a link after three failures in a row and reinstates it once it answers", async () => {
    const flaky = linkTo("/flaky");
    await runHealthCheck([flaky]);
    await runHealthCheck([flaky]);
    assert.strictEqual(getFailureCount(flaky.url), 2);
    assert.strictEqual(isUrlSuspended(flaky.url), false);
    await runHealthCheck([flaky]);
    assert.strictEqual(isUrlSuspended(flaky.url), true);
    flakyAnswers = 200;
    await runHealthCheck([flaky]);
    assert.strictEqual(isUrlSuspended(flaky.url), false);
    assert.strictEqual(getFailureCount(flaky.url), 0);
  });

  it("getLastReport returns null before first check", () => {
    assert.strictEqual(getLastReport(), null);
  });

  it("getLastReport returns report after check", async () => {
    await runHealthCheck([linkTo("/live")]);
    const report = getLastReport();
    assert.ok(report);
    assert.ok(report!.checked_at);
  });

  it("isUrlSuspended returns false for unchecked URLs", () => {
    assert.strictEqual(isUrlSuspended("https://example.com/ref"), false);
  });

  it("getFailureCount returns 0 for unknown URLs", () => {
    assert.strictEqual(getFailureCount("https://example.com/ref"), 0);
  });

  it("resetHealthState clears all state", async () => {
    await runHealthCheck([linkTo("/gone")]);
    assert.ok(getLastReport());
    assert.strictEqual(getFailureCount(`${base}/gone`), 1);
    resetHealthState();
    assert.strictEqual(getLastReport(), null);
    assert.strictEqual(getFailureCount(`${base}/gone`), 0);
  });
});
