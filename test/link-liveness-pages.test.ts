import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

type Offer = { vendor: string; url: string; verifiedDate: string };

function slugOf(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const changed = new Set<string>(
  JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes.map(
    (c: { vendor: string }) => c.vendor.toLowerCase()
  )
);

const rowsPerVendor = new Map<string, number>();
for (const o of offers) rowsPerVendor.set(o.vendor, (rowsPerVendor.get(o.vendor) ?? 0) + 1);

const unblemished = offers.filter(
  (o) =>
    !changed.has(o.vendor.toLowerCase()) &&
    slugOf(o.vendor).length > 2 &&
    o.url.startsWith("http") &&
    rowsPerVendor.get(o.vendor) === 1
);

const goneVendor = unblemished[0];
const refusedVendor = unblemished.find((o) => o.url !== goneVendor.url && o.vendor !== goneVendor.vendor)!;
const controlVendor = unblemished.find(
  (o) => o.url !== goneVendor.url && o.url !== refusedVendor.url && o.vendor !== goneVendor.vendor && o.vendor !== refusedVendor.vendor
)!;

let fixtureDir = "";
let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(fixturePath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_LINK_HEALTH_PATH: fixturePath },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, body: await res.text() };
};

before(async () => {
  assert.ok(goneVendor && refusedVendor && controlVendor, "fixture needs three distinct vendors carrying no change records");

  fixtureDir = mkdtempSync(path.join(tmpdir(), "link-health-"));
  const fixturePath = path.join(fixtureDir, "link_health.json");
  writeFileSync(fixturePath, JSON.stringify({
    generated_at: "2026-08-25",
    links: [
      { url: goneVendor.url, checked: "2026-08-25", outcome: "unreachable", detail: "GET 410", terminal: true, last_reachable: "2026-01-04", consecutive_unreachable: 6 },
      { url: refusedVendor.url, checked: "2026-08-25", outcome: "unknown", detail: "GET 403", terminal: false, last_reachable: "2026-01-04", consecutive_unreachable: 0 },
    ],
  }, null, 2));

  proc = await startServer(fixturePath);
});

