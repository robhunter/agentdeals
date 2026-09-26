import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { badgedEndingPopulation, subjectBadgedAsEnded, vendorsBadgedAsEnded } from "../dist/badged-endings.js";
import { endedOffersStatedAsAvailable } from "../dist/retired-terms.js";
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
  {
    why: "#1835 — LocalStack's badge stands on a March 2026 ending that two later records reverse, so the page copy is right and the badge is what has to change",
    route: /^\/testing-free-tier-comparison-2026$/,
    vendors: ["LocalStack"],
    unit: /are all free with no usage limits when self-hosted|While the free tier still covers 30\+ services/,
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

  it("leaves a sentence saying the vendor stopped serving its free tier", () => {
    const html = page(`<div class="diff-card"><h3>Gemini Code Assist ${SWEPT_BADGE("Gemini Code Assist", "google-gemini-code-assist")}</h3>
      <div class="diff-desc">Google stopped serving Gemini Code Assist for individuals, its free tier, on 2026-06-18.</div></div>`);
    assert.deepStrictEqual(contradictionsOn(html, "/ai-coding-tools-pricing"), []);
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
      const badged = vendorsBadgedAsEnded(html);
      if (badged.length === 0) continue;
      badgedRoutes.set(route, badged);
      badgeInstances += (html.match(/>FREE REMOVED</g) ?? []).length;
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
    assertPopulationFloor(badgedRoutes.size, 7, "routes serving a free-tier-ended badge");
    const pairs = [...badgedRoutes.values()].reduce((n, vendors) => n + vendors.length, 0);
    assertPopulationFloor(pairs, 10, "route-and-vendor pairs carrying a free-tier-ended badge");
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
