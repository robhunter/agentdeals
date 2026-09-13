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
    const timeout = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, 60000);
    child.stderr.on("data", (d) => {
      const m = d.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: Number(m[1]) }); }
    });
    child.on("error", reject);
  });
}

const out = (s) => writeSync(2, s + "\n");

const { publishedStabilityIndex } = await import(path.join(REPO, "dist", "data.js"));
const { gradeSuperlatives, superlativeClaims, pageTables } = await import(path.join(REPO, "dist", "superlative-claims.js"));

const stability = publishedStabilityIndex();
const { child, port } = await startServer();
const base = `http://localhost:${port}`;

async function get(p) {
  const res = await fetch(base + p, { redirect: "manual", headers: { "user-agent": "agentdeals-internal/1.0 (census-1492)" } });
  return { status: res.status, body: res.status === 200 ? await res.text() : "" };
}

function ldBlocks(html) {
  const blocks = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { blocks.push(JSON.parse(m[1])); } catch { blocks.push({ __parseError: m[1].slice(0, 120) }); }
  }
  return blocks;
}

function faqPages(html) {
  return ldBlocks(html).filter(b => b && b["@type"] === "FAQPage");
}

const index = await get("/best");
const bestPaths = [...new Set([...index.body.matchAll(/href="(\/best\/[a-z0-9-]+)"/g)].map(m => m[1]))].sort();
out(`/best/* paths: ${bestPaths.length}`);

const TIE_SENTENCE = /none is distinguishable from the others under any signal we record/;
const CARD_VENDOR = /<a href="\/vendor\/([a-z0-9][a-z0-9-]*)" class="best-pick-name">/g;
const DEMOTED_BLOCK = /<div class="best-pick best-pick-demoted"/;

const rows = [];
for (const p of bestPaths) {
  const { status, body } = await get(p);
  if (status !== 200) { out(`${p} -> ${status}`); continue; }
  const listed = [];
  const firstDemoted = body.search(DEMOTED_BLOCK);
  const qualifiedHtml = firstDemoted === -1 ? body : body.slice(0, firstDemoted);
  for (const m of qualifiedHtml.matchAll(CARD_VENDOR)) listed.push(m[1]);
  const classes = listed.map(slug => stability.of(slug));
  const tally = {};
  for (const c of classes) tally[c] = (tally[c] ?? 0) + 1;
  rows.push({
    path: p,
    listed: listed.length,
    tally,
    distinct: new Set(classes).size,
    saysTie: TIE_SENTENCE.test(body),
    saysGroupTie: /None is distinguishable from the others in this group/.test(body),
    hasFaq: faqPages(body).length > 0,
    isHub: /class="function-group-heading"/.test(body),
  });
}

const leaves = rows.filter(r => !r.isHub);
const hubs = rows.filter(r => r.isHub);
out(`leaf pages: ${leaves.length}   hub pages: ${hubs.length}`);
out(`leaf pages whose stability splits into 2+ groups: ${leaves.filter(r => r.distinct > 1).length}`);
out(`  ...of which the prose says nothing distinguishes them: ${leaves.filter(r => r.distinct > 1 && r.saysTie).length}`);
out(`leaf pages where stability does not split: ${leaves.filter(r => r.distinct <= 1).length}`);
out(`  ...listing them: ${leaves.filter(r => r.distinct <= 1).map(r => `${r.path} (${JSON.stringify(r.tally)})`).join(", ")}`);
out(`pages saying the tie sentence at all: ${rows.filter(r => r.saysTie).length}`);
out(`hub pages saying the per-group tie sentence: ${hubs.filter(r => r.saysGroupTie).length}`);
out(`pages carrying a FAQPage: ${rows.filter(r => r.hasFaq).length} of ${rows.length}`);

const classTotals = {};
for (const r of rows) for (const [k, v] of Object.entries(r.tally)) classTotals[k] = (classTotals[k] ?? 0) + v;
out(`listed rows by published stability: ${JSON.stringify(classTotals)}`);
out(`pages with at least one listed row per class:`);
for (const cls of ["stable", "watch", "volatile", "improving", "unrated"]) {
  out(`  ${cls}: ${rows.filter(r => (r.tally[cls] ?? 0) > 0).length} pages, ${classTotals[cls] ?? 0} rows`);
}

out("");
out("=== comparison pages ===");
const sitemapIndex = await get("/sitemap.xml");
const sub = [...sitemapIndex.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
const allPaths = new Set();
for (const u of sub) {
  const p = new URL(u).pathname;
  if (/sitemap/.test(p)) {
    const s = await get(p);
    for (const m of s.body.matchAll(/<loc>([^<]+)<\/loc>/g)) allPaths.add(new URL(m[1]).pathname);
  } else {
    allPaths.add(p);
  }
}
out(`sitemap paths: ${allPaths.size}`);

const GENEROSITY_Q = /free tier is most generous/i;
const faqPathCount = [];
const generosityPages = [];
for (const p of [...allPaths].sort()) {
  const { status, body } = await get(p);
  if (status !== 200) continue;
  const faqs = faqPages(body);
  if (faqs.length === 0) continue;
  const entities = faqs.flatMap(f => Array.isArray(f.mainEntity) ? f.mainEntity : []);
  faqPathCount.push({ path: p, questions: entities.length });
  const generosity = entities.filter(e => GENEROSITY_Q.test(e.name ?? ""));
  if (generosity.length === 0) continue;
  const graded = gradeSuperlatives(body);
  const claims = superlativeClaims(body);
  generosityPages.push({
    path: p,
    question: generosity[0].name,
    answer: (generosity[0].acceptedAnswer?.text ?? "").slice(0, 90),
    claims: claims.length,
    ranking: claims.filter(c => c.direction !== null).length,
    graded: graded.graded,
    refuted: graded.refuted.length,
    unattained: graded.unattained.length,
    ungraded: graded.ungraded.length,
    tables: pageTables(body).length,
  });
}
out(`paths carrying a FAQPage: ${faqPathCount.length}`);
out(`...of which ask the generosity question: ${generosityPages.length}`);
for (const g of generosityPages) {
  out(`  ${g.path}`);
  out(`      q: ${g.question}`);
  out(`      claims ${g.claims} (ranking ${g.ranking}) graded ${g.graded} refuted ${g.refuted} unattained ${g.unattained} ungraded ${g.ungraded} tables ${g.tables}`);
}

child.kill();
