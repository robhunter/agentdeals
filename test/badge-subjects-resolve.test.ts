import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { badgedSubjects, parsePageReviews, reviewStatus, unresolvedBadgeSubjects } from "../src/page-reviews.ts";
import {
  assertedVendorSlugs, badgeAliasTargets, isNonVendorSubject, nonVendorSubjects, vendorSlugMap,
} from "../dist/vendor-slug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const REGISTRY = JSON.parse(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8"));

const RESOLVER = { slugsFor: assertedVendorSlugs, isNonVendor: isNonVendorSubject };

let serverPort = 0;
let proc: ChildProcess | null = null;
const rendered = new Map<string, string>();

function startWith(extraEnv: Record<string, string> = {}): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", ...extraEnv },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function get(routePath: string): Promise<string> {
  const res = await fetch(`http://localhost:${serverPort}${routePath}`, {
    headers: { "user-agent": "agentdeals-internal/1.0 (badge-subject-test)" },
  });
  assert.strictEqual(res.status, 200, `${routePath} returned ${res.status}`);
  return await res.text();
}

before(async () => {
  const started = await startWith();
  proc = started.child;
  serverPort = started.port;
  for (const page of REGISTRY.pages) rendered.set(page.path, await get(page.path));
});

after(() => { if (proc) proc.kill(); });

