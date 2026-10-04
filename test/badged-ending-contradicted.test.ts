import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { badgedEndingPopulation, endingBadgesServed, subjectBadgedAsEnded, vendorsBadgedAsEnded, type EndingBadge } from "../dist/badged-endings.js";
import { recordsStillInForce } from "../dist/change-resolution.js";
import { FREE_TIER_ENDING_TYPES, changesTheVendorMade, loadDealChanges, loadOffers, recordRestoringTheFreeTier } from "../dist/data.js";
import { endedOffersStatedAsAvailable } from "../dist/retired-terms.js";
import { offerRetired } from "../dist/retirement.js";
import type { DealChange, Offer } from "../dist/types.js";
import { namedVendorSlug, toSlug } from "../dist/vendor-slug.js";
import { assertPopulationFloor } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const SWEPT_BADGE = (vendor: string, slug: string) =>
  `<a href="/changes#vendor-${slug}" class="removed-badge" title="Our own change log records that the ${vendor} free tier has ended.">FREE REMOVED</a>`;

const NO_RECORD_TAG =
  `<a href="#source-x" class="unsourced-tag" style="display:inline-block;margin-left:.35rem" title="no catalogue record">No record</a>`;

function page(body: string, description = ""): string {
  return `<!DOCTYPE html><html><head><meta name="description" content="${description}"></head><body>${body}</body></html>`;
}

function contradictionsOn(html: string, route: string) {
  return endedOffersStatedAsAvailable(html, route, badgedEndingPopulation(html));
}

interface AnExemption {
  why: string;
  route: RegExp;
  vendors: string[];
  unit: RegExp;
}

const A_BADGE_AND_A_FREE_CLAIM_CAN_STAND_TOGETHER: AnExemption[] = [
  {
    why: "the page-claim and the meta description name the vendors the page compares, and the figures belong to the page's own cost analysis rather than to any vendor named beside them",
    route: /^\/email-comparison-2026$/,
    vendors: ["Amazon SES", "SendGrid"],
    unit: /growth cost analysis at 10K\/50K\/100K\/500K emails/,
  },
];

describe("reading the vendor a page badges as having lost its free tier", () => {
  it("reads the name out of a provider cell the sweep has marked", () => {
    const cell = `<span style="color:var(--text-dim);text-decoration:line-through">StackHawk</span> ${SWEPT_BADGE("StackHawk", "stackhawk")} ${NO_RECORD_TAG}`;
    assert.strictEqual(subjectBadgedAsEnded(cell), "StackHawk");
  });

  it("reads the name out of a card heading that carries a tagline", () => {
    const heading = `<a href="/vendor/augment-code" style="color:var(--text)">Augment Code</a> <span style="font-size:.75rem">Flat + pay-as-you-go top-ups</span> ${SWEPT_BADGE("Augment Code", "augment-code")}`;
    assert.strictEqual(subjectBadgedAsEnded(heading), "Augment Code");
  });

  it("reads the name out of a cell whose badge is written into the page source", () => {
    assert.strictEqual(subjectBadgedAsEnded(`Amazon SES<span class="removed-badge">FREE REMOVED</span>`), "Amazon SES");
  });

  it("keeps the name when the name itself is the only element before the badge", () => {
    const cell = `<span style="color:var(--text)">Heroku</span> <span style="font-size:.75rem">No free tier</span> ${SWEPT_BADGE("Heroku", "heroku")}`;
    assert.strictEqual(subjectBadgedAsEnded(cell), "Heroku");
  });

  it("takes the subject of a table row from its provider cell and nothing else", () => {
    const html = page(`<table><tr>
      <td class="provider-col">Momento ${SWEPT_BADGE("Momento", "momento")}</td>
      <td>Cache + pub/sub</td><td>5 GB transfer/mo</td>
    </tr><tr><td>Redis Cloud</td><td>30 MB</td></tr></table>`);
    assert.deepStrictEqual(vendorsBadgedAsEnded(html), ["Momento"]);
  });

  it("takes no vendor from a cell that is not the one naming the provider", () => {
    const html = page(`<table><tr>
      <td class="provider-col">Momento ${SWEPT_BADGE("Momento", "momento")}</td>
      <td>Was 5 GB transfer/mo <span class="removed-badge">FREE REMOVED</span></td>
    </tr></table>`);
    assert.deepStrictEqual(vendorsBadgedAsEnded(html), ["Momento"]);
  });

  it("finds nothing on a page that badges nobody", () => {
    assert.deepStrictEqual(vendorsBadgedAsEnded(page("<table><tr><td class=\"provider-col\">Groq</td><td>Free</td></tr></table>")), []);
  });
});

