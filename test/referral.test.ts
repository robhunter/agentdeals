import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Unit tests for validateReferral and stripReferrerValue
const { validateReferral, stripReferrerValue } = await import("../dist/data.js");

function makeReferral(overrides: Record<string, unknown> = {}) {
  return {
    code: "TEST",
    url: "https://example.com?ref=TEST",
    referee_value: "$20 in credits",
    referrer_value: "15% commission",
    type: "dual-sided" as const,
    source: "curated" as const,
    submitted_by: null,
    terms_url: "https://example.com/terms",
    verified_date: new Date().toISOString().slice(0, 10),
    restrictions: [],
    phase1_eligible: true,
    ...overrides,
  };
}

describe("validateReferral", () => {
  it("valid referral passes with no errors", () => {
    const errors = validateReferral(makeReferral(), "TestVendor");
    assert.strictEqual(errors.length, 0);
  });

  it("rejects invalid URL", () => {
    const errors = validateReferral(makeReferral({ url: "not-a-url" }), "TestVendor");
    assert.ok(errors.some(e => e.includes("valid URL")));
  });

  it("rejects empty URL", () => {
    const errors = validateReferral(makeReferral({ url: "" }), "TestVendor");
    assert.ok(errors.some(e => e.includes("valid URL")));
  });

  it("rejects invalid type", () => {
    const errors = validateReferral(makeReferral({ type: "invalid" }), "TestVendor");
    assert.ok(errors.some(e => e.includes("type must be one of")));
  });

  it("rejects invalid source", () => {
    const errors = validateReferral(makeReferral({ source: "unknown" }), "TestVendor");
    assert.ok(errors.some(e => e.includes("source must be one of")));
  });

  it("requires referee_value for dual-sided type", () => {
    const errors = validateReferral(makeReferral({ type: "dual-sided", referee_value: "" }), "TestVendor");
    assert.ok(errors.some(e => e.includes("referee_value is required")));
  });

  it("requires referee_value for referee-only type", () => {
    const errors = validateReferral(makeReferral({ type: "referee-only", referee_value: "" }), "TestVendor");
    assert.ok(errors.some(e => e.includes("referee_value is required")));
  });

  it("does not require referee_value for referrer-only type", () => {
    const errors = validateReferral(makeReferral({ type: "referrer-only", referee_value: "" }), "TestVendor");
    assert.ok(!errors.some(e => e.includes("referee_value is required")));
  });

  it("rejects invalid verified_date format", () => {
    const errors = validateReferral(makeReferral({ verified_date: "Jan 1 2026" }), "TestVendor");
    assert.ok(errors.some(e => e.includes("valid ISO date")));
  });

  it("rejects verified_date older than 90 days", () => {
    const oldDate = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const errors = validateReferral(makeReferral({ verified_date: oldDate }), "TestVendor");
    assert.ok(errors.some(e => e.includes("older than 90 days")));
  });

  it("accepts verified_date within 90 days", () => {
    const recentDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const errors = validateReferral(makeReferral({ verified_date: recentDate }), "TestVendor");
    assert.strictEqual(errors.length, 0);
  });

  it("accepts all valid source types", () => {
    for (const source of ["curated", "sovrn", "agent-submitted"]) {
      const errors = validateReferral(makeReferral({ source }), "TestVendor");
      assert.strictEqual(errors.length, 0, `source "${source}" should be valid`);
    }
  });
});

