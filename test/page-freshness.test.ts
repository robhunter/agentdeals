import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compiledNotice, dataProvenanceFor, daysBetween, deriveTier, freshnessSegmentFor, indexCitation,
  linkifyVerdictBlocks, overdueReport,
  parsePageReviews, reviewStatus, verdictBlocks, vendorsAssertedIn, verdictsOutdatedBy,
  SLA_DAYS, EXPIRY_MULTIPLE, type PageReviewRecord,
} from "../src/page-reviews.ts";
import { namedVendorSlug } from "../dist/vendor-slug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const REGISTRY = JSON.parse(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8"));

let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function get(routePath: string): Promise<string> {
  const res = await fetch(`http://localhost:${serverPort}${routePath}`);
  assert.strictEqual(res.status, 200, `${routePath} returned ${res.status}`);
  return await res.text();
}

function jsonLdOf(html: string): any {
  const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  return block ? JSON.parse(block[1]) : null;
}

function record(over: Partial<PageReviewRecord> = {}): PageReviewRecord {
  return { path: "/p", published: "2026-01-01", tier: "A", vendors_asserted: [], badge_subjects_unresolved: [], reviewed_at: null, reviewer: null, ...over };
}

before(async () => { proc = await startServer(); });
after(() => { if (proc) proc.kill(); });

describe("#1061 review state is derived from a stored date, never from the clock", () => {
  it("counts days between two dates", () => {
    assert.strictEqual(daysBetween("2026-01-01", "2026-01-31"), 30);
    assert.strictEqual(daysBetween("2026-03-01", "2026-03-01"), 0);
    assert.strictEqual(daysBetween("2026-02-27", "2026-03-01"), 2);
  });

  it("calls a page with no review date never_reviewed however recently it was published", () => {
    const status = reviewStatus(record({ published: "2026-08-26" }), "2026-08-26");
    assert.strictEqual(status.state, "never_reviewed");
    assert.strictEqual(status.days_since, 0);
  });

  it("runs the never-reviewed clock from publication, so an old unread page reports as overdue", () => {
    const status = reviewStatus(record({ published: "2026-03-31" }), "2026-08-26");
    assert.strictEqual(status.clock_starts, "2026-03-31");
    assert.strictEqual(status.days_since, 148);
    assert.strictEqual(status.days_overdue, 148 - SLA_DAYS.A);
  });

  it("moves from current to overdue to expired at the tier's own boundaries", () => {
    const reviewed = (days: number) => reviewStatus(record({ tier: "A", reviewed_at: "2026-01-01" }), addDays("2026-01-01", days)).state;
    assert.strictEqual(reviewed(SLA_DAYS.A), "current");
    assert.strictEqual(reviewed(SLA_DAYS.A + 1), "overdue");
    assert.strictEqual(reviewed(SLA_DAYS.A * EXPIRY_MULTIPLE), "overdue");
    assert.strictEqual(reviewed(SLA_DAYS.A * EXPIRY_MULTIPLE + 1), "expired");
  });

  it("gives tier B three times the window tier A gets", () => {
    assert.strictEqual(SLA_DAYS.B, SLA_DAYS.A * 3);
    assert.strictEqual(reviewStatus(record({ tier: "B", reviewed_at: "2026-01-01" }), addDays("2026-01-01", 89)).state, "current");
    assert.strictEqual(reviewStatus(record({ tier: "A", reviewed_at: "2026-01-01" }), addDays("2026-01-01", 89)).state, "expired");
  });
});

