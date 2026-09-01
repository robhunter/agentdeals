import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { eligibilityGate, publishableEligibilityConditions, CONDITION_RECORDING_AN_UNREAD_PROGRAM } =
  await import("../dist/eligibility.js");
const { gateFor } = await import("../dist/ranking.js");

type Offer = import("../src/types.ts").Offer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

function slugOf(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const vendorsHoldingAGatedRecord = [...new Set(offers.filter(o => o.eligibility).map(o => o.vendor))];

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
  const tier = webPage?.mainEntity?.offers?.description;
  if (typeof vendor !== "string" || typeof tier !== "string") return undefined;
  return offers.find(o => o.vendor === vendor && o.tier === tier);
}

type RenderedPage = { vendor: string; slug: string; html: string; offer: Offer };

let rendered: RenderedPage[] = [];

before(async () => {
  proc = await startServer();
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
    const controls = rendered.filter(p => !p.offer.eligibility);
    assert.ok(
      controls.length > 0,
      "every vendor holding a gated record now renders it, so the over-fire control has no subject",
    );
    for (const p of controls) {
      assert.ok(
        (faqAnswer(p.html, `Is ${p.vendor} free?`) ?? "").startsWith("Yes"),
        `${p.slug} lost an answer it was entitled to`,
      );
      assert.ok(!p.html.includes("eligibility-gate-line"), `${p.slug} renders a gate it does not carry`);
    }
  });

  it("carries the qualification into the page description too", () => {
    for (const p of rendered.filter(x => x.offer.eligibility)) {
      const description = blockOfType(p.html, "WebPage")?.description ?? "";
      assert.ok(description.startsWith(gateFor(p.offer, "")!.reason), `${p.slug} description is unqualified`);
    }
  });

  it("publishes every condition it holds except the one recording that no program was read", () => {
    const withRealConditions = rendered.filter(
      p => p.offer.eligibility && publishableEligibilityConditions(p.offer).length > 0,
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
      p => p.offer.eligibility && publishableEligibilityConditions(p.offer).length === 0,
    );
    assert.ok(
      placeholderOnly.length > 0,
      "the placeholder condition is gone from the data, so this branch has no subject",
    );
    for (const p of placeholderOnly) {
      assert.ok(p.html.includes("eligibility-gate-line"), `${p.slug} states no restriction`);
      assert.ok(!p.html.includes(escapeHtml(CONDITION_RECORDING_AN_UNREAD_PROGRAM)), `${p.slug} publishes the placeholder`);
    }
  });
});

describe("the category page a gated offer is sent to states the restriction", () => {
  it("names it on the row for every gated offer in the category", async () => {
    const gatedByCategory = new Map<string, Offer[]>();
    for (const o of offers) {
      if (!o.eligibility) continue;
      const list = gatedByCategory.get(o.category) ?? [];
      list.push(o);
      gatedByCategory.set(o.category, list);
    }
    assert.ok(gatedByCategory.size > 0, "no category holds a gated offer, so this block has no subject");
    for (const [category, gated] of gatedByCategory) {
      const html = await page(`/category/${slugOf(category)}`);
      for (const o of gated) {
        assert.ok(
          html.includes(escapeHtml(gateFor(o, "")!.reason)),
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
    const inCategory = offers.filter(o => o.category === category);
    return { total: inCategory.length, gated: inCategory.filter(o => eligibilityGate(o)).length };
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

  it("qualifies the count claim rather than closing it", async () => {
    for (const category of categoryNames) {
      const { total, gated } = censusOf(category);
      const html = await page(`/category/${slugOf(category)}`);
      const lede = ledeOf(html);
      const where = `/category/${slugOf(category)} (${gated} of ${total})`;
      if (gated === 0) {
        assert.ok(lede.startsWith(`${total} verified free tiers and developer deals.`), `${where} lede is ${lede}`);
        assert.ok(!lede.includes(QUALIFICATION), `${where} states a restriction it does not hold`);
        continue;
      }
      assert.ok(lede.includes(QUALIFICATION), `${where} lede is ${lede}`);
      if (gated === total) {
        assert.ok(lede.includes("none of them generally available"), `${where} lede is ${lede}`);
        assert.ok(
          !lede.startsWith(`${total} verified free tiers and developer deals.`),
          `${where} closes the count claim before qualifying it: ${lede}`,
        );
      } else {
        assert.ok(lede.includes(`${gated} of them`), `${where} lede does not name ${gated}: ${lede}`);
      }
    }
  });

  it("states a number the rows below it agree with", async () => {
    for (const category of categoryNames) {
      const { total, gated } = censusOf(category);
      const html = await page(`/category/${slugOf(category)}`);
      assert.strictEqual(restrictedRows(html), gated, `/category/${slugOf(category)} restricted rows`);
      if (gated > 0 && gated < total) {
        assert.ok(ledeOf(html).includes(`${restrictedRows(html)} of them`), `/category/${slugOf(category)}`);
      }
    }
  });

  it("carries the same qualification into the search snippet, ahead of the vendor list", async () => {
    for (const category of categoryNames) {
      const { total, gated } = censusOf(category);
      const html = await page(`/category/${slugOf(category)}`);
      const description = descriptionOf(html);
      const where = `/category/${slugOf(category)} (${gated} of ${total})`;
      if (gated === 0) {
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

  it("qualifies the two that state or recommend the terms", () => {
    assert.ok(gatedPages().length > 0, "no vendor page renders a gated record");
    for (const p of gatedPages()) {
      const reason = gateFor(p.offer, "")!.reason;
      for (const question of [`What is ${p.vendor}'s free tier?`, `Is ${p.vendor}'s free tier good for production?`]) {
        const answer = faqAnswer(p.html, question) ?? "";
        assert.ok(answer.startsWith(reason), `${p.slug} answers "${question}" with ${answer.slice(0, 70)}`);
      }
    }
  });

  it("leaves the four that describe our record rather than the offer alone", () => {
    for (const p of gatedPages()) {
      const reason = gateFor(p.offer, "")!.reason;
      for (const question of [
        `Is ${p.vendor}'s free tier reliable?`,
        `What changed in ${p.vendor}'s pricing?`,
        `When will I outgrow ${p.vendor}'s free tier?`,
        `What category is ${p.vendor} in?`,
      ]) {
        const answer = faqAnswer(p.html, question);
        if (answer === undefined) continue;
        assert.ok(!answer.startsWith(reason), `${p.slug} qualified "${question}", which is about our record`);
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
