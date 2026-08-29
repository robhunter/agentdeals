import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const repo = process.argv[2];
const out = process.argv[3];

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [path.join(repo, "dist", "serve.js")], {
      cwd: repo,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
    });
    const timeout = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("timeout")); }, 30000);
    p.stderr.on("data", (b) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: p, port: parseInt(m[1], 10) }); }
    });
    p.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

const toSlug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const index = JSON.parse(readFileSync(path.join(repo, "data", "index.json"), "utf8"));
const offers = Array.isArray(index) ? index : index.offers;
const vendorSlugs = [...new Set(offers.map((o) => toSlug(o.vendor)))].filter(Boolean).sort();

const fullBodyPaths = [
  "/disclosure",
  "/referral-programs",
  "/marketplace",
  "/api/referral-programs",
  "/api/referral-codes",
  "/api/referral-codes?source=platform",
  "/api/referral-codes?source=agent-submitted",
  "/privacy",
  "/press",
];

const { proc, port } = await startServer();
const result = { pages: {}, vendors: {} };

for (const p of fullBodyPaths) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  const body = await res.text();
  result.pages[p] = { status: res.status, length: body.length, body };
}

for (const slug of vendorSlugs) {
  const res = await fetch(`http://127.0.0.1:${port}/vendor/${slug}`);
  const body = await res.text();
  result.vendors[slug] = {
    status: res.status,
    length: body.length,
    sha: createHash("sha256").update(body).digest("hex"),
    referralBox: body.includes("Sign up via our referral link"),
    programSection: body.includes("<h2>Referral Program</h2>"),
    solicitation: body.includes("marketplace-solicitation"),
  };
}

proc.kill("SIGKILL");
writeFileSync(out, JSON.stringify(result));

const renderingReferral = Object.entries(result.vendors).filter(([, v]) => v.referralBox).map(([k]) => k);
console.log(`swept ${fullBodyPaths.length} pages + ${vendorSlugs.length} vendor pages -> ${out}`);
console.log(`vendor pages rendering a referral link: ${renderingReferral.length} (${renderingReferral.join(", ")})`);
console.log(`vendor pages rendering the marketplace solicitation: ${Object.values(result.vendors).filter((v) => v.solicitation).length}`);
const bad = Object.entries(result.pages).filter(([, v]) => v.status !== 200);
if (bad.length) console.log("NON-200:", bad.map(([k, v]) => `${k}=${v.status}`).join(", "));
const badVendors = Object.entries(result.vendors).filter(([, v]) => v.status !== 200);
if (badVendors.length) console.log(`NON-200 vendor pages: ${badVendors.length}`);