describe("#1061 what the freshness line is allowed to say", () => {
  it("says a page was not reviewed rather than printing a date", () => {
    assert.strictEqual(freshnessSegmentFor(record(), "2026-08-26"), " &middot; Not yet reviewed");
  });

  it("prints the review date while the review still stands", () => {
    assert.strictEqual(freshnessSegmentFor(record({ reviewed_at: "2026-08-20" }), "2026-08-26"), " &middot; Reviewed 2026-08-20");
  });

  it("falls silent rather than print a review date nobody stands behind any more", () => {
    const expired = record({ tier: "A", reviewed_at: "2026-01-01" });
    assert.strictEqual(reviewStatus(expired, "2026-06-01").state, "expired");
    assert.strictEqual(freshnessSegmentFor(expired, "2026-06-01"), "");
  });

  it("says nothing at all about a page it holds no record for", () => {
    assert.strictEqual(freshnessSegmentFor(null, "2026-08-26"), "");
  });

  it("refuses to publish a review date that has not happened yet", () => {
    const ahead = record({ published: "2026-04-01", reviewed_at: "2027-08-26" });
    assert.strictEqual(reviewStatus(ahead, "2026-08-26").state, "never_reviewed");
    assert.strictEqual(reviewStatus(ahead, "2026-08-26").reviewed_at, null);
    assert.strictEqual(freshnessSegmentFor(ahead, "2026-08-26"), " &middot; Not yet reviewed");
  });
});

describe("#1061 the registry survives a file it cannot trust", () => {
  it("returns an empty register rather than throwing on unparseable content", () => {
    assert.deepStrictEqual(parsePageReviews("not json at all").pages, []);
    assert.deepStrictEqual(parsePageReviews("{}").pages, []);
  });

  it("drops a record whose published date is not a real date", () => {
    const parsed = parsePageReviews(JSON.stringify({ pages: [
      { path: "/a", published: "2026-02-30", tier: "A" },
      { path: "/b", published: "not-a-date", tier: "A" },
      { path: "/c", published: "2026-04-01", tier: "A" },
    ] }));
    assert.deepStrictEqual(parsed.pages.map(p => p.path), ["/c"]);
  });

  it("refuses a review date that is not a real date rather than rendering it", () => {
    const parsed = parsePageReviews(JSON.stringify({ pages: [
      { path: "/a", published: "2026-04-01", tier: "A", reviewed_at: "yesterday" },
    ] }));
    assert.strictEqual(parsed.pages[0].reviewed_at, null);
  });
});

describe("#1061 a phrase only names a vendor when one slug prefixes the other", () => {
  it("resolves an exact vendor name", () => {
    assert.strictEqual(namedVendorSlug("Supabase"), "supabase");
  });

  it("resolves a name our record spells with a domain suffix", () => {
    assert.strictEqual(namedVendorSlug("Mailtrap"), "mailtrap-io");
  });

  it("resolves a product tier to the vendor that sells it", () => {
    assert.strictEqual(namedVendorSlug("Supabase Pro"), "supabase");
  });

  it("refuses to read a vendor out of the middle of an editorial label", () => {
    assert.strictEqual(namedVendorSlug("Highest Free Volume (SES from EC2)"), null);
  });

  it("refuses a phrase naming more than one subject", () => {
    assert.strictEqual(namedVendorSlug("Prometheus + Grafana"), null);
  });

  it("still resolves a vendor whose own name contains a conjunction", () => {
    assert.strictEqual(namedVendorSlug("Weights & Biases"), "weights-biases");
  });
});

