import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Offer } from "../dist/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { CONFIRMED_DATE_LABEL, UNCONFIRMED_DATE_LABEL, confirmationDate } = await import("../dist/read-date.js");

const MONTH_NAMES = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATED_LINE = new RegExp(`(${CONFIRMED_DATE_LABEL}|${UNCONFIRMED_DATE_LABEL}) (?:${MONTH_NAMES}) \\d{4}`);

function slugOf(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const checkedOn = new Date().toISOString().slice(0, 10);
const [goneVendor, refusedVendor, controlVendor]: Offer[] = ["Gone", "Refused", "Control"].map(state => ({
  vendor: `Fixture ${state} Link`,
  category: "Cloud Hosting",
  description: "Free service with 100 requests per month.",
  tier: "Free",
  url: `https://${state.toLowerCase()}-link.example/pricing`,
  tags: [],
  verifiedDate: checkedOn,
  source_check: { checked: checkedOn, outcome: "ok", detail: "The pricing page states the free plan." },
  product_role: { deployment_model: "hosted", is_addon: false, source_url: `https://${state.toLowerCase()}-link.example/pricing`, source_quote: "Hosted service.", reviewed: checkedOn },
  product_subtypes: { taxonomy: "Cloud Hosting", labels: [{ subtype: "static_site", source_url: `https://${state.toLowerCase()}-link.example/pricing`, source_quote: "Static site hosting." }], reviewed: checkedOn },
}));

let fixtureDir = "";
let serverPort = 0;
let proc: ChildProcess | null = null;
let previousEnvironment: NodeJS.ProcessEnv = {};

function fixtureEnvironment(): NodeJS.ProcessEnv {
  return {
    AGENTDEALS_INDEX_PATH: path.join(fixtureDir, "index.json"),
    AGENTDEALS_CHANGES_PATH: path.join(fixtureDir, "changes.json"),
    AGENTDEALS_REFUSALS_PATH: path.join(fixtureDir, "refusals.json"),
    AGENTDEALS_VERIFICATION_STATE_PATH: path.join(fixtureDir, "verification_state.json"),
    AGENTDEALS_LINK_HEALTH_PATH: path.join(fixtureDir, "link_health.json"),
  };
}

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...fixtureEnvironment(), PORT: "0", BASE_URL: "http://localhost" },
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
  const res = await fetch(`http://localhost:${serverPort}${p}`, { redirect: "error" });
  return { status: res.status, body: await res.text() };
};

before(async () => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "link-health-"));
  const fixturePath = path.join(fixtureDir, "link_health.json");
  writeFileSync(path.join(fixtureDir, "index.json"), JSON.stringify({ offers: [goneVendor, refusedVendor, controlVendor] }));
  writeFileSync(path.join(fixtureDir, "changes.json"), JSON.stringify({ changes: [] }));
  writeFileSync(path.join(fixtureDir, "refusals.json"), JSON.stringify({ refusals: [] }));
  writeFileSync(path.join(fixtureDir, "verification_state.json"), JSON.stringify({ records: [goneVendor, refusedVendor, controlVendor].map(offer => ({
    vendor: offer.vendor,
    url: offer.url,
    last_attempt_at: checkedOn,
    last_outcome: "confirmed",
    last_success: checkedOn,
    last_error: null,
    failure_category: null,
    consecutive_failures: 0,
    quarantined_since: null,
  })) }));
  writeFileSync(fixturePath, JSON.stringify({
    generated_at: "2026-08-25",
    links: [
      { url: goneVendor.url, checked: "2026-08-25", outcome: "unreachable", detail: "GET 410", terminal: true, last_reachable: "2026-01-04", consecutive_unreachable: 6 },
      { url: refusedVendor.url, checked: "2026-08-25", outcome: "unknown", detail: "GET 403", terminal: false, last_reachable: "2026-01-04", consecutive_unreachable: 0 },
    ],
  }, null, 2));

  const environment = fixtureEnvironment();
  previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  proc = await startServer();
});

after(() => {
  if (proc) proc.kill();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("#1046 a vendor page whose link is confirmed unreachable", () => {
  it("renders, so the assertions below are about a real page", async () => {
    const res = await get(`/vendor/${slugOf(goneVendor.vendor)}`);
    assert.equal(res.status, 200, `/vendor/${slugOf(goneVendor.vendor)} must exist for this test to mean anything`);
    assert.match(res.body, new RegExp(`<h1>[^<]*${goneVendor.vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  });

  it("does not render a stable badge", async () => {
    const { body } = await get(`/vendor/${slugOf(goneVendor.vendor)}`);
    const h1 = body.match(/<h1>[\s\S]*?<\/h1>(?:\s*<span class="risk-badge"[^>]*>[^<]*<\/span>)?/)![0];
    assert.doesNotMatch(h1, /risk-badge/, "the heading must have no risk badge while the link is confirmed gone");
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
    const h1 = body.match(/<h1>[\s\S]*?<\/h1>(?:\s*<span class="risk-badge"[^>]*>[^<]*<\/span>)?/)![0];
    assert.match(h1, /risk-badge[^>]*>stable</);
    assert.match(body, /class="detail-label">Verified</);
    assert.doesNotMatch(body, /class="link-unreachable-line"/);
    assert.doesNotMatch(body, /pricing page has not resolved/);
    assert.match(body.match(/<tr class="current-vendor-row">[\s\S]*?<\/tr>/)?.[0] ?? "", /stability-dot/);
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
    const h1 = body.match(/<h1>[\s\S]*?<\/h1>(?:\s*<span class="risk-badge"[^>]*>[^<]*<\/span>)?/)![0];
    assert.match(h1, /risk-badge[^>]*>stable</);
    const dated = body.match(DATED_LINE);
    assert.ok(dated, "the page states no dated line at all");
    assert.equal(
      dated[1],
      confirmationDate(controlVendor) ? CONFIRMED_DATE_LABEL : UNCONFIRMED_DATE_LABEL,
      `the page labels its date ${dated[1]} while the store ${confirmationDate(controlVendor) ? "holds" : "holds no"} confirmation for it`,
    );
    assert.doesNotMatch(body, /class="link-unreachable-line"/);
    assert.match(body.match(/<tr class="current-vendor-row">[\s\S]*?<\/tr>/)?.[0] ?? "", /stability-dot/);
  });
});

describe("#1046 the MCP tool that answers whether a vendor is risky", () => {
  it("does not tell an agent a vendor has a stable pricing history when we cannot reach its page", async () => {
    const { checkVendorRisk, resetCache } = await import("../dist/data.js");
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
      resetCache();
    }
  });
});
