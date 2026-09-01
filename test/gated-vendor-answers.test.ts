import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { gateFor, utcDate } = await import("../dist/ranking.js");
const { vendorSlugMap } = await import("../dist/vendor-slug.js");
const { offerEnded } = await import("../dist/retirement.js");

type Offer = import("../src/types.ts").Offer;
type Gate = { code: string; reason: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const TODAY = utcDate();

const PAY_AS_YOU_GO_REASON = 'Tier "Pay-as-you-go" is usage-billed from the first request.';
const DIGITALOCEAN_EXPIRY_REASON = "Offer expired on 2026-06-30.";
const NO_FREE_TIER_FOR_PRODUCTION = "There is no free tier here to run in production.";
const STABLE_RATING_CLAUSE = "We rate it stable and";
const RECOMMENDATION_CLAUSE = "so it's a reasonable starting point";

const UNGATED_PAGES_ANSWERING_YES = 745;
const UNGATED_PAGES_RECOMMENDING = 582;

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
const freeAnswer = (p: VendorPage) => faqAnswer(p.html, `Is ${p.vendor} free?`);
const productionAnswer = (p: VendorPage) => faqAnswer(p.html, `Is ${p.vendor}'s free tier good for production?`);

describe("the page a gated record renders does not answer the free-tier question with yes", () => {
  it("renders one page per vendor and reads the record that page renders", () => {
    assert.ok(rendered.length > 1500, `only ${rendered.length} vendor pages rendered`);
    for (const p of rendered) {
      assert.strictEqual(
        blockOfType(p.html, "WebPage")?.mainEntity?.description,
        p.primary.description,
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
    for (const p of gated().filter(x => x.gate!.code !== "eligibility_restricted" && !offerEnded(x.primary))) {
      const answer = freeAnswer(p);
      const opening = p.primary.description.slice(0, 60);
      assert.ok(
        answer.includes(opening),
        `/vendor/${p.slug} drops the stored terms: ${answer.slice(0, 120)}`,
      );
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

  it("names no free tier in the tier answer either", () => {
    const subjects = gated().filter(p => p.gate!.code !== "eligibility_restricted" && !offerEnded(p.primary));
    assert.ok(subjects.length > 0, "no vendor page renders a record gated outside eligibility");
    for (const p of subjects) {
      const answer = faqAnswer(p.html, `What is ${p.vendor}'s free tier?`);
      assert.ok(answer.startsWith(p.gate!.reason), `/vendor/${p.slug} opens with ${answer.slice(0, 70)}`);
      assert.ok(
        !answer.includes(`${p.vendor}'s free tier is called`),
        `/vendor/${p.slug} still names a free tier`,
      );
    }
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
    const plainlyFree = ungated().filter(
      p => p.primary.source_check?.outcome === "ok"
        && p.primary.tier.toLowerCase() !== "none"
        && !p.primary.description.toLowerCase().includes("no free tier"),
    );
    assert.ok(plainlyFree.length > 100, `only ${plainlyFree.length} ungated pages are plainly free`);
    const quiet = plainlyFree.filter(p => !freeAnswer(p).startsWith("Yes")).map(p => p.slug);
    assert.deepStrictEqual(quiet, []);
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

const CLAIMS_A_RATING = (vendor: string) => [
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

const UNGATED_VERDICTS_OPENING_ON_A_FREE_TIER = 1414;
const UNGATED_PAGES_RATING_RELIABILITY = 745;
const UNGATED_PAGES_ASKING_ABOUT_OUTGROWING = 1415;
const UNGATED_PAGES_PUBLISHING_A_ZERO_PRICE = 1415;

describe("no page a gated record renders claims a free tier or rates one", () => {
  it("makes none of the claims a page makes about an offer it does list", () => {
    const offenders: string[] = [];
    for (const p of gated()) {
      const prose = pageProse(p);
      for (const claim of CLAIMS_A_RATING(p.vendor)) {
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

describe("the same page an ungated record renders is unchanged", () => {
  it("still makes every one of those claims somewhere", () => {
    const unmade: string[] = [];
    for (const claim of [...CLAIMS_A_RATING("<vendor>"), ...NAMES_A_FREE_TIER("<vendor>")]) {
      const made = ungated().filter(p => pageProse(p).includes(claim.replace(/<vendor>/g, p.vendor))).length;
      if (made === 0) unmade.push(claim);
    }
    assert.deepStrictEqual(unmade, [], "claims no ungated page makes, so the gated assertion above is vacuous for them");
  });

  it("still opens its verdict on the free tier", () => {
    const opening = ungated().filter(p => pageProse(p).includes(`${p.vendor}'s free tier offers `)).length;
    assert.ok(
      opening >= UNGATED_VERDICTS_OPENING_ON_A_FREE_TIER,
      `${opening} ungated verdicts open on the free tier, down from ${UNGATED_VERDICTS_OPENING_ON_A_FREE_TIER}`,
    );
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
    const asked = ungated().filter(outgrowQuestionAsked).length;
    assert.ok(
      asked >= UNGATED_PAGES_ASKING_ABOUT_OUTGROWING,
      `${asked} ungated pages answer it, down from ${UNGATED_PAGES_ASKING_ABOUT_OUTGROWING}`,
    );
  });

  it("still publishes a zero-price Offer", () => {
    const publishing = ungated().filter(p => offerBlock(p)?.price === "0").length;
    assert.ok(
      publishing >= UNGATED_PAGES_PUBLISHING_A_ZERO_PRICE,
      `${publishing} ungated pages publish one, down from ${UNGATED_PAGES_PUBLISHING_A_ZERO_PRICE}`,
    );
  });
});
