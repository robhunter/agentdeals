import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import type { DealChange } from "../dist/types.js";

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
  changesByVendor,
  refusalsForVendor,
  vendorRiskAssessment,
  verdictHasLapsed,
} = await import("../dist/data.js");
const { demotionTheVerdictNames } = await import("../dist/vendor-verdict.js");
const { utcDate } = await import("../dist/ranking.js");
const { vendorVerdictContextFrom } = await import("../dist/vendor-verdict-input.js");
const { toSlug } = await import("../dist/vendor-slug.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const DAY = 24 * 60 * 60 * 1000;
const EVERY_NTH_UNDEMOTED_PAGE = 7;
const PAGES_NAMING_A_LAPSING_DEMOTION_FLOOR = 140;

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

describe("the vendor pages", () => {
  let server: { proc: ChildProcess; base: string };
  const naming: string[] = [];
  const silent: string[] = [];

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
    }
    server = await startServer();
  });

  after(() => server?.proc.kill());

  const lapseLineOf = async (slug: string): Promise<string | null> => {
    const body = await (await fetch(`${server.base}/vendor/${slug}`)).text();
    const found = body.match(/<p class="verdict-lapse-line"[^>]*>([\s\S]*?)<\/p>/);
    return found ? found[1].replace(/<[^>]+>/g, " ").replace(/&mdash;/g, "—").replace(/\s+/g, " ").trim() : null;
  };

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
    const offers = loadOffers();
    const withholding = [...new Set(
      offers
        .filter(offer => vendorRiskAssessment(recordsFor(offer.vendor), Date.now()).rating_withheld !== null)
        .map(offer => toSlug(offer.vendor)),
    )];
    assert.ok(withholding.length > 0, "no vendor in the catalogue withholds a rating, so this reads nothing");
    const quiet: string[] = [];
    for (const slug of withholding) {
      const body = await (await fetch(`${server.base}/vendor/${slug}`)).text();
      const found = body.match(/<p class="rating-withheld-line"[^>]*>([\s\S]*?)<\/p>/);
      const line = found ? found[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
      if (!line.includes(A_WITHHELD_RATING_DOES_NOT_LAPSE)) quiet.push(slug);
    }
    assert.deepStrictEqual(
      quiet.slice(0, 8),
      [],
      `${quiet.length} of ${withholding.length} vendor pages withhold a rating without saying the withholding does not expire`,
    );
  });
});
