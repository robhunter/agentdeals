import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { changesByVendor, loadOffers } from "../dist/data.js";
import { supersedingChange } from "../dist/superseded-description.js";
import { unconfirmedTermsForOffer } from "../dist/vendor-verdict-input.js";
import { unconfirmedTermsSentence } from "../dist/vendor-verdict.js";

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

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, body]) => { try { return JSON.parse(body); } catch { return null; } })
    .filter((v) => v !== null);
}

function walk(node, found) {
  if (Array.isArray(node)) { for (const item of node) walk(item, found); return found; }
  if (!node || typeof node !== "object") return found;
  if (node["@type"] === "SoftwareApplication" && typeof node.description === "string") found.push(node);
  for (const value of Object.values(node)) walk(value, found);
  return found;
}

function withoutJsonLd(html) {
  return html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, " ");
}

function asServed(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function metaDescriptionOf(html) {
  const m = html.match(/<meta name="description" content="([^"]*)">/);
  return m ? m[1] : "";
}

const offers = loadOffers();
const changes = changesByVendor();

const owedSentence = new Map();
const noFreePlanRead = new Set();
for (const offer of offers) {
  const superseded = supersedingChange(offer, changes.get(offer.vendor.toLowerCase()) ?? []);
  if (superseded) continue;
  const unconfirmed = unconfirmedTermsForOffer(offer);
  if (!unconfirmed) continue;
  owedSentence.set(offer, unconfirmedTermsSentence(unconfirmed));
  if (!unconfirmed.theReadFoundAFreePlan) noFreePlanRead.add(offer);
}

const offerKey = (vendor, category, tier) => `${String(vendor).toLowerCase()}|${category}|${tier}`;

const offerByKey = new Map();
const collidingKeys = new Set();
for (const offer of offers) {
  const key = offerKey(offer.vendor, offer.category, offer.tier);
  if (offerByKey.has(key)) collidingKeys.add(key);
  else offerByKey.set(key, offer);
}

const owedByVendor = new Map();
for (const [offer, sentence] of owedSentence) {
  const key = offer.vendor.toLowerCase();
  if (!owedByVendor.has(key)) owedByVendor.set(key, new Set());
  owedByVendor.get(key).add(sentence);
}

