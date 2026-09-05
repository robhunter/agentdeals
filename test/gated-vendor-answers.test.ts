import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { gateFor, utcDate } = await import("../dist/ranking.js");
const { vendorSlugMap } = await import("../dist/vendor-slug.js");
const { offerEnded } = await import("../dist/retirement.js");
const { supersededTermsNotice, supersedingChange } = await import("../dist/superseded-description.js");
const { qualityBudget } = await import("../dist/page-reviews.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;
type Gate = { code: string; reason: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const dealChanges: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"),
).changes;
const TODAY = utcDate();

const supersededBy = new Map<Offer, DealChange>();
for (const offer of offers) {
  const superseding = supersedingChange(
    offer,
    dealChanges.filter(c => c.vendor.toLowerCase() === offer.vendor.toLowerCase()),
  );
  if (superseding) supersededBy.set(offer, superseding);
}

function publishedDescriptionOf(offer: Offer): string {
  const superseding = supersededBy.get(offer);
  return superseding ? supersededTermsNotice(offer.vendor, superseding) : offer.description;
}

const PAY_AS_YOU_GO_REASON = 'Tier "Pay-as-you-go" is usage-billed from the first request.';
const DIGITALOCEAN_EXPIRY_REASON = "Offer expired on 2026-06-30.";
const NO_FREE_TIER_FOR_PRODUCTION = "There is no free tier here to run in production.";
const STABLE_RATING_CLAUSE = "We rate it stable and";
const RECOMMENDATION_CLAUSE = "so it's a reasonable starting point";

const UNGATED_PAGES_ANSWERING_YES = 588;
const UNGATED_PAGES_RECOMMENDING = 559;

let port = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
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

async function fetchAll(paths: string[], workers = 12): Promise<void> {
  const queue = paths.filter(p => !pages.has(p));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async () => {
      while (next < queue.length) await page(queue[next++]);
    }),
  );
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

function faqAnswer(html: string, prefix: string): string {
  const faq = blockOfType(html, "FAQPage");
  const item = faq?.mainEntity?.find((q: { name: string }) => q.name.startsWith(prefix));
  return item?.acceptedAnswer?.text ?? "";
}

function faqPairs(html: string): { q: string; a: string }[] {
  const faq = blockOfType(html, "FAQPage");
  return (faq?.mainEntity ?? []).map((item: { name: string; acceptedAnswer: { text: string } }) => ({
    q: item.name,
    a: item.acceptedAnswer.text,
  }));
}

function asks(html: string, question: string): boolean {
  return faqPairs(html).some(pair => pair.q === question);
}

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function headingOf(html: string): string {
  const m = /<h1>([\s\S]*?)<\/h1>/.exec(html);
  return m ? textOf(m[1]) : "";
}

function titleOf(html: string): string {
  const m = /<title>([\s\S]*?)<\/title>/.exec(html);
  return m ? textOf(m[1]) : "";
}

function gateLineOf(html: string): string | null {
  const m = /<p class="gate-line"[\s\S]*?<\/p>/.exec(html);
  return m ? textOf(m[0]) : null;
}

type VendorPage = { slug: string; vendor: string; primary: Offer; gate: Gate | null; html: string };

const primaries: { slug: string; vendor: string; primary: Offer }[] = [];
for (const [slug, vendor] of vendorSlugMap.entries()) {
  const vendorOffers = offers.filter(o => o.vendor === vendor);
  if (vendorOffers.length === 0) continue;
  primaries.push({ slug, vendor, primary: vendorOffers[0] });
}

const rendered: VendorPage[] = [];

before(async () => {
  proc = await startServer();
  await fetchAll(primaries.map(p => `/vendor/${p.slug}`));
  for (const p of primaries) {
    rendered.push({ ...p, gate: gateFor(p.primary, TODAY), html: await page(`/vendor/${p.slug}`) });
  }
});

after(() => { proc?.kill(); });

