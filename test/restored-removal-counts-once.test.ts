import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DealChange } from "../dist/types.js";
import type { VendorVerdictInput } from "../dist/vendor-verdict.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const {
  A_DEMOTION_IN_FORCE_RULE,
  A_VERDICT_LAPSES_RULE,
  VERDICT_WINDOW_DAYS,
  classifyStability,
  demotionLapsesOn,
  freeTierEndingRecord,
  freeTierRestoredOn,
  lapsingDemotionStated,
  loadDealChanges,
  loadOffers,
  publishedRisk,
  riskCauseOf,
  stabilityDeciders,
  vendorRiskAssessment,
} = await import("../dist/data.js");
const { freeTierClaim, restorationClause, vendorVerdictSentence } = await import("../dist/vendor-verdict.js");
const { DISCOVERED_DATE_PREFIX } = await import("../dist/change-dates.js");
const { listingOffersAFreeTier } = await import("../dist/free-tier-record.js");
const { toSlug } = await import("../dist/vendor-slug.js");
const { utcDate } = await import("../dist/ranking.js");

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const REMOVED_ON = daysAgo(30);
const RESTORED_ON = daysAgo(10);

function record(over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Fixture Vendor",
    change_type: "free_tier_removed",
    date: REMOVED_ON,
    date_source: "vendor_page",
    summary: "The free plan was replaced with a 14-day trial.",
    previous_state: "Free plan, $0 a month",
    current_state: "14-day trial only",
    impact: "high",
    source_url: "https://fixture.example/pricing",
    ...over,
  } as DealChange;
}

function reversed(removedOn: string = REMOVED_ON, restoredOn: string = RESTORED_ON, over: Partial<DealChange> = {}): DealChange {
  return record({
    date: removedOn,
    resolution: { state: "reversed", date: restoredOn, detail: "The free plan is back on the pricing page.", source_url: "https://fixture.example/pricing" },
    ...over,
  });
}

const restoringRecord = (over: Partial<DealChange> = {}) => record({
  change_type: "new_free_tier",
  date: RESTORED_ON,
  summary: "The free plan is back.",
  previous_state: "14-day trial only",
  current_state: "Free plan, $0 a month",
  impact: "medium",
  ...over,
});

const earlierWidening = () => record({
  change_type: "limits_increased",
  date: daysAgo(60),
  summary: "The free plan's monthly requests doubled.",
  previous_state: "Free plan: 1,000 requests a month",
  current_state: "Free plan: 2,000 requests a month",
  impact: "low",
});

function inputFor(changes: DealChange[]): VendorVerdictInput {
  const assessment = vendorRiskAssessment(changes);
  return {
    vendor: "Fixture Vendor",
    tier: "Free",
    level: assessment.level,
    historyLevel: assessment.level,
    cause: riskCauseOf(assessment.cause),
    endingTheListingConfirms: null,
    changes,
    levelWithheld: null,
    unconfirmableSince: "",
    termsConfirmedOn: utcDate(),
    lastReadOn: utcDate(),
  };
}

