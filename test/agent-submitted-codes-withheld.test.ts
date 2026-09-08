import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODES_PATH = path.join(__dirname, "..", "data", "referral_codes.json");
const RETIRED_PATH = path.join(__dirname, "..", "data", "retired_agent_submissions.json");

const WITNESS = {
  id: "code_withheldwitness",
  vendor: "Supabase",
  code: "supabase-referral-2026",
  referral_url: "https://supabase.com/referrals/rhen-checkout-gate",
  description: "Supabase referral code for rhen-checkout-gate",
  commission_rate: null,
  expiry: null,
  submitted_by: "agent_withheldwitness",
  source: "agent-submitted",
  status: "active",
  trust_tier_at_submission: "new",
  impressions: 0,
  clicks: 0,
  conversions: 0,
  submitted_at: "2026-08-30T00:00:00.000Z",
  updated_at: "2026-08-30T00:00:00.000Z",
};

const SURFACES = [
  "/api/referral-codes",
  "/api/referral-codes?source=agent",
  "/api/referral-codes?source=platform",
  `/api/referral-codes/${WITNESS.vendor}`,
  `/api/details/${WITNESS.vendor}`,
  `/api/offers?q=${WITNESS.vendor.toLowerCase()}`,
  `/api/compare?a=${WITNESS.vendor}&b=Neon`,
  "/api/newest?limit=50",
];

describe("a submitted referral code cannot reach a served response", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;
  let savedCodes: string | null = null;

  before(async () => {
    savedCodes = fs.existsSync(CODES_PATH) ? fs.readFileSync(CODES_PATH, "utf8") : null;
    fs.writeFileSync(CODES_PATH, JSON.stringify({ referral_codes: [WITNESS] }, null, 2), "utf8");

    proc = await new Promise<ChildProcess>((resolve, reject) => {
      const p = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 15000);
      p.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  });

  after(() => {
    proc?.kill();
    if (savedCodes !== null) fs.writeFileSync(CODES_PATH, savedCodes, "utf8");
    else if (fs.existsSync(CODES_PATH)) fs.unlinkSync(CODES_PATH);
  });

  it("the store under test really does hold an active submitted code", () => {
    const held = JSON.parse(fs.readFileSync(CODES_PATH, "utf8")).referral_codes;
    assert.strictEqual(held.length, 1, "the witness must be in the store, or every assertion below is vacuous");
    assert.strictEqual(held[0].status, "active");
    assert.strictEqual(held[0].source, "agent-submitted");
  });

  it("no API surface carries the code, the URL or the submitter", async () => {
    for (const surface of SURFACES) {
      const res = await fetch(`http://localhost:${serverPort}${surface}`);
      assert.ok(res.status < 500, `${surface} answered ${res.status}`);
      const body = await res.text();
      for (const trace of [WITNESS.code, WITNESS.referral_url, WITNESS.submitted_by, "agent-submitted", "agent_referral_codes"]) {
        assert.ok(!body.includes(trace), `${surface} carries "${trace}"`);
      }
    }
  });

  it("source=agent answers with an empty list and the reason", async () => {
    const body = await (await fetch(`http://localhost:${serverPort}/api/referral-codes?source=agent`)).json();
    assert.deepStrictEqual(body.codes, []);
    assert.strictEqual(body.total, 0);
    assert.match(body.withheld_reason, /retired/i);
  });

  it("the vendor lookup refuses rather than falling through to the submitted code", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/referral-codes/${WITNESS.vendor}`);
    assert.strictEqual(res.status, 404, "we hold no code for this vendor, so the lookup must say so");
  });

  it("/disclosure does not describe agent submission", async () => {
    const html = await (await fetch(`http://localhost:${serverPort}/disclosure`, { redirect: "error" })).text();
    for (const trace of ["Agent-Submitted Referral Codes", "submitted by community agents", WITNESS.code]) {
      assert.ok(!html.includes(trace), `/disclosure carries "${trace}"`);
    }
    assert.ok(html.includes("Current Referral Partners"), "the codes we do hold are still listed");
  });

  it("negative control: the codes we hold are still served in full", async () => {
    const listed = await (await fetch(`http://localhost:${serverPort}/api/referral-codes`)).json();
    const railway = listed.codes.find((c: any) => c.vendor === "Railway");
    assert.ok(railway, "Railway's code must still be served");
    assert.strictEqual(railway.code, "7RZL9q");
    assert.strictEqual(railway.source, "platform");

    const single = await (await fetch(`http://localhost:${serverPort}/api/referral-codes/railway`)).json();
    assert.strictEqual(single.code, "7RZL9q");

    const vultr = listed.codes.find((c: any) => c.vendor === "Vultr DNS");
    assert.ok(vultr, "Vultr DNS's code must still be served");
    assert.ok(vultr.restrictions.length > 0, "and with the conditions attached to it");
  });

  it("the submission we withdrew is recorded where it can still be read", () => {
    const record = JSON.parse(fs.readFileSync(RETIRED_PATH, "utf8"));
    assert.ok(record.retired_on, "the record states when");
    assert.ok(record.reason, "the record states why");
    const kept = record.submissions.find((s: any) => s.code === WITNESS.code);
    assert.ok(kept, "the code we stopped serving is kept");
    assert.strictEqual(kept.referral_url, WITNESS.referral_url);
  });
});
