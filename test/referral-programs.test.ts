import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Unit tests for referral_program metadata in data
const { loadOffers } = await import("../dist/data.js");
const offers = loadOffers();

describe("referral_program metadata", () => {
  it("at least 40 vendors have referral_program metadata", () => {
    const seen = new Set<string>();
    for (const o of offers) {
      if (o.referral_program) seen.add(o.vendor);
    }
    assert.ok(seen.size >= 40, `Expected at least 40 unique vendors with referral_program, got ${seen.size}`);
  });

  it("referral_program entries have required fields", () => {
    for (const o of offers) {
      if (!o.referral_program) continue;
      assert.ok(typeof o.referral_program.available === "boolean", `${o.vendor}: available must be boolean`);
      assert.ok(typeof o.referral_program.referrer_benefit === "string" && o.referral_program.referrer_benefit.length > 0, `${o.vendor}: referrer_benefit required`);
      assert.ok(typeof o.referral_program.referee_benefit === "string" && o.referral_program.referee_benefit.length > 0, `${o.vendor}: referee_benefit required`);
      assert.ok(typeof o.referral_program.program_url === "string" && o.referral_program.program_url.startsWith("http"), `${o.vendor}: program_url must be valid URL`);
      assert.ok(["self-service", "application", "affiliate-network", "partner", "closed"].includes(o.referral_program.type), `${o.vendor}: type must be valid`);
    }
  });

  it("Railway has both referral code and referral_program", () => {
    const railway = offers.find((o: any) => o.vendor === "Railway");
    assert.ok(railway, "Railway should exist");
    assert.ok(railway.referral, "Railway should have referral code");
    assert.ok(railway.referral_program?.available, "Railway should have referral_program");
  });

  it("DigitalOcean has referral_program but no referral code", () => {
    const digitalOcean = offers.find((o: any) => o.vendor === "DigitalOcean");
    assert.ok(digitalOcean, "DigitalOcean should exist");
    assert.ok(!digitalOcean.referral, "DigitalOcean should not have referral code");
    assert.ok(digitalOcean.referral_program?.available, "DigitalOcean should have referral_program");
  });

  it("Vercel has referral_program (v0 affiliate)", () => {
    const vercel = offers.find((o: any) => o.vendor === "Vercel");
    assert.ok(vercel, "Vercel should exist");
    assert.ok(vercel.referral_program?.available, "Vercel should have referral_program");
  });

  it("vendors without programs have available: false", () => {
    const unavailable = offers.filter((o: any) => o.referral_program && !o.referral_program.available);
    assert.ok(unavailable.length >= 5, `Expected at least 5 vendors with available: false, got ${unavailable.length}`);
  });
});

// HTTP server tests
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
    }, 10000);

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