describe("a route that badges a vendor and then states terms for it", () => {
  it("flags a row cell that prices the badged vendor at zero", () => {
    const html = page(`<table>
      <tr><td class="provider-col">StackHawk ${SWEPT_BADGE("StackHawk", "stackhawk")}</td><td>DAST</td></tr>
      <tr><td>DAST</td><td class="cheapest">$0 (OWASP ZAP)</td><td>$0 (StackHawk, 1 app)</td><td>$3,000&ndash;12,000/yr</td></tr>
    </table>`);
    const found = contradictionsOn(html, "/security-free-tier-comparison-2026");
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].reason, "prices it at zero");
    assert.strictEqual(found[0].unit, "$0 (StackHawk, 1 app)");
  });

  it("leaves a row cell that states what the badged vendor charges", () => {
    const html = page(`<table>
      <tr><td class="provider-col">StackHawk ${SWEPT_BADGE("StackHawk", "stackhawk")}</td><td>DAST</td></tr>
      <tr><td>DAST</td><td class="cheapest">$0 (OWASP ZAP)</td><td>$10/user/mo (StackHawk)</td></tr>
    </table>`);
    assert.deepStrictEqual(contradictionsOn(html, "/security-free-tier-comparison-2026"), []);
  });

  it("does not read a price under a dollar as a price of nothing", () => {
    const html = page(`<table>
      <tr><td class="provider-col">Momento ${SWEPT_BADGE("Momento", "momento")}</td><td>Cache</td></tr>
      <tr><td>Transfer</td><td>$0.01 per GB (Momento)</td></tr>
    </table>`);
    assert.deepStrictEqual(contradictionsOn(html, "/database-pricing"), []);
  });

  it("flags a card description that sells the badged vendor's plan", () => {
    const html = page(`<div class="diff-card"><h3>StackHawk ${SWEPT_BADGE("StackHawk", "stackhawk")}</h3>
      <div class="diff-desc">StackHawk&rsquo;s free Developer plan covers 1 application with unlimited scans.</div></div>`);
    const found = contradictionsOn(html, "/security-free-tier-comparison-2026");
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].where, "<div>");
    assert.strictEqual(found[0].reason, "names a free tier");
  });

  it("leaves a card description that reports the ending", () => {
    const html = page(`<div class="diff-card"><h3>StackHawk ${SWEPT_BADGE("StackHawk", "stackhawk")}</h3>
      <div class="diff-desc">StackHawk&rsquo;s free Developer plan was removed in April 2026. It now sells Wingman at $10/user/month.</div></div>`);
    assert.deepStrictEqual(contradictionsOn(html, "/security-free-tier-comparison-2026"), []);
  });

  it("leaves a cell that states the trial period the badged vendor offers", () => {
    const html = page(`<table>
      <tr><td class="provider-col">Storj ${SWEPT_BADGE("Storj", "storj")}</td><td>Object</td></tr>
      <tr><td>Starting capacity</td><td>25 GB for 30 days (Storj)</td></tr>
    </table>`);
    assert.deepStrictEqual(contradictionsOn(html, "/storage-comparison-2026"), []);
  });

  it("leaves a sentence that states the badged vendor's allowance as a trial", () => {
    const html = page(`<div class="diff-card"><h3>Storj ${SWEPT_BADGE("Storj", "storj")}</h3></div>
      <p>Storj offers the largest starting capacity at 25 GB, but as a 30-day trial rather than a free tier.</p>`);
    assert.deepStrictEqual(contradictionsOn(html, "/storage-comparison-2026"), []);
  });

  it("still flags a cell that states the badged vendor's allowance with no period", () => {
    const html = page(`<table>
      <tr><td class="provider-col">Storj ${SWEPT_BADGE("Storj", "storj")}</td><td>Object</td></tr>
      <tr><td>Starting capacity</td><td>25 GB (Storj)</td></tr>
    </table>`);
    const found = contradictionsOn(html, "/storage-comparison-2026");
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].reason, "states an allowance");
  });

  it("leaves a sentence saying the vendor stopped serving its free tier", () => {
    const html = page(`<div class="diff-card"><h3>Gemini Code Assist ${SWEPT_BADGE("Gemini Code Assist", "google-gemini-code-assist")}</h3>
      <div class="diff-desc">Google stopped serving Gemini Code Assist for individuals, its free tier, on 2026-06-18.</div></div>`);
    assert.deepStrictEqual(contradictionsOn(html, "/ai-coding-tools-pricing"), []);
  });

  it("leaves a sentence saying the vendor closed its free plan to new sign-ups", () => {
    const html = page(`<div class="diff-card"><h3>CockroachDB ${SWEPT_BADGE("CockroachDB", "cockroachdb")}</h3></div>
      <p>CockroachDB closed its free Basic plan to new deployments on 2026-09-15.</p>`);
    assert.deepStrictEqual(contradictionsOn(html, "/database-pricing"), []);
  });

  it("does not read a licence as an offer", () => {
    const html = page(`<div class="diff-card"><h3>MinIO ${SWEPT_BADGE("MinIO", "minio")}</h3>
      <div class="diff-desc">MinIO is free software, but running it in production costs infrastructure and on-call time.</div></div>`);
    assert.deepStrictEqual(contradictionsOn(html, "/storage-comparison-2026"), []);
  });

  it("does not read a credential as an allowance", () => {
    const html = page(`<div class="diff-card"><h3>LocalStack ${SWEPT_BADGE("LocalStack", "localstack")}</h3>
      <div class="diff-desc">All usage now requires a free auth token from localstack.cloud.</div></div>`);
    assert.deepStrictEqual(contradictionsOn(html, "/testing-free-tier-comparison-2026"), []);
  });

  const COMPARED_APIS = "OpenAI, Anthropic, Google Gemini, Mistral, Groq, DeepSeek, Cerebras, OpenRouter, Cohere and xAI compared — free tier limits, rate limits, context windows and per-token pricing.";
  const CEREBRAS_BADGED = `<table><tr><td class="provider-col">Cerebras ${SWEPT_BADGE("Cerebras", "cerebras")}</td><td>Trial</td></tr></table>`;

  it("does not read free tier limits as an offer where they are a term the page compares the vendors on", () => {
    const html = page(`${CEREBRAS_BADGED}<p>${COMPARED_APIS}</p>`, COMPARED_APIS);
    assert.deepStrictEqual(contradictionsOn(html, "/llm-api-pricing"), []);
    const comparedOn = COMPARED_APIS.replace("compared — free tier limits", "compared on free-tier limits");
    assert.deepStrictEqual(contradictionsOn(page(`${CEREBRAS_BADGED}<p>${comparedOn}</p>`), "/llm-api-pricing"), []);
  });

  it("still flags a free-tier claim for the badged vendor beside the list of what the page compares", () => {
    const html = page(`${CEREBRAS_BADGED}<p>${COMPARED_APIS}</p>
      <p>Cerebras&rsquo;s free tier gives 3,000 requests per month.</p>`, COMPARED_APIS);
    const found = contradictionsOn(html, "/llm-api-pricing");
    assert.deepStrictEqual(found.map(f => [f.where, f.reason, f.unit]), [["<p>", "names a free tier", "Cerebras's free tier gives 3,000 requests per month."]]);
  });

  it("still flags free tier limits or a free tier stated as the badged vendor's, inside or outside a list of compared vendors", () => {
    for (const claim of ["Groq, DeepSeek and Cerebras compared — all three keep a free tier for prototyping.", "Cerebras&rsquo;s free tier limits are the highest of the ten."]) {
      const found = contradictionsOn(page(`${CEREBRAS_BADGED}<p>${claim}</p>`), "/llm-api-pricing");
      assert.deepStrictEqual(found.map(f => f.reason), ["names a free tier"], claim);
    }
  });

  it("does not read the change timeline, which reports rather than recommends", () => {
    const html = page(`<table><tr><td class="provider-col">LocalStack ${SWEPT_BADGE("LocalStack", "localstack")}</td><td>AWS emulation</td></tr></table>
      <h2 id="changes">What we recorded</h2>
      <table><tr><td>2026-09-07</td><td>LocalStack</td><td>The Hobby plan is still available and free, with 30+ services.</td></tr></table>`);
    assert.deepStrictEqual(contradictionsOn(html, "/testing-free-tier-comparison-2026"), []);
  });

  it("does not read the source register, which reports what a check found", () => {
    const html = page(`<table><tr><td class="provider-col">MinIO ${SWEPT_BADGE("MinIO", "minio")}</td><td>Object storage</td></tr></table>
      <ul><li id="source-minio">MinIO &mdash; its markup states 1 typed price (AIStor Free USD 0)</li></ul>`);
    assert.deepStrictEqual(contradictionsOn(html, "/storage-comparison-2026"), []);
  });

  it("flags prose that puts the badged vendor among the platforms with free tiers", () => {
    const html = page(`<table><tr><td class="provider-col">StackHawk ${SWEPT_BADGE("StackHawk", "stackhawk")}</td><td>DAST</td></tr></table>
      <p>Hosted platforms (Snyk, SonarCloud, StackHawk) with generous free tiers cap scans.</p>`);
    assert.strictEqual(contradictionsOn(html, "/security-free-tier-comparison-2026").length, 1);
  });

  it("says nothing about a vendor the page does not badge", () => {
    const html = page(`<table><tr><td class="provider-col">StackHawk ${SWEPT_BADGE("StackHawk", "stackhawk")}</td><td>DAST</td></tr></table>
      <p>Snyk&rsquo;s free tier covers 200 SCA tests per month.</p>`);
    assert.deepStrictEqual(contradictionsOn(html, "/security-free-tier-comparison-2026"), []);
  });
});