const gated = () => rendered.filter(p => p.gate);
const ungated = () => rendered.filter(p => !p.gate);
const supersededTerms = (p: VendorPage) => supersededBy.has(p.primary);
const publishingItsTerms = () => ungated().filter(p => !supersededTerms(p));
const freeAnswer = (p: VendorPage) => faqAnswer(p.html, `Is ${p.vendor} free?`);
const productionAnswer = (p: VendorPage) => faqAnswer(p.html, `Is ${p.vendor}'s free tier good for production?`);

describe("the page a gated record renders does not answer the free-tier question with yes", () => {
  it("renders one page per vendor and reads the record that page renders", () => {
    assert.ok(rendered.length > 1500, `only ${rendered.length} vendor pages rendered`);
    for (const p of rendered) {
      assert.strictEqual(
        blockOfType(p.html, "WebPage")?.mainEntity?.description,
        publishedDescriptionOf(p.primary),
        `/vendor/${p.slug} renders a record other than the first this vendor holds`,
      );
    }
  });

  it("holds a subject for every gate code the ranker can return on this data", () => {
    const codes = new Set(gated().map(p => p.gate!.code));
    assert.ok(codes.has("not_a_free_offer"), "no vendor page renders a record gated as not_a_free_offer");
    assert.ok(codes.has("offer_expired"), "no vendor page renders a record gated as offer_expired");
    assert.ok(codes.has("eligibility_restricted"), "no vendor page renders a record gated on eligibility");
    assert.ok(codes.has("offer_retired"), "no vendor page renders a record gated as offer_retired");
  });

  it("answers no gated record with yes, whichever code gates it", () => {
    const offenders = gated()
      .filter(p => freeAnswer(p).startsWith("Yes"))
      .map(p => `${p.slug} (${p.gate!.code})`);
    assert.deepStrictEqual(offenders, []);
  });

  it("opens that answer with the sentence the gate composes", () => {
    for (const p of gated().filter(x => x.gate!.code !== "eligibility_restricted" && !offerEnded(x.primary))) {
      assert.ok(
        freeAnswer(p).startsWith(p.gate!.reason),
        `/vendor/${p.slug} opens with ${freeAnswer(p).slice(0, 70)}`,
      );
    }
  });

  it("states the terms the record does hold after that sentence", () => {
    const subjects = gated().filter(
      x => x.gate!.code !== "eligibility_restricted" && !offerEnded(x.primary) && !supersededTerms(x),
    );
    assert.ok(subjects.length > 0, "no gated record still publishes its stored terms, so this assertion has no subject");
    for (const p of subjects) {
      const answer = freeAnswer(p);
      const opening = p.primary.description.slice(0, 60);
      assert.ok(
        answer.includes(opening),
        `/vendor/${p.slug} drops the stored terms: ${answer.slice(0, 120)}`,
      );
    }
  });

  it("says why it withholds them where the change log supersedes them instead", () => {
    const subjects = gated().filter(
      x => x.gate!.code !== "eligibility_restricted" && !offerEnded(x.primary) && supersededTerms(x),
    );
    assert.ok(subjects.length > 0, "no gated record has superseded terms, so this assertion has no subject");
    for (const p of subjects) {
      const answer = freeAnswer(p);
      assert.ok(!answer.includes(p.primary.description.slice(0, 60)), `/vendor/${p.slug} still states them: ${answer.slice(0, 120)}`);
      assert.ok(answer.includes("names them as the previous terms"), `/vendor/${p.slug}: ${answer.slice(0, 160)}`);
    }
  });

  it("publishes the composed sentence verbatim on the pages the issue names", () => {
    const stripe = rendered.find(p => p.slug === "stripe")!;
    const turbopuffer = rendered.find(p => p.slug === "turbopuffer")!;
    const digitalocean = rendered.find(p => p.slug === "digitalocean")!;
    assert.ok(freeAnswer(stripe).startsWith(PAY_AS_YOU_GO_REASON), freeAnswer(stripe).slice(0, 90));
    assert.ok(freeAnswer(turbopuffer).startsWith(PAY_AS_YOU_GO_REASON), freeAnswer(turbopuffer).slice(0, 90));
    assert.ok(freeAnswer(digitalocean).startsWith(DIGITALOCEAN_EXPIRY_REASON), freeAnswer(digitalocean).slice(0, 90));
  });

  it("asks nothing about a free tier its own gate says is not there", () => {
    const subjects = gated().filter(p => p.gate!.code !== "eligibility_restricted" && !offerEnded(p.primary));
    assert.ok(subjects.length > 0, "no vendor page renders a record gated outside eligibility");
    const asking = subjects
      .filter(p => asks(p.html, `What is ${p.vendor}'s free tier?`))
      .map(p => `${p.slug} (${p.gate!.code})`);
    assert.deepStrictEqual(asking, []);
  });

  it("keeps the unverified-terms caveat where the source check also withholds the level", () => {
    const withheld = gated().filter(
      p => p.gate!.code === "not_a_free_offer" && p.primary.source_check && p.primary.source_check.outcome !== "ok",
    );
    assert.ok(withheld.length > 0, "no gated record's source check withholds the level, so this branch has no subject");
    for (const p of withheld) {
      const answer = freeAnswer(p);
      assert.ok(answer.startsWith(p.gate!.reason), `/vendor/${p.slug} leads with our reading rather than the tier`);
      assert.ok(
        answer.includes("treat them as unverified"),
        `/vendor/${p.slug} drops the caveat: ${answer.slice(0, 120)}`,
      );
      assert.ok(
        !answer.includes(`offers a free tier: ${p.primary.tier}`),
        `/vendor/${p.slug} still says the record holds a free tier`,
      );
    }
  });
});

