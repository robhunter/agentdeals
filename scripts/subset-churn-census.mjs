import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://localhost";
const A_DAY_IN_MS = 86400000;

const HELP = `Report which surfaces name a different set of vendors tomorrow.

Every page is rendered twice, the second time against a server whose clock is a day ahead, and
the names each surface publishes are compared as sets. A tied set listed in a rotating order is
the same set both times; a slice of that order is not, and this is what finds the slices.

Regions are read from each page's own headings rather than from a list of surfaces, so a surface
added later is measured without being registered here.

Usage: node scripts/subset-churn-census.mjs [--all]

  --all    Read every published URL rather than only the pages data/page-lastmod.json calls daily
  --help   This text
`;

function startServer(inventoryOut, clockShiftMs = 0) {
  return new Promise((resolve, reject) => {
    const args = clockShiftMs ? ["--import", join(REPO, "scripts", "shifted-clock.mjs")] : [];
    const proc = spawn("node", [...args, join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TZ: "UTC",
        PORT: "0",
        BASE_URL: ORIGIN,
        AGENTDEALS_PAGE_INVENTORY_OUT: inventoryOut,
        AGENTDEALS_CLOCK_SHIFT_MS: String(clockShiftMs),
      },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("no port in 60s")); }, 60000);
    proc.stderr.on("data", chunk => {
      const match = chunk.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve({ proc, base: `${ORIGIN}:${match[1]}` }); }
    });
    proc.on("error", err => { clearTimeout(timeout); reject(err); });
    proc.on("exit", code => { clearTimeout(timeout); reject(new Error(`exit ${code} before port`)); });
  });
}

function metaDescription(body) {
  const m = body.match(/<meta name="description" content="([^"]*)"/);
  return m ? m[1] : null;
}

function jsonLdBlocks(body) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(body))) {
    try { out.push(JSON.parse(m[1])); } catch { out.push({ unparseable: m[1] }); }
  }
  return out;
}

function itemListNames(body) {
  const names = [];
  const walk = node => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    if (node["@type"] === "ItemList" && Array.isArray(node.itemListElement)) {
      for (const el of node.itemListElement) {
        const name = el?.item?.name ?? el?.name;
        if (typeof name === "string") names.push(name);
      }
    }
    for (const value of Object.values(node)) walk(value);
  };
  jsonLdBlocks(body).forEach(walk);
  return names;
}

function compareTableNames(body) {
  const section = body.match(/<table class="mini-compare-table">([\s\S]*?)<\/table>/);
  if (!section) return null;
  const names = [...section[1].matchAll(/<a href="\/vendor\/[^"]*">([^<]*)<\/a>/g)].map(m => m[1]);
  return names;
}

function growthConsideration(body) {
  const m = body.match(/At that point, consider <a href="\/vendor\/([^"]*)"/);
  return m ? m[1] : null;
}

function faqOtherVendors(body) {
  const m = body.match(/Other vendors in [^.]*? include ([^.]*)\./);
  return m ? m[1] : null;
}

function linkedVendorSlugs(body) {
  return [...new Set([...body.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)].map(m => m[1]))];
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function vendorsByRegion(body) {
  const regions = new Map();
  const add = (region, slug) => {
    if (!regions.has(region)) regions.set(region, new Set());
    regions.get(region).add(slug);
  };
  const headingAt = [...body.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g)].map(m => ({ at: m.index, text: stripTags(m[1]) }));
  const headingFor = index => {
    let current = "(before the first heading)";
    for (const heading of headingAt) {
      if (heading.at > index) break;
      current = heading.text;
    }
    return current;
  };
  for (const match of body.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)) {
    add(headingFor(match.index), match[1]);
  }
  return Object.fromEntries([...regions].map(([k, v]) => [k, [...v].sort()]));
}

function faqAnswers(body) {
  const out = [];
  const walk = node => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    if (node["@type"] === "Question" && typeof node.acceptedAnswer?.text === "string") {
      out.push(`${node.name} :: ${node.acceptedAnswer.text}`);
    }
    for (const value of Object.values(node)) walk(value);
  };
  jsonLdBlocks(body).forEach(walk);
  return out.sort();
}

function surfacesOf(body) {
  return {
    regions: vendorsByRegion(body),
    faq_answers: faqAnswers(body),
    every_vendor_named: linkedVendorSlugs(body),
    meta_description: metaDescription(body),
    item_list_names: itemListNames(body),
    compare_table: compareTableNames(body),
    growth_consideration: growthConsideration(body),
    faq_other_vendors: faqOtherVendors(body),
  };
}