const { proc, base } = await startServer();
try {
  const index = await (await fetch(`${base}/sitemap.xml`)).text();
  const children = [...index.matchAll(/<loc>[^<]*?(\/sitemap-[^<]*)<\/loc>/g)].map(([, p]) => p);
  const documents = [index];
  for (const child of children) documents.push(await (await fetch(`${base}${child}`)).text());
  const paths = [...new Set(documents.flatMap((doc) =>
    [...doc.matchAll(/<loc>[^<]*?(\/(?:best|category)\/[^<]*)<\/loc>/g)].map(([, p]) => p)))].sort();

  const rows = [];
  for (const p of paths) {
    const res = await fetch(`${base}${p}`, { redirect: "manual" });
    if (res.status !== 200) { rows.push({ path: p, status: res.status }); continue; }
    const html = await res.text();
    const prose = withoutJsonLd(html);
    const nodes = walk(jsonLdBlocks(html), []);

    let owed = 0;
    let carried = 0;
    let unmatched = 0;
    let zeroPricedNoFreePlan = 0;
    const missing = [];
    const owedVendors = new Set();
    const carriedVendors = new Set();
    for (const node of nodes) {
      const offer = offerByKey.get(offerKey(node.name, node.applicationCategory, node.offers?.description));
      if (!offer) { unmatched++; continue; }
      if (noFreePlanRead.has(offer) && node.offers?.price === "0") zeroPricedNoFreePlan++;
      const sentence = owedSentence.get(offer);
      if (!sentence) continue;
      owed++;
      owedVendors.add(offer.vendor.toLowerCase());
      if (node.description.includes(sentence)) { carried++; carriedVendors.add(offer.vendor.toLowerCase()); }
      else missing.push(`${offer.vendor} (${offer.tier})`);
    }

    const proseVendors = new Set();
    for (const [vendor, sentences] of owedByVendor) {
      if ([...sentences].some((s) => prose.includes(asServed(s)))) proseVendors.add(vendor);
    }
    const proseOnly = [...proseVendors].filter((v) => owedVendors.has(v) && !carriedVendors.has(v));

    const meta = metaDescriptionOf(html);
    const verifiedList = meta.match(/Nothing on record contradicts our terms for ([^.]*)\./);
    const namedAsVerified = verifiedList
      ? verifiedList[1].replace(/ and more$/, "").split(", ").map((n) => n.trim().toLowerCase())
      : [];
    const metaNames = namedAsVerified.filter((v) => owedVendors.has(v));
    const metaDiscloses = /We could not confirm today&#39;s terms for \d+ of them|We could not confirm today's terms for \d+ of them/.test(meta);

    rows.push({
      path: p,
      status: 200,
      nodes: nodes.length,
      unmatched,
      zeroPricedNoFreePlan,
      owed,
      carried,
      proseVendors: proseVendors.size,
      owedVendors: owedVendors.size,
      proseOnly,
      missing,
      meta,
      metaNamesUnconfirmed: metaNames.length,
      metaDiscloses,
    });
  }

  const served = rows.filter((r) => r.status === 200);
  const totals = served.reduce((acc, r) => ({
    nodes: acc.nodes + r.nodes,
    owed: acc.owed + r.owed,
    carried: acc.carried + r.carried,
  }), { nodes: 0, owed: 0, carried: 0 });

  const short = served.filter((r) => r.owed !== r.carried);
  const proseAhead = served.filter((r) => r.proseOnly.length > 0);
  const metaExposed = served.filter((r) => r.metaNamesUnconfirmed > 0);
  const metaOwing = served.filter((r) => r.owed > 0 && !r.metaDiscloses);

  const lines = [];
  lines.push(`paths measured: ${rows.length} (${served.length} served 200)`);
  lines.push(`nodes this census could not key to a record: ${served.reduce((n, r) => n + r.unmatched, 0)}${collidingKeys.size > 0 ? `, ${collidingKeys.size} records share a key` : ""}`);
  lines.push(`SoftwareApplication nodes: ${totals.nodes}`);
  lines.push(`nodes stating terms we cannot confirm: ${totals.owed}`);
  lines.push(`of those, closing with the clause: ${totals.carried}`);
  lines.push(`pages whose structured data is short of what it owes: ${short.length}`);
  lines.push(`pages where a vendor carries the clause in prose and not in the structured data: ${proseAhead.length}`);
  lines.push(`pages naming a vendor as verified while the page owes a caveat for it: ${metaExposed.length}`);
  lines.push(`pages owing a caveat whose meta description does not disclose one: ${metaOwing.length}`);
  lines.push(`nodes pricing an offer at 0 over a read that found no free plan: ${served.reduce((n, r) => n + r.zeroPricedNoFreePlan, 0)}`);
  lines.push("");
  lines.push("| page | nodes | owed | carried | prose vendors | structured vendors | meta discloses |");
  lines.push("|---|---:|---:|---:|---:|---:|---|");
  for (const r of served.slice().sort((a, b) => (b.owed - b.carried) - (a.owed - a.carried) || b.owed - a.owed)) {
    lines.push(`| ${r.path} | ${r.nodes} | ${r.owed} | ${r.carried} | ${r.proseVendors} | ${r.owedVendors} | ${r.metaDiscloses ? "yes" : "no"} |`);
  }
  const out = lines.join("\n");
  writeFileSync("/tmp/census-1603-structured.md", out);
  process.stderr.write(`${lines.slice(0, 10).join("\n")}\n\nfull table: /tmp/census-1603-structured.md\n`);
  writeFileSync("/tmp/census-1603-structured.json", JSON.stringify(rows, null, 1));
} finally {
  proc.kill("SIGKILL");
}
