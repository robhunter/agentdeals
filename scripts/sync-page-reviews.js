import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOGUE_TEXT_FIELDS, CHANGE_LOG_TEXT_FIELDS, deriveTier, parsePageReviews, pageReviewsPath,
  perturbTextFields, unresolvedBadgeSubjects, vendorFactRows, vendorsAssertedIn,
} from "../dist/page-reviews.js";
import { assertedVendorSlugs, isNonVendorSubject, namedVendorSlug, vendorSlugMap } from "../dist/vendor-slug.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `Rebuild the editorial page review registry.

Renders every page that carries hand-written prose, derives its review tier from
whether it states a verdict naming a vendor, and records which vendors that verdict
commits us to. It records separately which vendors the page puts a number beside in a
table, because a table row states a fact about a vendor whether or not a verdict does.
Review dates already on record are carried over untouched: this regenerates what is
derived, never what a reviewer asserted.

Which stores a page reads is measured rather than carried over. Each page is rendered
again against a catalogue and a change log whose text fields have been replaced, and a
byte-identical render means the page never opened that store.

A page that reads no catalogue record keeps whichever data_source it was given, and a
page new to the register defaults to "unsourced" — the state that fails the ratchet —
so a page asserting vendor facts from nowhere has to be argued for rather than slip in.

Publication dates come from the first commit in which the page's route was served,
which is an event that happened, unlike a hand-typed literal.

Usage: node scripts/sync-page-reviews.js [options]

  --out <path>    Registry to write (default ${pageReviewsPath()})
  --dry-run       Report the diff, write nothing
  --help          This text