describe("#1063 an editorial badge names something we hold a record for", () => {
  it("resolves every badge subject on every editorial page", () => {
    const offenders: string[] = [];
    for (const [route, html] of rendered) {
      for (const { subject, badges } of unresolvedBadgeSubjects(html, RESOLVER)) {
        offenders.push(`${route}: "${subject}" carries ${badges.join(", ")}`);
      }
    }
    assert.deepStrictEqual(offenders, [], `badge subjects with no catalogue record:\n${offenders.join("\n")}`);
  });

  it("applies the rule to every badge on the page rather than to a handful", () => {
    let spans = 0;
    const subjects = new Set<string>();
    for (const html of rendered.values()) {
      for (const { subject, badge } of badgedSubjects(html)) {
        spans += 1;
        subjects.add(`${subject}|${badge}`);
      }
    }
    assert.ok(spans > 150, `expected the sweep to reach every badge on the site, reached ${spans}`);
    assert.ok(subjects.size > 100, `expected over 100 distinct subject and badge pairs, found ${subjects.size}`);
  });

  it("carries a subject for every badge it enumerates", () => {
    const empty: string[] = [];
    for (const [route, html] of rendered) {
      for (const { subject, badge } of badgedSubjects(html)) {
        if (!subject) empty.push(`${route}: ${badge}`);
      }
    }
    assert.deepStrictEqual(empty, [], `badges whose subject could not be read:\n${empty.join("\n")}`);
  });

  it("stores in the registry the same unresolved subjects the live pages produce", () => {
    for (const page of REGISTRY.pages) {
      const html = rendered.get(page.path)!;
      const live = unresolvedBadgeSubjects(html, RESOLVER).map(b => b.subject);
      assert.deepStrictEqual(page.badge_subjects_unresolved ?? [], live, `${page.path} registry drifted from what it renders`);
    }
  });

  it("publishes the unresolved subjects on the review report", async () => {
    const body = JSON.parse(await get("/api/page-reviews"));
    assert.ok(Array.isArray(body.totals.unresolved_badge_subjects), "totals should list unresolved badge subjects");
    assert.deepStrictEqual(body.totals.unresolved_badge_subjects, []);
    for (const page of body.pages) {
      assert.ok(Array.isArray(page.badge_subjects_unresolved), `${page.path} should report its unresolved badge subjects`);
    }
  });

  it("carries an unresolved subject through parse into the review status", () => {
    const index = parsePageReviews(JSON.stringify({
      version: 1,
      sla_days: { A: 30, B: 90 },
      pages: [{
        path: "/p", published: "2026-01-01", tier: "A", vendors_asserted: [],
        badge_subjects_unresolved: ["A Product Nobody Sells"], reviewed_at: null, reviewer: null,
      }],
    }));
    assert.deepStrictEqual(index.pages[0].badge_subjects_unresolved, ["A Product Nobody Sells"]);
    assert.deepStrictEqual(reviewStatus(index.pages[0], "2026-08-27").badge_subjects_unresolved, ["A Product Nobody Sells"]);
  });

  it("reports an unresolved subject on the review report when the registry holds one", async () => {
    const fixture = path.join(REPO, "test", "tmp-badge-registry.json");
    writeFileSync(fixture, JSON.stringify({
      version: 1,
      sla_days: { A: 30, B: 90 },
      pages: [{
        path: "/free-tier-tracker", published: "2026-01-01", tier: "A", vendors_asserted: [],
        badge_subjects_unresolved: ["A Product Nobody Sells"], reviewed_at: null, reviewer: null,
      }],
    }));
    const { child, port } = await startWith({ AGENTDEALS_PAGE_REVIEWS_PATH: fixture });
    try {
      const res = await fetch(`http://localhost:${port}/api/page-reviews`);
      const body = await res.json();
      assert.deepStrictEqual(body.totals.unresolved_badge_subjects, ["A Product Nobody Sells"]);
      assert.deepStrictEqual(body.pages[0].badge_subjects_unresolved, ["A Product Nobody Sells"]);
    } finally {
      child.kill();
      rmSync(fixture, { force: true });
    }
  });

  it("finds no badge on the generated page families the editorial sweep does not cover", async () => {
    const prefixes = ["/vendor/", "/alternative-to/", "/category/", "/compare/", "/best/"];
    const registered = new Set(REGISTRY.pages.map((p: { path: string }) => p.path));
    const index = await get("/sitemap.xml");
    const maps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].replace(/^https?:\/\/[^/]+/, ""));
    const routes = new Set<string>();
    for (const map of maps) {
      const body = await get(map);
      for (const loc of body.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        routes.add(loc[1].replace(/^https?:\/\/[^/]+/, "") || "/");
      }
    }
    let sampled = 0;
    for (const prefix of prefixes) {
      const sample = [...routes].find(r => r.startsWith(prefix) && !registered.has(r));
      if (!sample) continue;
      sampled += 1;
      const html = await get(sample);
      assert.deepStrictEqual(
        badgedSubjects(html).map(b => b.badge), [],
        `${sample} renders a badge, so ${prefix} needs to be in the editorial sweep`,
      );
    }
    assert.ok(sampled >= 4, `expected to sample at least four generated families, sampled ${sampled}`);
  });
});

describe("#1063 reading the subject a badge is attached to", () => {
  it("reads the name written before the badge", () => {
    const html = '<td class="provider-col">Storj<span class="winner-badge">MOST STORAGE</span></td>';
    assert.deepStrictEqual(badgedSubjects(html), [{ subject: "Storj", badge: "MOST STORAGE", linkedSlug: null }]);
  });

  it("reads the linked name written after the badge", () => {
    const html = '<div class="pick-header"><span class="pick-badge">Recommended</span>'
      + '<a href="/vendor/resend" class="pick-name">Resend</a></div>';
    assert.deepStrictEqual(badgedSubjects(html), [{ subject: "Resend", badge: "Recommended", linkedSlug: "resend" }]);
  });

  it("reads an unlinked name written after the badge", () => {
    const html = '<div class="pick-header"><span class="pick-badge">Recommended</span>'
      + '<span class="pick-name">Django Built-in Auth</span></div>';
    assert.deepStrictEqual(badgedSubjects(html), [{ subject: "Django Built-in Auth", badge: "Recommended", linkedSlug: null }]);
  });

  it("reports a badge subject no record answers for", () => {
    const html = '<td class="provider-col">A Product Nobody Sells<span class="winner-badge">BEST OF ALL</span></td>';
    assert.deepStrictEqual(unresolvedBadgeSubjects(html, RESOLVER), [{ subject: "A Product Nobody Sells", badges: ["BEST OF ALL"] }]);
  });

  it("reports a badge attached to nothing at all", () => {
    const html = '<div><span class="winner-badge">BEST OF ALL</span></div>';
    assert.deepStrictEqual(unresolvedBadgeSubjects(html, RESOLVER), [{ subject: "", badges: ["BEST OF ALL"] }]);
  });

  it("passes a badge whose subject is linked to a record", () => {
    const html = '<h3><a href="/vendor/storj">Storj</a> <span class="winner-badge">MOST STORAGE</span></h3>';
    assert.deepStrictEqual(unresolvedBadgeSubjects(html, RESOLVER), []);
  });

  it("prefers the linked name before the badge over the text before it", () => {
    const html = '<h3><a href="/vendor/neon">Neon</a> <span class="winner-badge">BEST POSTGRES</span></h3>';
    assert.deepStrictEqual(badgedSubjects(html), [{ subject: "Neon", badge: "BEST POSTGRES", linkedSlug: "neon" }]);
  });
});

