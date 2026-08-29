import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const repo = process.argv[2];
const out = process.argv[3];
const CONCURRENCY = 16;

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [path.join(repo, "dist", "serve.js")], {
      cwd: repo,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://127.0.0.1" },
    });
    const timeout = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("timeout")); }, 60000);
    p.stderr.on("data", (b) => {
      const m = b.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: p, port: parseInt(m[1], 10) }); }
    });
    p.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

const { sponsoredAnchorsIn } = await import(path.join(repo, "dist", "sponsored-links.js"))
  .catch(() => ({ sponsoredAnchorsIn: null }));

const ANCHOR_TAG = /<a\s+([^>]*)>([\s\S]*?)<\/a>/gi;
const fallbackSponsoredAnchorsIn = (html) => {
  const found = [];
  for (const m of html.matchAll(ANCHOR_TAG)) {
    const rel = /rel="([^"]*)"/i.exec(m[1]);
    if (!rel || !rel[1].split(/\s+/).includes("sponsored")) continue;
    const href = /href="([^"]*)"/i.exec(m[1]);
    found.push({ href: href ? href[1] : "", label: m[2].replace(/<[^>]*>/g, "").trim() });
  }
  return found;
};
const anchorsIn = sponsoredAnchorsIn ?? fallbackSponsoredAnchorsIn;

const { proc, port } = await startServer();
const base = `http://127.0.0.1:${port}`;

const stripHost = (u) => u.replace(/^https?:\/\/[^/]+/, "");
const index = await (await fetch(`${base}/sitemap.xml`)).text();
let paths = [];
for (const m of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
  const xml = await (await fetch(`${base}${stripHost(m[1])}`)).text();
  paths.push(...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((l) => stripHost(l[1])));
}
paths = [...new Set(paths)].sort();

const extra = ["/", "/disclosure", "/referral-programs", "/marketplace", "/hosting-pricing", "/signal"];
for (const p of extra) if (!paths.includes(p)) paths.push(p);

const pages = {};
let cursor = 0;
async function worker() {
  while (cursor < paths.length) {
    const p = paths[cursor++];
    const res = await fetch(`${base}${p}`);
    const body = await res.text();
    pages[p] = {
      status: res.status,
      sha: createHash("sha256").update(body).digest("hex"),
      length: body.length,
      sponsored: anchorsIn(body),
    };
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

proc.kill("SIGKILL");
writeFileSync(out, JSON.stringify({ paths, pages }));

const withSponsored = Object.entries(pages).filter(([, v]) => v.sponsored.length > 0);
const hrefCounts = new Map();
for (const [, v] of withSponsored) {
  for (const a of v.sponsored) hrefCounts.set(a.href, (hrefCounts.get(a.href) ?? 0) + 1);
}
console.log(`swept ${paths.length} paths -> ${out}`);
console.log(`pages rendering at least one sponsored link: ${withSponsored.length}`);
console.log("distinct sponsored hrefs:");
for (const [href, count] of [...hrefCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count.toString().padStart(5)}  ${href}`);
}
