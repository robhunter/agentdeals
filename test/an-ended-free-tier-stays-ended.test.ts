import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import type { DealChange } from "../dist/types.js";
import type { VendorVerdictInput } from "../dist/vendor-verdict.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { freeTierClaim, endedClaimVerdictSentence, endedClaimReliabilityAnswer } = await import("../dist/vendor-verdict.js");
const { endingTheListingConfirms, vendorVerdictContextFrom } = await import("../dist/vendor-verdict-input.js");
const { loadOffers, loadDealChanges, riskCauseOf, vendorRiskAssessment } = await import("../dist/data.js");
const { toSlug } = await import("../dist/vendor-slug.js");
const { utcDate } = await import("../dist/ranking.js");

const TWO_YEARS_AGO = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const ONE_YEAR_AGO = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function record(over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Fixture Vendor",
    change_type: "free_tier_removed",
    date: TWO_YEARS_AGO,
    date_source: "vendor_page",
    summary: "The free plan was withdrawn.",
    previous_state: "Free plan",
    current_state: "14-day trial",
    impact: "high",
    source_url: "https://fixture.example/pricing",
    ...over,
  } as DealChange;
}

function inputFor(changes: DealChange[], tier: string): VendorVerdictInput {
  const assessment = vendorRiskAssessment(changes);
  return {
    vendor: "Fixture Vendor",
    tier,
    level: assessment.level,
    historyLevel: assessment.level,
    cause: riskCauseOf(assessment.cause),
    endingTheListingConfirms: endingTheListingConfirms({ tier }, changes),
    changes,
    levelWithheld: null,
    unconfirmableSince: "",
    termsConfirmedOn: utcDate(),
    lastReadOn: utcDate(),
  };
}

describe("a free tier our record says ended stays ended after its first year", () => {
  it("rates a removal older than a year as caution, which is why the claim cannot rest on the level", () => {
    assert.strictEqual(vendorRiskAssessment([record()]).level, "caution");
  });

  it("states the free tier ended when the listing records no free tier either", () => {
    const claim = freeTierClaim(inputFor([record()], "Trial"));
    assert.strictEqual(claim.states, "ended");
    assert.strictEqual(claim.states === "ended" && claim.how === "removed" ? claim.cause.date : null, TWO_YEARS_AGO);
  });

  it("keeps the rating where the listing still records a free tier, as when a vendor ended one product's free plan and we list another that is free", () => {
    const claim = freeTierClaim(inputFor([record()], "Free (open-source library; managed cloud is paid-only)"));
    assert.deepStrictEqual(claim, { states: "offered", level: "caution" });
  });

  it("does not state an ending a later free tier reversed", () => {
    const restored = record({ change_type: "new_free_tier", date: ONE_YEAR_AGO, current_state: "Free plan again" });
    assert.strictEqual(endingTheListingConfirms({ tier: "Trial" }, [record(), restored]), null);
  });

  it("does not state an ending we retracted", () => {
    const retracted = record({ resolution: { state: "retracted", date: utcDate(), detail: "Not a removal." } } as Partial<DealChange>);
    assert.strictEqual(endingTheListingConfirms({ tier: "Trial" }, [retracted]), null);
  });

  it("does not state an ending from a record that cites no source", () => {
    assert.strictEqual(endingTheListingConfirms({ tier: "Trial" }, [record({ source_url: "" })]), null);
  });

  it("names the record that ended the free tier as the cause, not a later narrowing that set the level", () => {
    const narrowing = record({ change_type: "limits_reduced", date: THIRTY_DAYS_AGO, summary: "The trial got shorter." });
    const input = inputFor([record(), narrowing], "Trial");
    assert.strictEqual(input.cause?.change_type, "limits_reduced", "the narrowing does not set the level, so this proves nothing");
    const claim = freeTierClaim(input);
    assert.strictEqual(claim.states === "ended" && claim.how === "removed" ? claim.cause.change_type : null, "free_tier_removed");
  });
});

