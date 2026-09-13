import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { changesByVendor, loadOffers } from "../dist/data.js";
import { supersedingChange } from "../dist/superseded-description.js";
import { unconfirmedTermsForOffer } from "../dist/vendor-verdict-input.js";
import { unconfirmedTermsSentence } from "../dist/vendor-verdict.js";
import { getGuideList } from "../dist/guides.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 120000);
    child.stderr.on("data", (b) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ proc: child, base: `http://127.0.0.1:${m[1]}` }); }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

const asServed = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const readable = (html) => html
  .replace(/<script[\s\S]*?<\/script>/g, " ")
  .replace(/<datalist[\s\S]*?<\/datalist>/g, " ")
  .replace(/<select[\s\S]*?<\/select>/g, " ")
  .replace(/<style[\s\S]*?<\/style>/g, " ");

const countOf = (haystack, needle) => {
  let n = 0, at = 0;
  while (needle && (at = haystack.indexOf(needle, at)) !== -1) { n++; at += needle.length; }
  return n;
};

const offers = loadOffers();
const changes = changesByVendor();

const stating = [];
for (const offer of offers) {
  if (supersedingChange(offer, changes.get(offer.vendor.toLowerCase()) ?? [])) continue;
  const unconfirmed = unconfirmedTermsForOffer(offer);
  if (!unconfirmed) continue;
  if (!offer.description || offer.description.length < 25) continue;
  stating.push({
    vendor: offer.vendor,
    tier: offer.tier,
    terms: asServed(offer.description),
    sentence: asServed(unconfirmedTermsSentence(unconfirmed)),
  });
}

const { proc, base } = await startServer();
const rows = [];
try {
  for (const guide of getGuideList()) {
    const at = `/${guide.slug}`;
    const res = await fetch(`${base}${at}`, { redirect: "manual" });
    if (res.status !== 200) { rows.push({ at, status: res.status }); continue; }
    const html = readable(await res.text());
    const published = [];
    for (const record of stating) {
      const times = countOf(html, record.terms);
      if (times === 0) continue;
      published.push({
        vendor: record.vendor, tier: record.tier, times,
        closes: countOf(html, `${record.terms}</`) === 0 ? 0 : countOf(html, record.sentence),
        sentences: countOf(html, record.sentence),
      });
    }
    rows.push({
      at, status: 200,
      publishing: published.length,
      renderings: published.reduce((a, p) => a + p.times, 0),
      disclosing: published.filter(p => p.sentences > 0).length,
      repeated: published.filter(p => p.times > 1).map(p => `${p.vendor} x${p.times}`),
      published,
    });
  }
} finally { proc.kill("SIGKILL"); }

writeFileSync(path.join(__dirname, "..", "artifacts", "census-1603-register-guides.json"), JSON.stringify(rows, null, 2));
const served = rows.filter(r => r.status === 200);
const owing = served.filter(r => r.publishing > 0);
console.log(`guide paths: ${rows.length}, served 200: ${served.length}`);
console.log(`offers stating terms we cannot confirm: ${stating.length}`);
console.log(`guide pages publishing at least one such offer's terms verbatim: ${owing.length}`);
console.log(`(page, offer) pairs publishing those terms: ${owing.reduce((a, r) => a + r.publishing, 0)}`);
console.log(`renderings of those terms: ${owing.reduce((a, r) => a + r.renderings, 0)}`);
console.log(`(page, offer) pairs closing with the reason: ${owing.reduce((a, r) => a + r.disclosing, 0)}`);
console.log(`pages short of what they owe: ${owing.filter(r => r.disclosing < r.publishing).length}`);
console.log(`\npairs rendered more than once on one page: ${owing.reduce((a, r) => a + r.repeated.length, 0)}`);
for (const r of owing.filter(r => r.repeated.length)) console.log(`  ${r.at}: ${r.repeated.join(", ")}`);
console.log("\ntop pages by owed pairs:");
for (const r of [...owing].sort((a, b) => b.publishing - a.publishing).slice(0, 12)) {
  console.log(`  ${String(r.publishing).padStart(3)} owed, ${String(r.disclosing).padStart(3)} disclosing  ${r.at}`);
}
