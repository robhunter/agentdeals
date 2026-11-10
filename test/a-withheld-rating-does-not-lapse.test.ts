import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import type { DealChange } from "../dist/types.js";
import type { VendorVerdictInput } from "../dist/vendor-verdict.js";
import type { VendorVerdictContext } from "../dist/vendor-verdict-input.js";

const {
  A_VERDICT_LAPSES_RULE,
  A_VERDICT_ROLLS_NOTICE,
  A_WITHHELD_RATING_DOES_NOT_LAPSE,
  VERDICT_WINDOW_DAYS,
  demotionCanLapse,
  demotionInForce,
  demotionLapsesOn,
  demotionWithheldForNoSource,
  lapsingDemotionStated,
  loadOffers,
  publishedRisk,
  riskCauseOf,
  changesByVendor,
  refusalsForVendor,
  vendorRiskAssessment,
  verdictHasLapsed,
} = await import("../dist/data.js");
const { demotionTheVerdictNames, withholdingThatDoesNotLapse } = await import("../dist/vendor-verdict.js");
const { utcDate } = await import("../dist/ranking.js");
const { vendorVerdictContextFrom, verdictLapseSentence } = await import("../dist/vendor-verdict-input.js");
const { toSlug } = await import("../dist/vendor-slug.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const DAY = 24 * 60 * 60 * 1000;
const EVERY_NTH_UNDEMOTED_PAGE = 7;
const PAGES_NAMING_A_LAPSING_DEMOTION_FLOOR = 25;
const PAGES_READ_AT_ONCE = 12;
const A_DEMOTION_GIVEN_AS_THE_REASON = /<p class="risk-cause-line"[^>]*><strong[^>]*>Why (?:caution|risky):<\/strong>/;
const PAGES_STATING_A_WITHHELD_RATING_FLOOR = 1;

const record = (over: Partial<DealChange> = {}): DealChange => ({
  vendor: "Fixture Vendor",
  change_type: "limits_reduced",
  date: "2026-01-04",
  summary: "Free tier request allowance cut from 1,000 to 100 per day",
  previous_state: "1,000 requests/day",
  current_state: "100 requests/day",
  impact: "high",
  source_url: "https://example.com/pricing",
  category: "Databases",
  alternatives: [],
  date_source: "vendor_page",
  ...over,
});

const uncited = (over: Partial<DealChange> = {}) => record({ source_url: "", ...over });

const atDay = (date: string) => Date.parse(`${date}T00:00:00Z`);

const changeLog = changesByVendor();
const recordsFor = (vendor: string): DealChange[] => changeLog.get(vendor.toLowerCase()) ?? [];

function startServer(): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 120000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, base: `http://localhost:${m[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

describe("a rating we withhold because the record cites no source", () => {
  it("stays withheld after the day a demotion resting on the same record would lapse", () => {
    const wellPast = atDay("2027-06-01");
    assert.ok(
      verdictHasLapsed(uncited(), wellPast),
      "the fixture record has not passed the verdict window, so this proves nothing about what happens when it does",
    );
    assert.deepStrictEqual(
      vendorRiskAssessment([uncited()], wellPast).rating_withheld,
      { reason: "no_source", records: 1 },
    );
  });

  it("stays withheld for as long as we hold the record, at every point in the decade after it", () => {
    for (let year = 0; year < 10; year++) {
      const assessment = vendorRiskAssessment([uncited()], atDay("2026-01-05") + year * 365 * DAY);
      assert.strictEqual(assessment.rating_withheld?.reason, "no_source", `year ${year} after the record`);
      assert.strictEqual(assessment.cause, null, `year ${year} after the record`);
    }
  });

  it("lifts when the record gains a source, and when the record is retracted", () => {
    const wellPast = atDay("2027-06-01");
    const sourced = vendorRiskAssessment([record()], wellPast);
    assert.strictEqual(sourced.rating_withheld, null);

    const retracted = vendorRiskAssessment(
      [uncited({ resolution: { state: "retracted", date: "2026-02-01", note: "The event never happened" } })],
      wellPast,
    );
    assert.strictEqual(retracted.rating_withheld, null);
    assert.strictEqual(demotionWithheldForNoSource(uncited()), "caution");
  });

  it("keeps every rating the catalogue withholds today withheld a year from now", () => {
    const withheldOn = (nowMs: number) => [...new Set(
      loadOffers()
        .filter(offer => vendorRiskAssessment(recordsFor(offer.vendor), nowMs).rating_withheld !== null)
        .map(offer => offer.vendor),
    )].sort();

    const today = withheldOn(Date.now());
    const inAYear = withheldOn(Date.now() + 365 * DAY);
    assert.ok(
      today.length > 0,
      "no vendor in the catalogue withholds a rating today, so this reads a population that is not there",
    );
    assert.deepStrictEqual(
      today.filter(vendor => !inAYear.includes(vendor)),
      [],
      "a rating withheld for want of a source was published a year on, with nothing having been read",
    );
  });
});

describe("a demotion resting on a dated record", () => {
  it("still lapses on the window the catalogue publishes, which the withholding does not touch", () => {
    const cause = record({ date: "2026-01-04" });
    assert.strictEqual(demotionInForce(cause, atDay("2026-02-01")), "caution");
    assert.strictEqual(demotionInForce(cause, atDay(demotionLapsesOn("2026-01-04"))), null);
  });

  it("lapses on the day the page says it lapses, for every record the catalogue holds", () => {
    const lapsing = loadOffers()
      .flatMap(offer => recordsFor(offer.vendor))
      .filter(change => demotionCanLapse(change.change_type) && demotionInForce(change, atDay(change.date)) !== null);
    assert.ok(lapsing.length > 0, "the catalogue holds no record carrying a demotion that can lapse");

    for (const change of lapsing) {
      const stated = demotionLapsesOn(change.date);
      assert.strictEqual(
        demotionInForce(change, atDay(stated) - DAY),
        demotionInForce(change, atDay(change.date)),
        `${change.vendor}: the demotion had already gone the day before ${stated}`,
      );
      assert.strictEqual(
        demotionInForce(change, atDay(stated)),
        null,
        `${change.vendor}: the demotion was still counted on ${stated}`,
      );
    }
  });

  it("is dated by a rule the comparison pages and the vendor pages read from one string", () => {
    assert.ok(A_VERDICT_ROLLS_NOTICE.startsWith(A_VERDICT_LAPSES_RULE));
    assert.ok(lapsingDemotionStated(record()).startsWith(A_VERDICT_LAPSES_RULE));
    assert.ok(A_VERDICT_LAPSES_RULE.includes(`last ${VERDICT_WINDOW_DAYS} days`));
    assert.ok(lapsingDemotionStated(record({ date: "2026-01-04" })).includes(demotionLapsesOn("2026-01-04")));
    assert.ok(!lapsingDemotionStated(record({ change_type: "free_tier_removed" })).includes(demotionLapsesOn("2026-01-04")));
  });

  it("says which end of a record its date came from, as every other rendering of one does", () => {
    assert.ok(lapsingDemotionStated(record({ date_source: "vendor_page" })).includes("effective 2026-01-04"));
    assert.ok(lapsingDemotionStated(record({ date_source: "discovered" })).includes("discovered 2026-01-04"));
    assert.ok(!lapsingDemotionStated(record({ date_source: "discovered" })).includes("record 2026-01-04"));
  });
});

describe("a dated demotion with another standing cause", () => {
  const contextFor = (changes: DealChange[], cause: DealChange): VendorVerdictContext => {
    const primary = {
      vendor: "Fixture Vendor", category: "Databases", tier: "Free",
      description: "100 requests a day", url: "https://example.com/pricing",
      tags: [], verifiedDate: "2026-11-10",
    };
    const context = vendorVerdictContextFrom({
      vendor: primary.vendor, vendorOffers: [primary], vendorChanges: changes,
      refusedReads: [], servedOn: "2026-11-10",
    })!;
    return {
      ...context,
      input: {
        vendor: primary.vendor, tier: primary.tier, level: "caution", historyLevel: "caution",
        cause: riskCauseOf(cause), changes, levelWithheld: null,
        unconfirmableSince: "", termsConfirmedOn: "2026-11-10", lastReadOn: "2026-11-10",
      },
    };
  };

  const scenarios = [
    { name: "discovered pricing restructure over a restriction", date: "2026-10-07", type: "pricing_restructured", source: "discovered", older: "2026-08-05", standing: "restriction", noun: "restriction" },
    { name: "discovered pricing restructure over a removed free tier", date: "2026-10-07", type: "pricing_restructured", source: "discovered", older: "2025-08-31", standing: "free_tier_removed", noun: "free tier removal" },
    { name: "effective limit reduction over a restriction", date: "2026-09-18", type: "limits_reduced", source: "vendor_page", older: "2026-03-01", standing: "restriction", noun: "restriction" },
    { name: "effective pricing restructure over a removed free tier", date: "2026-09-25", type: "pricing_restructured", source: "vendor_page", older: "2025-07-01", standing: "free_tier_removed", noun: "free tier removal" },
    { name: "announced limit reduction over a restriction", date: "2026-12-01", type: "limits_reduced", source: "vendor_page", older: "2026-02-03", standing: "restriction", noun: "restriction" },
  ] as const;

  for (const scenario of scenarios) {
    it(`names the continuing cause for a ${scenario.name}`, () => {
      const event = record({ date: scenario.date, change_type: scenario.type, date_source: scenario.source });
      const standing = record({ date: scenario.older, change_type: scenario.standing });
      const changes = [event, standing];
      const expires = demotionLapsesOn(event.date);
      const after = vendorRiskAssessment(changes, atDay(expires) + DAY);
      assert.strictEqual(after.cause, standing);
      assert.notStrictEqual(after.level, "stable");
      const sentence = verdictLapseSentence(contextFor(changes, event))!;
      assert.ok(sentence.startsWith(A_VERDICT_LAPSES_RULE));
      assert.ok(sentence.includes(`stops counting on ${expires}; the rating then rests on the ${scenario.noun} recorded ${scenario.older}, a standing condition that does not lapse.`), sentence);
      assert.doesNotMatch(sentence, /so it lapses on/);
      assert.ok(sentence.includes(scenario.source === "discovered" ? `discovered ${scenario.date}` : `effective ${scenario.date}`), sentence);
    });
  }

  it("keeps the original date sentence when no standing cause remains", () => {
    const event = record();
    assert.strictEqual(verdictLapseSentence(contextFor([event], event)), lapsingDemotionStated(event, [event]));
  });

  it("keeps an existing standing-condition sentence", () => {
    const standing = record({ change_type: "restriction" });
    assert.strictEqual(verdictLapseSentence(contextFor([standing], standing)), lapsingDemotionStated(standing, [standing]));
  });

  it("keeps the standing ending the page states instead of a later rating cause", () => {
    const event = record({ date: "2026-09-25" });
    const removal = record({ date: "2025-07-01", change_type: "free_tier_removed" });
    const changes = [event, removal];
    const context = contextFor(changes, event);
    context.input.endingTheListingConfirms = riskCauseOf(removal);
    assert.strictEqual(verdictLapseSentence(context), lapsingDemotionStated(removal, changes));
  });

  it("names the standing cause after a restored removal stops counting", () => {
    const restored = record({ date: "2026-10-07", change_type: "free_tier_removed", resolution: { state: "reversed", date: "2026-10-10", detail: "The free plan returned" } });
    const restriction = record({ date: "2026-03-01", change_type: "restriction" });
    const changes = [restored, restriction];
    const sentence = verdictLapseSentence(contextFor(changes, restored))!;
    assert.ok(sentence.includes(`stops counting on ${demotionLapsesOn(restored.date)}; the rating then rests on the restriction recorded 2026-03-01`), sentence);
  });

  it("does not borrow a standing condition from another tier", () => {
    const event = record();
    const otherTier = record({ date: "2025-08-01", change_type: "restriction", tier: "Enterprise", summary: "Enterprise requests require a contract" });
    assert.strictEqual(verdictLapseSentence(contextFor([event, otherTier], event)), lapsingDemotionStated(event, [event]));
  });

  it("does not continue a retracted, reversed or uncited restriction", () => {
    const event = record();
    for (const over of [
      { resolution: { state: "retracted", date: "2025-09-01", note: "The restriction was an error" } },
      { resolution: { state: "reversed", date: "2025-09-01", detail: "The restriction was lifted" } },
      { source_url: "" },
    ] satisfies Partial<DealChange>[]) {
      const standing = record({ date: "2025-08-01", change_type: "restriction", ...over });
      assert.strictEqual(verdictLapseSentence(contextFor([event, standing], event)), lapsingDemotionStated(event, [event, standing]));
    }
  });

  it("does not call a restored free tier a standing condition", () => {
    const event = record();
    const removal = record({ date: "2025-08-01", change_type: "free_tier_removed" });
    const restoration = record({ date: "2025-09-01", change_type: "new_free_tier", current_state: "Free plan: 100 requests/day" });
    const changes = [event, removal, restoration];
    assert.strictEqual(verdictLapseSentence(contextFor(changes, event)), lapsingDemotionStated(event, changes));
  });

  it("names the standing cause selected by the rating instead of the first standing record", () => {
    const event = record({ date: "2026-01-04" });
    const older = record({ date: "2025-07-01", change_type: "restriction" });
    const newer = record({ date: "2025-08-01", change_type: "restriction" });
    const sentence = verdictLapseSentence(contextFor([event, older, newer], event))!;
    assert.ok(sentence.includes("the restriction recorded 2025-08-01, a standing condition"), sentence);
    assert.ok(!sentence.includes("recorded 2025-07-01"), sentence);
  });

  it("keeps silence when the page names no demotion", () => {
    const event = record();
    const context = contextFor([event], event);
    context.input.level = "stable";
    context.input.historyLevel = "stable";
    context.input.cause = null;
    assert.strictEqual(verdictLapseSentence(context), null);
  });
});

describe("the narrowing the page reads before it states a withholding", () => {
  const withheld = { reason: "no_source", records: 1 } as const;
  const input = (over: Partial<VendorVerdictInput> = {}): VendorVerdictInput => ({
    vendor: "Fixture Vendor",
    level: null,
    historyLevel: "caution",
    cause: null,
    changes: [uncited()],
    levelWithheld: null,
    unconfirmableSince: "",
    termsConfirmedOn: "",
    ratingWithheld: withheld,
    ...over,
  });

  it("states the withholding on an offer a reader can still get", () => {
    assert.deepStrictEqual(withholdingThatDoesNotLapse(input()), withheld);
  });

  it("states nothing where the offer has ended, because the ending is why there is no rating", () => {
    assert.strictEqual(withholdingThatDoesNotLapse(input({ offerEnded: true })), null);
  });

  it("states nothing where a gate already answers why there is no rating", () => {
    assert.strictEqual(withholdingThatDoesNotLapse(input({ gate: "offer_retired" })), null);
  });

  it("states nothing where no rating is withheld", () => {
    assert.strictEqual(withholdingThatDoesNotLapse(input({ ratingWithheld: null })), null);
  });
});

describe("the vendor pages", () => {
  let server: { proc: ChildProcess; base: string };
  const naming: string[] = [];
  const silent: string[] = [];
  const statingAWithholding: string[] = [];
  const withholdingSuppressed: string[] = [];

  before(async () => {
    const offers = loadOffers();
    const servedOn = utcDate();
    const byVendor = new Map<string, typeof offers>();
    for (const offer of offers) {
      if (!byVendor.has(offer.vendor)) byVendor.set(offer.vendor, []);
      byVendor.get(offer.vendor)!.push(offer);
    }
    for (const [vendor, vendorOffers] of byVendor) {
      const context = vendorVerdictContextFrom({
        vendor,
        vendorOffers,
        vendorChanges: recordsFor(vendor),
        refusedReads: refusalsForVendor(vendor),
        servedOn,
      });
      if (!context) continue;
      (demotionTheVerdictNames(context.input) ? naming : silent).push(toSlug(vendor));
      if (!context.input.ratingWithheld) continue;
      (withholdingThatDoesNotLapse(context.input) ? statingAWithholding : withholdingSuppressed).push(toSlug(vendor));
    }
    server = await startServer();
  });

  after(() => server?.proc.kill());

  const lapseLineIn = (body: string): string | null => {
    const found = body.match(/<p class="verdict-lapse-line"[^>]*>([\s\S]*?)<\/p>/);
    return found ? found[1].replace(/<[^>]+>/g, " ").replace(/&mdash;/g, "—").replace(/\s+/g, " ").trim() : null;
  };

  const lapseLineOf = async (slug: string): Promise<string | null> =>
    lapseLineIn(await (await fetch(`${server.base}/vendor/${slug}`)).text());

  it("say when the demotion they publish lapses, on every page that publishes one", async () => {
    assertPopulationFloor(naming.length, PAGES_NAMING_A_LAPSING_DEMOTION_FLOOR, "vendor pages publishing a demotion");
    const quiet: string[] = [];
    for (const slug of naming) {
      const line = await lapseLineOf(slug);
      if (line === null || !line.startsWith(A_VERDICT_LAPSES_RULE)) quiet.push(slug);
    }
    assert.deepStrictEqual(
      quiet.slice(0, 8),
      [],
      `${quiet.length} of ${naming.length} vendor pages publish a demotion without saying what makes it lapse`,
    );
  });

  it("say when the demotion lapses on every page giving one as the reason for its rating, read off the page itself", async () => {
    const everyPage = [...new Set(loadOffers().map(offer => toSlug(offer.vendor)))];
    const givingAReason: string[] = [];
    const quiet: string[] = [];
    const unanswered: string[] = [];
    await Promise.all(Array.from({ length: PAGES_READ_AT_ONCE }, async () => {
      for (let slug = everyPage.pop(); slug !== undefined; slug = everyPage.pop()) {
        const res = await fetch(`${server.base}/vendor/${slug}`);
        const body = await res.text();
        if (!res.ok) unanswered.push(slug);
        if (!A_DEMOTION_GIVEN_AS_THE_REASON.test(body)) continue;
        givingAReason.push(slug);
        const line = lapseLineIn(body);
        if (line === null || !line.startsWith(A_VERDICT_LAPSES_RULE)) quiet.push(slug);
      }
    }));
    assert.deepStrictEqual(unanswered.sort().slice(0, 8), [], `${unanswered.length} vendor pages did not answer`);
    assertPopulationFloor(givingAReason.length, 1, "vendor pages giving a demotion as the reason for their rating");
    assert.deepStrictEqual(
      quiet.sort().slice(0, 8),
      [],
      `${quiet.length} of ${givingAReason.length} vendor pages give a demotion as the reason for their rating without saying what makes it lapse`,
    );
  });

  it("never promise that a rating lapses while a cited cause still demotes its listed tier", async () => {
    const primary = new Map<string, ReturnType<typeof loadOffers>[number]>();
    for (const offer of loadOffers()) {
      if (!primary.has(offer.vendor)) primary.set(offer.vendor, offer);
    }
    const promises: string[] = [];
    const incorrect: string[] = [];
    for (const [vendor, offer] of primary) {
      const line = await lapseLineOf(toSlug(vendor));
      const date = line?.match(/so it lapses on (\d{4}-\d{2}-\d{2})/)?.[1];
      if (!date) continue;
      promises.push(vendor);
      const after = new Date(atDay(date) + DAY).toISOString().slice(0, 10);
      const next = publishedRisk(offer, recordsFor(vendor), after, atDay(after));
      if (next.history_level !== "stable" || next.cause !== null) incorrect.push(`${vendor}: ${line}`);
    }
    assert.ok(promises.length > 0, "no vendor page states a rating lapse date");
    assert.deepStrictEqual(incorrect, []);
  });

  it("say nothing about lapsing where they publish no demotion", async () => {
    const sampled = silent.filter((_, at) => at % EVERY_NTH_UNDEMOTED_PAGE === 0);
    assert.ok(sampled.length > 0, "no vendor page in the sample publishes a verdict resting on no demotion");
    const loud: string[] = [];
    for (const slug of sampled) {
      if (await lapseLineOf(slug) !== null) loud.push(slug);
    }
    assert.deepStrictEqual(
      loud.slice(0, 8),
      [],
      `${loud.length} of ${sampled.length} vendor pages date a demotion they do not publish`,
    );
  });

  it("never date a demotion beside a rating that says there is none, read off the badge they publish", async () => {
    const everyPage = [...new Set(loadOffers().map(offer => toSlug(offer.vendor)))].sort();
    const sampled = everyPage.filter((_, at) => at % EVERY_NTH_UNDEMOTED_PAGE === 0);
    const rated: string[] = [];
    const contradicting: string[] = [];
    for (const slug of sampled) {
      const body = await (await fetch(`${server.base}/vendor/${slug}`)).text();
      const badge = body.match(/<span class="risk-badge"[^>]*>([^<]*)</)?.[1]?.trim() ?? null;
      if (badge !== "stable") continue;
      rated.push(slug);
      if (/verdict-lapse-line/.test(body)) contradicting.push(slug);
    }
    assert.ok(
      rated.length > 0,
      `no page in the ${sampled.length} sampled publishes a stable badge, so this reads a population that is not there`,
    );
    assert.deepStrictEqual(
      contradicting.slice(0, 8),
      [],
      `${contradicting.length} of ${rated.length} vendor pages rate a vendor stable and date a demotion against it on the same page`,
    );
  });

  it("state on every page that withholds a rating that the withholding runs on no clock", async () => {
    assertPopulationFloor(
      statingAWithholding.length,
      PAGES_STATING_A_WITHHELD_RATING_FLOOR,
      "vendor pages the renderer states a withheld rating on",
    );
    const quiet: string[] = [];
    for (const slug of statingAWithholding) {
      const body = await (await fetch(`${server.base}/vendor/${slug}`)).text();
      const found = body.match(/<p class="rating-withheld-line"[^>]*>([\s\S]*?)<\/p>/);
      const line = found ? found[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
      if (!line.includes(A_WITHHELD_RATING_DOES_NOT_LAPSE)) quiet.push(slug);
    }
    assert.deepStrictEqual(
      quiet.slice(0, 8),
      [],
      `${quiet.length} of ${statingAWithholding.length} vendor pages withhold a rating without saying the withholding does not expire`,
    );
  });

  it("say nothing about a withholding where the page already answers why there is no rating", async () => {
    for (const slug of withholdingSuppressed) {
      const body = await (await fetch(`${server.base}/vendor/${slug}`)).text();
      assert.doesNotMatch(
        body,
        /class="rating-withheld-line"/,
        `${slug} states a withholding beside the ending or the gate that is the reason`,
      );
    }
  });
});