describe("an ended free tier is stated in place of a rating, naming the record that ended it", () => {
  const removal = riskCauseOf(record({ date: "2024-11-17" }))!;
  const shutdown = riskCauseOf(record({ change_type: "product_deprecated", date: "2026-08-28", summary: "The product is being sunset." }))!;

  it("states a removal as the end of the free tier and publishes no rating", () => {
    assert.strictEqual(
      endedClaimVerdictSentence(removal),
      "Its free tier has ended — one recorded free tier removal, on 2024-11-17. We no longer rate it.",
    );
  });

  it("states a deprecation as the product being shut down and publishes no rating", () => {
    assert.strictEqual(
      endedClaimVerdictSentence(shutdown),
      "The product is being shut down — one recorded product deprecation, on 2026-08-28. We no longer rate it.",
    );
  });

  it("answers whether the free tier is reliable with the removal and its source", () => {
    assert.strictEqual(
      endedClaimReliabilityAnswer("Fixture Vendor", removal),
      "Fixture Vendor's free tier has ended — one recorded free tier removal, on 2024-11-17: The free plan was withdrawn. Source: https://fixture.example/pricing There is no free tier left to rate.",
    );
  });

  it("answers whether the free tier is reliable with the deprecation and its source", () => {
    assert.strictEqual(
      endedClaimReliabilityAnswer("Fixture Vendor", shutdown),
      "Fixture Vendor is shutting the product down — one recorded product deprecation, on 2026-08-28: The product is being sunset. Source: https://fixture.example/pricing We don't rate a product that is ending.",
    );
  });
});

describe("no badge sells a free tier that our record and our listing both say has ended", () => {
  let proc: ChildProcess | null = null;
  let port = 0;

  before(async () => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    proc = child;
    port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
    });
  });

  after(() => { proc?.kill(); });

  it("labels each such vendor's badge as ended or unrated, never as a free tier on offer", async () => {
    const offers = loadOffers();
    const changes = loadDealChanges();
    const vendors = [...new Set(offers.map((o: { vendor: string }) => o.vendor))] as string[];
    const population = vendors.filter((vendor) => {
      const vendorChanges = changes.filter((c: DealChange) => c.vendor.toLowerCase() === vendor.toLowerCase());
      const listing = offers.find((o: { vendor: string }) => o.vendor === vendor)!;
      return endingTheListingConfirms(listing, vendorChanges) !== null;
    });
    assertPopulationFloor(population.length, 1, "vendors whose record and listing both say the free tier ended");

    const sellingOne: string[] = [];
    for (const vendor of population) {
      const svg = await (await fetch(`http://localhost:${port}/badge/${toSlug(vendor)}.svg`)).text();
      const label = (svg.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").split(": ").slice(1).join(": ").split(" · ")[0].trim();
      if (["active", "at risk", "stale"].includes(label)) sellingOne.push(`${vendor}: ${label}`);
    }
    assert.deepStrictEqual(sellingOne, [], "a badge says the free tier is on offer where our record and our listing say it ended");
  });

  it("builds the same ending into the verdict every surface reads", () => {
    const offers = loadOffers();
    const changes = loadDealChanges();
    const vendor = offers.find((o: { vendor: string; tier: string }) => {
      const vendorChanges = changes.filter((c: DealChange) => c.vendor.toLowerCase() === o.vendor.toLowerCase());
      return endingTheListingConfirms(o, vendorChanges) !== null;
    })!;
    const vendorChanges = changes.filter((c: DealChange) => c.vendor.toLowerCase() === vendor.vendor.toLowerCase());
    const context = vendorVerdictContextFrom({
      vendor: vendor.vendor,
      vendorOffers: offers.filter((o: { vendor: string }) => o.vendor === vendor.vendor),
      vendorChanges,
      refusedReads: [],
      servedOn: utcDate(),
    });
    assert.deepStrictEqual(context!.input.endingTheListingConfirms, endingTheListingConfirms(vendor, vendorChanges));
  });
});