describe("a free tier the vendor removed and later restored counts once, as caution", () => {
  it("rates caution on a removal marked reversed, with the removal as the cause", () => {
    const assessment = vendorRiskAssessment([reversed()]);
    assert.strictEqual(assessment.level, "caution");
    assert.strictEqual(assessment.cause?.date, REMOVED_ON);
    assert.strictEqual(freeTierRestoredOn(reversed(), [reversed()]), RESTORED_ON);
  });

  it("rates caution, not risky, on a removal a later vendor record restores", () => {
    const restoredByANewTier = [record(), restoringRecord()];
    assert.strictEqual(freeTierRestoredOn(record(), restoredByANewTier), RESTORED_ON);
    assert.strictEqual(vendorRiskAssessment(restoredByANewTier).level, "caution");

    const restoredInWords = [record(), restoringRecord({ change_type: "limits_increased", current_state: "Hobby plan is free: $0 a month, 30+ services" })];
    assert.strictEqual(freeTierRestoredOn(record(), restoredInWords), RESTORED_ON);
    assert.strictEqual(vendorRiskAssessment(restoredInWords).level, "caution");
    assert.strictEqual(vendorRiskAssessment([record()]).level, "risky");
  });

  it("stops counting a restored removal once the removal's date leaves the verdict window, while an unrestored one keeps counting", () => {
    const old = daysAgo(VERDICT_WINDOW_DAYS + 1);
    assert.deepStrictEqual(vendorRiskAssessment([reversed(old)]), { level: "stable", cause: null, rating_withheld: null });
    assert.strictEqual(vendorRiskAssessment([reversed(daysAgo(VERDICT_WINDOW_DAYS - 1))]).level, "caution");
    assert.notStrictEqual(vendorRiskAssessment([record({ date: old })]).level, "stable");
  });

  it("counts a retracted removal for nothing", () => {
    const retracted = record({ resolution: { state: "retracted", date: RESTORED_ON, detail: "Our misreading." } });
    assert.strictEqual(freeTierRestoredOn(retracted, [retracted]), null);
    assert.deepStrictEqual(vendorRiskAssessment([retracted]), { level: "stable", cause: null, rating_withheld: null });
  });

  it("withholds the rating on a restored removal that cites no source or that no archived copy confirms, while it counts", () => {
    const unsourced = reversed(REMOVED_ON, RESTORED_ON, { source_url: "" });
    const assessment = vendorRiskAssessment([unsourced]);
    assert.strictEqual(assessment.level, "stable");
    assert.deepStrictEqual(assessment.rating_withheld, { reason: "no_source", records: 1 });
    const unconfirmed = reversed(REMOVED_ON, RESTORED_ON, { archive_check: { outcome: "no_usable_capture" } } as Partial<DealChange>);
    assert.deepStrictEqual(vendorRiskAssessment([unconfirmed]), { level: "stable", cause: null, rating_withheld: { reason: "unconfirmed", records: 1 } });
    assert.strictEqual(vendorRiskAssessment([reversed(daysAgo(VERDICT_WINDOW_DAYS + 1), RESTORED_ON, { source_url: "" })]).rating_withheld, null);
  });

  it("is not restored by our own correction, by a later removal, or by a later record that denies a free tier", () => {
    const notRestoring = [
      restoringRecord({ change_type: "record_corrected" }),
      restoringRecord({ change_type: "free_tier_removed", current_state: "Pay-per-use pricing, free plan expired Feb 13" }),
      restoringRecord({ change_type: "pricing_restructured", current_state: "No free tier." }),
      restoringRecord({ date: daysAgo(40) }),
      restoringRecord({ resolution: { state: "retracted", date: RESTORED_ON, detail: "Our misreading." } }),
    ];
    for (const later of notRestoring) {
      assert.strictEqual(freeTierRestoredOn(record(), [record(), later]), null, `${later.change_type} ${later.date}: ${later.current_state}`);
    }
  });

  it("is not the record that ends a free tier", () => {
    assert.notStrictEqual(freeTierEndingRecord([record()]), null);
    assert.strictEqual(freeTierEndingRecord([record(), restoringRecord()]), null);
    assert.strictEqual(freeTierEndingRecord([record(), restoringRecord({ change_type: "pricing_restructured", current_state: "Free plan: $0 a month, 1,000 requests" })]), null);
    assert.deepStrictEqual(freeTierClaim(inputFor([reversed()])), { states: "offered", level: "caution" });
  });

  it("counts as one negative change in stability: watch on its own, volatile only beside another", () => {
    assert.strictEqual(classifyStability([reversed()]), "watch");
    assert.strictEqual(classifyStability([record(), restoringRecord()]), "watch");
    assert.strictEqual(classifyStability([record()]), "volatile");
    assert.strictEqual(classifyStability([reversed(), record({ change_type: "limits_reduced", date: daysAgo(20) })]), "volatile");
    assert.strictEqual(classifyStability([record({ resolution: { state: "retracted", date: RESTORED_ON } })]), "stable");
    assert.deepStrictEqual(stabilityDeciders([reversed()]).map(c => c.date), [REMOVED_ON]);
  });

  it("names the removal and the reversal where the rating gives its reason, and says when the rating lapses", () => {
    const only = reversed();
    const sentence = vendorVerdictSentence(inputFor([only]));
    assert.match(sentence, /^We rate it caution\. The one change we have recorded, a free tier removal .+, was reversed on (\d{4}-\d{2}-\d{2})\.$/);
    assert.ok(sentence.includes(REMOVED_ON) && sentence.endsWith(`was reversed on ${RESTORED_ON}.`), sentence);
    assert.match(lapsingDemotionStated(riskCauseOf(only)!), new RegExp(`lapses on ${demotionLapsesOn(REMOVED_ON)} unless`));
    assert.match(lapsingDemotionStated(record(), [record(), restoringRecord()]), new RegExp(`lapses on ${demotionLapsesOn(REMOVED_ON)} unless`));
    assert.match(lapsingDemotionStated(record(), [record()]), /does not lapse/);
  });

  it("names the reversal after the removal's date where the vendor holds other records too", () => {
    assert.strictEqual(
      vendorVerdictSentence(inputFor([reversed(), earlierWidening()])),
      `We rate it caution — one recorded free tier removal, on ${REMOVED_ON}, reversed on ${RESTORED_ON}.`,
    );
  });

  it("names the later record that offered a free plan again, dated the way the removal is", () => {
    assert.strictEqual(
      vendorVerdictSentence(inputFor([record(), restoringRecord()])),
      `We rate it caution — one recorded free tier removal, on ${REMOVED_ON}, after which the vendor offered a free plan again on ${RESTORED_ON}.`,
    );
    const discovered = vendorVerdictSentence(inputFor([record(), restoringRecord({ date_source: "discovered" })]));
    assert.ok(discovered.endsWith(`, after which the vendor offered a free plan again ${DISCOVERED_DATE_PREFIX} ${RESTORED_ON}.`), discovered);
  });

  it("adds nothing to a removal that was not restored", () => {
    assert.strictEqual(restorationClause(riskCauseOf(record())!, [record()]), "");
    assert.strictEqual(restorationClause(riskCauseOf(earlierWidening())!, [earlierWidening(), restoringRecord()]), "");
    assert.doesNotMatch(vendorVerdictSentence(inputFor([record()])), /reversed|again/);
  });

  it("says a withdrawn free tier does not lapse only while it is not restored, on vendor pages and in the at-risk lists", () => {
    assert.ok(
      A_VERDICT_LAPSES_RULE.endsWith("a standing condition — a free tier withdrawn and not restored, a product retired — does not lapse with time."),
      A_VERDICT_LAPSES_RULE,
    );
    assert.ok(
      A_DEMOTION_IN_FORCE_RULE.includes("or a standing condition, also cited, such as a product retired or a free tier withdrawn and not restored, which does not expire with time."),
      A_DEMOTION_IN_FORCE_RULE,
    );
  });
});