describe("#1061 vendor names in a verdict resolve to the vendor page", () => {
  const slugFor = (name: string) => ({ Supabase: "supabase", Neon: "neon" } as Record<string, string>)[name] ?? null;

  it("links a stat card whose number is a vendor name", () => {
    const html = '<div class="summary-stats"><div class="stat-card"><div class="stat-number green">Neon</div><div class="stat-label">Best Pure Postgres</div></div></div>';
    assert.ok(linkifyVerdictBlocks(html, slugFor).includes('<div class="stat-number green"><a href="/vendor/neon">Neon</a></div>'));
  });

  it("leaves the label describing the win alone", () => {
    const html = '<div class="summary-stats"><div class="stat-card"><div class="stat-number">44</div><div class="stat-label">Neon</div></div></div>';
    assert.ok(!linkifyVerdictBlocks(html, slugFor).includes('class="stat-label"><a'));
  });

  it("links an emphasised vendor inside the verdict prose", () => {
    const html = '<div class="executive-summary"><p><strong>Quick verdict:</strong> <strong>Supabase</strong> wins.</p></div>';
    const out = linkifyVerdictBlocks(html, slugFor);
    assert.ok(out.includes('<strong><a href="/vendor/supabase">Supabase</a></strong>'));
    assert.ok(out.includes("<strong>Quick verdict:</strong>"), "a label ending in a colon is not a vendor name");
  });

  it("does not nest a second anchor inside a link the page already made", () => {
    const html = '<div class="executive-summary"><p><strong><a href="/vendor/supabase">Supabase</a></strong> wins.</p></div>';
    assert.strictEqual(linkifyVerdictBlocks(html, slugFor), html);
  });

  it("leaves a name with no matching record as text", () => {
    const html = '<div class="summary-stats"><div class="stat-number">Wombat DB</div></div>';
    assert.strictEqual(linkifyVerdictBlocks(html, slugFor), html);
  });

  it("touches nothing outside a verdict block", () => {
    const html = '<table><tr><td><strong>Supabase</strong></td></tr></table>';
    assert.strictEqual(linkifyVerdictBlocks(html, slugFor), html);
  });

  it("rewrites the element text and not a matching attribute value", () => {
    const html = '<div class="summary-stats"><div class="stat-number" title="Neon">Neon</div></div>';
    const out = linkifyVerdictBlocks(html, slugFor);
    assert.ok(out.includes('title="Neon"><a href="/vendor/neon">Neon</a></div>'), out);
    assert.ok(!out.includes('title="<a'), `the attribute was rewritten instead of the text: ${out}`);
  });
});

describe("#1061 which pages carry a verdict", () => {
  it("reads a vendor out of a winner badge row", () => {
    const html = '<h3>Mailtrap <span class="winner-badge">BEST TESTING</span></h3>';
    assert.deepStrictEqual(vendorsAssertedIn(html, { slugForPhrase: n => (n === "Mailtrap" ? "mailtrap-io" : null), slugsForSubject: n => (n === "Mailtrap" ? ["mailtrap-io"] : []), nameForSlug: () => null }), ["mailtrap-io"]);
  });

  it("counts a vendor the verdict block links directly", () => {
    const html = '<div class="verdict-box"><p><a href="/vendor/supabase">Supabase</a> wins.</p></div>';
    assert.deepStrictEqual(vendorsAssertedIn(html, { slugForPhrase: () => null, slugsForSubject: () => [], nameForSlug: () => null }), ["supabase"]);
  });

  it("counts a vendor named in verdict prose when the page links it elsewhere", () => {
    const html = '<div class="executive-summary"><p>Hetzner is raising prices across every line.</p></div>'
      + '<table><tr><td><a href="/vendor/hetzner">Hetzner</a></td></tr></table>';
    const lookup = { slugForPhrase: () => null, slugsForSubject: () => [], nameForSlug: (s: string) => (s === "hetzner" ? "Hetzner" : null) };
    assert.deepStrictEqual(vendorsAssertedIn(html, lookup), ["hetzner"]);
  });

  it("calls a page with no verdict block tier B", () => {
    assert.strictEqual(deriveTier("<p>Just prose about pricing.</p>"), "B");
    assert.strictEqual(deriveTier('<div class="verdict-box"><p>Pick this one.</p></div>'), "A");
  });

  it("closes a verdict block at its own closing tag, not the first one it meets", () => {
    const html = '<div class="executive-summary"><div><p>inner</p></div><p>outer</p></div><div>after</div>';
    const blocks = verdictBlocks(html);
    assert.strictEqual(blocks.length, 1);
    assert.ok(blocks[0].endsWith("<p>outer</p></div>"), blocks[0]);
    assert.ok(!blocks[0].includes("after"));
  });
});

