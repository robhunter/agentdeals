import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchBadgeVerdicts, type SiteFreeTierVerdict } from "./badge-verdicts.ts";

const { eligibilityGate, eligibilityGateAsPublished, publishableEligibilityConditions, CONDITION_RECORDING_AN_UNREAD_PROGRAM } =
  await import("../dist/eligibility.js");
const { gateFor, notAFreeOfferGateFor, utcDate } = await import("../dist/ranking.js");
const { supersededTermsNotice, supersedingChange } = await import("../dist/superseded-description.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const dealChanges: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"),
).changes;

function publishedDescriptionOf(offer: Offer): string {
  const superseding = supersedingChange(
    offer,
    dealChanges.filter(c => c.vendor.toLowerCase() === offer.vendor.toLowerCase()),
  );
  return superseding ? supersededTermsNotice(offer.vendor, superseding) : offer.description;
}

function slugOf(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const vendorsHoldingAGatedRecord = [...new Set(offers.filter(o => o.eligibility).map(o => o.vendor))];

const TODAY = utcDate();

const publishesARestriction = (offer: Offer) => gateFor(offer, TODAY)?.code === "eligibility_restricted";

let port = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

const pages = new Map<string, string>();

async function page(pathname: string): Promise<string> {
  const cached = pages.get(pathname);
  if (cached !== undefined) return cached;
  const res = await fetch(`http://localhost:${port}${pathname}`);
  const body = await res.text();
  pages.set(pathname, body);
  return body;
}

function jsonLdBlocks(html: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { out.push(JSON.parse(m[1])); } catch { continue; }
  }
  return out;
}

function blockOfType(html: string, type: string): Record<string, any> | undefined {
  return jsonLdBlocks(html).find(b => b["@type"] === type);
}

function faqAnswer(html: string, prefix: string): string | undefined {
  const faq = blockOfType(html, "FAQPage");
  const item = faq?.mainEntity?.find((q: { name: string }) => q.name.startsWith(prefix));
  return item?.acceptedAnswer?.text;
}

function renderedOffer(html: string): Offer | undefined {
  const webPage = blockOfType(html, "WebPage");
  const vendor = webPage?.mainEntity?.name;
  const description = webPage?.mainEntity?.description;
  if (typeof vendor !== "string" || typeof description !== "string") return undefined;
  return offers.find(o => o.vendor === vendor && publishedDescriptionOf(o) === description);
}

type RenderedPage = { vendor: string; slug: string; html: string; offer: Offer };

let rendered: RenderedPage[] = [];

let verdicts = new Map<string, SiteFreeTierVerdict>();

before(async () => {
  proc = await startServer();
  verdicts = await fetchBadgeVerdicts(port);
  for (const vendor of vendorsHoldingAGatedRecord) {
    const slug = slugOf(vendor);
    const html = await page(`/vendor/${slug}`);
    const offer = renderedOffer(html);
    if (offer) rendered.push({ vendor, slug, html, offer });
  }
});

after(() => { proc?.kill(); });