after(() => {
  if (proc) proc.kill();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe("#1046 a vendor page whose link is confirmed unreachable", () => {
  it("renders, so the assertions below are about a real page", async () => {
    const res = await get(`/vendor/${slugOf(goneVendor.vendor)}`);
    assert.equal(res.status, 200, `/vendor/${slugOf(goneVendor.vendor)} must exist for this test to mean anything`);
    assert.match(res.body, new RegExp(`<h1>[^<]*${goneVendor.vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  });

  it("does not render a stable badge", async () => {
    const { body } = await get(`/vendor/${slugOf(goneVendor.vendor)}`);
    const h1 = body.match(/<h1>[\s\S]*?<\/h1>/)![0];
    assert.doesNotMatch(h1, /risk-badge/, "the h1 must carry no risk badge while the link is confirmed gone");
  });

  it("does not claim a verification month anywhere on the page or in its meta description", async () => {
    const { body } = await get(`/vendor/${slugOf(goneVendor.vendor)}`);
    assert.doesNotMatch(body, /Verified (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}/);
    assert.doesNotMatch(body, /class="detail-label">Verified</);
  });

  it("says the true thing instead — the date the link was last reachable", async () => {
    const { body } = await get(`/vendor/${slugOf(goneVendor.vendor)}`);
    assert.match(body, /class="link-unreachable-line"/);
    assert.match(body, /Last reachable <span class="link-last-reachable"[^>]*>2026-01-04<\/span>/);
    assert.match(body, /class="detail-label">Link last reachable</);
  });

  it("makes no favourable claim anywhere in its prose, including the FAQ answers an AI search engine quotes", async () => {
    const { body } = await get(`/vendor/${slugOf(goneVendor.vendor)}`);
    for (const claim of ["It's stable", "considered stable", "positive stability signal", "reasonable starting point"]) {
      assert.ok(!body.includes(claim), `the page still says "${claim}" about a vendor whose link does not resolve`);
    }
    assert.match(body, /pricing page has not resolved for us since 2026-01-04/);
  });

  it("shows the comparison table the link state rather than a green stability dot", async () => {
    const { body } = await get(`/vendor/${slugOf(goneVendor.vendor)}`);
    const ownRow = body.match(/<tr class="current-vendor-row">[\s\S]*?<\/tr>/)![0];
    assert.match(ownRow, /link unreachable/);
    assert.doesNotMatch(ownRow, /stability-dot/);
  });

  it("withholds the level from the API rather than publishing a green one", async () => {
    const { body } = await get(`/api/offers?q=${encodeURIComponent(goneVendor.vendor)}&limit=50`);
    const match = JSON.parse(body).offers.find((o: { url: string }) => o.url === goneVendor.url);
    assert.ok(match, "the offer must come back from the API for this assertion to have a subject");
    assert.equal(match.risk_level, null);
    assert.deepEqual(match.link_unreachable, { last_reachable: "2026-01-04", checked: "2026-08-25", terminal: true });
  });
});

describe("#1046 a vendor page whose link we were merely refused", () => {
  it("is untouched — being refused is evidence about us, not about them", async () => {
    const { status, body } = await get(`/vendor/${slugOf(refusedVendor.vendor)}`);
    assert.equal(status, 200);
    const h1 = body.match(/<h1>[\s\S]*?<\/h1>/)![0];
    assert.match(h1, /risk-badge[^>]*>stable</);
    assert.match(body, /class="detail-label">Verified</);
    assert.doesNotMatch(body, /class="link-unreachable-line"/);
    assert.doesNotMatch(body, /pricing page has not resolved/);
    assert.match(body, /<tr class="current-vendor-row">[\s\S]*?stability-dot[\s\S]*?<\/tr>/);
  });

  it("publishes no link claim in the API in either direction", async () => {
    const { body } = await get(`/api/offers?q=${encodeURIComponent(refusedVendor.vendor)}&limit=50`);
    const match = JSON.parse(body).offers.find((o: { url: string }) => o.url === refusedVendor.url);
    assert.ok(match, "the offer must come back from the API for this assertion to have a subject");
    assert.equal(match.link_unreachable, null);
    assert.equal(match.risk_level, "stable");
  });
});

describe("#1046 a vendor page we never checked", () => {
  it("renders exactly as it did before, badge and verification date included", async () => {
    const { status, body } = await get(`/vendor/${slugOf(controlVendor.vendor)}`);
    assert.equal(status, 200);
    const h1 = body.match(/<h1>[\s\S]*?<\/h1>/)![0];
    assert.match(h1, /risk-badge[^>]*>stable</);
    assert.match(body, /Verified (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}/);
    assert.doesNotMatch(body, /class="link-unreachable-line"/);
  });
});

describe("#1046 the MCP tool that answers whether a vendor is risky", () => {
  it("does not tell an agent a vendor has a stable pricing history when we cannot reach its page", async () => {
    const { checkVendorRisk, resetCache } = await import("../dist/data.js");
    process.env.AGENTDEALS_LINK_HEALTH_PATH = path.join(fixtureDir, "link_health.json");
    resetCache();
    try {
    const gone = checkVendorRisk(goneVendor.vendor);
    assert.ok("result" in gone, `checkVendorRisk did not resolve ${goneVendor.vendor}`);
    assert.equal(gone.result.risk_level, null);
    assert.equal(gone.result.link_unreachable?.last_reachable, "2026-01-04");
    assert.ok(!gone.result.summary.includes("has a stable pricing history"), gone.result.summary);
    assert.match(gone.result.summary, /has not resolved for us since 2026-01-04/);

    const refused = checkVendorRisk(refusedVendor.vendor);
    assert.ok("result" in refused, `checkVendorRisk did not resolve ${refusedVendor.vendor}`);
    assert.equal(refused.result.risk_level, "stable");
    assert.equal(refused.result.link_unreachable, null);
    assert.match(refused.result.summary, /has a stable pricing history/);
    } finally {
      delete process.env.AGENTDEALS_LINK_HEALTH_PATH;
      resetCache();
    }
  });
});