describe("the vendor page heading states the ending its badge states", () => {
  let proc: ChildProcess | null = null;
  let port = 0;
  let sweep: Promise<VendorPageReading[]> | null = null;

  before(async () => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    proc = child;
    port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
    });
  });

  after(() => { proc?.kill(); });

  const ENDING_LABELS = ["free tier removed", "deprecated", "retired"];
  const REMOVAL_LABELS = ["free tier removed", "deprecated"];
  const DISCONTINUED_GATE = "product_discontinued";
  const RATING_PHRASES = ["rate it caution", "rate it risky", "requires caution", "considered risky"];
  const VERDICT_OPENING_FOR_HEADING: Record<string, string> = {
    "free tier removed": "Its free tier has ended — one recorded ",
    "deprecated": "The product is being shut down — one recorded ",
  };

  interface VendorPageReading {
    slug: string;
    heading: string | null;
    badge: string;
    badgeMonth: string;
    causeLabel: string | null;
    causeDate: string | null;
    gate: string | null;
    lapseLine: string | null;
    verdict: string;
    ratingStated: string[];
  }

  function textOf(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&mdash;/g, "—")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function readVendorPage(slug: string): Promise<VendorPageReading> {
    const [page, svg] = await Promise.all([
      fetch(`http://localhost:${port}/vendor/${slug}`).then((r) => r.text()),
      fetch(`http://localhost:${port}/badge/${slug}.svg`).then((r) => r.text()),
    ]);
    const h1 = page.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? "";
    const heading = h1.match(/<span class="risk-badge"[^>]*>([^<]*)<\/span>/)?.[1] ?? null;
    const causeLine = page.match(/<p class="risk-cause-line"[^>]*><strong[^>]*>([^<]*)<\/strong> <span class="risk-cause-date"[^>]*>([^<]*)<\/span>/);
    const lapseLine = page.match(/<p class="verdict-lapse-line"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? null;
    const [badge, badgeMonth] = (svg.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").split(": ").slice(1).join(": ").split(" · ").map((s) => s.trim());
    const text = textOf(page).toLowerCase();
    return {
      slug,
      heading,
      badge,
      badgeMonth,
      causeLabel: causeLine?.[1] ?? null,
      causeDate: causeLine?.[2].match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
      gate: page.match(/<p class="gate-line"[^>]*><strong[^>]*>([^<]*)<\/strong>/)?.[1] ?? null,
      lapseLine: lapseLine === null ? null : textOf(lapseLine),
      verdict: textOf(page.match(/<div class="quick-verdict">([\s\S]*?)<\/div>/)?.[1] ?? ""),
      ratingStated: RATING_PHRASES.filter((phrase) => text.includes(phrase)),
    };
  }

  function everyVendorPage(): Promise<VendorPageReading[]> {
    sweep ??= (async () => {
      const sitemap = await (await fetch(`http://localhost:${port}/sitemap-vendors.xml`)).text();
      const slugs = [...new Set([...sitemap.matchAll(/\/vendor\/([^<\/"]+)</g)].map((m) => m[1]))];
      const readings: VendorPageReading[] = [];
      for (let i = 0; i < slugs.length; i += 16) {
        readings.push(...(await Promise.all(slugs.slice(i, i + 16).map(readVendorPage))));
      }
      return readings;
    })();
    return sweep;
  }

  async function pagesHeadedWithARemoval(): Promise<VendorPageReading[]> {
    const headed = (await everyVendorPage()).filter((r) => REMOVAL_LABELS.includes(r.heading ?? ""));
    assertPopulationFloor(headed.length, 1, "vendor pages headed with a removed or deprecated free tier");
    return headed;
  }

  it("heads every vendor page whose free tier ended with the label its badge carries, and says how it ended", async () => {
    const disagreeing: string[] = [];
    for (const r of await everyVendorPage()) {
      if (r.gate === DISCONTINUED_GATE) continue;
      if ((ENDING_LABELS.includes(r.badge) || ENDING_LABELS.includes(r.heading ?? "")) && r.heading !== r.badge) {
        disagreeing.push(`${r.slug}: heading ${r.heading}, badge ${r.badge}`);
      }
    }
    const headed = await pagesHeadedWithARemoval();
    const unexplained = headed.filter((r) => r.causeLabel !== "How it ended:").map((r) => `${r.slug}: ${r.causeLabel}`);
    const misdated = headed.flatMap((r) => {
      const month = r.causeDate
        ? new Date(r.causeDate + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
        : null;
      return month === r.badgeMonth ? [] : [`${r.slug}: heading names ${r.causeDate}, badge ${r.badgeMonth}`];
    });
    assert.deepStrictEqual(disagreeing, [], "a vendor page heading and its badge disagree about an ended free tier");
    assert.deepStrictEqual(unexplained, [], "a heading states an ending without saying how it ended");
    assert.deepStrictEqual(misdated, [], "a heading names a different record from the one its badge dates");
  });

  it("heads a vendor page as retired where the product_discontinued gate says the product has already ended, whatever its badge says", async () => {
    const gated = (await everyVendorPage()).filter((r) => r.gate === DISCONTINUED_GATE);
    assertPopulationFloor(gated.length, 1, "vendor pages the product_discontinued gate covers");
    assert.deepStrictEqual(
      gated.filter((r) => r.heading !== "retired").map((r) => `${r.slug}: heading ${r.heading}, badge ${r.badge}`),
      [],
      "a vendor page whose product has already been discontinued is headed with something other than retired",
    );
  });

  it("states no rating anywhere on a vendor page whose badge says its free tier ended, FAQPage answers included", async () => {
    const ended = (await everyVendorPage()).filter((r) => ENDING_LABELS.includes(r.badge));
    assertPopulationFloor(ended.length, 1, "vendor pages whose badge says the free tier ended");
    assert.deepStrictEqual(
      ended.filter((r) => r.ratingStated.length > 0).map((r) => `${r.slug}: ${r.ratingStated.join(", ")}`),
      [],
      "a vendor page whose badge says the free tier ended still states a rating",
    );
  });

  it("opens the verdict on a vendor page headed with a removal with the ending its heading names", async () => {
    const mismatched = (await pagesHeadedWithARemoval())
      .filter((r) => !r.verdict.includes(VERDICT_OPENING_FOR_HEADING[r.heading!]))
      .map((r) => `${r.slug} (${r.heading}): ${r.verdict.slice(-160)}`);
    assert.deepStrictEqual(mismatched, [], "a verdict does not state the ending its heading names");
  });

  it("says the record under a heading that states a removal is a standing condition, which does not lapse", async () => {
    const lapsing = (await pagesHeadedWithARemoval())
      .filter((r) => r.lapseLine === null || !r.lapseLine.includes("rests on a standing condition, so it does not lapse"))
      .map((r) => `${r.slug}: ${r.lapseLine}`);
    assert.deepStrictEqual(lapsing, [], "a page headed with a removal dates its verdict to lapse, or says nothing about lapsing");
  });

  it("keeps stating the rating on a vendor page whose badge still rates a vendor on a free-tier removal", async () => {
    const offers = loadOffers();
    const changes = loadDealChanges();
    const pages = new Map((await everyVendorPage()).map((r) => [r.slug, r]));
    const vendors = [...new Set(offers.map((o: { vendor: string }) => o.vendor))] as string[];
    const rated = vendors.flatMap((vendor) => {
      const context = vendorVerdictContextFrom({
        vendor,
        vendorOffers: offers.filter((o: { vendor: string }) => o.vendor === vendor),
        vendorChanges: changes.filter((c: DealChange) => c.vendor.toLowerCase() === vendor.toLowerCase()),
        refusedReads: [],
        servedOn: utcDate(),
      });
      const page = pages.get(toSlug(vendor));
      return context?.input.cause?.change_type === "free_tier_removed" && page?.badge === "at risk" ? [page] : [];
    });
    assertPopulationFloor(rated.length, 1, "vendor pages whose badge rates the vendor on a free-tier removal");
    assert.deepStrictEqual(
      rated.filter((r) => r.ratingStated.length === 0).map((r) => r.slug),
      [],
      "a vendor page whose badge still rates the vendor on a free-tier removal stopped stating the rating",
    );
  });
});