describe("a vendor page whose record is gated on eligibility says so", () => {
  it("covers every vendor holding a gated record", () => {
    assert.ok(
      vendorsHoldingAGatedRecord.length > 0,
      "no record in the index carries an eligibility gate, so this file has no subject",
    );
    assert.strictEqual(rendered.length, vendorsHoldingAGatedRecord.length);
  });

  it("never answers the free-tier question with a bare yes over a gated record", () => {
    const gated = rendered.filter(p => p.offer.eligibility);
    assert.ok(gated.length > 0, "no vendor page renders a gated record, so this assertion has no subject");
    const offenders = gated
      .filter(p => (faqAnswer(p.html, `Is ${p.vendor} free?`) ?? "").startsWith("Yes"))
      .map(p => p.slug);
    assert.deepStrictEqual(offenders, []);
  });

  it("opens that answer with the same sentence the ranking gate composes", () => {
    for (const p of rendered.filter(x => x.offer.eligibility)) {
      const answer = faqAnswer(p.html, `Is ${p.vendor} free?`) ?? "";
      assert.ok(
        answer.startsWith(gateFor(p.offer, "")!.reason),
        `${p.slug} opens with ${answer.slice(0, 60)}`,
      );
    }
  });

  it("still answers yes where the page renders an ungated record for a vendor that also holds a gated one", () => {
    const controls = rendered.filter(p => !p.offer.eligibility && !gateFor(p.offer, utcDate()));
    assert.ok(
      controls.length > 0,
      "every vendor holding a gated record now renders it, so the over-fire control has no subject",
    );
    for (const p of controls) {
      assert.ok(
        (faqAnswer(p.html, `Is ${p.vendor} free?`) ?? "").startsWith("Yes"),
        `${p.slug} lost an answer it was entitled to`,
      );
      assert.ok(!p.html.includes("gate-line"), `${p.slug} renders a gate it does not carry`);
    }
  });

  it("carries the qualification into the page description too", () => {
    const subjects = rendered.filter(x => publishesARestriction(x.offer));
    assert.ok(subjects.length > 0, "no rendered page has the restriction as its effective gate");
    for (const p of subjects) {
      const description = blockOfType(p.html, "WebPage")?.description ?? "";
      assert.ok(description.startsWith(gateFor(p.offer, TODAY)!.reason), `${p.slug} description is unqualified`);
    }
  });

  it("states the restriction in that description only where the restriction is the effective gate", () => {
    const others = rendered.filter(x => !publishesARestriction(x.offer));
    assert.ok(others.length > 0, "every rendered page has the restriction as its effective gate");
    for (const p of others) {
      const description = blockOfType(p.html, "WebPage")?.description ?? "";
      const restriction = eligibilityGate(p.offer)?.reason;
      assert.ok(
        restriction === undefined || !description.includes(restriction),
        `${p.slug} states a restriction its own gate outranks: ${description.slice(0, 90)}`,
      );
    }
  });

  it("publishes every condition it holds except the one recording that no program was read", () => {
    const withRealConditions = rendered.filter(
      p => publishesARestriction(p.offer) && publishableEligibilityConditions(p.offer).length > 0,
    );
    assert.ok(withRealConditions.length > 0, "no gated record holds a publishable condition");
    for (const p of withRealConditions) {
      const list = p.html.match(/<ul class="eligibility-conditions"[^>]*>([\s\S]*?)<\/ul>/)?.[1];
      assert.ok(list, `${p.slug} renders no conditions list`);
      for (const condition of publishableEligibilityConditions(p.offer)) {
        assert.ok(list!.includes(`<li>${escapeHtml(condition)}</li>`), `${p.slug} withholds ${condition}`);
      }
    }
    const placeholderOnly = rendered.filter(
      p => publishesARestriction(p.offer) && publishableEligibilityConditions(p.offer).length === 0,
    );
    assert.ok(
      placeholderOnly.length > 0,
      "the placeholder condition is gone from the data, so this branch has no subject",
    );
    for (const p of placeholderOnly) {
      assert.ok(p.html.includes("gate-line"), `${p.slug} states no restriction`);
      assert.ok(!p.html.includes(escapeHtml(CONDITION_RECORDING_AN_UNREAD_PROGRAM)), `${p.slug} publishes the placeholder`);
    }
  });
});

describe("the category page a gated offer is sent to states the restriction", () => {
  it("names it on the row for every gated offer in the category", async () => {
    const gatedByCategory = new Map<string, Offer[]>();
    for (const o of offers) {
      if (!publishesARestriction(o)) continue;
      const list = gatedByCategory.get(o.category) ?? [];
      list.push(o);
      gatedByCategory.set(o.category, list);
    }
    assert.ok(gatedByCategory.size > 0, "no category holds a gated offer, so this block has no subject");
    for (const [category, gated] of gatedByCategory) {
      const html = await page(`/category/${slugOf(category)}`);
      for (const o of gated) {
        assert.ok(
          html.includes(escapeHtml(gateFor(o, TODAY)!.reason)),
          `/category/${slugOf(category)} omits the restriction on ${o.vendor}`,
        );
      }
    }
  });

  it("keeps every gated offer on the category page and the vendor page the gate promises", async () => {
    for (const o of offers.filter(x => x.eligibility)) {
      const category = await page(`/category/${slugOf(o.category)}`);
      assert.ok(category.includes(`/vendor/${slugOf(o.vendor)}`), `${o.vendor} left its category page`);
      const vendor = await page(`/vendor/${slugOf(o.vendor)}`);
      assert.ok(vendor.includes("<h1>"), `/vendor/${slugOf(o.vendor)} stopped rendering`);
    }
  });
});

