import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const {
  rankOffers,
  rotateListing,
  evaluate,
  gateFor,
  classifyTier,
  timeLimitedTierRule,
  changesByVendor,
  seededShuffle,
  tieBreakSeed,
  utcDate,
  DEMERIT_TABLE,
  GATE_TABLE,
} = await import("../dist/ranking.js");
const { unreachableNoticeForUrl } = await import("../dist/link-health.js");
const { endsAFreeTier } = await import("../dist/product-deprecation.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const index = JSON.parse(readFileSync(join(REPO, "data", "index.json"), "utf8")) as { offers: Offer[] };
const dealChanges = (JSON.parse(readFileSync(join(REPO, "data", "deal_changes.json"), "utf8")) as { changes: DealChange[] }).changes;

const TODAY = "2026-08-25";

function offer(over: Partial<Offer> = {}): Offer {
  return {
    vendor: "Acme",
    category: "Databases",
    description: "A free tier.",
    tier: "Free",
    url: "https://example.com/pricing",
    tags: [],
    verifiedDate: "2026-08-20",
    ...over,
  };
}

function change(over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Acme",
    change_type: "limits_reduced",
    date: "2026-06-01",
    summary: "Halved the row limit.",
    previous_state: "10k rows",
    current_state: "5k rows",
    impact: "medium",
    source_url: "https://example.com/blog",
    category: "Databases",
    alternatives: [],
    ...over,
  };
}

function vendorsOf(entries: { offer: Offer }[]): string[] {
  return entries.map((e) => e.offer.vendor);
}

const SERVE_SOURCE = readFileSync(join(REPO, "src", "serve.ts"), "utf8");
const BEST_OF_MIN_VENDORS = Number(/const BEST_OF_MIN_VENDORS = (\d+);/.exec(SERVE_SOURCE)?.[1]);

const WITHDRAWAL_CHANGE_TYPES = new Set(["free_tier_removed", "open_source_killed", "product_deprecated"]);
const DISCLOSURE_CHANGE_TYPES = new Set(["limits_reduced", "pricing_restructured", "restriction"]);
const ADVERSE_CHANGE_WINDOW_DAYS = 365;
const STALE_VERIFICATION_DAYS = 90;

type Demerit = { code: string; points: number; date?: string; reason: string };
type Demoted = { offer: Offer; demerits: Demerit[] };