describe("the ungated pages keep the answer they had", () => {
  it("answers yes on every ungated record nothing else withholds", () => {
    const plainlyFree = publishingItsTerms().filter(
      p => p.primary.source_check?.outcome === "ok"
        && p.primary.tier.toLowerCase() !== "none"
        && !p.primary.description.toLowerCase().includes("no free tier"),
    );
    assert.ok(plainlyFree.length > 100, `only ${plainlyFree.length} ungated pages are plainly free`);
    const quiet = plainlyFree.filter(p => !freeAnswer(p).startsWith("Yes")).map(p => p.slug);
    assert.deepStrictEqual(quiet, []);
  });

  it("holds no more ungated pages withholding their terms than the recorded count, so the drop below is accounted for", () => {
    const budget = qualityBudget("ungated_pages_withholding_superseded_terms");
    const withholding = ungated().filter(supersededTerms).length;
    assert.ok(
      withholding <= budget,
      `${withholding} ungated pages withhold superseded terms, over the ${budget} recorded in ` +
        `data/quality_budgets.json. The daily re-verification run raises this by reading pages and ` +
        `scripts/ratchet-quality-budgets.js records what it measures in the same commit; nothing else may raise it.`,
    );
    assert.deepStrictEqual(ungated().filter(p => supersededTerms(p) && freeAnswer(p).startsWith("Yes")).map(p => p.slug), []);
  });

  it("counts at least as many ungated pages answering yes as the census found", () => {
    const answering = ungated().filter(p => freeAnswer(p).startsWith("Yes")).length;
    assert.ok(
      answering >= UNGATED_PAGES_ANSWERING_YES,
      `${answering} ungated pages answer yes, down from ${UNGATED_PAGES_ANSWERING_YES}`,
    );
  });

  it("counts at least as many ungated pages recommending the tier for production", () => {
    const recommending = ungated().filter(p => productionAnswer(p).includes(RECOMMENDATION_CLAUSE)).length;
    assert.ok(
      recommending >= UNGATED_PAGES_RECOMMENDING,
      `${recommending} ungated pages recommend the tier, down from ${UNGATED_PAGES_RECOMMENDING}`,
    );
  });

  it("still rates those tiers stable in the production answer", () => {
    const rating = ungated().filter(p => productionAnswer(p).includes(STABLE_RATING_CLAUSE)).length;
    assert.ok(rating >= UNGATED_PAGES_RECOMMENDING, `only ${rating} ungated pages still carry the stable rating`);
  });
});