describe("a category page does not count a gated offer as a plain free tier", () => {
  const categoryNames = [...new Set(offers.map(o => o.category))].sort();
  const censusOf = (category: string) => {
    const held = offers.filter(o => o.category === category);
    const inCategory = held.filter(o => verdicts.get(slugOf(o.vendor)) !== "ended");
    return {
      total: inCategory.length,
      restricted: inCategory.filter(publishesARestriction).length,
      gated: inCategory.filter(o => gateFor(o, utcDate())).length,
      ended: held.length - inCategory.length,
    };
  };
  const ledeOf = (html: string) => html.match(/<p class="cat-meta">([\s\S]*?)<\/p>/)?.[1] ?? "";
  const descriptionOf = (html: string) => html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
  const restrictedRows = (html: string) => [...html.matchAll(/class="listing-eligibility-restricted"/g)].length;
  const QUALIFICATION = "application or qualification";

  it("has an entirely gated category, a partly gated one and an ungated one to measure", () => {
    const censuses = categoryNames.map(censusOf);
    assert.ok(censuses.some(c => c.gated > 0 && c.gated === c.total), "no category is entirely gated");
    assert.ok(censuses.some(c => c.gated > 0 && c.gated < c.total), "no category is partly gated");
    assert.ok(censuses.some(c => c.gated === 0), "every category holds a gated record");
  });

  it("holds a category gated by something other than eligibility, so the two counts are separable", () => {
    const censuses = categoryNames.map(censusOf);
    assert.ok(censuses.some(c => c.gated > c.restricted), "eligibility accounts for every gated record");
    assert.ok(censuses.some(c => c.gated > 0 && c.restricted === 0), "no category is gated without eligibility");
  });

  it("qualifies the count claim rather than closing it", async () => {
    for (const category of categoryNames) {
      const { total, restricted, gated } = censusOf(category);
      const html = await page(`/category/${slugOf(category)}`);
      const lede = ledeOf(html);
      const where = `/category/${slugOf(category)} (${gated} gated, ${restricted} restricted, of ${total})`;
      if (gated === 0) {
        assert.ok(lede.startsWith(`${total} verified free tiers and developer deals.`), `${where} lede is ${lede}`);
        assert.ok(!lede.includes(QUALIFICATION), `${where} states a restriction it does not hold`);
        continue;
      }
      assert.strictEqual(
        lede.includes(QUALIFICATION),
        restricted > 0,
        `${where} states the eligibility clause on ${restricted} restricted records: ${lede}`,
      );
      if (gated === total && restricted === total) {
        assert.ok(lede.includes("none of them generally available"), `${where} lede is ${lede}`);
        assert.ok(
          !lede.startsWith(`${total} verified free tiers and developer deals.`),
          `${where} closes the count claim before qualifying it: ${lede}`,
        );
      } else if (gated === total && total > 1) {
        assert.ok(lede.includes("None of them are on our ranked list"), `${where} lede is ${lede}`);
        assert.ok(
          !lede.includes("none of them generally available"),
          `${where} says each record requires an application, on ${restricted} restricted of ${gated} gated: ${lede}`,
        );
      } else if (gated === 1) {
        assert.ok(lede.includes("One of them is not on our ranked list"), `${where} lede is ${lede}`);
      } else {
        assert.ok(lede.includes(`${gated} of them`), `${where} lede does not name ${gated}: ${lede}`);
      }
    }
  });

  it("states a number the rows below it agree with", async () => {
    for (const category of categoryNames) {
      const { total, restricted, gated } = censusOf(category);
      const html = await page(`/category/${slugOf(category)}`);
      const lede = ledeOf(html);
      const rowsCarryingARestriction = offers.filter(o => o.category === category).filter(publishesARestriction).length;
      assert.strictEqual(restrictedRows(html), rowsCarryingARestriction, `/category/${slugOf(category)} restricted rows`);
      if (gated > 1 && gated < total) {
        assert.ok(lede.includes(`${gated} of them`), `/category/${slugOf(category)} lede is ${lede}`);
      }
      if (restricted > 0 && gated < total) {
        const clause = restricted === 1
          ? "1 requires an application or qualification"
          : `${restricted} require an application or qualification`;
        assert.ok(lede.includes(clause), `/category/${slugOf(category)} does not name ${restricted}: ${lede}`);
      }
    }
  });

  it("carries the same qualification into the search snippet, ahead of the vendor list", async () => {
    for (const category of categoryNames) {
      const { total, restricted } = censusOf(category);
      const html = await page(`/category/${slugOf(category)}`);
      const description = descriptionOf(html);
      const where = `/category/${slugOf(category)} (${restricted} restricted of ${total})`;
      if (restricted === 0) {
        assert.ok(!description.includes(QUALIFICATION), `${where} description is ${description}`);
        continue;
      }
      assert.ok(description.includes(QUALIFICATION), `${where} description is ${description}`);
      assert.ok(
        description.indexOf(QUALIFICATION) < description.indexOf("Verified pricing for"),
        `${where} appends the qualification after the vendor list, where a snippet truncates it`,
      );
    }
  });
});

