import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const { loadOffers, loadDealChanges, changesByVendor } = await import(path.join(REPO, "dist", "data.js"));
const { loadChangeRefusals } = await import(path.join(REPO, "dist", "data.js"));
const { vendorVerdictContextFrom } = await import(path.join(REPO, "dist", "vendor-verdict-input.js"));
const { whyWeCannotConfirmTheseTerms } = await import(path.join(REPO, "dist", "vendor-verdict.js"));
const { loadVerificationState } = await import(path.join(REPO, "dist", "verification-state.js"));
const { toSlug } = await import(path.join(REPO, "dist", "slug.js"));

const out = (line) => writeSync(2, `${line}\n`);

const servedOn = new Date().toISOString().slice(0, 10);
const offers = loadOffers();
const changes = changesByVendor();
const refusals = loadChangeRefusals();
const refusalsByVendor = new Map();
for (const refusal of refusals) {
  const key = refusal.vendor.toLowerCase();
  if (!refusalsByVendor.has(key)) refusalsByVendor.set(key, []);
  refusalsByVendor.get(key).push(refusal);
}

function caveatFor(offer) {
  const context = vendorVerdictContextFrom({
    vendor: offer.vendor,
    vendorOffers: [offer],
    vendorChanges: changes.get(offer.vendor) ?? [],
    refusedReads: refusalsByVendor.get(offer.vendor.toLowerCase()) ?? [],
    servedOn,
  });
  return context ? whyWeCannotConfirmTheseTerms(context.input) : null;
}

const byOutcome = new Map();
const caveated = new Map();
const withCaveat = [];
for (const offer of offers) {
  const outcome = offer.source_check?.outcome ?? "(none)";
  byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
  const caveat = caveatFor(offer);
  if (!caveat) continue;
  withCaveat.push({ offer, caveat });
  caveated.set(caveat.because.reason, (caveated.get(caveat.because.reason) ?? 0) + 1);
}

out(`offers: ${offers.length}`);
out(`source_check.outcome:`);
for (const [outcome, n] of [...byOutcome].sort((a, b) => b[1] - a[1])) out(`  ${outcome}: ${n}`);
out(`offers where whyWeCannotConfirmTheseTerms returns a caveat: ${withCaveat.length}`);
for (const [reason, n] of [...caveated].sort((a, b) => b[1] - a[1])) out(`  ${reason}: ${n}`);
const freePlanStanding = withCaveat.filter(w => w.caveat.theReadFoundAFreePlan).length;
out(`  of those, the read left the free plan standing: ${freePlanStanding}`);

const slugOfVendor = new Map();
for (const offer of offers) slugOfVendor.set(toSlug(offer.vendor), offer.vendor);
const caveatBySlug = new Map();
for (const { offer, caveat } of withCaveat) {
  const slug = toSlug(offer.vendor);
  if (!caveatBySlug.has(slug)) caveatBySlug.set(slug, caveat);
}

const state = loadVerificationState();
let attemptAfterVerified = 0;
let attemptAfterVerifiedNotRead = 0;
const READ_THE_PAGE = new Set(["confirmed", "changed", "link_ok", "states_no_price"]);
for (const { offer } of withCaveat) {
  const record = state.get(`${offer.vendor}|${offer.url}`);
  if (!record?.last_attempt_at) continue;
  if (record.last_attempt_at <= offer.verifiedDate) continue;
  attemptAfterVerified += 1;
  if (!READ_THE_PAGE.has(record.last_outcome ?? "")) attemptAfterVerifiedNotRead += 1;
}
out(`caveated offers with a read attempt later than verifiedDate: ${attemptAfterVerified}`);
out(`  of those, the attempt did not read the page (invisible in Read / verified today): ${attemptAfterVerifiedNotRead}`);

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TZ: "UTC", PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("startup timeout")); }, 90000);
    proc.stderr.on("data", data => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve({ proc, base: `http://localhost:${match[1]}` }); }
    });
    proc.on("error", err => { clearTimeout(timeout); reject(err); });
  });
}

const { proc, base } = await startServer();
try {
  const locsOf = (xml) =>
    [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => new URL(m[1]).pathname);
  const index = locsOf(await (await fetch(`${base}/sitemap.xml`, { redirect: "manual" })).text());
  const paths = [];
  for (const child of index) {
    if (!child.startsWith("/sitemap")) { paths.push(child); continue; }
    paths.push(...locsOf(await (await fetch(`${base}${child}`, { redirect: "manual" })).text()));
  }
  const ranked = paths.filter(p => p.startsWith("/best/") || p.startsWith("/category/"));
  out(`ranked pages on the sitemap: ${ranked.length}`);

  const CLAUSE_MARKERS = [
    "the page we cite for this offer",
    "we could not read the page we cite",
    "states no amount, tier or rate we can read",
    "does not name it",
    "we cannot confirm these terms",
    "treat them as unverified",
    "we refused the change we last considered recording",
    "found a change we could not reconcile",
  ];

  let assertions = 0;
  const pagesNaming = new Set();
  const pagesWithAnyCaveat = new Set();
  let caveatSentences = 0;
  const emDashCells = [];

  for (const route of ranked) {
    const res = await fetch(`${base}${route}`, { redirect: "manual" });
    if (res.status !== 200) { out(`  ${route} -> ${res.status}`); continue; }
    const body = await res.text();
    const named = new Set([...body.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)].map(m => m[1]));
    let namedCaveated = 0;
    for (const slug of named) if (caveatBySlug.has(slug)) namedCaveated += 1;
    if (namedCaveated > 0) { pagesNaming.add(route); assertions += namedCaveated; }
    const lower = body.toLowerCase();
    const hits = CLAUSE_MARKERS.filter(m => lower.includes(m)).length;
    if (hits > 0) { pagesWithAnyCaveat.add(route); caveatSentences += hits; }
    for (const cell of body.matchAll(/<td>(?:<span[^>]*>)?&mdash;(?:<\/span>)?<\/td>/g)) emDashCells.push(route);
  }

  out(`ranked pages naming at least one caveated offer: ${pagesNaming.size} of ${ranked.length}`);
  out(`(page, vendor) assertions standing over a caveated record: ${assertions}`);
  out(`ranked pages carrying any caveat-shaped clause: ${pagesWithAnyCaveat.size}`);
  out(`caveat clause markers matched, total: ${caveatSentences}`);
  out(`Quick Comparison cells rendering a bare em-dash: ${emDashCells.length}`);
} finally {
  proc.kill();
}