describe("the production answer reads the same gate", () => {
  it("recommends no record gated as not a free offer or as expired", () => {
    const subjects = gated().filter(p => p.gate!.code === "not_a_free_offer" || p.gate!.code === "offer_expired");
    assert.ok(subjects.length > 0, "no record is gated as not a free offer or as expired");
    for (const p of subjects) {
      assert.strictEqual(
        productionAnswer(p),
        `${p.gate!.reason} ${NO_FREE_TIER_FOR_PRODUCTION}`,
        `/vendor/${p.slug}`,
      );
    }
  });

  it("recommends no record whose own tier records the offer as ended", () => {
    const subjects = gated().filter(p => offerEnded(p.primary));
    assert.ok(subjects.length > 0, "no vendor page renders an offer its own tier records as ended");
    for (const p of subjects) {
      assert.strictEqual(
        productionAnswer(p),
        `${p.gate!.reason} ${NO_FREE_TIER_FOR_PRODUCTION}`,
        `/vendor/${p.slug}`,
      );
    }
  });

  it("opens with whatever opens the free-tier answer on the same page", () => {
    const subjects = gated().filter(p => freeAnswer(p).startsWith(p.gate!.reason));
    assert.ok(
      subjects.length > 100,
      `only ${subjects.length} gated pages open the free-tier answer with the gate, so this has no subject`,
    );
    const contradicting = subjects
      .filter(p => !productionAnswer(p).startsWith(p.gate!.reason))
      .map(p => `${p.slug} (${p.gate!.code}): ${productionAnswer(p).slice(0, 60)}`);
    assert.deepStrictEqual(contradicting, []);
  });

  it("publishes that answer verbatim on the pages the issue names", () => {
    const stripe = rendered.find(p => p.slug === "stripe")!;
    assert.strictEqual(
      productionAnswer(stripe),
      `${PAY_AS_YOU_GO_REASON} ${NO_FREE_TIER_FOR_PRODUCTION}`,
    );
  });

  it("volunteers no stability rating on a record the ranked surfaces refuse to rate", () => {
    const offenders = gated().filter(p => productionAnswer(p).includes(STABLE_RATING_CLAUSE)).map(p => p.slug);
    assert.deepStrictEqual(offenders, []);
  });

  it("states the pricing history rather than a rating where the level is not stable", () => {
    const subjects = gated().filter(p => productionAnswer(p).includes("is usable for prototyping and development"));
    assert.ok(subjects.length > 0, "no gated page takes the branch that rated the tier");
    for (const p of subjects) {
      const answer = productionAnswer(p);
      assert.ok(answer.startsWith(p.gate!.reason), `/vendor/${p.slug} drops the restriction`);
      assert.ok(!/we rate it (stable|caution|risky)/i.test(answer), `/vendor/${p.slug}: ${answer.slice(0, 160)}`);
      assert.ok(
        ["warrants caution", "is high risk", "has a stable pricing history"].some(
          form => answer.includes(`${p.vendor} ${form}`),
        ),
        `/vendor/${p.slug} names no pricing history: ${answer.slice(0, 160)}`,
      );
    }
  });

  it("keeps the restriction prefix and the rest of the sentence on an eligibility-gated record", () => {
    const subjects = gated().filter(
      p => p.gate!.code === "eligibility_restricted" && productionAnswer(p).includes(RECOMMENDATION_CLAUSE),
    );
    assert.ok(subjects.length > 0, "no eligibility-gated page still recommends the tier");
    for (const p of subjects) {
      const answer = productionAnswer(p);
      assert.ok(answer.startsWith(p.gate!.reason), `/vendor/${p.slug} drops the restriction`);
      assert.ok(answer.includes(`${p.vendor}'s free tier can be suitable for small production workloads`), p.slug);
      assert.ok(answer.includes(`It offers `), `/vendor/${p.slug}: ${answer.slice(0, 160)}`);
    }
  });
});