describe("referral-programs page", () => {
  before(async () => {
    serverProc = await startServer();
  });

  after(() => {
    serverProc?.kill();
  });

  it("GET /referral-programs returns 200", async () => {
    const res = await fetch(`http://localhost:${serverPort}/referral-programs`);
    assert.strictEqual(res.status, 200);
  });

  it("/referral-programs lists vendors with programs", async () => {
    const res = await fetch(`http://localhost:${serverPort}/referral-programs`);
    const html = await res.text();
    assert.ok(html.includes("DigitalOcean"), "Should list DigitalOcean");
    assert.ok(html.includes("Railway"), "Should list Railway");
    assert.ok(html.includes("Hetzner"), "Should list Hetzner");
    assert.ok(html.includes("Neon"), "Should list Neon");
  });

  it("/referral-programs shows 'Use our code' for vendors with codes", async () => {
    const res = await fetch(`http://localhost:${serverPort}/referral-programs`);
    const html = await res.text();
    assert.ok(html.includes("Use our code"), "Should show 'Use our code' badge");
  });

  it("/referral-programs shows 'Submit a code' for vendors without codes", async () => {
    const res = await fetch(`http://localhost:${serverPort}/referral-programs`);
    const html = await res.text();
    assert.ok(html.includes("Submit a code"), "Should show 'Submit a code' badge");
  });

  it("/referral-programs includes affiliate disclosure", async () => {
    const res = await fetch(`http://localhost:${serverPort}/referral-programs`);
    const html = await res.text();
    assert.ok(html.includes("/disclosure"), "Should link to disclosure page");
    assert.ok(html.includes("Affiliate disclosure"), "Should mention affiliate disclosure");
  });

  it("/referral-programs has JSON-LD schema", async () => {
    const res = await fetch(`http://localhost:${serverPort}/referral-programs`);
    const html = await res.text();
    assert.ok(html.includes("application/ld+json"), "Should have JSON-LD");
    assert.ok(html.includes("ItemList"), "Should have ItemList schema");
    assert.ok(html.includes("FAQPage"), "Should have FAQ schema");
  });

  it("/vendor/digitalocean shows referral program section", async () => {
    const res = await fetch(`http://localhost:${serverPort}/vendor/digitalocean`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Referral Program"), "Should show Referral Program section");
    assert.ok(html.includes("$25 credit"), "Should show referrer benefit");
    assert.ok(html.includes("Submit your referral code"), "Should show submit CTA for vendor without our code");
  });

  it("/vendor/vercel shows referral program section", async () => {
    const res = await fetch(`http://localhost:${serverPort}/vendor/vercel`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Referral Program"), "Vercel should show referral program section");
  });

  it("/referral-programs has category filter buttons", async () => {
    const res = await fetch(`http://localhost:${serverPort}/referral-programs`);
    const html = await res.text();
    assert.ok(html.includes("filter-btn"), "Should have filter buttons");
    assert.ok(html.includes('data-category="all"'), "Should have 'All' filter");
  });

  it("/referral-programs has agent registration CTA", async () => {
    const res = await fetch(`http://localhost:${serverPort}/referral-programs`);
    const html = await res.text();
    assert.ok(html.includes("Register on the Marketplace"), "Should have marketplace CTA");
    assert.ok(html.includes("Earn Revenue"), "Should have agent CTA heading");
  });

  it("/referral-programs links to /api/referral-programs", async () => {
    const res = await fetch(`http://localhost:${serverPort}/referral-programs`);
    const html = await res.text();
    assert.ok(html.includes("/api/referral-programs"), "Should link to API endpoint");
  });

  it("GET /api/referral-programs returns JSON with programs", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-programs`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "application/json");
    assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
    const body = await res.json();
    assert.ok(Array.isArray(body.programs), "Should have programs array");
    assert.ok(body.count >= 15, `Should have at least 15 programs, got ${body.count}`);
    assert.ok(Array.isArray(body.categories), "Should have categories array");
    assert.ok(body.categories.length >= 3, "Should have at least 3 categories");
    const first = body.programs[0];
    assert.ok(first.vendor, "Program should have vendor");
    assert.ok(first.category, "Program should have category");
    assert.ok(first.referrer_benefit, "Program should have referrer_benefit");
    assert.ok(first.referee_benefit, "Program should have referee_benefit");
    assert.ok(first.program_url, "Program should have program_url");
    assert.ok(first.type, "Program should have type");
    assert.ok(first.vendor_page, "Program should have vendor_page");
  });

  it("GET /api/referral-programs?category=Databases filters by category", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-programs?category=Databases`);
    const body = await res.json();
    assert.ok(body.programs.length > 0, "Should have database programs");
    for (const p of body.programs) {
      assert.strictEqual(p.category, "Databases", `Expected Databases category, got ${p.category}`);
    }
  });

  it("sitemap-pages.xml includes /referral-programs", async () => {
    const res = await fetch(`http://localhost:${serverPort}/sitemap-pages.xml`);
    const xml = await res.text();
    assert.ok(xml.includes("/referral-programs"), "Sitemap should include referral-programs page");
  });
});
