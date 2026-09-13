import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const A_DAY_IN_MS = 86400000;
const DEMOTED_HEADING = "Demoted — and exactly why";
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_RANGE = new RegExp(`(?:${MONTHS}) \\d{1,2}\\s?[–—-]\\s?(?:(?:${MONTHS}) )?\\d{1,2}, \\d{4}`, "g");

function startServer(inventoryOut, clockShiftMs) {
  return new Promise((resolve, reject) => {
    const args = clockShiftMs ? ["--import", path.join(REPO, "scripts", "shifted-clock.mjs")] : [];
    const proc = spawn("node", [...args, path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TZ: "UTC",
        PORT: "0",
        BASE_URL: "http://localhost",
        AGENTDEALS_PAGE_INVENTORY_OUT: inventoryOut,
        AGENTDEALS_CLOCK_SHIFT_MS: String(clockShiftMs),
      },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("startup timeout")); }, 60000);
    proc.stderr.on("data", data => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve({ proc, base: `http://localhost:${match[1]}` }); }
    });
    proc.on("error", err => { clearTimeout(timeout); reject(err); });
  });
}

function decodeEntities(text) {
  return text
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&minus;/g, "−")
    .replace(/&rsaquo;/g, "›").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function headingsOf(body) {
  return [...body.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g)].map(m => ({ at: m.index, text: stripTags(m[1]) }));
}

function regionsOf(body) {
  const headings = headingsOf(body);
  const headingFor = index => {
    let current = "(above the first heading)";
    for (const heading of headings) { if (heading.at > index) break; current = heading.text; }
    return current;
  };
  const regions = new Map();
  for (const match of body.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)) {
    const region = headingFor(match.index);
    if (!regions.has(region)) regions.set(region, new Set());
    regions.get(region).add(match[1]);
  }
  return Object.fromEntries([...regions].map(([k, v]) => [k, [...v].sort()]));
}

function demotedRegion(body) {
  const headings = headingsOf(body);
  const start = headings.findIndex(h => h.text === DEMOTED_HEADING);
  if (start === -1) return null;
  const from = headings[start].at;
  const to = headings[start + 1]?.at ?? body.length;
  return body.slice(from, to);
}

function datedDemeritsByVendor(body) {
  const region = demotedRegion(body);
  if (region === null) return null;
  const links = [...region.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)];
  const boundaries = [];
  for (const link of links) {
    if (boundaries.length === 0 || boundaries[boundaries.length - 1].slug !== link[1]) {
      boundaries.push({ slug: link[1], at: link.index });
    }
  }
  const out = {};
  boundaries.forEach((boundary, i) => {
    const card = region.slice(boundary.at, boundaries[i + 1]?.at ?? region.length);
    const demerits = [...card.matchAll(/<ul class="demerit-list">([\s\S]*?)<\/ul>/g)].map(m => m[1]).join(" ");
    out[boundary.slug] = [...new Set([...demerits.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(m => m[0]))];
  });
  return out;
}

function jsonLdNodes(body) {
  const out = [];
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    out.push(node);
    for (const value of Object.values(node)) walk(value);
  };
  for (const m of body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { walk(JSON.parse(m[1])); } catch { continue; }
  }
  return out;
}