describe("stripReferrerValue", () => {
  it("removes referrer_value from offer with referral", () => {
    const offer = {
      vendor: "Test",
      category: "Cloud",
      referral: makeReferral(),
    };
    const stripped = stripReferrerValue(offer);
    assert.ok(!("referrer_value" in stripped.referral!));
    assert.strictEqual(stripped.referral!.referee_value, "$20 in credits");
    assert.strictEqual(stripped.referral!.url, "https://example.com?ref=TEST");
  });

  it("returns offer unchanged when no referral", () => {
    const offer = { vendor: "Test", category: "Cloud" };
    const stripped = stripReferrerValue(offer);
    assert.deepStrictEqual(stripped, offer);
  });

  it("preserves all other referral fields", () => {
    const referral = makeReferral();
    const offer = { vendor: "Test", referral };
    const stripped = stripReferrerValue(offer);
    assert.strictEqual(stripped.referral!.code, "TEST");
    assert.strictEqual(stripped.referral!.type, "dual-sided");
    assert.strictEqual(stripped.referral!.source, "curated");
    assert.strictEqual(stripped.referral!.phase1_eligible, true);
    assert.strictEqual(stripped.referral!.terms_url, "https://example.com/terms");
  });
});

// HTTP server tests for referral endpoints
let serverPort = 0;
let serverProc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 5000);

    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        serverPort = parseInt(match[1], 10);
        clearTimeout(timeout);
        resolve(proc);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("referral HTTP endpoints", () => {
  before(async () => {
    serverProc = await startServer();
  });

  after(() => {
    serverProc?.kill();
  });

  it("GET /disclosure returns 200 with disclosure content", async () => {
    const res = await fetch(`http://localhost:${serverPort}/disclosure`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Affiliate Disclosure"));
    assert.ok(html.includes("Material Connection Statement"));
    assert.ok(html.includes("AgentDeals may financially benefit"));
  });

  it("/disclosure page lists current referral partners", async () => {
    const res = await fetch(`http://localhost:${serverPort}/disclosure`);
    const html = await res.text();
    assert.ok(html.includes("Current Referral Partners"));
    assert.ok(html.includes("Railway"));
  });

  it("GET /api/offers includes referral data for Railway", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/offers?q=Railway&limit=5`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const railway = data.offers.find((o: any) => o.vendor === "Railway");
    assert.ok(railway, "Railway should be in results");
    assert.ok(railway.referral, "Railway should have referral data");
    assert.ok(railway.referral.url, "referral should have url");
    assert.ok(railway.referral.referee_value, "referral should have referee_value");
    assert.ok(!("referrer_value" in railway.referral), "referrer_value should be stripped from API");
  });

  it("GET /api/offers omits referral for vendors without it", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/offers?q=Vercel&limit=5`);
    const data = await res.json();
    const vercel = data.offers.find((o: any) => o.vendor === "Vercel");
    assert.ok(vercel, "Vercel should be in results");
    assert.ok(!vercel.referral, "Vercel should not have referral data");
  });

  it("GET /vendor/railway links to disclosure in footer", async () => {
    const res = await fetch(`http://localhost:${serverPort}/vendor/railway`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes("referral-callout"), "Referral callout banner should be removed");
    assert.ok(html.includes("/disclosure"), "Should link to disclosure page in footer");
  });

  it("GET /vendor/vercel does not show referral callout", async () => {
    const res = await fetch(`http://localhost:${serverPort}/vendor/vercel`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes("referral-callout"), "Vendor page without referral should not show callout");
  });

  it("GET /sitemap.xml includes /disclosure", async () => {
    const res = await fetch(`http://localhost:${serverPort}/sitemap.xml`);
    const xml = await res.text();
    assert.ok(xml.includes("/disclosure"), "Sitemap should include disclosure page");
  });

  it("GET /deal-changes redirects 301 to /changes", async () => {
    const res = await fetch(`http://localhost:${serverPort}/deal-changes`, { redirect: "manual" });
    assert.strictEqual(res.status, 301);
    const location = res.headers.get("location");
    assert.ok(location && location.endsWith("/changes"), "Should redirect to /changes");
  });

  it("GET /disclosure returns 200", async () => {
    const res = await fetch(`http://localhost:${serverPort}/disclosure`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Affiliate Disclosure"), "Disclosure page should have title");
  });

  it("all pages include disclosure link in footer", async () => {
    const res = await fetch(`http://localhost:${serverPort}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('href="/disclosure"'), "Home page footer should link to disclosure");
  });
});