describe("the other answers on a gated vendor page", () => {
  const gatedPages = () => rendered.filter(p => p.offer.eligibility);

  const pagesStillNamingATier = () => gatedPages().filter(p => notAFreeOfferGateFor(p.offer) === null);

  it("qualifies the two that state or recommend the terms", () => {
    assert.ok(
      pagesStillNamingATier().length > 0,
      "no vendor page renders a record gated only by its eligibility, so this check reads nothing",
    );
    for (const p of pagesStillNamingATier()) {
      const reason = gateFor(p.offer, "")!.reason;
      for (const question of [`What is ${p.vendor}'s free tier?`, `Is ${p.vendor}'s free tier good for production?`]) {
        const answer = faqAnswer(p.html, question) ?? "";
        assert.ok(answer.startsWith(reason), `${p.slug} answers "${question}" with ${answer.slice(0, 70)}`);
      }
    }
  });

  it("leaves the two that describe our record rather than the offer alone", () => {
    for (const p of gatedPages()) {
      const reason = gateFor(p.offer, "")!.reason;
      for (const question of [
        `What changed in ${p.vendor}'s pricing?`,
        `What category is ${p.vendor} in?`,
      ]) {
        const answer = faqAnswer(p.html, question);
        assert.ok(answer !== undefined, `${p.slug} no longer answers "${question}"`);
        assert.ok(!answer!.startsWith(reason), `${p.slug} qualified "${question}", which is about our record`);
      }
    }
  });
});

describe("the disclosure reuses one composition", () => {
  it("returns the ranking gate unchanged for a record carrying eligibility", () => {
    const gated = offers.find(o => o.eligibility)!;
    assert.deepStrictEqual(eligibilityGate(gated), gateFor(gated, ""));
    assert.strictEqual(eligibilityGate(gated)!.code, "eligibility_restricted");
  });

  it("returns nothing for a record gated on anything else", () => {
    const expired: Offer = {
      vendor: "Acme", category: "Databases", description: "A free tier.", tier: "Free",
      url: "https://example.com/pricing", tags: [], verifiedDate: "2026-08-20", expires_date: "2026-01-01",
    };
    assert.strictEqual(gateFor(expired, "2026-09-01")!.code, "offer_expired");
    assert.strictEqual(eligibilityGate(expired), null);
    assert.deepStrictEqual(publishableEligibilityConditions(expired), []);
  });

  it("publishes the restriction where nothing outranks it", () => {
    const restricted: Offer = {
      vendor: "Acme", category: "Databases", description: "A free tier.", tier: "Free",
      url: "https://example.com/pricing", tags: [], verifiedDate: "2026-08-20",
      eligibility: { type: "startup", conditions: ["Pre-Series B"], program: "Acme for Startups" },
    };
    assert.strictEqual(gateFor(restricted, "2026-09-02")!.code, "eligibility_restricted");
    assert.deepStrictEqual(
      eligibilityGateAsPublished(restricted, "2026-09-02"),
      gateFor(restricted, "2026-09-02"),
    );
  });

  it("withholds it from a record whose own tier records the offer as ended", () => {
    const ended: Offer = {
      vendor: "Acme", category: "Databases", description: "A free tier.", tier: "Retired",
      url: "https://example.com/pricing", tags: [], verifiedDate: "2026-08-20",
      eligibility: { type: "startup", conditions: ["Pre-Series B"], program: "Acme for Startups" },
    };
    assert.strictEqual(gateFor(ended, "2026-09-02")!.code, "offer_retired");
    assert.ok(eligibilityGate(ended), "the record still carries an eligibility block");
    assert.strictEqual(eligibilityGateAsPublished(ended, "2026-09-02"), null);
  });

  it("keeps it where the expiry date has passed, because the ranker still returns the restriction", () => {
    const expired: Offer = {
      vendor: "Acme", category: "Databases", description: "A free tier.", tier: "Free",
      url: "https://example.com/pricing", tags: [], verifiedDate: "2026-08-20", expires_date: "2026-01-01",
      eligibility: { type: "startup", conditions: ["Pre-Series B"], program: "Acme for Startups" },
    };
    assert.strictEqual(gateFor(expired, "2026-09-02")!.code, "eligibility_restricted");
    assert.deepStrictEqual(
      eligibilityGateAsPublished(expired, "2026-09-02"),
      gateFor(expired, "2026-09-02"),
    );
  });

  it("drops only the condition that records an unread program", () => {
    const offer = {
      eligibility: {
        type: "student" as const,
        conditions: ["Raised less than $25M", CONDITION_RECORDING_AN_UNREAD_PROGRAM, "Pre-Series B"],
      },
    };
    assert.deepStrictEqual(publishableEligibilityConditions(offer as Offer), [
      "Raised less than $25M",
      "Pre-Series B",
    ]);
  });
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