function daysApart(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function isRecorded(entry: Demoted, demerit: Demerit, changesForVendor: DealChange[], date: string): boolean {
  switch (demerit.code) {
    case "free_tier_withdrawn":
      return changesForVendor.some((c) =>
        WITHDRAWAL_CHANGE_TYPES.has(c.change_type)
        && !c.resolution
        && endsAFreeTier(c)
        && c.date === demerit.date
        && daysApart(c.date, date) <= ADVERSE_CHANGE_WINDOW_DAYS);
    case "time_limited_offer":
      return classifyTier(entry.offer.tier).class === "time_limited";
    case "expiring_soon":
      return entry.offer.expires_date === demerit.date;
    case "stale_verification":
      return Boolean(entry.offer.verifiedDate) && daysApart(entry.offer.verifiedDate!, date) > STALE_VERIFICATION_DAYS;
    case "link_gone":
    case "link_unreachable":
      return Boolean(unreachableNoticeForUrl(entry.offer.url, Date.parse(date)));
    default:
      return false;
  }
}

function demeritsWithNoRecord(entry: Demoted, changesForVendor: DealChange[], date: string): string[] {
  return entry.demerits.filter((d) => !isRecorded(entry, d, changesForVendor, date)).map((d) => d.code);
}

function bestOfCategories(): string[] {
  return [...new Set(index.offers.map((o) => o.category))].filter(
    (cat) => index.offers.filter((o) => o.category === cat && !o.eligibility).length >= BEST_OF_MIN_VENDORS,
  );
}

function rankCategory(cat: string) {
  return rankOffers(index.offers.filter((o) => o.category === cat), { queryKey: `best-of:${cat}`, changes: dealChanges, date: TODAY });
}

function inTheAdverseWindow(c: DealChange): boolean {
  return daysApart(c.date, TODAY) <= ADVERSE_CHANGE_WINDOW_DAYS;
}

describe("tier classification", () => {
  it("classifies every tier string in the live index", () => {
    const unclassified = new Set<string>();
    for (const o of index.offers) {
      const c = classifyTier(o.tier);
      if (!["free", "time_limited", "not_free", "retired"].includes(c.class)) unclassified.add(o.tier);
    }
    assert.strictEqual(unclassified.size, 0, `unclassified tiers: ${[...unclassified].join(", ")}`);
  });

  it("stops hiding the 290 offers the old hand-typed allowlist dropped", () => {
    for (const tier of ["Always Free", "Free OSS", "Free Forever", "Free Tier", "Free (Basic)", "Community", "Personal", "Developer", "Starter"]) {
      assert.strictEqual(classifyTier(tier).class, "free", `${tier} should be an ordinary free tier`);
    }
  });

  it("reads a credit grant as time-limited even when pay-as-you-go follows it", () => {
    assert.strictEqual(classifyTier("Free Credits + Pay-as-you-go").class, "time_limited");
    assert.strictEqual(classifyTier("Free ($30/mo credits)").class, "time_limited");
    assert.strictEqual(classifyTier("Trial Key").class, "time_limited");
    assert.strictEqual(classifyTier("Experimental Preview").class, "time_limited");
  });

  it("names what a listing that runs out is, by the rule its tier matched", () => {
    const labelled = (tier: string) => timeLimitedTierRule(tier)?.badgeLabel ?? null;
    assert.strictEqual(labelled("Credits"), "credits only");
    assert.strictEqual(labelled("Free Credits + Pay-as-you-go"), "credits only");
    assert.strictEqual(labelled("Trial"), "trial only");
    assert.strictEqual(labelled("Trial Key"), "trial only");
    assert.strictEqual(labelled("Experimental Preview"), "preview only");
    assert.strictEqual(labelled("Beta"), "preview only");
    assert.strictEqual(labelled("Sandbox"), "preview only");
    assert.strictEqual(labelled("Scholarship"), "award only");
    assert.strictEqual(labelled("Free"), null);
    assert.strictEqual(labelled("Paid"), null);
    for (const tier of ["Credits", "Trial", "Beta", "Scholarship", "Free", "Paid"]) {
      assert.strictEqual(labelled(tier) !== null, classifyTier(tier).class === "time_limited", `${tier} is labelled apart from its class`);
    }
  });

  it("excludes tiers that are not a free offer at all", () => {
    for (const tier of ["Paid", "Freemium", "Pay-as-you-go", "Pay-per-use", "Pay-per-use (no free tier)", "Conditional", "Exempt / Paid"]) {
      assert.strictEqual(classifyTier(tier).class, "not_free", `${tier} should be gated out`);
    }
  });

  it("treats an unrecognised tier as free rather than silently dropping it", () => {
    assert.strictEqual(classifyTier("Whatever The Vendor Calls It").class, "free");
  });

  it("puts every offer in exactly one class and lets no expiring tier into the free bucket", () => {
    const counts = { free: 0, time_limited: 0, not_free: 0, retired: 0 };
    const freeTiers = new Set<string>();
    for (const o of index.offers) {
      const tierClass = classifyTier(o.tier).class;
      counts[tierClass]++;
      if (tierClass === "free") freeTiers.add(o.tier);
    }
    assert.strictEqual(counts.free + counts.time_limited + counts.not_free + counts.retired, index.offers.length);
    assert.ok(counts.time_limited >= 20, `expected the time-limited class to be populated, found ${counts.time_limited}`);
    assert.ok(counts.not_free >= 15, `expected the not-free class to be populated, found ${counts.not_free}`);
    for (const tier of freeTiers) {
      assert.doesNotMatch(
        tier, /\b\d+[- ](?:day|days|week|weeks|month|months|year|years)\b/i,
        `"${tier}" names a duration but ranks as an ongoing free tier`,
      );
    }
  });
});

describe("gates", () => {
  it("excludes offers that are not generally available", () => {
    const g = gateFor(offer({ eligibility: { type: "student", conditions: ["enrolled"] } }), TODAY, []);
    assert.strictEqual(g?.code, "eligibility_restricted");
  });

  it("excludes an offer whose stated expiry has passed", () => {
    const g = gateFor(offer({ expires_date: "2026-08-24" }), TODAY, []);
    assert.strictEqual(g?.code, "offer_expired");
  });

  it("excludes an offer we have not confirmed in 180 days", () => {
    const g = gateFor(offer({ verifiedDate: "2026-01-01" }), TODAY, []);
    assert.strictEqual(g?.code, "verification_lapsed");
  });

  it("lets a healthy free offer through", () => {
    assert.strictEqual(gateFor(offer(), TODAY, []), null);
  });

  it("every gate code is documented on the criteria page table", () => {
    const documented = new Set(GATE_TABLE.map((g) => g.code));
    for (const code of ["eligibility_restricted", "not_a_free_offer", "offer_expired", "offer_retired", "product_discontinued", "verification_lapsed"]) {
      assert.ok(documented.has(code as never), `${code} must be documented`);
    }
    const byVendor = changesByVendor(dealChanges);
    for (const o of index.offers) {
      const gate = gateFor(o, TODAY, byVendor.get(o.vendor.toLowerCase()) ?? []);
      if (gate) assert.ok(documented.has(gate.code), `${o.vendor} is gated ${gate.code}, which the table does not describe`);
    }
  });
});

describe("demerits", () => {
  it("a stale record loses to a freshly verified one", () => {
    const fresh = offer({ vendor: "Fresh", verifiedDate: "2026-08-20" });
    const stale = offer({ vendor: "Stale", verifiedDate: "2026-04-01" });
    const r = rankOffers([stale, fresh], { queryKey: "t", changes: [], date: TODAY });
    assert.deepStrictEqual(vendorsOf(r.ranked), ["Fresh", "Stale"]);
    assert.strictEqual(r.qualified.length, 1);
    assert.strictEqual(r.demoted[0].demerits[0].code, "stale_verification");
  });

  it("a withdrawn free tier loses to one with no such record", () => {
    const clean = offer({ vendor: "Clean" });
    const withdrawn = offer({ vendor: "Withdrawn" });
    const r = rankOffers([withdrawn, clean], {
      queryKey: "t",
      changes: [change({ vendor: "Withdrawn", change_type: "free_tier_removed", date: "2026-03-19", summary: "Free tier removed." })],
      date: TODAY,
    });
    assert.deepStrictEqual(vendorsOf(r.ranked), ["Clean", "Withdrawn"]);
    assert.strictEqual(r.demoted[0].demerit_total, 3);
    assert.match(r.demoted[0].demerits[0].reason, /2026-03-19/);
  });

  it("an adverse change older than 12 months no longer demotes", () => {
    const e = evaluate(offer(), {
      date: TODAY,
      changesForVendor: [change({ change_type: "free_tier_removed", date: "2025-01-01" })],
    });
    assert.strictEqual(e.demerit_total, 0);
  });

  it("a credit grant is demoted as time-limited", () => {
    const e = evaluate(offer({ tier: "Free Credits" }), { date: TODAY, changesForVendor: [] });
    assert.strictEqual(e.demerit_total, 2);
    assert.strictEqual(e.demerits[0].code, "time_limited_offer");
  });

  it("demerits stack, and the total is an integer", () => {
    const e = evaluate(offer({ tier: "Trial", verifiedDate: "2026-04-01" }), {
      date: TODAY,
      changesForVendor: [change({ change_type: "product_deprecated", date: "2026-05-01", listing_effect: "ends" })],
    });
    assert.strictEqual(e.demerit_total, 6);
    assert.ok(Number.isInteger(e.demerit_total));
  });

  it("a removal we retracted, or the vendor reversed, demotes nothing and is not disclosed", () => {
    for (const state of ["retracted", "reversed"] as const) {
      const e = evaluate(offer(), {
        date: TODAY,
        changesForVendor: [change({ change_type: "free_tier_removed", date: "2026-03-19", resolution: { state, date: "2026-04-01" } })],
      });
      assert.strictEqual(e.demerit_total, 0, state);
      assert.deepStrictEqual(e.disclosures, [], state);
    }
  });

  it("a deprecation that leaves the listed product standing demotes nothing", () => {
    for (const listing_effect of ["none", "narrows"] as const) {
      const e = evaluate(offer(), {
        date: TODAY,
        changesForVendor: [change({ change_type: "product_deprecated", date: "2026-03-19", listing_effect })],
      });
      assert.strictEqual(e.demerit_total, 0, listing_effect);
    }
  });

  it("a deprecation that ends the listed product still demotes", () => {
    const e = evaluate(offer(), {
      date: TODAY,
      changesForVendor: [change({ change_type: "product_deprecated", date: "2026-03-19", listing_effect: "ends" })],
    });
    assert.deepStrictEqual(e.demerits.map((d) => d.code), ["free_tier_withdrawn"]);
  });

  it("every published demerit weight is a positive integer, so the tie band is exactly zero", () => {
    for (const d of DEMERIT_TABLE) {
      assert.ok(Number.isInteger(d.points) && d.points > 0, `${d.code} weight must be a positive integer`);
    }
  });

  it("ordering changes when the underlying data changes", () => {
    const a = offer({ vendor: "A" });
    const b = offer({ vendor: "B" });
    const before = rankOffers([a, b], { queryKey: "t", changes: [], date: TODAY });
    assert.strictEqual(before.qualified.length, 2);
    const after = rankOffers([a, b], {
      queryKey: "t",
      changes: [change({ vendor: "A", change_type: "open_source_killed", date: "2026-07-01" })],
      date: TODAY,
    });
    assert.deepStrictEqual(vendorsOf(after.qualified), ["B"]);
    assert.deepStrictEqual(vendorsOf(after.demoted), ["A"]);
  });
});

describe("recorded changes that must not move rank", () => {
  for (const change_type of ["limits_reduced", "pricing_restructured", "restriction"] as const) {
    it(`${change_type} is disclosed but costs nothing`, () => {
      const e = evaluate(offer(), { date: TODAY, changesForVendor: [change({ change_type })] });
      assert.strictEqual(e.demerit_total, 0, `${change_type} must not demote`);
      assert.strictEqual(e.disclosures.length, 1);
      assert.strictEqual(e.disclosures[0].code, change_type);
      assert.strictEqual(e.disclosures[0].date, "2026-06-01");
    });
  }

  it("a disclosed change we retracted is no longer disclosed", () => {
    const e = evaluate(offer(), {
      date: TODAY,
      changesForVendor: [change({ change_type: "limits_reduced", resolution: { state: "retracted", date: "2026-07-01" } })],
    });
    assert.deepStrictEqual(e.disclosures, []);
  });

  it("the Databases ranking is the same without its disclosed changes, and each offer with one shows it", () => {
    const dbs = index.offers.filter((o) => o.category === "Databases");
    const disclosable = (c: DealChange) => DISCLOSURE_CHANGE_TYPES.has(c.change_type);
    const r = rankOffers(dbs, { queryKey: "best-of:Databases", changes: dealChanges, date: TODAY });
    const withoutThem = rankOffers(dbs, {
      queryKey: "best-of:Databases",
      changes: dealChanges.filter((c) => !disclosable(c)),
      date: TODAY,
    });
    const places = (result: typeof r) => result.ranked.map((e) => `${e.offer.vendor} ${e.demerit_total}`);
    assert.deepStrictEqual(places(r), places(withoutThem));

    const withADisclosedChange = r.ranked.filter((e) =>
      dealChanges.some(
        (c) =>
          c.vendor.toLowerCase() === e.offer.vendor.toLowerCase()
          && disclosable(c)
          && !c.resolution
          && daysApart(c.date, TODAY) <= ADVERSE_CHANGE_WINDOW_DAYS,
      ),
    );
    assertPopulationFloor(
      withADisclosedChange.filter((e) => e.demerit_total === 0).length,
      1,
      "qualified Databases offers with a disclosed change, without which nothing here is about the top band",
    );
    for (const entry of withADisclosedChange) {
      assert.ok(entry.disclosures.length > 0, `${entry.offer.vendor}'s recorded change should still be disclosed`);
    }
  });
});

describe("stale_verification says something true about who is at fault", () => {
  it("without a failure record it states only that we could not confirm it", () => {
    const e = evaluate(offer({ verifiedDate: "2026-04-01" }), { date: TODAY, changesForVendor: [] });
    const d = e.demerits[0];
    assert.strictEqual(d.code, "stale_verification");
    assert.strictEqual(d.about_us, true);
    assert.match(d.reason, /have not confirmed/);
    assert.match(d.reason, /not a change by the vendor/);
  });

  it("with a failure record it states the attempt count and the last success", () => {
    const ledger = new Map([
      ["acme", { vendor: "Acme", url: "https://example.com", consecutive_failures: 14, last_success: "2026-03-01", last_attempt: "2026-08-24", last_error: "HTTP 403" }],
    ]);
    const r = rankOffers([offer({ verifiedDate: "2026-04-01" })], {
      queryKey: "t",
      changes: [],
      date: TODAY,
      verificationLedger: ledger,
    });
    const d = r.demoted[0].demerits[0];
    assert.match(d.reason, /14 consecutive re-check attempts have failed/);
    assert.match(d.reason, /last confirmed 2026-03-01/);
    assert.match(d.reason, /HTTP 403/);
    assert.match(d.reason, /our inability to verify, not a change by the vendor/);
    assert.strictEqual(d.about_us, true);
  });

  it("the demerit is worth the same either way — the wording changes, not the rank", () => {
    const withoutLedger = evaluate(offer({ verifiedDate: "2026-04-01" }), { date: TODAY, changesForVendor: [] });
    const withLedger = evaluate(offer({ verifiedDate: "2026-04-01" }), {
      date: TODAY,
      changesForVendor: [],
      verificationLedger: new Map([["acme", { vendor: "Acme", url: "u", consecutive_failures: 3, last_success: null, last_attempt: "2026-08-24", last_error: "timeout" }]]),
    });
    assert.strictEqual(withoutLedger.demerit_total, withLedger.demerit_total);
  });
});

describe("tie-break", () => {
  const tied = Array.from({ length: 41 }, (_, i) => offer({ vendor: `V${i}` }));

  it("is deterministic for the same day and query", () => {
    const a = rankOffers(tied, { queryKey: "best-of:Databases", changes: [], date: TODAY });
    const b = rankOffers(tied, { queryKey: "best-of:Databases", changes: [], date: TODAY });
    assert.deepStrictEqual(vendorsOf(a.ranked), vendorsOf(b.ranked));
  });

  it("rotates the next day", () => {
    const a = rankOffers(tied, { queryKey: "best-of:Databases", changes: [], date: "2026-08-25" });
    const b = rankOffers(tied, { queryKey: "best-of:Databases", changes: [], date: "2026-08-26" });
    assert.notDeepStrictEqual(vendorsOf(a.ranked), vendorsOf(b.ranked));
  });

  it("differs by query key on the same day", () => {
    const a = rankOffers(tied, { queryKey: "best-of:Databases", changes: [], date: TODAY });
    const b = rankOffers(tied, { queryKey: "best-of:Auth", changes: [], date: TODAY });
    assert.notDeepStrictEqual(vendorsOf(a.ranked), vendorsOf(b.ranked));
  });

  it("depends on nothing the vendor controls — rename every vendor, same permutation", () => {
    const renamed = tied.map((o, i) => ({ ...o, vendor: `zzz-${100 - i}` }));
    const a = rankOffers(tied, { queryKey: "k", changes: [], date: TODAY });
    const b = rankOffers(renamed, { queryKey: "k", changes: [], date: TODAY });
    const posA = vendorsOf(a.ranked).map((v) => tied.findIndex((o) => o.vendor === v));
    const posB = vendorsOf(b.ranked).map((v) => renamed.findIndex((o) => o.vendor === v));
    assert.deepStrictEqual(posA, posB);
  });

  it("is not sensitive to our editorial copy", () => {
    const wordy = tied.map((o) => ({ ...o, description: "x".repeat(500) }));
    const a = rankOffers(tied, { queryKey: "k", changes: [], date: TODAY });
    const b = rankOffers(wordy, { queryKey: "k", changes: [], date: TODAY });
    const posA = vendorsOf(a.ranked).map((v) => tied.findIndex((o) => o.vendor === v));
    const posB = vendorsOf(b.ranked).map((v) => wordy.findIndex((o) => o.vendor === v));
    assert.deepStrictEqual(posA, posB);
  });

  it("gives every member of a tie the top slot about equally often", () => {
    const N = 41;
    const DAYS = 3650;
    const items = Array.from({ length: N }, (_, i) => i);
    const first = new Array(N).fill(0);
    const positionSum = new Array(N).fill(0);
    const base = Date.UTC(2026, 0, 1);
    for (let d = 0; d < DAYS; d++) {
      const date = new Date(base + d * 86400000).toISOString().slice(0, 10);
      const order = seededShuffle(items, tieBreakSeed(date, "best-of:Databases", 0));
      first[order[0]]++;
      order.forEach((item, pos) => { positionSum[item] += pos; });
    }
    const expected = DAYS / N;
    const chi2 = first.reduce((s, o) => s + (o - expected) ** 2 / expected, 0);
    assert.ok(chi2 < 63.7, `chi-square ${chi2.toFixed(1)} suggests a non-uniform tie-break`);

    const meanPos = positionSum.map((s) => s / DAYS);
    const centre = (N - 1) / 2;
    for (const idx of [0, N - 1]) {
      assert.ok(Math.abs(meanPos[idx] - centre) < 1, `incoming index ${idx} has a positional bias`);
    }
  });

  it("publishes a seed anyone can recompute", () => {
    const r = rankOffers(tied, { queryKey: "best-of:Databases", changes: [], date: TODAY });
    assert.strictEqual(r.tie_break.seed, tieBreakSeed(TODAY, "best-of:Databases", 0));
    assert.match(r.tie_break.seed, /^[0-9a-f]{64}$/);
    assert.strictEqual(r.tie_break.tie_count, 41);
    assert.strictEqual(r.tie_break.date, TODAY);
  });

  it("a demoted offer can never inherit a top-band slot", () => {
    const candidates = [
      ...Array.from({ length: 20 }, (_, i) => offer({ vendor: `Clean${i}` })),
      offer({ vendor: "Stale", verifiedDate: "2026-04-01" }),
    ];
    for (const date of ["2026-07-05", "2026-08-25", "2026-09-01", "2026-09-25"]) {
      const r = rankOffers(candidates, { queryKey: "k", changes: [], date });
      assert.strictEqual(r.ranked.length, 21, `${date}: nothing should be gated out`);
      assert.strictEqual(r.ranked[r.ranked.length - 1].offer.vendor, "Stale", `${date}: demoted entry must sort last`);
    }
  });

  it("rotateListing is stable across days — URL sets must not churn", () => {
    const vendors = Array.from({ length: 10 }, (_, i) => `V${i}`);
    assert.deepStrictEqual(
      rotateListing(vendors, "compare-pairs:Databases"),
      seededShuffle(vendors, tieBreakSeed("", "compare-pairs:Databases", 0)),
    );
    assert.notDeepStrictEqual(rotateListing(vendors, "compare-pairs:Databases"), rotateListing(vendors, "compare-pairs:Auth"));
    assert.deepStrictEqual(rotateListing(vendors, "k"), rotateListing(vendors, "k", undefined));
  });
});

describe("no thumb on the scale", () => {
  const source = readFileSync(join(REPO, "src", "ranking.ts"), "utf8");

  const stripComments = (src: string) =>
    src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*|\*\/)/.test(l)).join("\n");
  const code = stripComments(source);

  it("no vendor name from the index appears anywhere in the selection module", () => {
    const vendors = [...new Set(index.offers.map((o) => o.vendor))].filter((v) => v.length >= 4);
    const hits = vendors.filter((v) => new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(source));
    assert.deepStrictEqual(hits, [], `vendor names must not be reachable from scoring: ${hits.join(", ")}`);
  });

  it("no override, boost, pin or allowlist mechanism exists in the module", () => {
    for (const forbidden of [/\bboost\b/i, /\bpin(ned)?\b/i, /allowlist/i, /whitelist/i, /\boverride\b/i, /preferredVendors/i]) {
      assert.ok(!forbidden.test(code), `selection module must not contain ${forbidden}`);
    }
  });

  it("our own editorial copy is not read by the scoring path", () => {
    assert.ok(!/\.description\b/.test(code), "offer.description must never be a scoring input");
  });

  it("the per-surface scorer scoreBestOfVendor is gone, not left alongside", () => {
    const serve = stripComments(readFileSync(join(REPO, "src", "serve.ts"), "utf8"));
    assert.ok(!/scoreBestOfVendor/.test(serve), "scoreBestOfVendor must not exist");
    assert.ok(!/description\.length\s*\/\s*50/.test(serve), "the comparison-page description.length lever must be gone");
  });
});