describe("#1063 which records an editorial subject commits us to", () => {
  it("resolves a name we hold under a different one", () => {
    assert.deepStrictEqual(assertedVendorSlugs("GCP"), ["google-cloud"]);
    assert.deepStrictEqual(assertedVendorSlugs("Appwrite Auth"), ["appwrite-cloud"]);
  });

  it("resolves a name carrying a trailing qualifier to the name itself", () => {
    assert.deepStrictEqual(assertedVendorSlugs("Tigris (Fly.io)"), ["tigris"]);
    assert.deepStrictEqual(assertedVendorSlugs("Brevo (formerly Sendinblue)"), ["brevo"]);
  });

  it("resolves a compound subject to every part it names", () => {
    assert.deepStrictEqual(assertedVendorSlugs("Prometheus + Grafana").sort(), ["grafana", "prometheus"]);
  });

  it("refuses a compound subject when one part has no record", () => {
    assert.deepStrictEqual(assertedVendorSlugs("Prometheus + Nothing We Track"), []);
  });

  it("refuses a name no record answers for", () => {
    assert.deepStrictEqual(assertedVendorSlugs("A Product Nobody Sells"), []);
  });

  it("points every alias at a record that exists", () => {
    for (const target of badgeAliasTargets()) {
      assert.ok(vendorSlugMap.has(target), `alias target ${target} is not in the catalogue`);
    }
  });

  it("exempts only subjects no record could answer for", () => {
    for (const subject of nonVendorSubjects()) {
      assert.deepStrictEqual(
        assertedVendorSlugs(subject), [],
        `${subject} is exempted from the badge rule but resolves to a record, so the exemption hides it`,
      );
    }
  });

  it("keeps every exemption in use on a page", () => {
    const onPages = new Set<string>();
    for (const html of rendered.values()) {
      for (const { subject } of badgedSubjects(html)) onPages.add(subject);
    }
    for (const subject of nonVendorSubjects()) {
      assert.ok(onPages.has(subject), `${subject} is exempted from the badge rule but no page badges it`);
    }
  });
});

function comparisonRow(html: string, subject: string): string[] {
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  const row = rows.find(r => new RegExp(`<td class="provider-col">${subject}<`).test(r));
  assert.ok(row, `no comparison-table row for ${subject}`);
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1].replace(/<[^>]*>/g, "").trim());
}

function offerCard(html: string, subject: string): string {
  const cards = html.match(/<div class="diff-card">[\s\S]*?<\/div>\s*<\/div>/g) ?? [];
  const card = cards.find(c => new RegExp(`<h3>${subject}[ <]`).test(c));
  assert.ok(card, `no offer card for ${subject}`);
  return card;
}

