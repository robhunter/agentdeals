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
        blockOfType(p.html, "WebPage")?.mainEntity?.offers?.description,
        p.primary.tier,
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