describe("the heading agrees with the title on the same page", () => {
  it("uses the free-tier form in both places or in neither", () => {
    const disagreeing: string[] = [];
    for (const p of rendered) {
      const titleClaimsFree = / Free Tier \d{4}:/.test(titleOf(p.html));
      const headingClaimsFree = / Free Tier \d{4}\b/.test(headingOf(p.html));
      if (titleClaimsFree !== headingClaimsFree) disagreeing.push(p.slug);
    }
    assert.deepStrictEqual(disagreeing, []);
  });

  it("withholds the free-tier form from a page whose gate says there is no free tier", () => {
    const subjects = gated().filter(p => p.gate!.code === "not_a_free_offer" || p.gate!.code === "offer_expired");
    assert.ok(subjects.length > 0, "no record is gated as not a free offer or as expired");
    for (const p of subjects) {
      assert.ok(!/ Free Tier \d{4}/.test(headingOf(p.html)), `/vendor/${p.slug} is headed ${headingOf(p.html)}`);
      assert.ok(!/ Free Tier \d{4}:/.test(titleOf(p.html)), `/vendor/${p.slug} is titled ${titleOf(p.html)}`);
    }
  });

  it("keeps it on a page whose gate is the restriction rather than the tier", () => {
    const restricted = gated().filter(p => p.gate!.code === "eligibility_restricted");
    const heading = restricted.filter(p => / Free Tier \d{4}/.test(headingOf(p.html))).length;
    assert.ok(heading > 100, `only ${heading} of ${restricted.length} restricted pages still head a free tier`);
  });

  it("heads a page whose title withholds the free-tier form with the pricing form", () => {
    const withheld = rendered.filter(p => !offerEnded(p.primary) && !/ Free Tier \d{4}:/.test(titleOf(p.html)));
    assert.ok(withheld.length > 0, "every live vendor page titles itself as a free tier");
    for (const p of withheld) {
      assert.ok(
        headingOf(p.html).startsWith(`${p.vendor} Pricing `),
        `/vendor/${p.slug} is headed ${headingOf(p.html)}`,
      );
    }
  });
});

describe("a reader sees why the record is gated without opening the FAQ", () => {
  it("carries a gate line on every gated page except the ended ones", () => {
    for (const p of gated().filter(x => x.gate!.code !== "offer_retired")) {
      const line = gateLineOf(p.html);
      assert.ok(line, `/vendor/${p.slug} states no gate above the fold`);
      assert.ok(line!.includes(p.gate!.code), `/vendor/${p.slug} names no gate code`);
      assert.ok(line!.includes(p.gate!.reason), `/vendor/${p.slug} states no reason: ${line}`);
    }
  });

  it("carries none on an ungated page", () => {
    const offenders = ungated().filter(p => gateLineOf(p.html) !== null).map(p => p.slug);
    assert.deepStrictEqual(offenders, []);
  });

  it("carries none on an ended page, which states the ending in its own heading", () => {
    const ended = rendered.filter(p => offerEnded(p.primary));
    assert.ok(ended.length > 0, "no record in the index has ended, so this control has no subject");
    for (const p of ended) {
      assert.strictEqual(gateLineOf(p.html), null, `/vendor/${p.slug} repeats the ending as a gate line`);
      assert.ok(headingOf(p.html).includes("free tier retired"), `/vendor/${p.slug} is headed ${headingOf(p.html)}`);
    }
  });

  it("states the expiry date on the page the issue names", () => {
    const digitalocean = rendered.find(p => p.slug === "digitalocean")!;
    assert.ok(
      (gateLineOf(digitalocean.html) ?? "").includes(DIGITALOCEAN_EXPIRY_REASON),
      gateLineOf(digitalocean.html) ?? "no gate line",
    );
  });
});

