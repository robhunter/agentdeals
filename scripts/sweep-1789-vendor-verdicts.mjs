import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOffers } from "../dist/data.js";
import { toSlug } from "../dist/vendor-slug.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 60 * 60 * 1000;

function startServer(shiftMs) {
  return new Promise((resolve, reject) => {
    const args = shiftMs ? ["--import", path.join(REPO, "scripts", "shifted-clock.mjs")] : [];
    const proc = spawn("node", [...args, path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_CLOCK_SHIFT_MS: String(shiftMs) },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("startup timeout")); }, 120000);
    proc.stderr.on("data", (d) => {
      const m = d.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc, base: `http://localhost:${m[1]}` }); }
    });
    proc.on("exit", (c) => { clearTimeout(timeout); reject(new Error(`exited ${c}`)); });
  });
}

const decode = (s) => s
  .replace(/&mdash;/g, "—").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"')
  .replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const strip = (s) => decode(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

function verdictOf(html) {
  const badge = html.match(/<span class="risk-badge"[^>]*>([^<]*)</);
  const verdict = html.match(/<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/);
  const text = verdict ? strip(verdict[1]) : null;
  return {
    badge: badge ? strip(badge[1]) : null,
    sentence: text,
    withheld: text ? /not publishing a (?:stability )?rating/i.test(text) : false,
    lapse: /180 days/.test(strip(html)),
  };
}

async function sweep(shiftDays, slugs) {
  const { proc, base } = await startServer(shiftDays * DAY);
  const out = new Map();
  try {
    for (const slug of slugs) {
      const res = await fetch(`${base}/vendor/${slug}`);
      const html = res.ok ? await res.text() : "";
      out.set(slug, res.ok ? verdictOf(html) : { badge: null, sentence: `HTTP ${res.status}`, withheld: false, lapse: false });
    }
  } finally { proc.kill(); }
  return out;
}

const slugs = [...new Set(loadOffers().map(o => toSlug(o.vendor)))].sort();
const days = (process.argv[2] ?? "0,30").split(",").map(Number);
console.error(`sweeping ${slugs.length} vendor pages at +${days.join(" and +")}`);

const a = await sweep(days[0], slugs);
const b = await sweep(days[1], slugs);

let moved = 0, lapseStated = 0, ratedPages = 0;
const rows = [];
for (const slug of slugs) {
  const x = a.get(slug), y = b.get(slug);
  if (x.badge && x.badge !== "stable") ratedPages++;
  if (x.lapse) lapseStated++;
  if (x.badge !== y.badge || x.sentence !== y.sentence) {
    moved++;
    rows.push({ slug, kind: x.withheld && !y.withheld ? "withholding lifts" : "verdict moves", before: x, after: y });
  }
}

const dump = process.env.AGENTDEALS_SWEEP_OUT;
if (dump) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(dump, JSON.stringify(rows, null, 1));
}

console.log(`vendor pages: ${slugs.length}`);
console.log(`pages publishing a non-stable badge at +${days[0]}: ${ratedPages}`);
console.log(`pages stating the 180-day clock at +${days[0]}: ${lapseStated}`);
console.log(`pages whose verdict moves +${days[0]} -> +${days[1]}: ${moved}`);
for (const kind of ["withholding lifts", "verdict moves"]) {
  const group = rows.filter(r => r.kind === kind);
  console.log(`\n${kind}: ${group.length}`);
  for (const r of group) {
    console.log(`  /vendor/${r.slug}`);
    console.log(`    before: [${r.before.badge}] ${r.before.sentence}`);
    console.log(`    after:  [${r.after.badge}] ${r.after.sentence}`);
  }
}