function surfacesOf(body) {
  const itemListNames = [];
  const faqAnswers = [];
  for (const node of jsonLdNodes(body)) {
    if (node["@type"] === "ItemList" && Array.isArray(node.itemListElement)) {
      for (const el of node.itemListElement) {
        const name = el?.item?.name ?? el?.name;
        if (typeof name === "string") itemListNames.push(name);
      }
    }
    if (node["@type"] === "Question" && typeof node.acceptedAnswer?.text === "string") {
      faqAnswers.push(`${node.name} :: ${node.acceptedAnswer.text}`);
    }
  }
  const meta = body.match(/<meta name="description" content="([^"]*)"/);
  const title = body.match(/<title>([\s\S]*?)<\/title>/);
  const text = stripTags(body);
  const regions = regionsOf(body);
  const stated = (meta ? decodeEntities(meta[1]) : "").match(/(\d+) offers? (?:meets?|meet) the criteria and (\d+) offers? (?:is|are) demoted/);
  const held = [...text.matchAll(/We hold (\d+) /g)].map(m => Number(m[1]));
  return {
    regions,
    title: title ? decodeEntities(title[1]) : null,
    statedCounts: stated ? { qualified: Number(stated[1]), demoted: Number(stated[2]) } : null,
    heldCounts: held,
    quickComparisonSize: (regions["Quick Comparison"] ?? []).length,
    demotedRegionSize: (regions[DEMOTED_HEADING] ?? []).length,
    vendors: [...new Set([...body.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)].map(m => m[1]))].sort(),
    demoted: datedDemeritsByVendor(body),
    metaDescription: meta ? decodeEntities(meta[1]) : null,
    itemListNames: itemListNames.sort(),
    faqAnswers: faqAnswers.sort(),
    dateRanges: [...new Set([...text.matchAll(DATE_RANGE)].map(m => m[0]))].sort(),
  };
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

const baseDays = Number(process.argv[2] ?? 0);
const scratch = mkdtempSync(path.join(tmpdir(), "census-1600-"));
const inventoryOut = path.join(scratch, "inventory.json");
const first = await startServer(inventoryOut, baseDays * A_DAY_IN_MS);
const inventory = JSON.parse(readFileSync(inventoryOut, "utf-8"));
const today = await readEveryPage(first.base, inventory);
first.proc.kill();
const ahead = await startServer(path.join(scratch, "ahead.json"), (baseDays + 1) * A_DAY_IN_MS);
const tomorrow = await readEveryPage(ahead.base, inventory);
ahead.proc.kill();

const report = {
  clockShiftDays: baseDays,
  pages: inventory.length,
  pagesWithADemotedRegion: 0,
  pagesWithADatedDemerit: 0,
  vendorSetMoved: [],
  regionMoved: [],
  dateRangeMoved: [],
  metaMoved: [],
  itemListMoved: [],
  faqMoved: [],
  titleMoved: [],
  movers: [],
  pagesStatingCounts: 0,
  countsThatDisagree: [],
};

for (const pagePath of inventory) {
  const a = today.get(pagePath);
  const b = tomorrow.get(pagePath);
  if (a.demoted !== null) {
    report.pagesWithADemotedRegion += 1;
    if (Object.values(a.demoted).some(dates => dates.length > 0)) report.pagesWithADatedDemerit += 1;
  }
  if (a.vendors.join("|") !== b.vendors.join("|")) {
    report.vendorSetMoved.push({
      path: pagePath,
      lost: a.vendors.filter(v => !b.vendors.includes(v)),
      gained: b.vendors.filter(v => !a.vendors.includes(v)),
    });
  }
  const regionOf = (surfaces, vendor) =>
    Object.entries(surfaces.regions).filter(([, vendors]) => vendors.includes(vendor)).map(([region]) => region).sort().join(" + ");
  for (const vendor of new Set([...a.vendors, ...b.vendors])) {
    const before = regionOf(a, vendor);
    const after = regionOf(b, vendor);
    if (before === after) continue;
    report.movers.push({
      path: pagePath,
      vendor,
      before,
      after,
      datedToday: a.demoted?.[vendor] ?? null,
      datedTomorrow: b.demoted?.[vendor] ?? null,
    });
  }
  const regionKeys = new Set([...Object.keys(a.regions), ...Object.keys(b.regions)]);
  for (const region of regionKeys) {
    if ((a.regions[region] ?? []).join(",") !== (b.regions[region] ?? []).join(",")) {
      report.regionMoved.push(`${pagePath} :: ${region}`);
      break;
    }
  }
  if (a.dateRanges.join("|") !== b.dateRanges.join("|")) {
    report.dateRangeMoved.push({ path: pagePath, before: a.dateRanges, after: b.dateRanges });
  }
  if (a.metaDescription !== b.metaDescription) {
    report.metaMoved.push({ path: pagePath, before: a.metaDescription, after: b.metaDescription });
  }
  if (a.itemListNames.join("|") !== b.itemListNames.join("|")) {
    report.itemListMoved.push({
      path: pagePath,
      lost: a.itemListNames.filter(n => !b.itemListNames.includes(n)),
      gained: b.itemListNames.filter(n => !a.itemListNames.includes(n)),
    });
  }
  if (a.faqAnswers.join("|") !== b.faqAnswers.join("|")) {
    report.faqMoved.push({ path: pagePath, before: a.faqAnswers.filter(x => !b.faqAnswers.includes(x)) });
  }
  if (a.title !== b.title) report.titleMoved.push({ path: pagePath, before: a.title, after: b.title });
  for (const [label, surfaces] of [["today", a], ["tomorrow", b]]) {
    if (surfaces.statedCounts === null) continue;
    if (label === "today") report.pagesStatingCounts += 1;
    const agrees = surfaces.statedCounts.qualified === surfaces.quickComparisonSize
      && surfaces.statedCounts.demoted === surfaces.demotedRegionSize
      && surfaces.heldCounts.every(n => n === surfaces.quickComparisonSize);
    if (!agrees) {
      report.countsThatDisagree.push(
        `${pagePath} (${label}): states ${JSON.stringify(surfaces.statedCounts)} and holds ${JSON.stringify(surfaces.heldCounts)}, lists ${surfaces.quickComparisonSize} qualified and ${surfaces.demotedRegionSize} demoted`,
      );
    }
  }
}

