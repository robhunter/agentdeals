// The shared selection module (#1025).
//
// This is the trust surface: it decides what we put in front of an agent as a
// recommendation, and the product claim is that the answer is not for sale.
// So the tests that matter most are the ones that would catch a thumb on the
// scale — an input derived from our own copy, a vendor name reachable from the
// scoring path, a tie-break that quietly favours whoever sorts first.

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const {
  rankOffers,
  rotateListing,
  evaluate,
  gateFor,
  classifyTier,
  seededShuffle,
  tieBreakSeed,
  utcDate,
  DEMERIT_TABLE,
  GATE_TABLE,
} = await import("../src/ranking.ts");

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

describe("tier classification", () => {
  it("classifies every tier string in the live index", () => {
    const unclassified = new Set<string>();
    for (const o of index.offers) {
      const c = classifyTier(o.tier);
      if (!["free", "time_limited", "not_free"].includes(c.class)) unclassified.add(o.tier);
    }
    assert.strictEqual(unclassified.size, 0, `unclassified tiers: ${[...unclassified].join(", ")}`);
  });

  it("stops hiding the 290 offers the old hand-typed allowlist dropped", () => {
    // findBestOffer() gated on {Free, Hobby, Open Source, Free Credits}. Every
    // tier below was invisible to plan_stack purely because nobody typed it.
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

  it("excludes tiers that are not a free offer at all", () => {
    for (const tier of ["Paid", "Freemium", "Pay-as-you-go", "Pay-per-use", "Pay-per-use (no free tier)", "Conditional", "Exempt / Paid"]) {
      assert.strictEqual(classifyTier(tier).class, "not_free", `${tier} should be gated out`);
    }
  });

  it("treats an unrecognised tier as free rather than silently dropping it", () => {
    assert.strictEqual(classifyTier("Whatever The Vendor Calls It").class, "free");
  });

  it("classification of the live index matches the counts published on /criteria", () => {
    const counts = { free: 0, time_limited: 0, not_free: 0 };
    for (const o of index.offers) counts[classifyTier(o.tier).class]++;
    assert.strictEqual(counts.not_free, 19);
    assert.strictEqual(counts.time_limited, 23);
    assert.strictEqual(counts.free, index.offers.length - 42);
  });
});

describe("gates", () => {
  it("excludes offers that are not generally available", () => {
    const g = gateFor(offer({ eligibility: { type: "student", conditions: ["enrolled"] } }), TODAY);
    assert.strictEqual(g?.code, "eligibility_restricted");
  });

  it("excludes an offer whose stated expiry has passed", () => {
    const g = gateFor(offer({ expires_date: "2026-08-24" }), TODAY);
    assert.strictEqual(g?.code, "offer_expired");
  });

  it("excludes an offer we have not confirmed in 180 days", () => {
    const g = gateFor(offer({ verifiedDate: "2026-01-01" }), TODAY);
    assert.strictEqual(g?.code, "verification_lapsed");
  });

  it("lets a healthy free offer through", () => {
    assert.strictEqual(gateFor(offer(), TODAY), null);
  });

  it("every gate code is documented on the criteria page table", () => {
    const documented = new Set(GATE_TABLE.map((g) => g.code));
    for (const code of ["eligibility_restricted", "not_a_free_offer", "offer_expired", "verification_lapsed"]) {
      assert.ok(documented.has(code as never), `${code} must be documented`);
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
      changesForVendor: [change({ change_type: "product_deprecated", date: "2026-05-01" })],
    });
    assert.strictEqual(e.demerit_total, 6);
    assert.ok(Number.isInteger(e.demerit_total));
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

  it("Supabase and Neon stay in the top band despite their recorded changes", () => {
    // The coverage-bias case: both have exactly one recorded negative change,
    // which under a stability-scoring model put them 37th and 40th of 42.
    const dbs = index.offers.filter((o) => o.category === "Databases");
    const r = rankOffers(dbs, { queryKey: "best-of:Databases", changes: dealChanges, date: TODAY });
    for (const vendor of ["Supabase", "Neon"]) {
      const entry = r.qualified.find((e) => e.offer.vendor === vendor);
      assert.ok(entry, `${vendor} should be in the qualified band`);
      assert.strictEqual(entry.demerit_total, 0);
      assert.ok(entry.disclosures.length > 0, `${vendor}'s recorded change should still be disclosed`);
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
    // Same input positions land in the same output positions regardless of name.
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
    // 3,650 consecutive dates over a 41-way tie. Expected 89.0 first places
    // each; chi-square must clear the 99% critical value for df=40 (63.7).
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

    // And no residual file-order bias: first and last incoming index should sit
    // at the middle of the distribution over time, like everyone else.
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
    // Dates chosen so "Stale" is past 90 days but not yet past the 180-day gate.
    for (const date of ["2026-07-05", "2026-08-25", "2026-09-01", "2026-09-25"]) {
      const r = rankOffers(candidates, { queryKey: "k", changes: [], date });
      assert.strictEqual(r.ranked.length, 21, `${date}: nothing should be gated out`);
      assert.strictEqual(r.ranked[r.ranked.length - 1].offer.vendor, "Stale", `${date}: demoted entry must sort last`);
    }
  });

  it("rotateListing is stable across days — URL sets must not churn", () => {
    const vendors = Array.from({ length: 10 }, (_, i) => `V${i}`);
    // Pinned to the date-free seed: which /compare/ pages exist must not depend
    // on when the process happened to boot, or the site churns 300+ URLs a day.
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

  // Comments in this module exist precisely to explain which levers were
  // removed and why, so they name the banned things. The assertions below are
  // about executable code.
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
  it("no category has a unique number one — the finding we publish", () => {
    const categories = [...new Set(index.offers.map((o) => o.category))];
    let pages = 0;
    let uniqueTop = 0;
    for (const cat of categories) {
      const eligible = index.offers.filter((o) => o.category === cat && !o.eligibility);
      if (eligible.length < 5) continue;
      pages++;
      const r = rankOffers(index.offers.filter((o) => o.category === cat), {
        queryKey: `best-of:${cat}`,
        changes: dealChanges,
        date: TODAY,
      });
      if (r.tie_break.tie_count === 1) uniqueTop++;
    }
    assert.strictEqual(pages, 57);
    assert.strictEqual(uniqueTop, 0);
  });

  it("Databases: Firebase is the only demotion, on a named recorded fact", () => {
    const r = rankOffers(index.offers.filter((o) => o.category === "Databases"), {
      queryKey: "best-of:Databases",
      changes: dealChanges,
      date: TODAY,
    });
    assert.strictEqual(r.qualified.length, 41);
    assert.deepStrictEqual(vendorsOf(r.demoted), ["Firebase"]);
    assert.strictEqual(r.demoted[0].demerits[0].code, "free_tier_withdrawn");
    assert.strictEqual(r.excluded.length, 3);
  });

  it("AI/ML: the vendors whose free tier is really a credit grant are demoted", () => {
    const r = rankOffers(index.offers.filter((o) => o.category === "AI / ML"), {
      queryKey: "best-of:AI / ML",
      changes: dealChanges,
      date: TODAY,
    });
    const demoted = new Map(r.demoted.map((e) => [e.offer.vendor, e]));
    for (const vendor of ["OpenAI", "Google Gemini API", "Clarifai", "xAI"]) {
      assert.ok(demoted.get(vendor)?.demerits.some((d) => d.code === "free_tier_withdrawn"), `${vendor} withdrew a free tier and must be demoted`);
    }
    for (const vendor of ["Cohere", "Together AI", "Fireworks AI", "Modal", "DeepSeek API"]) {
      assert.ok(demoted.get(vendor)?.demerits.some((d) => d.code === "time_limited_offer"), `${vendor} offers credits, not a free tier`);
    }
    assert.strictEqual(r.qualified.length, 47);
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
});

describe("dates", () => {
  it("utcDate is UTC, not local", () => {
    assert.strictEqual(utcDate(new Date("2026-08-25T23:59:59Z")), "2026-08-25");
    assert.strictEqual(utcDate(new Date("2026-08-26T00:00:01Z")), "2026-08-26");
  });
});