const BADGE_LINK_TO_RECORDS = /^\/(?:vendor\/([a-z0-9-]+)#changes|changes#vendor-([a-z0-9-]+))$/;
const OUR_CHANGE_LOG_RECORDS_THE_ENDING = /^Our own change log records that the .+ free tier has ended\.$/;
const THE_CATALOGUE_RECORDS_THE_OFFER_AS = /^.+'s offer is recorded as (.+)\.$/;

function subjectSlugOf(badge: EndingBadge): string | null {
  if (badge.href === null) return toSlug(badge.subject) || null;
  const linked = BADGE_LINK_TO_RECORDS.exec(badge.href);
  return linked ? (linked[1] ?? linked[2])! : null;
}

const subjectsLoggedAs = new Map<string, Set<string>>();

function loggedUnder(vendor: string, slug: string): boolean {
  let subjects = subjectsLoggedAs.get(vendor);
  if (!subjects) {
    subjects = new Set([toSlug(vendor), namedVendorSlug(vendor)].filter((s): s is string => Boolean(s)));
    subjectsLoggedAs.set(vendor, subjects);
  }
  return subjects.has(slug);
}

function latestEndingTheVendorMade(records: readonly DealChange[]): DealChange | null {
  return changesTheVendorMade(recordsStillInForce(records))
    .filter(change => FREE_TIER_ENDING_TYPES.has(change.change_type))
    .sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

function whyTheBadgeDoesNotStand(badge: EndingBadge, log: readonly DealChange[], catalogue: readonly Pick<Offer, "vendor" | "tier">[]): string | null {
  const slug = subjectSlugOf(badge);
  if (!slug) return `links to ${badge.href}, which names no vendor`;
  const recordedAs = THE_CATALOGUE_RECORDS_THE_OFFER_AS.exec(badge.title ?? "")?.[1];
  if (recordedAs !== undefined) {
    const listings = catalogue.filter(offer => toSlug(offer.vendor) === slug);
    if (listings.length === 0) return `cites the catalogue, which lists nothing under ${slug}`;
    if (!listings.every(offer => offerRetired(offer))) return `cites the catalogue, which still offers a listing under ${slug}`;
    return listings.some(offer => offer.tier === recordedAs) ? null : `cites the catalogue as "${recordedAs}", which no listing under ${slug} is recorded as`;
  }
  if (badge.title !== null && !OUR_CHANGE_LOG_RECORDS_THE_ENDING.test(badge.title)) {
    return `cites neither our change log nor the catalogue: "${badge.title}"`;
  }
  const records = log.filter(change => loggedUnder(change.vendor, slug));
  const ending = latestEndingTheVendorMade(records);
  if (!ending) return `no ending the vendor made is in force under ${slug}`;
  const restoring = recordRestoringTheFreeTier(ending, records);
  return restoring ? `its ${restoring.date} ${restoring.change_type} states a free plan after the ${ending.date} ending` : null;
}

function badgesOn(html: string): number {
  return (html.match(/>FREE REMOVED</g) ?? []).length;
}

function dayAfter(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function badgesThatDoNotStand(html: string, log: readonly DealChange[], catalogue: readonly Pick<Offer, "vendor" | "tier">[]): string[] {
  return endingBadgesServed(html).flatMap(badge => {
    const why = whyTheBadgeDoesNotStand(badge, log, catalogue);
    return why ? [`${badge.subject}: ${why}`] : [];
  });
}

const A_VENDOR = "Postbox Relay";
const A_VENDORS_SLUG = "postbox-relay";

function logged(change_type: string, date: string, current_state: string, more: Partial<DealChange> = {}): DealChange {
  return {
    vendor: A_VENDOR,
    change_type,
    date,
    summary: `${A_VENDOR} ${change_type.replace(/_/g, " ")} on ${date}.`,
    previous_state: "",
    current_state,
    impact: "high",
    source_url: "https://postbox-relay.example/pricing",
    ...more,
  } as DealChange;
}

const ITS_ENDING = logged("free_tier_removed", "2025-05-27", "60-day trial only. Paid plans from $19.95 a month.");
const A_WRITTEN_IN_BADGE = page(`<table><tr><td class="provider-col">${A_VENDOR}<span class="removed-badge">FREE REMOVED</span></td><td>Email</td></tr></table>`);
const A_SWEPT_BADGE = page(`<table><tr><td class="provider-col">${A_VENDOR} ${SWEPT_BADGE(A_VENDOR, A_VENDORS_SLUG)}</td><td>Email</td></tr></table>`);
const A_CATALOGUE_BADGE = page(`<h3>${A_VENDOR} <a href="/vendor/${A_VENDORS_SLUG}#changes" class="removed-badge" title="${A_VENDOR}&#39;s offer is recorded as Retired.">FREE REMOVED</a></h3>`);

describe("the record a free-tier-ended badge stands on", () => {
  it("reads each badge with the vendor it sits beside, its link and its title", () => {
    assert.deepStrictEqual(endingBadgesServed(A_WRITTEN_IN_BADGE), [{ subject: A_VENDOR, href: null, title: null }]);
    assert.deepStrictEqual(endingBadgesServed(A_CATALOGUE_BADGE), [{
      subject: A_VENDOR,
      href: `/vendor/${A_VENDORS_SLUG}#changes`,
      title: `${A_VENDOR}'s offer is recorded as Retired.`,
    }]);
    const twice = page(`<table><tr><td class="provider-col">${A_VENDOR}<span class="removed-badge">FREE REMOVED</span> ${SWEPT_BADGE(A_VENDOR, A_VENDORS_SLUG)}</td></tr></table>`);
    assert.deepStrictEqual(endingBadgesServed(twice).map(badge => badge.href), [null, `/changes#vendor-${A_VENDORS_SLUG}`]);
  });

  it("lets a badge stand on the vendor's own ending when nothing it recorded later states a free plan", () => {
    const later = logged("pricing_restructured", "2026-09-01", "Paid plans now start at $24.95 a month.");
    for (const html of [A_WRITTEN_IN_BADGE, A_SWEPT_BADGE]) {
      assert.deepStrictEqual(badgesThatDoNotStand(html, [ITS_ENDING, later], []), []);
    }
  });

  it("flags a badge once a later record the vendor made states a free plan", () => {
    const restoring = logged("pricing_restructured", "2026-09-01", "Free plan: 100 emails/day, no credit card required.");
    for (const html of [A_WRITTEN_IN_BADGE, A_SWEPT_BADGE]) {
      assert.deepStrictEqual(badgesThatDoNotStand(html, [ITS_ENDING, restoring], []),
        [`${A_VENDOR}: its 2026-09-01 pricing_restructured states a free plan after the 2025-05-27 ending`]);
    }
  });

  it("reads the latest ending, so a free plan restored between two endings leaves the second standing", () => {
    const firstEnding = logged("free_tier_removed", "2022-11-28", "No free plan.");
    const restoredBetween = logged("new_free_tier", "2023-06-01", "Free plan: 50 emails/day.");
    assert.deepStrictEqual(badgesThatDoNotStand(A_WRITTEN_IN_BADGE, [firstEnding, restoredBetween, ITS_ENDING], []), []);
  });

  it("does not count our own correction as the vendor restoring its free tier", () => {
    const correction = logged("record_corrected", "2026-09-26", "Free plan: 100 emails/day, no credit card required.");
    assert.deepStrictEqual(badgesThatDoNotStand(A_WRITTEN_IN_BADGE, [ITS_ENDING, correction], []), []);
  });

  it("flags a badge whose vendor has no ending of its own in force", () => {
    const retracted = { ...ITS_ENDING, resolution: { state: "retracted", date: "2026-09-20", detail: "No such change." } } as DealChange;
    const reversed = { ...ITS_ENDING, resolution: { state: "reversed", date: "2026-08-01", detail: "The free plan came back." } } as DealChange;
    for (const log of [[], [retracted], [reversed]]) {
      assert.deepStrictEqual(badgesThatDoNotStand(A_WRITTEN_IN_BADGE, log, []),
        [`${A_VENDOR}: no ending the vendor made is in force under ${A_VENDORS_SLUG}`]);
    }
  });

  it("reads the vendor's records from the badge's link, not from the label beside it", () => {
    const labelled = page(`<table><tr><td class="provider-col">Relay ${SWEPT_BADGE(A_VENDOR, A_VENDORS_SLUG)}</td><td>Email</td></tr></table>`);
    assert.deepStrictEqual(badgesThatDoNotStand(labelled, [ITS_ENDING], []), []);
    const underTheLabel = { ...ITS_ENDING, vendor: "Relay" };
    assert.deepStrictEqual(badgesThatDoNotStand(labelled, [underTheLabel], []),
      [`Relay: no ending the vendor made is in force under ${A_VENDORS_SLUG}`]);
  });

  it("needs every listing under the vendor recorded as ended behind a badge that cites the catalogue", () => {
    assert.deepStrictEqual(badgesThatDoNotStand(A_CATALOGUE_BADGE, [], [{ vendor: A_VENDOR, tier: "Retired" }]), []);
    const cases: [Pick<Offer, "vendor" | "tier">[], string][] = [
      [[], `cites the catalogue, which lists nothing under ${A_VENDORS_SLUG}`],
      [[{ vendor: A_VENDOR, tier: "Free" }], `cites the catalogue, which still offers a listing under ${A_VENDORS_SLUG}`],
      [[{ vendor: A_VENDOR, tier: "Retired" }, { vendor: A_VENDOR, tier: "Free" }], `cites the catalogue, which still offers a listing under ${A_VENDORS_SLUG}`],
      [[{ vendor: A_VENDOR, tier: "Discontinued" }], `cites the catalogue as "Retired", which no listing under ${A_VENDORS_SLUG} is recorded as`],
    ];
    for (const [catalogue, why] of cases) {
      assert.deepStrictEqual(badgesThatDoNotStand(A_CATALOGUE_BADGE, [ITS_ENDING], catalogue), [`${A_VENDOR}: ${why}`]);
    }
  });

  it("flags a badge that cites neither our change log nor the catalogue", () => {
    const html = page(`<h3>${A_VENDOR} <a href="/vendor/${A_VENDORS_SLUG}#changes" class="removed-badge" title="Readers report the free plan is gone.">FREE REMOVED</a></h3>`);
    assert.deepStrictEqual(badgesThatDoNotStand(html, [ITS_ENDING], []),
      [`${A_VENDOR}: cites neither our change log nor the catalogue: "Readers report the free plan is gone."`]);
  });
});

let proc: ChildProcess | null = null;
let serverPort = 0;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function exemptionFor(route: string, vendor: string, said: string): AnExemption | undefined {
  return A_BADGE_AND_A_FREE_CLAIM_CAN_STAND_TOGETHER.find(one =>
    one.route.test(route) && one.vendors.includes(vendor) && one.unit.test(said));
}

describe("every route we publish that badges a free tier as ended", () => {
  const badgedRoutes = new Map<string, string[]>();
  const servedOnBadgedRoutes = new Map<string, string>();
  const servedWhereAReasonIsNamed = new Map<string, string>();
  const unexplained: string[] = [];
  const explainedBy = new Set<string>();
  let routesRead = 0;
  let badgeInstances = 0;

  before(async () => {
    proc = await startServer();
    const base = `http://localhost:${serverPort}`;
    const index = await (await fetch(`${base}/sitemap.xml`)).text();
    const subs = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map(m => m[1]!)
      .filter(u => !/sitemap-vendors\.xml$/.test(u));
    const listed = new Set<string>();
    for (const sub of subs) {
      const xml = await (await fetch(base + new URL(sub).pathname)).text();
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) listed.add(new URL(m[1]!).pathname);
    }
    for (const route of [...listed].sort()) {
      const res = await fetch(base + route);
      if (res.status !== 200) continue;
      routesRead += 1;
      const html = await res.text();
      const served = badgesOn(html);
      if (served > 0) servedOnBadgedRoutes.set(route, html);
      const badged = vendorsBadgedAsEnded(html);
      if (badged.length === 0) continue;
      badgedRoutes.set(route, badged);
      badgeInstances += served;
      if (A_BADGE_AND_A_FREE_CLAIM_CAN_STAND_TOGETHER.some(one => one.route.test(route))) {
        servedWhereAReasonIsNamed.set(route, html);
      }
      for (const found of contradictionsOn(html, route)) {
        const said = found.unit.trim();
        const exempt = exemptionFor(route, found.vendor, said);
        if (exempt) { explainedBy.add(exempt.why); continue; }
        unexplained.push(`${route} ${found.where} ${found.vendor} [${found.reason}]: ${said.slice(0, 160)}`);
      }
    }
  });

  after(() => { proc?.kill(); });

  it("reads enough badged routes for the sweep to be able to fail", () => {
    assertPopulationFloor(routesRead, 500, "routes read for a badged ending");
    assertPopulationFloor(badgeInstances, 12, "free-tier-ended badges served across the site");
    assertPopulationFloor(badgedRoutes.size, 1, "routes serving a free-tier-ended badge");
    const pairs = [...badgedRoutes.values()].reduce((n, vendors) => n + vendors.length, 0);
    assertPopulationFloor(pairs, 6, "route-and-vendor pairs carrying a free-tier-ended badge");
  });

  it("reads every free-tier-ended badge a route serves, so none goes unchecked", () => {
    const unread = [...servedOnBadgedRoutes].flatMap(([route, html]) => {
      const read = endingBadgesServed(html).length;
      return read === badgesOn(html) ? [] : [`${route}: ${badgesOn(html)} served, ${read} read`];
    });
    assert.deepStrictEqual(unread, []);
  });

  it("rests every badge it serves on an ending the vendor made and did not reverse, or on listings the catalogue records as ended", () => {
    const log = loadDealChanges();
    const catalogue = loadOffers();
    const checked = [...servedOnBadgedRoutes].flatMap(([route, html]) =>
      endingBadgesServed(html).map(badge => ({ route, badge, why: whyTheBadgeDoesNotStand(badge, log, catalogue) })));
    assertPopulationFloor(checked.length, 12, "free-tier-ended badges checked against the record they stand on");
    assert.deepStrictEqual(checked.filter(one => one.why).map(one => `${one.route} ${one.badge.subject}: ${one.why}`), []);
  });

  it("would flag each badge written into a page once its vendor records a free plan after the ending", () => {
    const log = loadDealChanges();
    const catalogue = loadOffers();
    const writtenIn = [...servedOnBadgedRoutes].flatMap(([route, html]) =>
      endingBadgesServed(html).filter(badge => badge.href === null).map(badge => ({ route, html, badge })));
    assertPopulationFloor(writtenIn.length, 1, "badges written into a page rather than set from the change log");
    for (const { route, html, badge } of writtenIn) {
      const ending = latestEndingTheVendorMade(log.filter(change => loggedUnder(change.vendor, toSlug(badge.subject))));
      assert.ok(ending, `${route} writes in a badge for ${badge.subject}, which has no ending of its own in force`);
      const restoring = { ...ending, change_type: "pricing_restructured", date: dayAfter(ending.date), current_state: "Free plan: 100 requests a day, no credit card required." };
      const flagged = badgesThatDoNotStand(html, [...log, restoring], catalogue);
      assert.ok(flagged.length > 0 && flagged.every(why => why.startsWith(`${badge.subject}: its ${restoring.date} pricing_restructured states a free plan`)),
        `${route}: a free plan ${badge.subject} records after its ending flags ${JSON.stringify(flagged)}`);
    }
  });

  it("names a vendor in every badge it reads, so no badge is swept past unread", () => {
    for (const [route, vendors] of badgedRoutes) {
      for (const vendor of vendors) {
        assert.ok(/^[A-Za-z0-9]/.test(vendor) && vendor.length <= 40,
          `${route} badges a subject read as "${vendor}", which is not a vendor name`);
      }
    }
  });

  it("states no free offer for a vendor whose free tier it badges as ended", () => {
    assert.deepStrictEqual(unexplained, [],
      `${unexplained.length} of ${badgeInstances} served badges sit on a route that also offers the vendor for nothing`);
  });

  it("needs every reason it names, so a stale exemption cannot hide a route", () => {
    const unused = A_BADGE_AND_A_FREE_CLAIM_CAN_STAND_TOGETHER.filter(one => !explainedBy.has(one.why)).map(one => one.why);
    assert.deepStrictEqual(unused, [], `${unused.length} exemptions matched nothing served`);
  });

  it("holds a reason narrow enough that a new claim on the same route still surfaces", () => {
    assert.strictEqual(servedWhereAReasonIsNamed.size, A_BADGE_AND_A_FREE_CLAIM_CAN_STAND_TOGETHER.length,
      "every reason names a route the site serves");
    for (const [route, html] of servedWhereAReasonIsNamed) {
      for (const vendor of badgedRoutes.get(route) ?? []) {
        const claim = `<p>${vendor}&rsquo;s free tier gives 3,000 requests per month.</p>`;
        const timeline = /<h2\b[^>]*\bid="changes"/i.exec(html);
        const planted = timeline
          ? html.slice(0, timeline.index) + claim + html.slice(timeline.index)
          : html.replace("</body>", `${claim}</body>`);
        const surfaced = contradictionsOn(planted, route)
          .filter(found => found.vendor === vendor && /3,000 requests per month/.test(found.unit))
          .filter(found => exemptionFor(route, found.vendor, found.unit.trim()) === undefined);
        assert.strictEqual(surfaced.length, 1,
          `a fresh free-tier claim for ${vendor} on ${route} is covered by a reason meant for other copy`);
      }
    }
  });

  it("explains the contradiction in fewer reasons than there are routes carrying a badge", () => {
    assert.ok(A_BADGE_AND_A_FREE_CLAIM_CAN_STAND_TOGETHER.length < badgedRoutes.size,
      `${A_BADGE_AND_A_FREE_CLAIM_CAN_STAND_TOGETHER.length} exemptions against ${badgedRoutes.size} badged routes is a census, not a reason list`);
  });

  it("keeps the pages that report the ending naming the vendor they end", () => {
    for (const [route, vendors] of badgedRoutes) {
      assert.ok(vendors.length > 0, `${route} carries a badge attached to no vendor`);
    }
    assert.ok(badgedRoutes.has("/security-free-tier-comparison-2026"), "the security comparison still badges an ended free tier");
  });
});