const PRESENT_TENSE_ALLOWANCE = (subject: string) =>
  new RegExp(`${subject}(?:'s)?\\s+(?:offers?|gives?|provides?|has|includes?)\\s+(?!no\\b|not\\b|never\\b)[^.]*\\bfree\\b`, "i");

describe("#1063 the two verdicts checked against the vendor's own pricing page", () => {
  it("states no free sending allowance for Amazon SES", () => {
    const html = rendered.get("/email-comparison-2026")!;
    const cells = comparisonRow(html, "Amazon SES");
    assert.match(cells[2], /^None\b/, `the free-per-month cell reads "${cells[2]}"`);
    const card = offerCard(html, "Amazon SES");
    assert.match(card, /<strong>Free tier:<\/strong>\s*none\b/i, "the offer card should open by saying there is no free tier");
    assert.doesNotMatch(card, /\b62,000 emails\/month when sent\b/, "the card presents the withdrawn allowance as current");
    assert.doesNotMatch(html, PRESENT_TENSE_ALLOWANCE("SES"), "a sentence still says SES gives something free");
    assert.doesNotMatch(html, /SES[^.]*highest free volume/i, "SES is still credited with the highest free volume");
    assert.deepStrictEqual(badgedSubjects(html).filter(b => b.subject === "Amazon SES"), [], "Amazon SES still carries a badge");
  });

  it("describes the Storj allowance as the trial it is", () => {
    const html = rendered.get("/storage-comparison-2026")!;
    const cells = comparisonRow(html, "Storj");
    assert.match(cells[2], /30 days/, `the free-storage cell reads "${cells[2]}"`);
    const card = offerCard(html, "Storj");
    assert.match(card, /<strong>Free trial:<\/strong>/, "the offer card should present a trial rather than a free tier");
    assert.match(card, /no permanent free tier/i, "the card should say the free tier is not permanent");
    assert.doesNotMatch(html, /most generous free tier/i, "Storj is still called the most generous free tier");
    assert.doesNotMatch(html, /this much capacity at zero cost/i, "the zero-cost claim survives");
    assert.match(cells[6], /^\s*$|✗|&#10007;|\u2717/, `the permanent-free cell reads "${cells[6]}" for an offer that expires`);
    assert.deepStrictEqual(badgedSubjects(html).filter(b => b.subject === "Storj"), [], "Storj still carries a badge");
  });

  it("names one vendor for the monitoring page's overall verdict", () => {
    const html = rendered.get("/monitoring-comparison-2026")!;
    const card = html.match(/<div class="stat-number green">([\s\S]*?)<\/div><div class="stat-label">Best Overall Free Tier<\/div>/);
    assert.ok(card, "the Best Overall Free Tier stat card is missing");
    const cardSlug = card[1].match(/href="\/vendor\/([a-z0-9-]+)"/)?.[1] ?? null;
    assert.ok(cardSlug, `the stat card names "${card[1].replace(/<[^>]*>/g, "")}", which resolves to no record`);
    const badged = badgedSubjects(html).find(b => b.badge === "BEST OVERALL");
    assert.ok(badged, "no BEST OVERALL badge on the monitoring page");
    const badgeSlugs = badged.linkedSlug ? [badged.linkedSlug] : assertedVendorSlugs(badged.subject);
    assert.deepStrictEqual(
      badgeSlugs, [cardSlug],
      `the stat card credits ${cardSlug} and the badge credits ${badgeSlugs.join(", ")} for the same verdict`,
    );
  });

  it("holds a record and a change entry for both", () => {
    const offers = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
    const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
    for (const vendor of ["Amazon SES", "Storj"]) {
      assert.ok(offers.some((o: { vendor: string }) => o.vendor === vendor), `${vendor} has no catalogue record`);
      assert.ok(
        changes.some((c: { vendor: string; change_type: string }) => c.vendor === vendor && c.change_type === "free_tier_removed"),
        `${vendor} lost a free tier with nothing in the change log`,
      );
    }
  });
});