describe("the live index, ranked", () => {
  it("the best-of threshold this sweep uses is the one the site publishes with", () => {
    assert.ok(
      Number.isInteger(BEST_OF_MIN_VENDORS) && BEST_OF_MIN_VENDORS > 0,
      "src/serve.ts must state a best-of vendor minimum these sweeps can read",
    );
  });

  it("no category has a unique number one — the finding we publish", () => {
    const categories = [...new Set(index.offers.map((o) => o.category))];
    let pages = 0;
    let uniqueTop = 0;
    for (const cat of categories) {
      const eligible = index.offers.filter((o) => o.category === cat && !o.eligibility);
      if (eligible.length < BEST_OF_MIN_VENDORS) continue;
      pages++;
      const r = rankOffers(index.offers.filter((o) => o.category === cat), {
        queryKey: `best-of:${cat}`,
        changes: dealChanges,
        date: TODAY,
      });
      if (r.tie_break.tie_count === 1) uniqueTop++;
    }
    assert.ok(pages >= 40, `the finding is published per best-of page, and this sweep reached only ${pages}`);
    assert.strictEqual(uniqueTop, 0);
  });

  it("demotes on a withdrawal only for a record still in force that ends a free tier, on every best-of page", () => {
    const byVendor = changesByVendor(dealChanges);
    let demerits = 0;
    const unjustified: string[] = [];
    for (const cat of bestOfCategories()) {
      for (const entry of rankCategory(cat).demoted) {
        for (const d of entry.demerits.filter((d: Demerit) => d.code === "free_tier_withdrawn")) {
          demerits++;
          const cited = (byVendor.get(entry.offer.vendor.toLowerCase()) ?? [])
            .filter((c: DealChange) => WITHDRAWAL_CHANGE_TYPES.has(c.change_type) && c.date === d.date);
          if (!cited.some((c: DealChange) => !c.resolution && endsAFreeTier(c))) unjustified.push(`${cat}: ${entry.offer.vendor} on ${d.date}`);
        }
      }
    }
    assertPopulationFloor(demerits, 1, "withdrawal demerits across the best-of pages");
    assert.deepStrictEqual(unjustified, []);
  });

  it("discloses only records still in force, on every best-of page", () => {
    const byVendor = changesByVendor(dealChanges);
    let disclosed = 0;
    const withdrawn: string[] = [];
    for (const cat of bestOfCategories()) {
      for (const entry of rankCategory(cat).ranked) {
        for (const d of entry.disclosures) {
          disclosed++;
          const cited = (byVendor.get(d.vendor.toLowerCase()) ?? [])
            .filter((c: DealChange) => c.change_type === d.code && c.date === d.date && c.summary === d.summary);
          if (!cited.some((c: DealChange) => !c.resolution)) withdrawn.push(`${cat}: ${d.vendor} ${d.code} on ${d.date}`);
        }
      }
    }
    assertPopulationFloor(disclosed, 1, "disclosures across the best-of pages");
    assert.deepStrictEqual(withdrawn, []);
  });

  it("a vendor whose only removals in the window were retracted is not demoted for them", () => {
    const byVendor = changesByVendor(dealChanges);
    const subjects = [...byVendor].filter(([vendor, changes]) => {
      const inWindow = changes.filter((c) => WITHDRAWAL_CHANGE_TYPES.has(c.change_type) && inTheAdverseWindow(c));
      return inWindow.some((c) => c.change_type === "free_tier_removed" && c.resolution?.state === "retracted")
        && inWindow.every((c) => c.resolution)
        && index.offers.some((o) => o.vendor.toLowerCase() === vendor);
    });
    assertPopulationFloor(subjects.length, 1, "listed vendors whose removal records in the window were all retracted or reversed");
    for (const [vendor, changes] of subjects) {
      for (const o of index.offers.filter((o) => o.vendor.toLowerCase() === vendor)) {
        const e = evaluate(o, { date: TODAY, changesForVendor: changes });
        assert.ok(!e.demerits.some((d: Demerit) => d.code === "free_tier_withdrawn"), `${o.vendor} is demoted on a record we retracted`);
      }
    }
  });

  it("a vendor with a removal still in force in the window is demoted for it", () => {
    const byVendor = changesByVendor(dealChanges);
    const subjects = [...byVendor].filter(([vendor, changes]) =>
      changes.some((c) => c.change_type === "free_tier_removed" && !c.resolution && inTheAdverseWindow(c))
      && index.offers.some((o) => o.vendor.toLowerCase() === vendor));
    assertPopulationFloor(subjects.length, 1, "listed vendors with a free tier removal still in force in the window");
    for (const [vendor, changes] of subjects) {
      for (const o of index.offers.filter((o) => o.vendor.toLowerCase() === vendor)) {
        const e = evaluate(o, { date: TODAY, changesForVendor: changes });
        assert.ok(e.demerits.some((d: Demerit) => d.code === "free_tier_withdrawn"), `${o.vendor} removed a free tier and is not demoted for it`);
      }
    }
  });

  it("every demotion on every page names a specific recorded fact", () => {
    const categories = [...new Set(index.offers.map((o) => o.category))];
    for (const cat of categories) {
      const r = rankOffers(index.offers.filter((o) => o.category === cat), {
        queryKey: `best-of:${cat}`,
        changes: dealChanges,
        date: TODAY,
      });
      for (const entry of r.demoted) {
        assert.ok(entry.demerits.length > 0, `${entry.offer.vendor} demoted with no reason`);
        for (const d of entry.demerits) {
          assert.ok(d.reason.length > 20, `${entry.offer.vendor}/${d.code} has no stated reason`);
          assert.ok(d.points > 0);
        }
      }
    }
  });

  it("every demotion traces to the record it cites, whichever vendors are demoted today", () => {
    const categories = [...new Set(index.offers.map((o) => o.category))];
    const byVendor = changesByVendor(dealChanges);
    let checked = 0;
    for (const cat of categories) {
      const r = rankOffers(index.offers.filter((o) => o.category === cat), {
        queryKey: `best-of:${cat}`,
        changes: dealChanges,
        date: TODAY,
      });
      for (const entry of r.demoted) {
        const unrecorded = demeritsWithNoRecord(entry, byVendor.get(entry.offer.vendor.toLowerCase()) ?? [], TODAY);
        assert.deepStrictEqual(unrecorded, [], `${entry.offer.vendor} is demoted on ${unrecorded.join(", ")} with no record behind it`);
        checked += entry.demerits.length;
      }
    }
    assert.ok(checked >= 50, `expected the live catalogue to exercise this rule, checked ${checked} demerits`);
  });

  it("a newly recorded withdrawal demotes a vendor that was qualifying, and disturbs no other demotion", () => {
    const offers = index.offers.filter((o) => o.category === "Databases");
    const before = rankOffers(offers, { queryKey: "best-of:Databases", changes: dealChanges, date: TODAY });
    const subject = vendorsOf(before.qualified)[0];
    const withdrawal = change({
      vendor: subject,
      change_type: "free_tier_removed",
      date: "2026-08-20",
      summary: "The published free allowance no longer appears on the vendor's pricing page.",
      category: "Databases",
    });
    const changes = [...dealChanges, withdrawal];
    const after = rankOffers(offers, { queryKey: "best-of:Databases", changes, date: TODAY });
    const demoted = new Map(after.demoted.map((e) => [e.offer.vendor, e]));

    assert.ok(demoted.get(subject)?.demerits.some((d) => d.code === "free_tier_withdrawn"), `${subject} withdrew a free tier and must be demoted`);
    assertPopulationFloor(before.demoted.length, 1, "Databases offers demoted before the new record");
    for (const entry of before.demoted) {
      const codes = (e: Demoted) => e.demerits.map((d) => d.code).sort();
      const still = after.demoted.find((e) => e.offer === entry.offer);
      assert.deepStrictEqual(still && codes(still), codes(entry), `${entry.offer.vendor}'s demotion must survive a new one`);
    }
    const offersUnderSubject = offers.filter((o) => o.vendor === subject).length;
    assert.strictEqual(after.demoted.length, before.demoted.length + offersUnderSubject);
    assert.strictEqual(after.qualified.length, offers.length - after.demoted.length - after.excluded.length);

    const byVendor = changesByVendor(changes);
    assert.deepStrictEqual(demeritsWithNoRecord(demoted.get(subject)!, byVendor.get(subject.toLowerCase()) ?? [], TODAY), []);
  });

  it("a demotion whose cited record does not exist is caught", () => {
    const entry = {
      offer: offer({ vendor: "Acme", tier: "Free", verifiedDate: TODAY }),
      demerits: [{ code: "free_tier_withdrawn", points: 3, date: "2026-08-01", reason: "Recorded free tier removal on 2026-08-01." }],
    };
    assert.deepStrictEqual(demeritsWithNoRecord(entry, [], TODAY), ["free_tier_withdrawn"]);
    assert.deepStrictEqual(
      demeritsWithNoRecord(entry, [change({ vendor: "Acme", change_type: "free_tier_removed", date: "2026-07-01" })], TODAY),
      ["free_tier_withdrawn"],
    );
    assert.deepStrictEqual(
      demeritsWithNoRecord(entry, [change({ vendor: "Acme", change_type: "limits_reduced", date: "2026-08-01" })], TODAY),
      ["free_tier_withdrawn"],
    );
    assert.deepStrictEqual(
      demeritsWithNoRecord(entry, [change({ vendor: "Acme", change_type: "free_tier_removed", date: "2026-08-01" })], TODAY),
      [],
    );
  });
});

describe("dates", () => {
  it("utcDate is UTC, not local", () => {
    assert.strictEqual(utcDate(new Date("2026-08-25T23:59:59Z")), "2026-08-25");
    assert.strictEqual(utcDate(new Date("2026-08-26T00:00:01Z")), "2026-08-26");
  });
});
