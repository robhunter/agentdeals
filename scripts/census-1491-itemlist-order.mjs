import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, 40000);
    child.stderr.on("data", (d) => {
      const m = d.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: Number(m[1]) }); }
    });
    child.on("error", reject);
  });
}

const out = (s) => writeSync(2, s + "\n");

const { child, port } = await startServer();
const base = `http://localhost:${port}`;

async function get(p) {
  const res = await fetch(base + p, { redirect: "manual", headers: { "user-agent": "agentdeals-internal/1.0 (census-1491)" } });
  const body = res.status === 200 ? await res.text() : "";
  return { status: res.status, body };
}

const sitemapIndex = await get("/sitemap.xml");
const sub = [...sitemapIndex.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
const pageUrls = new Set();
for (const u of sub) {
  const p = new URL(u).pathname;
  if (/sitemap/.test(p)) {
    const s = await get(p);
    for (const m of s.body.matchAll(/<loc>([^<]+)<\/loc>/g)) pageUrls.add(new URL(m[1]).pathname);
  } else {
    pageUrls.add(p);
  }
}
out(`sitemap paths: ${pageUrls.size}`);

function ldBlocks(html) {
  const blocks = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { blocks.push(JSON.parse(m[1])); } catch { blocks.push({ __parseError: m[1].slice(0, 120) }); }
  }
  return blocks;
}

function* itemLists(node, trail) {
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) yield* itemLists(v, `${trail}[${i}]`);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (node["@type"] === "ItemList") yield { node, trail };
  for (const [k, v] of Object.entries(node)) {
    if (k === "@type") continue;
    yield* itemLists(v, `${trail}.${k}`);
  }
}

const rows = [];
const statuses = new Map();
for (const p of [...pageUrls].sort()) {
  const { status, body } = await get(p);
  statuses.set(status, (statuses.get(status) ?? 0) + 1);
  if (status !== 200) { out(`  !! ${p} -> ${status}`); continue; }
  for (const block of ldBlocks(body)) {
    if (block.__parseError) { out(`  !! ${p} unparsable ld+json: ${block.__parseError}`); continue; }
    for (const { node, trail } of itemLists(block, "$")) {
      const els = Array.isArray(node.itemListElement) ? node.itemListElement : [];
      rows.push({
        path: p,
        trail,
        name: node.name ?? null,
        numberOfItems: node.numberOfItems ?? null,
        rendered: els.length,
        positions: els.filter(e => e && e.position !== undefined).length,
        itemListOrder: node.itemListOrder ?? null,
      });
    }
  }
}
child.kill();

out(`statuses: ${JSON.stringify([...statuses])}`);
out(`ItemList blocks: ${rows.length} on ${new Set(rows.map(r => r.path)).size} paths`);
out(`  with itemListOrder: ${rows.filter(r => r.itemListOrder).length}`);
out(`  with explicit positions: ${rows.filter(r => r.positions > 0).length}`);
out(`  positions on every element: ${rows.filter(r => r.rendered > 0 && r.positions === r.rendered).length}`);
out(`  numberOfItems !== rendered: ${rows.filter(r => r.numberOfItems !== null && r.numberOfItems !== r.rendered).length}`);
out(`  nested (not top level): ${rows.filter(r => r.trail !== "$").length}`);

const byPathFamily = new Map();
for (const r of rows) {
  const fam = r.path.split("/").slice(0, 2).join("/") || "/";
  byPathFamily.set(fam, (byPathFamily.get(fam) ?? 0) + 1);
}
out("\nby family:");
for (const [fam, n] of [...byPathFamily].sort((a, b) => b[1] - a[1])) out(`  ${fam} ${n}`);

out("\nnumberOfItems disagreeing with rendered element count:");
for (const r of rows.filter(r => r.numberOfItems !== null && r.numberOfItems !== r.rendered).slice(0, 40)) {
  out(`  ${r.path} ${r.trail} name=${JSON.stringify(r.name)} numberOfItems=${r.numberOfItems} rendered=${r.rendered}`);
}

out("\nevery ItemList, one line each:");
for (const r of rows) {
  out(`  ${r.path}\t${r.trail}\tname=${JSON.stringify(r.name)}\tn=${r.numberOfItems}\trendered=${r.rendered}\tpos=${r.positions}\torder=${r.itemListOrder ?? "-"}`);
}
