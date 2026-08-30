import { createHash } from "node:crypto";

const BASE = process.env.E2E_BASE ?? "http://localhost:3112";

let pass = 0;
let fail = 0;
const check = (ok, label, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
};

const readerSeed = (date, queryKey, band) =>
  createHash("sha256").update(`${date}|${queryKey}|p${band}`).digest("hex");

function readerRng(seedHex) {
  let a = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readerPermutation(seedHex, n) {
  const positions = Array.from({ length: n }, (_, i) => i);
  const rng = readerRng(seedHex);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = positions[i];
    positions[i] = positions[j];
    positions[j] = tmp;
  }
  return positions;
}

const decode = (s) => s
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rsquo;/g, "’");

function parseAuditBlock(html) {
  const block = html.match(/<div class="audit-block">[\s\S]*?<\/div>/);
  if (!block) return null;
  const field = (name) => {
    const m = block[0].match(new RegExp(`<dt>${name}</dt><dd>([^<]*)</dd>`));
    return m ? decode(m[1]) : null;
  };
  const truncation = block[0].match(/first (\d+) of (\d+) entries/);
  return {
    date: field("date"),
    query_key: field("query_key"),
    seed: field("seed"),
    tie_count: Number(field("tie_count")),
    shown: truncation ? Number(truncation[1]) : null,
    total: truncation ? Number(truncation[2]) : null,
  };
}

function vendorPageAlternatives(html) {
  const section = html.slice(html.indexOf('<div class="alt-grid">'));
  return [...section.matchAll(/<span class="alt-name">([^<]+)<\/span>/g)].map((m) => decode(m[1]));
}

function alternativeToList(html) {
  const section = html.slice(html.indexOf("All Free Alternatives"));
  return [...section.matchAll(/class="alt-vendor-name">([^<]+)</g)].map((m) => decode(m[1]));
}

console.log(`\n#1166 — a reader recomputes our published order (${BASE})\n`);

console.log("1. every ranked surface publishes the block /criteria promises");
const surfaces = [
  ["/best/free-databases", "html"],
  ["/vendor/doppler", "html"],
  ["/alternative-to/doppler", "html"],
];
for (const [path] of surfaces) {
  const html = await get(path);
  const audit = parseAuditBlock(html);
  check(audit !== null, `${path} renders an audit block`);
  if (!audit) continue;
  check(/^\d{4}-\d{2}-\d{2}$/.test(audit.date ?? ""), `${path} publishes a date`, audit.date ?? "");
  check((audit.query_key ?? "").length > 0, `${path} publishes a query_key`, audit.query_key ?? "");
  check(/^[0-9a-f]{64}$/.test(audit.seed ?? ""), `${path} publishes a full seed`, audit.seed ?? "");
  check(Number.isInteger(audit.tie_count), `${path} publishes a tie_count`, String(audit.tie_count));
}

const stack = await get("/api/stack?use_case=Next.js+SaaS+app");
check(stack.stack.every((r) => /^[0-9a-f]{64}$/.test(r.tie_break?.seed ?? "")), "/api/stack returns the same block");
const risk = await get("/api/vendor-risk/doppler");
check(/^[0-9a-f]{64}$/.test(risk.tie_break?.seed ?? ""), "/api/vendor-risk returns the same block");
const details = await get("/api/details/doppler?alternatives=true");
check(/^[0-9a-f]{64}$/.test(details.offer?.tie_break?.seed ?? ""), "/api/details/:vendor returns the same block");

console.log("\n2. the published seed is the one the published algorithm produces");
for (const path of ["/best/free-databases", "/vendor/doppler", "/alternative-to/doppler", "/vendor/supabase"]) {
  const audit = parseAuditBlock(await get(path));
  if (!audit) { check(false, `${path} seed = sha256(date|query_key|p0)`, "no audit block to check"); continue; }
  const derived = readerSeed(audit.date, audit.query_key, 0);
  check(derived === audit.seed, `${path} seed = sha256(date|query_key|p0)`, `${derived.slice(0, 16)} vs ${(audit.seed ?? "").slice(0, 16)}`);
}

console.log("\n3. the served order is the seed's permutation of the public index order");

function landsBackInIndexOrder(topBand, seed, tieCount, indexRank) {
  const inputIndexOf = readerPermutation(seed, tieCount);
  const recovered = topBand.map((vendor, outputPos) => ({ vendor, inputPos: inputIndexOf[outputPos] }));
  if (recovered.some((r) => !indexRank.has(r.vendor))) return null;
  const byInputPos = [...recovered].sort((a, b) => a.inputPos - b.inputPos).map((r) => r.vendor);
  const byIndexOrder = [...recovered].sort((a, b) => indexRank.get(a.vendor) - indexRank.get(b.vendor)).map((r) => r.vendor);
  return { ok: byInputPos.join("|") === byIndexOrder.join("|"), byInputPos, byIndexOrder };
}