describe("#1061 a verdict whose subject moved since the page was read", () => {
  it("names the vendor whose terms changed after the review", () => {
    const status = reviewStatus(record({ vendors_asserted: ["maileroo", "resend"], reviewed_at: "2026-04-03" }), "2026-08-26");
    const changed = new Map([["maileroo", "2026-04-12"], ["resend", "2026-03-01"]]);
    assert.deepStrictEqual(verdictsOutdatedBy(status, s => changed.get(s) ?? null), [{ slug: "maileroo", changed: "2026-04-12" }]);
  });

  it("says nothing when every named vendor's record predates the review", () => {
    const status = reviewStatus(record({ vendors_asserted: ["resend"], reviewed_at: "2026-08-26" }), "2026-08-26");
    assert.deepStrictEqual(verdictsOutdatedBy(status, () => "2026-04-12"), []);
  });
});

describe("#1061 the overdue report", () => {
  it("sorts by how far past its own SLA each page is", () => {
    const report = overdueReport("2026-08-26", { version: 1, sla_days: SLA_DAYS, pages: [
      record({ path: "/recent", published: "2026-08-01" }),
      record({ path: "/ancient", published: "2026-01-01" }),
    ] });
    assert.deepStrictEqual(report.pages.map(p => p.path), ["/ancient", "/recent"]);
    assert.strictEqual(report.totals.never_reviewed, 2);
  });
});