const CLAIMS_A_RATING = (vendor: string, category: string) => [
  `${vendor}'s free tier offers `,
  `${vendor}'s free tier is considered `,
  `${vendor}'s free tier requires caution`,
  "We rate it stable",
  "We rate it caution",
  "We rate it risky",
  "It's stable —",
  "This is a good sign",
  "This is a positive stability signal",
  `Yes, ${vendor} offers a free tier`,
  `Best for ${category.toLowerCase()} workloads`,
];

const NAMES_A_FREE_TIER = (vendor: string) => [
  `${vendor}'s free tier is called`,
  `${vendor} offers a free tier:`,
];

function visibleText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ");
  return stripped
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function pageProse(p: VendorPage): string {
  const faq = blockOfType(p.html, "FAQPage");
  const answers = (faq?.mainEntity ?? []).map((q: { acceptedAnswer: { text: string } }) => q.acceptedAnswer.text);
  return `${visibleText(p.html)} ${answers.join(" ")}`;
}

function outgrowQuestionAsked(p: VendorPage): boolean {
  const faq = blockOfType(p.html, "FAQPage");
  return (faq?.mainEntity ?? []).some((q: { name: string }) => q.name.startsWith("When will I outgrow"));
}

const offerBlock = (p: VendorPage) => blockOfType(p.html, "WebPage")?.mainEntity?.offers;

const currentVendorRow = (html: string) => /<tr class="current-vendor-row">[\s\S]*?<\/tr>/.exec(html)?.[0] ?? null;

const UNGATED_PAGES_RATING_RELIABILITY = 745;

describe("no page a gated record renders claims a free tier or rates one", () => {
  it("makes none of the claims a page makes about an offer it does list", () => {
    const offenders: string[] = [];
    for (const p of gated()) {
      const prose = pageProse(p);
      for (const claim of CLAIMS_A_RATING(p.vendor, p.primary.category)) {
        if (prose.includes(claim)) offenders.push(`${p.slug} (${p.gate!.code}): ${claim}`);
      }
      if (p.gate!.code === "eligibility_restricted") continue;
      for (const claim of NAMES_A_FREE_TIER(p.vendor)) {
        if (prose.includes(claim)) offenders.push(`${p.slug} (${p.gate!.code}): ${claim}`);
      }
    }
    assert.deepStrictEqual(offenders.slice(0, 20), []);
  });

  it("opens the verdict with the gate's own sentence instead", () => {
    for (const p of gated()) {
      const verdict = /<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/.exec(p.html)?.[1] ?? "";
      assert.ok(
        textOf(verdict).startsWith(textOf(p.gate!.reason)),
        `/vendor/${p.slug} opens ${textOf(verdict).slice(0, 90)}`,
      );
    }
  });

  it("offers no upgrade threshold for a tier it does not list", () => {
    const asked = gated().filter(outgrowQuestionAsked).map(p => p.slug);
    assert.deepStrictEqual(asked.slice(0, 20), []);
    const sectioned = gated().filter(p => p.html.includes('class="section growth-section"')).map(p => p.slug);
    assert.deepStrictEqual(sectioned.slice(0, 20), []);
  });

  it("publishes no zero-price Offer in its structured data", () => {
    const offenders = gated().filter(p => offerBlock(p) !== undefined).map(p => `${p.slug} ${JSON.stringify(offerBlock(p))}`);
    assert.deepStrictEqual(offenders.slice(0, 20), []);
  });

  it("names the gate rather than a rating in its own comparison row", () => {
    const rows = gated().map(p => ({ p, row: currentVendorRow(p.html) })).filter(r => r.row !== null);
    assert.ok(rows.length > 0, "no gated page renders itself in a comparison table");
    for (const { p, row } of rows) {
      assert.ok(!/stability-dot/.test(row!), `/vendor/${p.slug} rates itself in its comparison row`);
      assert.ok(row!.includes(p.gate!.code), `/vendor/${p.slug} states no gate in its comparison row`);
    }
  });
});