function sameSet(a, b) {
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    const sa = [...a].sort().join(" ");
    const sb = [...b].sort().join(" ");
    return sa === sb;
  }
  return a === b;
}

function sameSequence(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.join(" ") === b.join(" ");
  return a === b;
}

async function readEveryPage(base, paths) {
  const out = new Map();
  for (const pagePath of paths) {
    const response = await fetch(base + pagePath);
    const body = await response.text();
    if (response.status !== 200) throw new Error(`${pagePath} answered ${response.status}`);
    out.set(pagePath, surfacesOf(body));
  }
  return out;
}

function pageClass(pagePath) {
  const first = pagePath.split("/")[1] ?? "";
  if (["alternative-to", "vendor", "best", "category", "compare", "trends"].includes(first)) return `/${first}/*`;
  return pagePath;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const onlyDaily = !process.argv.includes("--all");
  const scratch = mkdtempSync(join(tmpdir(), "subset-churn-"));
  let today;
  let tomorrow;
  try {
    const startedAt = Date.now();
    const inventoryOut = join(scratch, "inventory.json");
    today = await startServer(inventoryOut);
    let paths = JSON.parse(readFileSync(inventoryOut, "utf-8"));
    if (onlyDaily) {
      const ledger = JSON.parse(readFileSync(join(REPO, "data", "page-lastmod.json"), "utf-8"));
      const daily = new Set(Object.entries(ledger.pages).filter(([, v]) => v.daily).map(([k]) => k));
      paths = paths.filter(p => daily.has(p));
    }
    const todaySurfaces = await readEveryPage(today.base, paths);
    today.proc.kill();
    today = null;

    tomorrow = await startServer(join(scratch, "inventory-tomorrow.json"), A_DAY_IN_MS);
    const tomorrowSurfaces = await readEveryPage(tomorrow.base, paths);
    tomorrow.proc.kill();
    tomorrow = null;

    const surfaceNames = ["faq_answers", "every_vendor_named", "meta_description", "item_list_names", "compare_table", "growth_consideration", "faq_other_vendors"];
    const membershipMoved = {};
    const orderOnlyMoved = {};
    const byClass = {};
    const examples = {};
    const regionChurn = {};
    for (const name of surfaceNames) { membershipMoved[name] = []; orderOnlyMoved[name] = []; }

    for (const pagePath of paths) {
      const a = todaySurfaces.get(pagePath);
      const b = tomorrowSurfaces.get(pagePath);
      const regionsToday = a.regions;
      const regionsTomorrow = b.regions;
      for (const region of new Set([...Object.keys(regionsToday), ...Object.keys(regionsTomorrow)])) {
        if (sameSet(regionsToday[region] ?? [], regionsTomorrow[region] ?? [])) continue;
        regionChurn[region] ??= { pages: 0, example: null };
        regionChurn[region].pages++;
        regionChurn[region].example ??= { path: pagePath, today: regionsToday[region], tomorrow: regionsTomorrow[region] };
      }
      for (const name of surfaceNames) {
        const same = sameSet(a[name], b[name]);
        if (!same) {
          membershipMoved[name].push(pagePath);
          const cls = pageClass(pagePath);
          byClass[name] ??= {};
          byClass[name][cls] = (byClass[name][cls] ?? 0) + 1;
          examples[name] ??= { path: pagePath, today: a[name], tomorrow: b[name] };
        } else if (!sameSequence(a[name], b[name])) {
          orderOnlyMoved[name].push(pagePath);
        }
      }
    }

    const report = {
      pages_read: paths.length,
      seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      membership_changes: Object.fromEntries(surfaceNames.map(n => [n, membershipMoved[n].length])),
      order_only_changes: Object.fromEntries(surfaceNames.map(n => [n, orderOnlyMoved[n].length])),
      by_class: byClass,
      region_churn: Object.fromEntries(
        Object.entries(regionChurn).sort((x, y) => y[1].pages - x[1].pages).map(([k, v]) => [k, v.pages]),
      ),
      region_examples: regionChurn,
      examples,
      paths: Object.fromEntries(surfaceNames.map(n => [n, membershipMoved[n]])),
    };
    const out = join(scratch, "..", "subset-churn-census.json");
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, paths: undefined, examples: undefined, region_examples: undefined }, null, 2));
    console.error(`Full report: ${out}`);
    return 0;
  } finally {
    if (today) today.proc.kill();
    if (tomorrow) tomorrow.proc.kill();
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().then(code => process.exit(code), err => { console.error(err.stack); process.exit(1); });