writeFileSync("/tmp/census-1600.json", JSON.stringify(report, null, 2));
const lines = [
  `both clocks shifted forward by ${baseDays} days before the overnight step`,
  `pages read on both clocks: ${report.pages}`,
  `pages carrying a demoted region: ${report.pagesWithADemotedRegion}`,
  `of those, carrying at least one dated demerit today: ${report.pagesWithADatedDemerit}`,
  `pages naming a different set of vendors tomorrow: ${report.vendorSetMoved.length}`,
  `pages naming a vendor under a different heading tomorrow: ${report.regionMoved.length}`,
  `pages printing a different date range tomorrow: ${report.dateRangeMoved.length}`,
  `pages serving a different meta description tomorrow: ${report.metaMoved.length}`,
  `pages publishing a different ItemList tomorrow: ${report.itemListMoved.length}`,
  `pages answering a question differently tomorrow: ${report.faqMoved.length}`,
  `pages whose own title is different tomorrow: ${report.titleMoved.length}`,
  ``,
  `pages stating how many offers they list: ${report.pagesStatingCounts}`,
  `of those, stating a count their own regions do not bear out: ${report.countsThatDisagree.length}`,
  ...report.countsThatDisagree.slice(0, 10).map(line => `  ${line}`),
  ``,
  `pages whose title moves:`,
  ...report.titleMoved.map(p => `  ${p.path}\n    ${p.before}\n    ${p.after}`),
  ``,
  `vendors that change heading: ${report.movers.length}`,
  ...report.movers.map(m => `  ${m.path} :: ${m.vendor} :: "${m.before}" -> "${m.after}" :: dated today ${JSON.stringify(m.datedToday)} tomorrow ${JSON.stringify(m.datedTomorrow)}`),
  ``,
  `pages whose vendor set moves:`,
  ...report.vendorSetMoved.map(p => `  ${p.path} lost ${p.lost.length} gained ${p.gained.length}`),
  ``,
  `pages whose printed date range moves:`,
  ...report.dateRangeMoved.map(p => `  ${p.path} ${JSON.stringify(p.before)} -> ${JSON.stringify(p.after)}`),
  ``,
  `pages whose meta description moves:`,
  ...report.metaMoved.map(p => `  ${p.path}\n    ${p.before}\n    ${p.after}`),
];
process.stderr.write(lines.join("\n") + "\n");
rmSync(scratch, { recursive: true, force: true });