const DECLINES_TO_RATE = [
  "so there is nothing to rate",
  "we are not publishing a stability judgement",
];

const RATES_THE_FREE_TIER = (vendor: string) => [
  `${vendor}'s free tier is considered stable`,
  `${vendor}'s free tier is considered risky`,
  `${vendor}'s free tier requires caution`,
  "We rate it stable",
  "We rate it caution",
  "We rate it risky",
];

const QUESTIONS_A_GATE_DOES_NOT_TOUCH = (vendor: string) => [
  `Is ${vendor} free?`,
  `Is ${vendor}'s free tier good for production?`,
  `What changed in ${vendor}'s pricing?`,
  `What category is ${vendor} in?`,
];

const GATED_PAGES_DECLINING_TO_RATE = 100;
const GATED_PAGES_NAMING_A_RESTRICTED_TIER = 130;

describe("no question a gated page asks presupposes what its own answer denies", () => {
  const reliability = (p: VendorPage) => faqAnswer(p.html, `Is ${p.vendor}'s free tier reliable?`);

  it("asks whether the free tier is reliable only where the answer declines to rate it", () => {
    const asking = gated().filter(p => asks(p.html, `Is ${p.vendor}'s free tier reliable?`));
    assert.ok(
      asking.length > GATED_PAGES_DECLINING_TO_RATE,
      `only ${asking.length} gated pages still ask it, so this assertion has almost no subject`,
    );
    const rating = asking
      .filter(p => !DECLINES_TO_RATE.some(form => reliability(p).includes(form)))
      .map(p => `${p.slug} (${p.gate!.code}): ${reliability(p).slice(0, 90)}`);
    assert.deepStrictEqual(rating.slice(0, 20), []);
  });

  it("answers no question naming a free tier with a rating of that tier", () => {
    const subjects = gated().filter(p => faqPairs(p.html).some(pair => /free tier/i.test(pair.q)));
    assert.ok(subjects.length > 0, "no gated page asks about a free tier at all, so this has no subject");
    const offenders: string[] = [];
    for (const p of subjects) {
      for (const { q, a } of faqPairs(p.html)) {
        if (!/free tier/i.test(q)) continue;
        for (const form of RATES_THE_FREE_TIER(p.vendor)) {
          if (a.includes(form)) offenders.push(`${p.slug} (${p.gate!.code}) asked "${q}": ${form}`);
        }
      }
    }
    assert.deepStrictEqual(offenders.slice(0, 20), []);
  });

  it("keeps every question the gate does not touch", () => {
    for (const p of gated()) {
      for (const q of QUESTIONS_A_GATE_DOES_NOT_TOUCH(p.vendor)) {
        assert.ok(asks(p.html, q), `/vendor/${p.slug} no longer asks "${q}"`);
      }
    }
  });

  it("still asks what the tier is where the gate is the restriction rather than the tier", () => {
    const asking = gated().filter(p => asks(p.html, `What is ${p.vendor}'s free tier?`)).length;
    assert.ok(
      asking > GATED_PAGES_NAMING_A_RESTRICTED_TIER,
      `only ${asking} gated pages still ask what the tier is, down from ${GATED_PAGES_NAMING_A_RESTRICTED_TIER}`,
    );
  });
});