describe("#1061 no page tells a reader or a crawler that it changed today", () => {
  it("has pages on the register to make this assertion about", () => {
    assert.ok(REGISTRY.pages.length >= 60, `register holds ${REGISTRY.pages.length} pages`);
  });

  it("never renders today's date as a page's own dateModified", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const offenders: string[] = [];
    let checked = 0;
    for (const page of REGISTRY.pages) {
      const jsonLd = jsonLdOf(await get(page.path));
      if (!jsonLd?.dateModified) continue;
      checked++;
      if (jsonLd.dateModified === today && page.reviewed_at !== today) offenders.push(page.path);
    }
    assert.ok(checked >= 55, `only ${checked} of ${REGISTRY.pages.length} pages published a dateModified`);
    assert.deepStrictEqual(offenders, []);
  });

  it("never renders a date later than today as its own", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const offenders: string[] = [];
    for (const page of REGISTRY.pages) {
      const html = await get(page.path);
      const line = html.match(/<p class="pub-date">([\s\S]*?)<\/p>|<div class="pub-date">([\s\S]*?)<\/div>/);
      const rendered = [line?.[1] ?? line?.[2] ?? "", JSON.stringify(jsonLdOf(html) ?? {})].join(" ");
      for (const m of rendered.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
        if (m[0] > today) offenders.push(`${page.path}: ${m[0]}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("never renders a Last updated line", async () => {
    const offenders: string[] = [];
    for (const page of REGISTRY.pages) {
      const html = await get(page.path);
      if (/Last updated|&middot; Updated /.test(html)) offenders.push(page.path);
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("publishes the same publication date to a reader and to a crawler", async () => {
    const drift: string[] = [];
    for (const page of REGISTRY.pages) {
      const html = await get(page.path);
      const jsonLd = jsonLdOf(html);
      if (jsonLd?.datePublished && jsonLd.datePublished !== page.published) {
        drift.push(`${page.path}: register ${page.published}, page ${jsonLd.datePublished}`);
      }
    }
    assert.deepStrictEqual(drift, []);
  });

  it("keeps the stored tier equal to the tier the page's own markup implies", async () => {
    const drift: string[] = [];
    for (const page of REGISTRY.pages) {
      const derived = deriveTier(await get(page.path));
      if (derived !== page.tier) drift.push(`${page.path}: stored ${page.tier}, derived ${derived}`);
    }
    assert.deepStrictEqual(drift, [], "run scripts/sync-page-reviews.js");
  });
});

describe("#1061 a date in the body does not outrun the date in the header", () => {
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const UPDATE_CLAIM = /(?:Last updated|Updated)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2},\s*)?(20\d\d)/g;

  it("recognises an update claim written in prose", () => {
    const found = [...".. Updated April 2, 2026 ..".matchAll(UPDATE_CLAIM)];
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0][1], "April");
  });

  it("never states an update month later than the page's own last real event", async () => {
    const contradictions: string[] = [];
    for (const page of REGISTRY.pages) {
      const html = await get(page.path);
      const anchor = (page.reviewed_at ?? page.published).slice(0, 7);
      for (const m of html.matchAll(UPDATE_CLAIM)) {
        const claimed = `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}`;
        if (claimed > anchor) contradictions.push(`${page.path}: body says "${m[0]}", header says ${anchor}`);
      }
    }
    assert.deepStrictEqual([...new Set(contradictions)], []);
  });
});

describe("#1061 what a reader sees instead", () => {
  it("tells a reader a page has never been reviewed", async () => {
    const html = await get("/database-free-tier-comparison-2026");
    assert.match(html, /Published 2026-03-31 &middot; Not yet reviewed/);
  });

  it("dates a page by its review once one is on record", async () => {
    const reviewed = REGISTRY.pages.find((p: any) => p.reviewed_at !== null);
    assert.ok(reviewed, "at least one page must carry a review for this assertion to have a subject");
    const html = await get(reviewed.path);
    assert.ok(html.includes(`Reviewed ${reviewed.reviewed_at}`), `${reviewed.path} does not render its review date`);
    assert.strictEqual(jsonLdOf(html)?.dateModified, reviewed.reviewed_at);
  });

  it("resolves the vendors its headline names to their vendor pages", async () => {
    const html = await get("/database-free-tier-comparison-2026");
    const stats = html.match(/<div class="summary-stats">[\s\S]*?<div class="executive-summary">/);
    assert.ok(stats, "the page must carry a summary-stats block followed by an executive summary");
    assert.ok(stats[0].includes('<a href="/vendor/supabase">Supabase</a>'), "the headline stat card does not link Supabase");
    assert.ok(stats[0].includes('<a href="/vendor/neon">Neon</a>'), "the headline stat card does not link Neon");
    const verdict = html.match(/<div class="executive-summary">[\s\S]*?<\/div>/);
    assert.ok(verdict, "the page must carry an executive summary");
    assert.ok(verdict[0].includes('<strong><a href="/vendor/supabase">Supabase</a></strong>'), "the quick verdict does not link Supabase");
  });

  it("links a verdict vendor on every page whose verdict names one", async () => {
    const linked: string[] = [];
    for (const page of REGISTRY.pages) {
      if (page.vendors_asserted.length === 0) continue;
      const html = await get(page.path);
      const blocks = html.split(/(?=<div class="(?:summary-stats|executive-summary)")/).slice(1);
      if (blocks.some((b: string) => /<a href="\/vendor\//.test(b.slice(0, 4000)))) linked.push(page.path);
    }
    assert.ok(linked.length >= 30, `only ${linked.length} pages carry a vendor link inside a verdict block`);
  });

  it("dates a generated page by the records it renders, and labels it as such", async () => {
    const html = await get("/category/databases");
    const line = html.match(/<p class="cat-meta">([^<]*)<\/p>/);
    assert.ok(line, "the category page must carry a meta line");
    assert.match(line[1], /Data verified through \d{4}-\d{2}-\d{2}\./);
  });
});

describe("#1061 the overdue report is served", () => {
  it("reports every page on the register", async () => {
    const report = await (await fetch(`http://localhost:${serverPort}/api/page-reviews`)).json() as any;
    assert.strictEqual(report.totals.pages, REGISTRY.pages.length);
    assert.deepStrictEqual(report.sla_days, SLA_DAYS);
    const days = report.pages.map((p: any) => p.days_overdue);
    assert.deepStrictEqual(days, [...days].sort((a: number, b: number) => b - a));
  });

  it("names the pages whose verdicts rest on a record that has since moved", async () => {
    const report = await (await fetch(`http://localhost:${serverPort}/api/page-reviews`)).json() as any;
    const flagged = report.pages.filter((p: any) => p.verdict_records_changed_since_review.length > 0);
    assert.ok(flagged.length > 0, "the corpus is old enough that some verdict must be out of date");
    for (const page of flagged) {
      for (const stale of page.verdict_records_changed_since_review) {
        assert.ok(stale.changed > page.clock_starts, `${page.path}/${stale.slug} is not actually stale`);
      }
    }
  });
});