function textOf(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function startServerWith(env: Record<string, string>): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

type Subject = { vendor: string; slug: string; category: string };

function stableListingsWithNoRecords(count: number): Subject[] {
  const recorded = new Set((loadDealChanges() as DealChange[]).map(c => c.vendor.toLowerCase()));
  const listings = (loadOffers() as Array<Parameters<typeof publishedRisk>[0] & { category: string }>).filter(offer =>
    listingOffersAFreeTier(offer)
    && !recorded.has(offer.vendor.toLowerCase())
    && publishedRisk(offer, []).risk_level === "stable"
    && publishedRisk(offer, []).stability === "stable");
  const distinct = [...new Map(listings.map(l => [toSlug(l.vendor), l])).entries()].slice(0, count);
  assert.strictEqual(distinct.length, count, `fewer than ${count} listings offer a free tier, hold no record and are rated stable`);
  return distinct.map(([slug, listing]) => ({ vendor: listing.vendor, slug, category: listing.category }));
}

function quickVerdictOf(page: string): string {
  return page.match(/<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "";
}

function productionAnswerOf(page: string): string {
  return page.match(/<summary class="faq-q">[^<]*good for production\?<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>/)?.[1] ?? "";
}

describe("pages rate a vendor whose removed free tier came back as caution, and never as ended", () => {
  let server: { child: ChildProcess; port: number } | null = null;
  let subject: Subject = { vendor: "", slug: "", category: "" };
  let restoredByALaterRecord: Subject = { vendor: "", slug: "", category: "" };
  let reversedBesideAnotherRecord: Subject = { vendor: "", slug: "", category: "" };
  const get = async (route: string) => (await fetch(`http://localhost:${server!.port}${route}`)).text();

  before(async () => {
    [subject, restoredByALaterRecord, reversedBesideAnotherRecord] = stableListingsWithNoRecords(3);
    const log = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"));
    log.changes.push(reversed(REMOVED_ON, RESTORED_ON, { vendor: subject.vendor }));
    log.changes.push(record({ vendor: restoredByALaterRecord.vendor }), restoringRecord({ vendor: restoredByALaterRecord.vendor }));
    log.changes.push(
      reversed(REMOVED_ON, RESTORED_ON, { vendor: reversedBesideAnotherRecord.vendor }),
      { ...earlierWidening(), vendor: reversedBesideAnotherRecord.vendor },
    );
    const scratch = mkdtempSync(path.join(tmpdir(), "restored-removal-"));
    writeFileSync(path.join(scratch, "deal_changes.json"), JSON.stringify(log));
    server = await startServerWith({ AGENTDEALS_CHANGES_PATH: path.join(scratch, "deal_changes.json") });
  });

  after(() => { server?.child.kill(); });

  it("rates it caution on its page, names both dates in the verdict and the production answer, and says when the rating lapses", async () => {
    const page = await get(`/vendor/${subject.slug}`);
    assert.match(page, /<h1>[^<]*<span class="risk-badge"[^>]*>caution<\/span>/, "the heading badge is not caution");
    const reason = new RegExp(`The one change we have recorded, a free tier removal [^<]*${REMOVED_ON}, was reversed on ${RESTORED_ON}\\.`);
    const verdict = page.match(/<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "";
    assert.match(verdict, new RegExp(`We rate it caution\\. ${reason.source}`), verdict);
    const production = page.match(/<summary class="faq-q">[^<]*good for production\?<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>/)?.[1] ?? "";
    assert.match(production, new RegExp(`but we rate it caution\\. ${reason.source}`), production);
    assert.doesNotMatch(production, /because of one recorded/);
    const lapse = page.match(/<p class="verdict-lapse-line"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    assert.match(lapse, new RegExp(`lapses on ${demotionLapsesOn(REMOVED_ON)} unless`), lapse);
    for (const ending of ["Its free tier has ended", "There is no free tier left to rate", "How it ended:"]) {
      assert.ok(!page.includes(ending), `/vendor/${subject.slug} says "${ending}"`);
    }
  });

  it("rates a removal a later vendor record restored caution, says when that lapses, and never says the free tier ended", async () => {
    const page = await get(`/vendor/${restoredByALaterRecord.slug}`);
    assert.match(page, /<h1>[^<]*<span class="risk-badge"[^>]*>caution<\/span>/, "the heading badge is not caution");
    const lapse = page.match(/<p class="verdict-lapse-line"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    assert.match(lapse, new RegExp(`lapses on ${demotionLapsesOn(REMOVED_ON)} unless`), lapse);
    assert.ok(lapse.includes("a standing condition — a free tier withdrawn and not restored, a product retired — does not lapse with time."), lapse);
    for (const ending of ["Its free tier has ended", "There is no free tier left to rate", "How it ended:"]) {
      assert.ok(!page.includes(ending), `/vendor/${restoredByALaterRecord.slug} says "${ending}"`);
    }
  });

  it("names the later record that restored the free plan in the verdict and the production answer", async () => {
    const page = await get(`/vendor/${restoredByALaterRecord.slug}`);
    const reason = `one recorded free tier removal, on ${REMOVED_ON}, after which the vendor offered a free plan again on ${RESTORED_ON}.`;
    assert.ok(quickVerdictOf(page).includes(`We rate it caution — ${reason}`), quickVerdictOf(page));
    assert.ok(productionAnswerOf(page).includes(`but we rate it caution because of ${reason}`), productionAnswerOf(page));
  });

  it("names the reversal after the removal's date in the verdict and the production answer when the vendor holds other records", async () => {
    const page = await get(`/vendor/${reversedBesideAnotherRecord.slug}`);
    assert.match(page, /<h1>[^<]*<span class="risk-badge"[^>]*>caution<\/span>/, "the heading badge is not caution");
    const reason = `one recorded free tier removal, on ${REMOVED_ON}, reversed on ${RESTORED_ON}.`;
    assert.ok(quickVerdictOf(page).includes(`We rate it caution — ${reason}`), quickVerdictOf(page));
    assert.ok(productionAnswerOf(page).includes(`but we rate it caution because of ${reason}`), productionAnswerOf(page));
    assert.doesNotMatch(productionAnswerOf(page), /The one change we have recorded/);
  });

  it("lists it at risk on its category's trends page under the rule that names a free tier withdrawn and not restored", async () => {
    const trends = await get(`/trends/${toSlug(restoredByALaterRecord.category)}`);
    const atRisk = trends.match(/<h2>At-Risk Vendors<\/h2>([\s\S]*?)<\/div>\s*<\/div>/)?.[1] ?? "";
    assert.ok(atRisk.includes(`href="/vendor/${restoredByALaterRecord.slug}"`), `${restoredByALaterRecord.vendor} is not in the at-risk list`);
    assert.ok(atRisk.includes("or a standing condition, also cited, such as a product retired or a free tier withdrawn and not restored, which does not expire with time."), atRisk.slice(0, 600));
  });

  it("lists it under Watch on /stability and badges it at risk", async () => {
    const stability = await get("/stability");
    const watch = stability.match(/<h2>🟡 Watch[\s\S]*?(?=<h2>)/)?.[0] ?? "";
    assert.match(watch, /class="vendor-card"/, "the Watch section did not render");
    assert.ok(watch.includes(`href="/vendor/${subject.slug}"`), `${subject.vendor} is not under Watch`);
    const svg = await get(`/badge/${subject.slug}.svg`);
    const label = textOf(svg.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").split(": ").slice(1).join(": ").split(" · ")[0].trim();
    assert.strictEqual(label, "at risk");
  });
});