describe("the same page an ungated record renders is unchanged", () => {
  it("reads a non-empty ungated population, so the checks below are not vacuous", () => {
    assert.ok(ungated().length > 0, "no record renders an ungated page, so nothing below is checked");
  });

  it("still asks what its free tier is and whether that tier is reliable", () => {
    const silentOnTier = ungated().filter(p => !asks(p.html, `What is ${p.vendor}'s free tier?`)).map(p => p.slug);
    const silentOnReliability = ungated().filter(p => !asks(p.html, `Is ${p.vendor}'s free tier reliable?`)).map(p => p.slug);
    assert.deepStrictEqual(silentOnTier.slice(0, 20), [], "ungated pages that stopped asking what the tier is");
    assert.deepStrictEqual(silentOnReliability.slice(0, 20), [], "ungated pages that stopped asking whether it is reliable");
  });

  it("still makes every one of those claims somewhere", () => {
    const unmade: string[] = [];
    for (const claim of [...CLAIMS_A_RATING("<vendor>", "<category>"), ...NAMES_A_FREE_TIER("<vendor>")]) {
      const made = ungated().filter(p =>
        pageProse(p).includes(
          claim.replace(/<vendor>/g, p.vendor).replace(/<category>/g, p.primary.category.toLowerCase()),
        ),
      ).length;
      if (made === 0) unmade.push(claim);
    }
    assert.deepStrictEqual(unmade, [], "claims no ungated page makes, so the gated assertion above is vacuous for them");
  });

  it("still opens its verdict on the free tier", () => {
    const notOpening = publishingItsTerms().filter(p => !pageProse(p).includes(`${p.vendor}'s free tier offers `)).map(p => p.slug);
    assert.ok(
      notOpening.length < publishingItsTerms().length * 0.01,
      `${notOpening.length} ungated verdicts do not open on the free tier: ${notOpening.slice(0, 20).join(", ")}`,
    );
  });

  it("opens the verdict on the supersession where the change log holds one", () => {
    const subjects = ungated().filter(supersededTerms);
    assert.ok(subjects.length > 100, `only ${subjects.length} ungated pages withhold superseded terms`);
    const opening = subjects.filter(p => pageProse(p).includes(`${p.vendor}'s free tier offers `)).map(p => p.slug);
    assert.deepStrictEqual(opening.slice(0, 20), [], "verdicts still opening on figures the change log supersedes");
    const silent = subjects
      .filter(p => !pageProse(p).includes(`names them as the previous ones`))
      .map(p => p.slug);
    assert.deepStrictEqual(silent.slice(0, 20), [], "verdicts that withhold the figures without saying why");
  });

  it("still rates the free tier in its reliability answer", () => {
    const rating = ungated().filter(p => {
      const answer = faqAnswer(p.html, `Is ${p.vendor}'s free tier reliable?`);
      return /is considered stable|requires caution|is considered risky/.test(answer);
    }).length;
    assert.ok(
      rating >= UNGATED_PAGES_RATING_RELIABILITY,
      `${rating} ungated pages rate the tier, down from ${UNGATED_PAGES_RATING_RELIABILITY}`,
    );
  });

  it("still answers when the reader will outgrow it", () => {
    const unanswered = ungated().filter(p => !outgrowQuestionAsked(p)).map(p => p.slug);
    assert.deepStrictEqual(unanswered.slice(0, 20), [], "ungated pages that stopped answering when the reader outgrows the tier");
  });

  it("still publishes a zero-price Offer", () => {
    const missing = publishingItsTerms().filter(p => offerBlock(p)?.price !== "0").map(p => p.slug);
    assert.deepStrictEqual(missing.slice(0, 20), [], "ungated pages that stopped publishing a zero-price Offer");
  });

  it("publishes none where the change log supersedes the terms behind it", () => {
    const offering = ungated().filter(p => supersededTerms(p) && offerBlock(p) !== undefined).map(p => p.slug);
    assert.deepStrictEqual(offering.slice(0, 20), [], "pages offering a price of zero for terms we withhold");
  });
});