describe("#1061 the email comparison's verdict agrees with the records it names", () => {
  it("names Mailtrap as a vendor its verdict commits us to", () => {
    const page = REGISTRY.pages.find((p: any) => p.path === "/email-comparison-2026");
    assert.ok(page.vendors_asserted.includes("mailtrap-io"), JSON.stringify(page.vendors_asserted));
  });

  it("states the same free-tier volumes the index states", async () => {
    const html = await get("/email-comparison-2026");
    const index = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    const offers = Array.isArray(index) ? index : index.offers;
    const record = (vendor: string) => offers.find((o: any) => o.vendor === vendor);
    assert.match(record("Mailtrap.io").description, /4,000 emails\/month/);
    assert.match(record("Maileroo").description, /3,000 emails per month/);
    assert.ok(html.includes("4,000/mo (sending)"), "the comparison table must quote Mailtrap's current volume");
    assert.ok(html.includes("3,000 emails/month with no daily cap"), "the vendor card must quote Maileroo's current volume");
    assert.ok(!html.includes("5,000 emails/month"), "Maileroo's superseded volume is still on the page");
    assert.ok(!html.includes("3,500/mo"), "Mailtrap's superseded volume is still on the page");
  });
});

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
}

describe("what a page is allowed to say about where its figures came from", () => {
  const record = (over: Partial<PageReviewRecord> = {}): PageReviewRecord => ({
    path: "/example",
    published: "2026-04-03",
    tier: "A",
    vendors_asserted: [],
    badge_subjects_unresolved: [],
    reviewed_at: null,
    reviewer: null,
    reads_index: false,
    ...over,
  });

  it("under-claims when the register does not say whether a page reads the catalogue", () => {
    const parsed = parsePageReviews(
      JSON.stringify({ pages: [{ path: "/undeclared", published: "2026-04-03", tier: "A" }] })
    );
    assert.strictEqual(parsed.pages[0].reads_index, false);
  });

  it("keeps a declared readership through parsing", () => {
    const parsed = parsePageReviews(
      JSON.stringify({ pages: [{ path: "/declared", published: "2026-04-03", tier: "A", reads_index: true }] })
    );
    assert.strictEqual(parsed.pages[0].reads_index, true);
  });

  it("cites the catalogue only for a page that reads it", () => {
    assert.strictEqual(dataProvenanceFor(record({ reads_index: true }), 1580), indexCitation(1580));
    assert.strictEqual(dataProvenanceFor(record(), 1580), compiledNotice("2026-04-03"));
  });

  it("dates the notice from the page's own compilation, not from any other date", () => {
    assert.strictEqual(dataProvenanceFor(record({ published: "2026-03-27" }), 1580), compiledNotice("2026-03-27"));
    assert.ok(compiledNotice("2026-03-27").includes("2026-03-27"));
  });

  it("says nothing at all about a page the register does not hold", () => {
    assert.strictEqual(dataProvenanceFor(null, 1580), "");
  });
});
