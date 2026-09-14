import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("startup timeout")); }, 120000);
    child.stderr?.on("data", (b) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

const { proc, port } = await startServer();
const base = `http://127.0.0.1:${port}`;

async function text(p) {
  const r = await fetch(`${base}${p}`, { redirect: "manual" });
  return { status: r.status, body: r.status === 200 ? await r.text() : "" };
}

const sitemapIndex = (await text("/sitemap.xml")).body;
const children = [...sitemapIndex.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
const allLocs = [];
for (const child of children) {
  const rel = child.replace(/^https?:\/\/[^/]+/, "");
  const body = (await text(rel)).body;
  for (const m of body.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    allLocs.push(m[1].replace(/^https?:\/\/[^/]+/, "") || "/");
  }
}

const unique = [...new Set(allLocs)];
const vendorPages = unique.filter(p => p.startsWith("/vendor/"));
const comparePages = unique.filter(p => p.startsWith("/compare/"));
const eventPages = unique.filter(p => p.startsWith("/events/"));

const claimPhrases = [
  ["api/watchlist", /api\/watchlist/g],
  ["signed POST", /signed POST/g],
  ["notified via webhook", /notified via webhook/g],
  ["developer-hub", /\/developer-hub/g],
  ["developers#watchlist", /\/developers#watchlist/g],
];

const tally = {};
for (const [label] of claimPhrases) tally[label] = { pages: 0, occurrences: 0, examples: [] };

const perFamily = {};
async function sweep(label, pages) {
  perFamily[label] = { total: pages.length, withClaim: 0 };
  for (const p of pages) {
    const { status, body } = await text(p);
    if (status !== 200) continue;
    let claimed = false;
    for (const [name, re] of claimPhrases) {
      const hits = body.match(re);
      if (!hits) continue;
      tally[name].occurrences += hits.length;
      tally[name].pages += 1;
      if (tally[name].examples.length < 3) tally[name].examples.push(p);
      if (name === "api/watchlist") claimed = true;
    }
    if (claimed) perFamily[label].withClaim += 1;
  }
}

await sweep("vendor", vendorPages);
await sweep("compare", comparePages);
await sweep("events", eventPages);
await sweep("other", unique.filter(p => !p.startsWith("/vendor/") && !p.startsWith("/compare/") && !p.startsWith("/events/")));

const linkTargets = {};
for (const p of ["/developer-hub", "/developers", "/pricing-changes/feed.xml", "/feed.xml"]) {
  const r = await fetch(`${base}${p}`, { redirect: "manual" });
  linkTargets[p] = r.status;
}

const changesVendor = {};
for (const v of ["Vercel", "Supabase", "NotARealVendorXyz"]) {
  const r = await fetch(`${base}/api/changes?vendor=${encodeURIComponent(v)}`);
  const body = await r.json();
  changesVendor[v] = { status: r.status, total: body.total ?? (body.changes?.length ?? null) };
}

const feedVendor = {};
for (const v of ["Vercel", "NotARealVendorXyz"]) {
  for (const p of ["/feed.xml", "/pricing-changes/feed.xml"]) {
    const r = await fetch(`${base}${p}?vendor=${encodeURIComponent(v)}`);
    const body = await r.text();
    feedVendor[`${p}?vendor=${v}`] = { status: r.status, entries: (body.match(/<entry>/g) ?? []).length };
  }
}
for (const p of ["/feed.xml", "/pricing-changes/feed.xml"]) {
  const r = await fetch(`${base}${p}`);
  const body = await r.text();
  feedVendor[`${p} (no filter)`] = { status: r.status, entries: (body.match(/<entry>/g) ?? []).length };
}

const report = {
  sitemap_pages: unique.length,
  families: perFamily,
  claim_tally: tally,
  link_targets: linkTargets,
  api_changes_vendor: changesVendor,
  feed_vendor_filter: feedVendor,
};

writeFileSync(path.join(REPO, "artifacts", "census-1655-watchlist-promise.json"), JSON.stringify(report, null, 2));
process.stderr.write(JSON.stringify(report, null, 2) + "\n");
proc.kill("SIGKILL");