`;

const EDITORIAL_PAGES = [
  "/agent-payments", "/agent-stack", "/ai-coding-pricing-2026", "/ai-coding-tools-pricing",
  "/analytics-free-tier-comparison-2026", "/api-development-free-tier-comparison-2026",
  "/auth-comparison-2026", "/aws-app-runner-migration", "/aws-free-tier-2026",
  "/azure-free-tier-2026", "/budget-builder", "/ci-cd-pricing",
  "/cicd-free-tier-comparison-2026", "/cloud-free-tier-comparison-2026", "/compare-tool",
  "/dall-e-shutdown", "/database-free-tier-comparison-2026", "/database-pricing",
  "/datadog-vs-new-relic", "/digitalocean-free-tier-2026", "/disclosure",
  "/email-comparison-2026",
  "/firebase-studio-shutdown", "/free-ai-stack", "/free-devops-stack", "/free-django-stack",
  "/free-fastapi-stack", "/free-frontend-stack", "/free-go-stack", "/free-nextjs-stack",
  "/free-saas-stack", "/free-startup-stack", "/free-tier-risk", "/free-tier-tracker",
  "/gcp-free-tier-2026", "/gemini-api-pricing-2026", "/gemini-api-pricing-changes",
  "/google-developer-program-2026", "/hcp-terraform-migration", "/hetzner-pricing-2026",
  "/hosting-free-tier-comparison-2026", "/hosting-pricing", "/llm-api-pricing",
  "/marketplace", "/monitoring-comparison-2026", "/neon-vs-supabase",
  "/openai-assistants-alternatives",
  "/openai-assistants-migration", "/openai-assistants-migration-2026",
  "/openai-realtime-migration", "/q1-2026-developer-pricing-report", "/q2-pricing-preview-2026",
  "/railway-vs-render", "/security-free-tier-comparison-2026",
  "/serverless-free-tier-comparison-2026", "/shutdowns", "/stack-check",
  "/stacks/ai-startup", "/stacks/api-first", "/stacks/open-source", "/stacks/saas-mvp",
  "/stacks/side-project", "/startup-credits",
  "/state-of-free-tiers", "/storage-comparison-2026", "/supabase-vs-firebase",
  "/tenor-alternatives", "/terraform-cloud-free-tier-removed",
  "/testing-free-tier-comparison-2026", "/vector-database-pricing", "/vercel-vs-netlify",
  "/x402-services",
];

function parseArgs(argv) {
  const opts = { out: pageReviewsPath(), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--dry-run") opts.dryRun = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      return { help: true, invalid: true };
    }
  }
  return opts;
}

function firstCommitHolding(literal) {
  try {
    const log = execFileSync("git", ["log", "--reverse", "-S", `"${literal}"`, "--format=%cs", "--", "src/serve.ts"], {
      cwd: REPO, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024,
    });
    const first = log.split("\n").find(l => /^\d{4}-\d{2}-\d{2}$/.test(l.trim()));
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

function routeFirstServed(route) {
  const whole = firstCommitHolding(route);
  if (whole) return whole;
  const segment = route.slice(route.lastIndexOf("/") + 1);
  return segment && segment !== route.slice(1) ? firstCommitHolding(segment) : null;
}

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(REPO, "dist", "serve.js")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_PAGE_REVIEWS_PATH: "/dev/null", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("server startup timed out")); }, 30000);
    child.stderr.on("data", (buf) => {
      const m = buf.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function writePerturbed(dir, name, key, fields) {
  const store = JSON.parse(readFileSync(join(REPO, "data", name), "utf-8"));
  const touched = perturbTextFields(store[key], fields);
  if (touched < 100) throw new Error(`only ${touched} text fields perturbed in ${name}; a readership measurement against it would prove nothing`);
  const target = join(dir, name);
  writeFileSync(target, JSON.stringify(store));
  return target;
}

async function render(port, route) {
  const res = await fetch(`http://localhost:${port}${route}`, {
    headers: { "user-agent": "agentdeals-internal/1.0 (sync-page-reviews)" },
  });
  if (res.status !== 200) throw new Error(`${route} returned ${res.status}`);
  return res.text();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(opts.invalid ? 1 : 0); }

  const existing = existsSync(opts.out) ? parsePageReviews(readFileSync(opts.out, "utf-8")) : { pages: [] };
  const byPath = new Map(existing.pages.map(p => [p.path, p]));
  const lookup = {
    slugForPhrase: namedVendorSlug,
    slugsForSubject: assertedVendorSlugs,
    nameForSlug: (slug) => vendorSlugMap.get(slug) ?? null,
  };
  const resolver = { slugsFor: assertedVendorSlugs, isNonVendor: isNonVendorSubject };

  const tmp = mkdtempSync(join(tmpdir(), "sync-page-reviews-"));
  const perturbedIndex = writePerturbed(tmp, "index.json", "offers", CATALOGUE_TEXT_FIELDS);
  const perturbedChanges = writePerturbed(tmp, "deal_changes.json", "changes", CHANGE_LOG_TEXT_FIELDS);

  const [real, blindIndex, blindChanges] = await Promise.all([
    startServer(),
    startServer({ AGENTDEALS_INDEX_PATH: perturbedIndex }),
    startServer({ AGENTDEALS_CHANGES_PATH: perturbedChanges }),
  ]);
  const pages = [];
  const changes = [];
  try {
    for (const route of [...EDITORIAL_PAGES].sort()) {
      const [html, withoutIndex, withoutChanges] = await Promise.all([
        render(real.port, route),
        render(blindIndex.port, route),
        render(blindChanges.port, route),
      ]);
      const prior = byPath.get(route);
      const published = prior?.published ?? routeFirstServed(route) ?? new Date().toISOString().slice(0, 10);
      const readsIndex = html !== withoutIndex;
      const record = {
        path: route,
        published,
        tier: deriveTier(html),
        vendors_asserted: vendorsAssertedIn(html, lookup),
        vendors_tabulated: [...new Set(vendorFactRows(html, namedVendorSlug).map(r => r.slug))].sort(),
        badge_subjects_unresolved: unresolvedBadgeSubjects(html, resolver).map(b => b.subject),
        reviewed_at: prior?.reviewed_at ?? null,
        reviewer: prior?.reviewer ?? null,
        review_outcome: prior?.review_outcome ?? null,
        review_note: prior?.review_note ?? null,
        reads_index: readsIndex,
        reads_changes: html !== withoutChanges,
        data_source: readsIndex ? "catalogue" : prior && prior.data_source !== "catalogue" ? prior.data_source : "unsourced",
        data_source_reason: prior?.data_source_reason ?? null,
      };
      if (!prior) changes.push(`+ ${route} (published ${published}, tier ${record.tier}, data_source ${record.data_source})`);
      else {
        if (prior.tier !== record.tier) changes.push(`~ ${route} tier ${prior.tier} -> ${record.tier}`);
        if (prior.reads_index !== record.reads_index) changes.push(`~ ${route} reads_index ${prior.reads_index} -> ${record.reads_index}`);
        if (prior.reads_changes !== record.reads_changes) changes.push(`~ ${route} reads_changes ${prior.reads_changes} -> ${record.reads_changes}`);
        if (prior.data_source !== record.data_source) changes.push(`~ ${route} data_source ${prior.data_source} -> ${record.data_source}`);
        const before = prior.vendors_asserted.join(","), after = record.vendors_asserted.join(",");
        if (before !== after) changes.push(`~ ${route} vendors ${prior.vendors_asserted.length} -> ${record.vendors_asserted.length}`);
        const tabulatedBefore = prior.vendors_tabulated.join(","), tabulatedAfter = record.vendors_tabulated.join(",");
        if (tabulatedBefore !== tabulatedAfter) changes.push(`~ ${route} tabulated vendors ${prior.vendors_tabulated.length} -> ${record.vendors_tabulated.length}`);
        const unresolvedBefore = prior.badge_subjects_unresolved.join(","), unresolvedAfter = record.badge_subjects_unresolved.join(",");
        if (unresolvedBefore !== unresolvedAfter) changes.push(`~ ${route} unresolved badge subjects [${unresolvedBefore}] -> [${unresolvedAfter}]`);
      }
      pages.push(record);
    }
  } finally {
    real.child.kill();
    blindIndex.child.kill();
    blindChanges.child.kill();
    rmSync(tmp, { recursive: true, force: true });
  }

  for (const stale of byPath.keys()) {
    if (!pages.some(p => p.path === stale)) changes.push(`- ${stale} (no longer an editorial page)`);
  }

  const index = { version: 1, sla_days: { A: 30, B: 90 }, pages };
  const serialized = JSON.stringify(index, null, 2) + "\n";
  const tierA = pages.filter(p => p.tier === "A").length;
  const unsourcedA = pages.filter(p => p.tier === "A" && p.data_source === "unsourced").length;
  console.log(`${pages.length} pages, ${tierA} tier A, ${pages.length - tierA} tier B`);
  console.log(`${pages.filter(p => p.reads_index).length} read the catalogue, ${pages.filter(p => p.reads_changes).length} read the change log`);
  console.log(`${unsourcedA} tier-A pages assert vendor facts and read no catalogue record`);
  for (const line of changes) console.log(line);
  if (opts.dryRun) { console.log("dry run — nothing written"); return; }
  writeFileSync(opts.out, serialized);
  console.log(`wrote ${opts.out}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