async function auditRankedPrefix(path, category, excludeVendor, servedOf) {
  const html = await get(path);
  const audit = parseAuditBlock(html);
  if (!audit) { check(false, `${path} — no audit block, so no order can be recomputed`); return; }
  const served = servedOf(html);
  const label = `${path} (${audit.tie_count} tied, ${served.length} shown)`;

  const api = await get(`/api/offers?category=${encodeURIComponent(category)}&limit=500`);
  const indexOrder = api.offers.map((o) => o.vendor).filter((v) => v !== excludeVendor);
  const indexRank = new Map(indexOrder.map((v, i) => [v, i]));

  const topBand = served.slice(0, Math.min(served.length, audit.tie_count));
  if (topBand.length < 2) { check(true, `${label} — fewer than two tied entries shown, nothing to permute`); return; }

  const unknown = topBand.filter((v) => !indexRank.has(v));
  check(unknown.length === 0, `${label} — every shown vendor is in the public index`, unknown.join(", "));
  if (unknown.length > 0) return;

  const served0 = landsBackInIndexOrder(topBand, audit.seed, audit.tie_count, indexRank);
  check(
    served0.ok,
    `${label} — inverting the seed's permutation lands the shown entries back in index order`,
    `\n       by seed:  ${served0.byInputPos.join(", ")}\n       by index: ${served0.byIndexOrder.join(", ")}`,
  );

  const handPlaced = [topBand[topBand.length - 1], ...topBand.slice(0, topBand.length - 1)];
  const tampered = landsBackInIndexOrder(handPlaced, audit.seed, audit.tie_count, indexRank);
  check(
    tampered !== null && !tampered.ok,
    `${label} — the same check rejects the served list with its last entry moved to the top`,
  );

  const shuffled = (() => {
    const band = indexOrder.filter((v) => topBand.includes(v));
    if (band.length !== audit.tie_count) return null;
    const out = band.slice();
    const rng = readerRng(audit.seed);
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  })();
  if (shuffled) {
    check(shuffled.join("|") === topBand.join("|"), `${label} — full forward recompute reproduces the served order`,
      `\n       recomputed: ${shuffled.join(", ")}\n       served:     ${topBand.join(", ")}`);
  }
}

await auditRankedPrefix("/vendor/supabase", "Databases", "Supabase", vendorPageAlternatives);
await auditRankedPrefix("/vendor/doppler", "Secrets Management", "Doppler", vendorPageAlternatives);
await auditRankedPrefix("/vendor/sentry", "Monitoring", "Sentry", vendorPageAlternatives);
await auditRankedPrefix("/vendor/vercel", "Cloud Hosting", "Vercel", vendorPageAlternatives);

for (const path of ["/alternative-to/vercel", "/alternative-to/doppler", "/alternative-to/openai"]) {
  const html = await get(path);
  const audit = parseAuditBlock(html);
  if (!audit) { check(false, `${path} — no audit block to reconcile against the list`); continue; }
  const listed = alternativeToList(html);
  const cards = html.slice(html.indexOf("All Free Alternatives")).split('<div class="alt-row').slice(1);
  const undemerited = cards.map((c) => !c.includes("alt-demerit"));
  const firstDemerited = undemerited.indexOf(false);
  const bandSize = firstDemerited === -1 ? cards.length : firstDemerited;
  check(
    bandSize === audit.tie_count,
    `${path} — the published tie_count matches the entries the page shows no demerit against`,
    `block says ${audit.tie_count}, page shows ${bandSize} of ${listed.length}`,
  );
  check(
    firstDemerited === -1 || undemerited.slice(firstDemerited).every((u) => !u),
    `${path} — no undemerited entry is ranked below a demoted one`,
  );
}

console.log("\n4. the order rotates with the date and nothing else");
const a = parseAuditBlock(await get("/vendor/supabase"));
if (!a) {
  check(false, "a vendor page publishes a query key to vary", "no audit block");
} else {
  check(readerSeed(a.date, a.query_key, 0) !== readerSeed("1999-01-01", a.query_key, 0), "a different date gives a different seed");
  check(readerSeed(a.date, a.query_key, 0) !== readerSeed(a.date, "alternatives:Databases:Neon", 0), "a different query key gives a different seed");
  check(!a.query_key.includes("referral") && !a.query_key.includes("sponsor"), "the query key carries no commercial input", a.query_key);
}

console.log("\n5. /criteria and llms.txt name what they count");
const criteria = await get("/criteria");
const llms = await get("/llms.txt");
const apiCats = await get("/api/categories");
const bestIndex = await get("/best");
const bestPages = new Set([...bestIndex.matchAll(/href="\/best\/([a-z0-9-]+)"/g)].map((m) => m[1])).size;
check(!/of 57 categories/.test(criteria), "/criteria no longer calls 57 best-of pages 57 categories");
check(!/of 57 categories/.test(llms), "llms.txt no longer calls 57 best-of pages 57 categories");
const scope = new RegExp(`of the ${bestPages} categories with a best-of page`);
check(scope.test(criteria), `/criteria names its scope as the ${bestPages} categories with a best-of page`);
check(scope.test(llms), `llms.txt names its scope as the ${bestPages} categories with a best-of page`);
check(
  criteria.includes(`The site publishes ${apiCats.categories.length} categories in all`),
  `/criteria states the ${apiCats.categories.length} categories the rest of the site publishes`,
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
