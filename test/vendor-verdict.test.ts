import "./refused-read-subjects.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANNOT_CONFIRM_THESE_TERMS,
  CHANGE_KIND_NOUN,
  demotionTheVerdictNames,
  freeTierClaim,
  gateStatesAnEnding,
  narrowingChanges,
  narrowingSentence,
  publishedVendorLevel,
  ratingWithheldForNoSource,
  refusedReadWeHold,
  statesRiskCause,
  vendorBadge,
  vendorVerdictSentence,
  vendorVerdictWord,
  type VendorVerdictInput,
} from "../dist/vendor-verdict.js";
import { CHANGE_DIRECTION, gateForOffer, loadDealChanges, loadOffers, refusalsForVendor, vendorRiskAssessment, classifyStability } from "../dist/data.js";
import { toSlug, vendorSlugMap } from "../dist/vendor-slug.js";
import { isNoLongerInForce } from "../dist/change-resolution.js";
import { changeCitesASource } from "../dist/change-citation.js";
import { changeDateClause } from "../dist/change-dates.js";
import { levelWithheldReason } from "../dist/source-check.js";
import { vendorVerdictContextFrom } from "../dist/vendor-verdict-input.js";
import { offerEnded, endedVerdictSentence, ENDED_BADGE_LABEL } from "../dist/retirement.js";
import { PRODUCT_DEPRECATED } from "../dist/product-deprecation.js";
import { CONFIRMED_DATE_LABEL, UNCONFIRMED_DATE_LABEL } from "../dist/read-date.js";
import { GATES_LEAVING_NO_FREE_TIER, classifyTier, gateFor, utcDate } from "../dist/ranking.js";
import type { DealChange, RiskCause } from "../dist/types.js";

type Gate = { code: string; reason: string };

const GATED_LEVEL_PHRASE: Record<"stable" | "caution" | "risky", string> = {
  stable: "has a stable pricing history",
  caution: "warrants caution",
  risky: "is high risk",
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const STABILITY_SCALE_WORDS = /\b(volatile|improving)\b|on our watch list/i;
const RATES_THE_TIER = /is considered (stable|risky)|requires caution/i;
const ENDED_VERDICT_OPENING: Record<string, string> = {
  "free tier removed": "Its free tier has ended — one recorded ",
  "deprecated": "The product is being shut down — one recorded ",
};
const ENDED_RELIABILITY_OPENING: Record<string, (vendor: string) => string> = {
  "free tier removed": (vendor) => `${vendor}'s free tier has ended — one recorded `,
  "deprecated": (vendor) => `${vendor} is shutting the product down — one recorded `,
};
const OTHER_SCALE_ON_A_SURFACE_THAT_EMBEDS_SUMMARIES = /\bvolatile\b|on our watch list/i;
const COUNT_AS_EVIDENCE = /\b\d+ pricing changes? recorded/;
const CLAIMS_A_NARROWING = /(?:One recorded [^.]*|(?<!None of the )\d+ recorded changes) narrowed the terms/;

const establishesANarrowing = (c: DealChange): boolean =>
  CHANGE_DIRECTION[c.change_type] === "negative" && !isNoLongerInForce(c);

const isARepairToOurOwnEntry = (c: DealChange): boolean => c.change_type === "record_corrected";

function namesTheRecord(verdict: string, record: DealChange): boolean {
  const noun = CHANGE_KIND_NOUN[record.change_type];
  const when = changeDateClause(record);
  return verdict.includes(`one recorded ${noun}, ${when}`)
    || verdict.includes(`One recorded ${noun} narrowed the terms, ${when}`);
}

function change(over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Vendor A",
    date: "2026-03-01",
    date_source: "vendor_page",
    change_type: "limits_reduced",
    summary: "Free tier storage cut from 10 GB to 1 GB",
    impact: "medium",
    source_url: "https://example.test/pricing",
    category: "Databases",
    ...over,
  } as DealChange;
}

function causeOf(c: DealChange): RiskCause {
  return { date: c.date, date_source: c.date_source, change_type: c.change_type, summary: c.summary };
}

function input(over: Partial<VendorVerdictInput> = {}): VendorVerdictInput {
  return { vendor: "Vendor A", level: "stable", historyLevel: "stable", cause: null, changes: [], levelWithheld: null, unconfirmableSince: "", termsConfirmedOn: "", ...over };
}

describe("vendor verdict — one rating word, and it carries its cause", () => {
  it("states the level and the kind of record that earned it, never a count", () => {
    const c = change({ change_type: "limits_reduced", date: "2026-03-01" });
    const sentence = vendorVerdictSentence(input({ level: "caution", cause: causeOf(c), changes: [c] }));
    assert.strictEqual(sentence, "We rate it caution — one recorded limit reduction, on 2026-03-01.");
    assert.doesNotMatch(sentence, COUNT_AS_EVIDENCE);
  });

  it("states a free tier removal that would rate the vendor risky as the ending, in place of the rating", () => {
    const c = change({ change_type: "free_tier_removed", date: "2026-04-13" });
    const sentence = vendorVerdictSentence(input({ level: "risky", cause: causeOf(c), changes: [c] }));
    assert.strictEqual(sentence, "Its free tier has ended — one recorded free tier removal, on 2026-04-13. We no longer rate it.");
  });

  it("dates a cause we found ourselves as discovered, not as the day it took effect", () => {
    const c = change({ change_type: "limits_reduced", date: "2026-08-28", date_source: "discovered" });
    const sentence = vendorVerdictSentence(input({ level: "caution", cause: causeOf(c), changes: [c] }));
    assert.strictEqual(sentence, "We rate it caution — one recorded limit reduction, discovered 2026-08-28.");
  });

  it("falls back to stable when a level arrives with no record to show for it", () => {
    assert.strictEqual(publishedVendorLevel("caution", null), "stable");
    assert.strictEqual(publishedVendorLevel("risky", null), "stable");
    const c = change();
    assert.strictEqual(publishedVendorLevel("caution", causeOf(c)), "caution");
  });

  it("substitutes no level where the catalogue publishes none", () => {
    assert.strictEqual(publishedVendorLevel(null, null), null);
    assert.strictEqual(publishedVendorLevel(null, causeOf(change())), null);
  });

  it("withholds the rating entirely when we cannot read the page we cite", () => {
    const withheld = input({ level: "stable", levelWithheld: "states_no_terms", changes: [change()] });
    assert.strictEqual(vendorVerdictWord(withheld), null);
    assert.strictEqual(
      vendorVerdictSentence(withheld),
      "The page we cite for this offer states no amount, tier or rate we can read, so we cannot confirm these terms today.",
    );
  });

  it("says a link has not resolved, with the date it last did", () => {
    const withheld = input({ levelWithheld: "link_unreachable", unconfirmableSince: " since 2026-05-02" });
    assert.strictEqual(
      vendorVerdictSentence(withheld),
      "Its pricing page has not resolved for us since 2026-05-02, so we cannot confirm these terms today.",
    );
  });
});

describe("the badge beside a vendor's name says what the verdict below it says", () => {
  const cause = causeOf(change({ change_type: "pricing_restructured", date: "2026-08-28" }));

  it("rates a record the ranker lists", () => {
    assert.deepStrictEqual(vendorBadge(input({ level: "stable" })), { kind: "rating", word: "stable" });
    assert.deepStrictEqual(vendorBadge(input({ level: "caution", cause })), { kind: "rating", word: "caution" });
  });

  it("states no rating on a record the ranker gates, and names the gate", () => {
    for (const level of ["stable", "caution", "risky"] as const) {
      const gated = input({ level, cause, gate: "eligibility_restricted", changes: [change()] });
      assert.deepStrictEqual(
        vendorBadge(gated),
        { kind: "none", because: { reason: "gated", gate: "eligibility_restricted" } },
        `a gated record rated ${level}`,
      );
    }
  });

  it("states the offer has ended rather than rating it, whatever its history says", () => {
    const ended = input({ level: "caution", cause, gate: "offer_retired", offerEnded: true, changes: [change(), change()] });
    assert.deepStrictEqual(vendorBadge(ended), { kind: "ended" });
    assert.strictEqual(vendorVerdictSentence(ended), endedVerdictSentence());
    assert.strictEqual(statesRiskCause(ended), false);
  });

  it("withholds the badge on the two grounds it withheld it on before, and says which", () => {
    assert.deepStrictEqual(
      vendorBadge(input({ level: null, levelWithheld: "states_no_terms" })),
      { kind: "none", because: { reason: "states_no_terms" } },
    );
    assert.deepStrictEqual(
      vendorBadge(input({ level: "stable", linkUnreachable: true })),
      { kind: "none", because: { reason: "link_unreachable" } },
    );
    assert.deepStrictEqual(
      vendorBadge(input({ level: "risky", cause, linkUnreachable: true })),
      { kind: "rating", word: "risky" },
    );
  });

  it("rates nothing on a level it does not hold, even where no reason was recorded with it", () => {
    assert.deepStrictEqual(
      vendorBadge(input({ level: null, levelWithheld: null, ratingWithheld: null })),
      { kind: "none", because: { reason: "no_source" } },
    );
  });

  it("names the reason the verdict sentence gives, not the gate, where both apply", () => {
    const both = input({
      level: null,
      levelWithheld: "unreadable",
      gate: "eligibility_restricted",
      changes: [change()],
    });
    assert.deepStrictEqual(vendorBadge(both), { kind: "none", because: { reason: "unreadable" } });
    assert.match(vendorVerdictSentence(both), /could not read the page we cite/);
  });

  it("explains a level only where the verdict states one", () => {
    assert.strictEqual(statesRiskCause(input({ level: "caution", cause })), true);
    assert.strictEqual(statesRiskCause(input({ level: "caution", cause, gate: "eligibility_restricted" })), true);
    assert.strictEqual(statesRiskCause(input({ level: "stable" })), false);
    assert.strictEqual(statesRiskCause(input({ level: "caution", cause, offerEnded: true })), false);
  });
});

describe("vendor verdict — a stable rating reports direction, not volume", () => {
  it("says zero changes are recorded when we hold none", () => {
    assert.strictEqual(vendorVerdictSentence(input()), "It's stable — zero pricing changes recorded.");
    assert.strictEqual(narrowingSentence([]), "");
  });

  it("says the one record it holds did not narrow the terms", () => {
    const c = change({ change_type: "limits_increased" });
    const sentence = vendorVerdictSentence(input({ changes: [c] }));
    assert.ok(sentence.startsWith("We rate it stable."));
    assert.ok(sentence.endsWith("The one change we have recorded did not narrow the terms."));
  });

  it("counts only the records that pointed down, not every record", () => {
    const changes = [
      change({ change_type: "limits_increased", date: "2026-01-01" }),
      change({ change_type: "limits_increased", date: "2025-01-22" }),
      change({ change_type: "restriction", date: "2026-03-21" }),
      change({ change_type: "restriction", date: "2026-08-28" }),
    ];
    const sentence = vendorVerdictSentence(input({ changes }));
    assert.ok(sentence.endsWith("2 recorded changes narrowed the terms, the most recent on 2026-08-28."));
    assert.doesNotMatch(sentence, /4 recorded changes narrowed/);
    assert.doesNotMatch(sentence, COUNT_AS_EVIDENCE);
  });

  it("names the single record that narrowed the terms", () => {
    const changes = [
      change({ change_type: "limits_increased", date: "2026-01-01" }),
      change({ change_type: "restriction", date: "2026-03-01" }),
    ];
    const sentence = vendorVerdictSentence(input({ changes }));
    assert.ok(sentence.endsWith("One recorded restriction narrowed the terms, on 2026-03-01."));
  });

  it("reports that none narrowed the terms when every record points the other way", () => {
    const changes = [
      change({ change_type: "limits_increased", date: "2026-01-01" }),
      change({ change_type: "new_free_tier", date: "2026-02-01" }),
      change({ change_type: "rebranded", date: "2026-03-01" }),
    ];
    assert.strictEqual(narrowingSentence(changes), "None of the 3 recorded changes narrowed the terms.");
  });

  it("does not let a withdrawn record establish the narrowing the verdict says is not there", () => {
    const standing = change({ change_type: "free_tier_removed", date: "2026-08-28" });
    const withdrawn = change({
      change_type: "free_tier_removed",
      date: "2026-08-28",
      resolution: { state: "retracted", date: "2026-09-03", source_url: "https://example.test/withdrawal" },
    });

    assert.strictEqual(establishesANarrowing(standing), true);
    assert.match(narrowingSentence([standing]), /One recorded free tier removal narrowed the terms/);

    assert.strictEqual(establishesANarrowing(withdrawn), false);
    assert.strictEqual(narrowingSentence([withdrawn]), "The one record we hold was our own error and has been withdrawn.");
    assert.doesNotMatch(
      vendorVerdictSentence(input({ level: "stable", changes: [withdrawn] })),
      /narrowed the terms/,
    );
  });

  it("says what a record that repairs our own entry is, rather than counting it as a change", () => {
    const changes = [change({ change_type: "record_corrected", date: "2026-03-22" })];
    assert.strictEqual(
      narrowingSentence(changes),
      "The one record we hold corrects our own earlier entry rather than reporting a change the vendor made.",
    );
    assert.doesNotMatch(narrowingSentence(changes), /narrowed the terms/);
    assert.doesNotMatch(vendorVerdictSentence(input({ changes })), /zero pricing changes recorded/);
  });

  it("says so for every repair when we hold nothing else", () => {
    const changes = [
      change({ change_type: "record_corrected", date: "2026-03-22" }),
      change({ change_type: "record_corrected", date: "2026-03-21" }),
    ];
    assert.strictEqual(
      narrowingSentence(changes),
      "All 2 records we hold correct our own earlier entries rather than reporting changes the vendor made.",
    );
  });

  it("leaves a repair out of both sides of the narrowing count", () => {
    const changes = [
      change({ change_type: "limits_increased", date: "2026-01-01" }),
      change({ change_type: "limits_increased", date: "2025-01-22" }),
      change({ change_type: "record_corrected", date: "2026-03-21" }),
      change({ change_type: "restriction", date: "2026-08-28" }),
    ];
    assert.strictEqual(
      narrowingSentence(changes),
      "One recorded restriction narrowed the terms, on 2026-08-28.",
    );
    assert.doesNotMatch(narrowingSentence(changes), /2 recorded changes narrowed/);
    const noNarrowing = changes.filter(c => c.change_type !== "restriction");
    assert.strictEqual(narrowingSentence(noNarrowing), "None of the 2 recorded changes narrowed the terms.");
  });

  it("#1721 says a record names our stored terms as the previous ones rather than which way it moved", () => {
    const one = [change({ change_type: "limits_increased", date: "2026-09-07" })];
    assert.strictEqual(
      narrowingSentence(one, null, true),
      "The one change we have recorded names our stored terms as the previous ones.",
    );
    assert.doesNotMatch(narrowingSentence(one, null, true), /narrow/);
    assert.strictEqual(
      narrowingSentence([...one, change({ change_type: "rebranded", date: "2026-08-01" })], null, true),
      "Of the 2 changes we have recorded, at least one names our stored terms as the previous ones.",
    );
    assert.strictEqual(narrowingSentence(one, null, false), "The one change we have recorded did not narrow the terms.");
  });

  it("#1721 names the narrowing rather than the supersession where a record narrowed the terms", () => {
    const narrowed = [change({ change_type: "limits_reduced", date: "2026-08-28" })];
    assert.match(narrowingSentence(narrowed, null, true), /One recorded limit reduction narrowed the terms/);
    assert.strictEqual(narrowingSentence(narrowed, null, true), narrowingSentence(narrowed, null, false));
  });

  it("never reaches for the second scale's vocabulary", () => {
    for (const changes of [[], [change()], [change({ change_type: "limits_increased" })], [change({ change_type: "product_deprecated" })]]) {
      assert.doesNotMatch(vendorVerdictSentence(input({ changes })), STABILITY_SCALE_WORDS);
    }
  });
});

describe("vendor verdict — a narrowing that has not taken effect is announced, not counted", () => {
  const SERVED_ON = "2026-10-06";

  it("counts and names as the most recent only the narrowings in effect, then announces the one ahead", () => {
    const changes = [
      change({ change_type: "restriction", date: "2026-08-28" }),
      change({ change_type: "restriction", date: "2026-09-20" }),
      change({ change_type: "limits_reduced", date: "2026-10-20" }),
    ];
    assert.strictEqual(
      narrowingSentence(changes, null, false, SERVED_ON),
      "2 recorded changes narrowed the terms, the most recent on 2026-09-20. A limit reduction is announced for 2026-10-20 and has not taken effect.",
    );
  });

  it("gives the count of announced narrowings and the first of them by date", () => {
    const changes = [
      change({ change_type: "restriction", date: "2026-09-20" }),
      change({ change_type: "limits_reduced", date: "2026-11-30" }),
      change({ change_type: "free_tier_removed", date: "2026-10-20" }),
    ];
    assert.strictEqual(
      narrowingSentence(changes, null, false, SERVED_ON),
      "One recorded restriction narrowed the terms, on 2026-09-20. 2 narrowing changes are announced and have not taken effect; the first is a free tier removal on 2026-10-20.",
    );
  });

  it("opens by saying nothing has taken effect when every record is still ahead", () => {
    assert.strictEqual(
      narrowingSentence([change({ change_type: "limits_reduced", date: "2026-10-20" })], null, false, SERVED_ON),
      "None of the changes we have recorded has taken effect yet. A limit reduction is announced for 2026-10-20 and has not taken effect.",
    );
    assert.strictEqual(
      narrowingSentence([change({ change_type: "new_tier", date: "2026-10-20" })], null, false, SERVED_ON),
      "None of the changes we have recorded has taken effect yet.",
    );
  });

  it("counts the records that did not narrow the terms over the same set in effect", () => {
    const changes = [
      change({ change_type: "limits_increased", date: "2026-09-01" }),
      change({ change_type: "new_tier", date: "2026-10-20" }),
    ];
    assert.strictEqual(narrowingSentence(changes, null, false, SERVED_ON), "The one change we have recorded did not narrow the terms.");
  });

  it("counts a narrowing dated the day the page is served as in effect", () => {
    assert.strictEqual(
      narrowingSentence([change({ change_type: "restriction", date: SERVED_ON })], null, false, SERVED_ON),
      `One recorded restriction narrowed the terms, on ${SERVED_ON}.`,
    );
  });

  it("announces no narrowing ahead that cites no source", () => {
    const changes = [
      change({ change_type: "restriction", date: "2026-09-20" }),
      change({ change_type: "limits_reduced", date: "2026-10-20", source_url: "" }),
    ];
    assert.strictEqual(narrowingSentence(changes, null, false, SERVED_ON), "One recorded restriction narrowed the terms, on 2026-09-20.");
  });
});

describe("vendor verdict — the prose table covers the data", () => {
  it("names every change type present in the change log", () => {
    const missing = [...new Set(loadDealChanges().map(c => c.change_type))]
      .filter(t => !(t in CHANGE_KIND_NOUN));
    assert.deepStrictEqual(missing, [], `change types with no reader-facing noun: ${missing.join(", ")}`);
  });
});

interface VendorRow {
  slug: string;
  vendor: string;
  expected: "stable" | "caution" | "risky" | null;
  historyLevel: "stable" | "caution" | "risky";
  badge: string;
  endingLabel: string | null;
  ended: boolean;
  badgeEnded: boolean;
  withheld: ReturnType<typeof levelWithheldReason>;
  ratingWithheld: boolean;
  badgeRendered: boolean;
  sentence: string;
  readAgainOn: string | null;
  termsSuperseded: boolean;
  tier: string;
  changes: DealChange[];
  gate: Gate | null;
  cause: RiskCause | null;
  demotionNamed: RiskCause | null;
}

function vendorRows(): VendorRow[] {
  const offers = loadOffers();
  const changes = loadDealChanges();
  const rows: VendorRow[] = [];
  for (const [slug, vendor] of vendorSlugMap) {
    const vendorOffers = offers.filter(o => o.vendor === vendor);
    const primary = vendorOffers[0];
    if (!primary) continue;
    const vendorChanges = changes
      .filter(c => c.vendor.toLowerCase() === vendor.toLowerCase())
      .sort((a, b) => b.date.localeCompare(a.date));
    const context = vendorVerdictContextFrom({
      vendor,
      vendorOffers,
      vendorChanges,
      refusedReads: refusalsForVendor(vendor),
      servedOn: utcDate(),
    })!;
    const enriched = context.enriched;
    const withheld = context.levelWithheld;
    const expected = publishedVendorLevel(enriched.risk_level ?? null, enriched.risk_cause ?? null);
    const gate = gateForOffer(primary, utcDate());
    const ended = offerEnded(primary);
    const badgeEnded = ended || gateStatesAnEnding(gate?.code ?? null);
    const termsSuperseded = context.input.termsSuperseded ?? false;
    const claim = freeTierClaim(context.input);
    const endingLabel = !badgeEnded && claim.states === "ended" && claim.how === "removed"
      ? (claim.cause.change_type === PRODUCT_DEPRECATED ? "deprecated" : "free tier removed")
      : null;
    rows.push({
      slug,
      vendor,
      expected,
      historyLevel: context.input.historyLevel,
      ended,
      badgeEnded,
      badge: endingLabel ?? (badgeEnded ? ENDED_BADGE_LABEL : expected),
      endingLabel,
      withheld,
      ratingWithheld: ratingWithheldForNoSource(context.input),
      badgeRendered: endingLabel !== null || badgeEnded || !(gate || enriched.risk_level === null || (enriched.link_unreachable && expected === "stable")),
      sentence: vendorVerdictSentence(context.input),
      readAgainOn: refusedReadWeHold(context.input)?.read_again_on ?? null,
      termsSuperseded,
      tier: primary.tier,
      changes: vendorChanges,
      gate,
      cause: enriched.risk_cause ?? null,
      demotionNamed: demotionTheVerdictNames(context.input),
    });
  }
  return rows;
}

const verdictRestsOnANarrowingInForce = (row: VendorRow): boolean => {
  const named = row.demotionNamed;
  return named !== null && row.changes.some(c => establishesANarrowing(c)
    && c.date === named.date && c.change_type === named.change_type && c.summary === named.summary);
};

const publishesALevelRatherThanAnEnding = (row: VendorRow): boolean => row.endingLabel === null && !row.badgeEnded;

describe("vendor verdict — corpus invariant, computed offline", () => {
  it("gives every vendor we hold records for one rating word and no second scale", () => {
    const wrong: string[] = [];
    for (const row of vendorRows()) {
      if (row.changes.length === 0) continue;
      if (STABILITY_SCALE_WORDS.test(row.sentence)) {
        wrong.push(`${row.slug}: verdict reaches for a second scale — ${row.sentence}`);
        continue;
      }
      if (row.ended) {
        if (row.sentence !== endedVerdictSentence()) {
          wrong.push(`${row.slug}: badge says ${row.badge}, verdict of an ended offer says ${row.sentence}`);
        }
        continue;
      }
      if (row.endingLabel) {
        if (!row.sentence.startsWith(ENDED_VERDICT_OPENING[row.endingLabel]) || !row.sentence.includes(" We no longer rate it.")) {
          wrong.push(`${row.slug}: badge says ${row.badge}, verdict says ${row.sentence}`);
        }
        if (row.withheld && !row.sentence.includes(CANNOT_CONFIRM_THESE_TERMS)) {
          wrong.push(`${row.slug}: states the ending without saying we cannot confirm the terms we print`);
        }
        continue;
      }
      if (row.expected === null && (row.withheld || row.ratingWithheld)) {
        if (/\bWe rate it\b/.test(row.sentence)) wrong.push(`${row.slug}: rates a vendor whose level we withhold`);
        continue;
      }
      if (row.gate) {
        if (row.badgeRendered && !row.badgeEnded) wrong.push(`${row.slug}: rates a gated record ${row.badge} beside its name`);
        if (!row.sentence.includes(`${row.vendor} ${GATED_LEVEL_PHRASE[row.historyLevel]}`)) {
          wrong.push(`${row.slug}: gated verdict says ${row.sentence}, over a history we read as ${row.historyLevel}`);
        }
        continue;
      }
      if (!row.badgeRendered) {
        if (/\bWe rate it\b/.test(row.sentence)) wrong.push(`${row.slug}: rates a vendor whose badge is withheld`);
        continue;
      }
      const named = row.sentence.match(/We rate it (stable|caution|risky)\b/)?.[1]
        ?? (row.sentence.startsWith("It's stable") ? "stable" : null);
      if (named !== row.expected) {
        wrong.push(`${row.slug}: badge says ${row.expected}, verdict says ${named ?? "nothing"}`);
      }
      if (row.withheld && !row.sentence.includes(CANNOT_CONFIRM_THESE_TERMS)) {
        wrong.push(`${row.slug}: rates the vendor without saying we cannot confirm the terms we print`);
      }
    }
    assert.deepStrictEqual(wrong, [], `vendors whose two stability judgements disagree:\n${wrong.join("\n")}`);
  });

  it("covers vendors the two classifiers rate differently, so the invariant is not vacuous", () => {
    const changes = loadDealChanges();
    const byVendor = new Map<string, DealChange[]>();
    for (const c of changes) {
      const key = c.vendor.toLowerCase();
      if (!byVendor.has(key)) byVendor.set(key, []);
      byVendor.get(key)!.push(c);
    }
    const negativeStability = new Set(["watch", "volatile"]);
    const disagreeing = [...byVendor.entries()].filter(([, vc]) =>
      vendorRiskAssessment(vc).level === "stable" && negativeStability.has(classifyStability(vc)));
    assert.ok(
      disagreeing.length > 0,
      "the change log holds no vendor the risk scale and the stability enum rate differently",
    );
    const routed = vendorRows().filter(r => r.changes.length > 0
      && vendorRiskAssessment(r.changes).level === "stable"
      && negativeStability.has(classifyStability(r.changes)));
    assert.ok(routed.length > 0, "no rendered vendor route sits in that population");
  });
});

describe("vendor verdict — as rendered", () => {
  let proc: ChildProcess | null = null;
  let port = 0;

  before(async () => {
    const started = await new Promise<{ child: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    proc = started.child;
    port = started.port;
  });

  after(() => { proc?.kill(); });

  const get = async (route: string) => {
    const res = await fetch(`http://localhost:${port}${route}`, {
      headers: { "user-agent": "agentdeals-internal/1.0 (vendor-verdict-test)" },
    });
    assert.strictEqual(res.status, 200, `${route} responded ${res.status}`);
    return res.text();
  };

  const badgeWord = (html: string): string | null => {
    const h1 = html.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
    return h1.match(/<span class="risk-badge"[^>]*>([a-z ]+)<\/span>/)?.[1] ?? null;
  };

  const verdictParagraph = (html: string): string => {
    const m = html.match(/<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/);
    assert.ok(m, "the page renders a verdict paragraph");
    return m[1];
  };

  const comparisonCell = (html: string): { rendered: boolean; word: string | null } => {
    const row = html.match(/<tr class="current-vendor-row">[\s\S]*?<\/tr>/)?.[0];
    if (!row) return { rendered: false, word: null };
    return {
      rendered: true,
      word: row.match(/<span class="stability-dot"[^>]*><\/span> <span[^>]*>([a-z]+)<\/span>/)?.[1] ?? null,
    };
  };

  const askedAbout = (row: VendorRow): string =>
    classifyTier(row.tier).class === "time_limited" && !(row.gate && GATES_LEAVING_NO_FREE_TIER.includes(row.gate.code))
      ? "free offer"
      : "free tier";

  const faqAnswers = (html: string, vendor: string, offer = "free tier"): { reliable: string | null; production: string } => {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(m => JSON.parse(m[1]) as Record<string, unknown>);
    const faq = blocks.find(b => b["@type"] === "FAQPage") as
      { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> } | undefined;
    assert.ok(faq, `${vendor} emits FAQ structured data`);
    const find = (name: string) => faq.mainEntity.find(e => e.name === name)?.acceptedAnswer.text ?? null;
    const production = find(`Is ${vendor}'s ${offer} good for production?`);
    assert.ok(production, `the structured data answers "Is ${vendor}'s ${offer} good for production?"`);
    return {
      reliable: find(`Is ${vendor}'s ${offer} reliable?`),
      production,
    };
  };

  it("renders on every vendor route the one rating its own records support", async () => {
    const rows = vendorRows();
    const wrong: string[] = [];
    let rating = 0;
    let index = 0;
    const worker = async () => {
      while (index < rows.length) {
        const row = rows[index++];
        const html = await get(`/vendor/${row.slug}`);
        const badge = badgeWord(html);
        const verdict = verdictParagraph(html);
        const cell = comparisonCell(html);

        if (badge !== null && badge !== ENDED_BADGE_LABEL && badge !== row.endingLabel) rating++;
        if (row.gate && !row.badgeEnded && badge !== null) {
          wrong.push(`${row.slug}: the h1 of a ${row.gate.code} record rates it ${badge}`);
        }
        if (row.gate && row.badgeEnded && badge !== (row.endingLabel ?? ENDED_BADGE_LABEL)) {
          wrong.push(`${row.slug}: the h1 of an ended offer reads ${badge ?? "nothing"}`);
        }
        if (row.badgeRendered && badge !== row.badge) {
          wrong.push(`${row.slug}: h1 badge is ${badge ?? "absent"}, expected ${row.badge}`);
        }
        if (!row.badgeRendered && badge !== null) {
          wrong.push(`${row.slug}: h1 badge renders ${badge} for a rating we are withholding`);
        }
        if (!verdict.includes(row.sentence)) {
          wrong.push(`${row.slug}: verdict does not render "${row.sentence}"`);
        }
        if (STABILITY_SCALE_WORDS.test(verdict)) {
          wrong.push(`${row.slug}: verdict reaches for a second scale — ${verdict}`);
        }
        if (COUNT_AS_EVIDENCE.test(verdict) && row.changes.length > 0) {
          wrong.push(`${row.slug}: verdict offers a count of changes as its evidence`);
        }
        if (cell.rendered && row.gate && cell.word !== null) {
          wrong.push(`${row.slug}: comparison table rates a gated record ${cell.word}`);
        }
        if (cell.rendered && !row.withheld && !row.gate && cell.word !== row.expected) {
          wrong.push(`${row.slug}: comparison table says ${cell.word ?? "nothing"}, h1 badge says ${row.expected}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    assert.deepStrictEqual(wrong.slice(0, 20), [], `vendor routes rendering more than one judgement:\n${wrong.slice(0, 20).join("\n")}`);
    assertPopulationFloor(rating, 400, "vendor pages rate the vendor beside its name");
    assert.ok(rows.some(r => r.gate && !r.ended), "no gated record reaches a vendor page, so the gate criterion has no subject");
    assert.ok(
      rows.some(r => r.readAgainOn !== null),
      "no vendor route holds a refused read we have read again since, so the sweep reads no record read twice",
    );
  });

  it("answers both of its own stability questions with the same word", async () => {
    const rows = vendorRows().filter(r => r.changes.length > 0);
    const wrong: string[] = [];
    let index = 0;
    const worker = async () => {
      while (index < rows.length) {
        const row = rows[index++];
        const html = await get(`/vendor/${row.slug}`);
        const answers = faqAnswers(html, row.vendor, askedAbout(row));
        for (const [name, text] of Object.entries(answers)) {
          if (text !== null && OTHER_SCALE_ON_A_SURFACE_THAT_EMBEDS_SUMMARIES.test(text)) {
            wrong.push(`${row.slug}: the "${name}" answer reaches for a second scale — ${text}`);
          }
        }
        const wouldRateAGatedOffer = row.gate !== null && !row.withheld && !row.ended;
        if (wouldRateAGatedOffer && answers.reliable !== null) {
          wrong.push(`${row.slug}: asks whether a gated free tier is reliable — ${answers.reliable}`);
        }
        if (!wouldRateAGatedOffer && answers.reliable === null) {
          wrong.push(`${row.slug}: no longer asks whether its free tier is reliable`);
        }
        if (answers.reliable !== null && row.endingLabel) {
          if (!answers.reliable.startsWith(ENDED_RELIABILITY_OPENING[row.endingLabel](row.vendor)) || RATES_THE_TIER.test(answers.reliable)) {
            wrong.push(`${row.slug}: the reliability answer does not state the ending its badge names — ${answers.reliable}`);
          }
        } else if (answers.reliable !== null && !row.withheld && !row.ended) {
          if (row.expected === null) {
            if (RATES_THE_TIER.test(answers.reliable)) {
              wrong.push(`${row.slug}: the reliability answer rates a vendor whose level we withhold — ${answers.reliable}`);
            }
          } else {
            if (!answers.reliable.includes(row.expected)) {
              wrong.push(`${row.slug}: the reliability answer does not carry the ${row.expected} rating`);
            }
            if (row.expected === "stable" && !answers.reliable.includes(narrowingSentence(row.changes, row, row.termsSuperseded))) {
              wrong.push(`${row.slug}: the reliability answer does not say what the records it holds did — ${answers.reliable}`);
            }
          }
        }
        const productionRating = answers.production.match(/we rate it (stable|caution|risky)\b/)?.[1];
        if (productionRating && row.endingLabel) {
          wrong.push(`${row.slug}: the production answer rates it ${productionRating} under a badge that says ${row.badge}`);
        } else if (productionRating && productionRating !== row.expected) {
          wrong.push(`${row.slug}: the production answer says ${productionRating}, the badge says ${row.expected}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    assert.deepStrictEqual(wrong.slice(0, 20), [], `vendor routes whose FAQ contradicts their badge:\n${wrong.slice(0, 20).join("\n")}`);
  });

  it("names a narrowing only where a record of the vendor's own establishes one", async () => {
    const rows = vendorRows().filter(r => r.changes.length > 0);
    const wrong: string[] = [];
    let index = 0;
    const worker = async () => {
      while (index < rows.length) {
        const row = rows[index++];
        const html = await get(`/vendor/${row.slug}`);
        const verdict = verdictParagraph(html);
        const narrowing = row.changes.filter(establishesANarrowing);
        if (CLAIMS_A_NARROWING.test(verdict) && narrowing.length === 0) {
          wrong.push(`${row.slug}: names a narrowing over ${row.changes.length} record(s), none of which still point down`);
        }
        if (row.changes.every(c => c.change_type === "record_corrected")) {
          if (!/corrects? our own earlier entr/.test(verdict)) {
            wrong.push(`${row.slug}: holds only repairs to our own entries and does not say so — ${verdict}`);
          }
          if (CLAIMS_A_NARROWING.test(verdict) || /pricing changes? recorded/.test(verdict)) {
            wrong.push(`${row.slug}: renders a repair to our own entry as a change the vendor made — ${verdict}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    assert.deepStrictEqual(wrong.slice(0, 20), [], `vendor routes claiming a narrowing they cannot show:\n${wrong.slice(0, 20).join("\n")}`);
  });

  it("counts one narrowing where a repair to our own entry sits beside it", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const besideARepair = vendorRows()
      .filter(row => row.changes.some(isARepairToOurOwnEntry) && row.changes.every(c => c.date <= today))
      .map(row => ({
        row,
        narrowing: narrowingChanges(row.changes.filter(c => !isARepairToOurOwnEntry(c) && changeCitesASource(c)), row),
      }))
      .filter(({ narrowing }) => narrowing.length === 1)
      .map(({ row, narrowing: [only] }) => ({ row, only }));
    assert.ok(
      besideARepair.length > 0,
      "no vendor holds a repair to our own entry beside exactly one narrowing record in force, so nothing here is checked",
    );

    for (const { row, only } of besideARepair) {
      assert.strictEqual(
        narrowingSentence(row.changes, row, row.termsSuperseded),
        `One recorded ${CHANGE_KIND_NOUN[only.change_type]} narrowed the terms, ${changeDateClause(only)}.`,
        `${row.slug}: the repair beside its one narrowing changes what the verdict counts`,
      );
    }

    let pagesNamingARecord = 0;
    let pagesStatingTheCount = 0;
    for (const { row, only } of besideARepair.filter(({ row }) => !row.gate)) {
      const verdict = verdictParagraph(await get(`/vendor/${row.slug}`));
      if (!/\bone recorded /i.test(verdict)) continue;
      pagesNamingARecord += 1;
      if (/narrowed the terms/.test(verdict)) pagesStatingTheCount += 1;
      assert.ok(namesTheRecord(verdict, only), `/vendor/${row.slug} names a record other than its one narrowing: ${verdict}`);
      assert.doesNotMatch(verdict, /\b\d+ recorded changes narrowed the terms/, `/vendor/${row.slug}`);
      assert.doesNotMatch(verdict, /corrects our own earlier entry/, `/vendor/${row.slug}`);
    }
    assert.ok(pagesNamingARecord > 0, "no vendor page under test names a record in its verdict, so no page is checked");
    assert.ok(
      pagesStatingTheCount > 0,
      "no vendor page under test says how many records narrowed the terms, so the count a reader sees is unchecked",
    );

    const neo4j = verdictParagraph(await get("/vendor/neo4j-auradb"));
    assert.match(neo4j, /The one record we hold corrects our own earlier entry rather than reporting a change the vendor made\./);
    assert.doesNotMatch(neo4j, /narrowed the terms/);
  });

  it("renders no green badge over a negative verdict on a route whose verdict rests on a narrowing record in force", async () => {
    const routes = vendorRows().filter(r => verdictRestsOnANarrowingInForce(r) && publishesALevelRatherThanAnEnding(r));
    let cellsChecked = 0;
    let index = 0;
    const worker = async () => {
      while (index < routes.length) {
        const row = routes[index++];
        const slug = row.slug;
        const html = await get(`/vendor/${slug}`);
        assert.strictEqual(
          badgeWord(html),
          row.gate ? null : row.expected,
          `/vendor/${slug} badge, over a ${row.gate?.code ?? "listed"} record`,
        );
        const cell = comparisonCell(html);
        if (cell.rendered) {
          cellsChecked += 1;
          assert.strictEqual(cell.word, row.expected, `/vendor/${slug} comparison cell`);
        }
        const verdict = verdictParagraph(html);
        assert.doesNotMatch(verdict, STABILITY_SCALE_WORDS, `/vendor/${slug} verdict`);
        assert.ok(verdict.includes(row.sentence), `/vendor/${slug} verdict does not render "${row.sentence}"`);
        assert.notStrictEqual(row.expected, "stable", `/vendor/${slug} still reads stable over a record that points down`);
        assert.ok(
          row.gate ? row.sentence.includes(row.cause!.summary) : /one recorded /.test(row.sentence),
          `/vendor/${slug} still names no record behind its level`,
        );
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    assert.ok(cellsChecked > 0, "no route under test rendered a comparison cell, so the badge agreement is unchecked");
    assert.ok(
      routes.some(r => !r.gate),
      "every route under test is now gated, so no rendered badge is checked against its verdict here",
    );
  });

  it("stops offering a product whose own shutdown date has passed", async () => {
    const html = await get("/vendor/hypertune");
    const pageMeta = html.match(/<p class="page-meta">([\s\S]*?)<\/p>/)?.[1] ?? "";
    assert.match(pageMeta, /Discontinued 2026-08-10/);
    assert.doesNotMatch(pageMeta, /Verified/, "the subhead still stamps a discontinued product as verified");

    const metaDesc = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
    assert.doesNotMatch(metaDesc, /Verified [A-Z][a-z]+ \d{4}/, "search results still stamp it as verified");

    const verdict = verdictParagraph(html);
    assert.match(verdict, /discontinued on 2026-08-10, so it is not a current option/);
    assert.doesNotMatch(verdict, /Best for [a-z ]*workloads/, "the verdict still recommends it for a workload");

    assert.ok(
      !/class="section growth-section"/.test(html),
      "the page still tells the reader when they will outgrow a free tier that has ended",
    );
    assert.match(html, /<div class="detail-label">Discontinued<\/div>\s*<div class="detail-value"[^>]*>2026-08-10<\/div>/);
  });
});

describe("vendor verdict — a product being sunset with no date past, as rendered", () => {
  const SUNSETTING = "Fixture Sunsetting Studio";
  let tmp = "";
  let proc: ChildProcess | null = null;
  let port = 0;

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "vendor-verdict-sunset-"));
    const index = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const fiveDaysAgo = daysAgo(5);
    index.offers.push({
      vendor: SUNSETTING,
      category: "Databases",
      description: "Free plan: 3 projects",
      tier: "Free",
      url: "https://sunsetting.example/pricing",
      tags: [],
      verifiedDate: fiveDaysAgo,
      source_check: { checked: fiveDaysAgo, outcome: "ok", detail: `the page names ${SUNSETTING} and states the terms we publish` },
    });
    const log = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
    log.changes.push({
      vendor: SUNSETTING,
      change_type: "product_deprecated",
      date: daysAgo(30),
      date_source: "vendor_page",
      summary: `${SUNSETTING} is being sunset and stops taking new sign-ups.`,
      previous_state: "Available",
      current_state: "Being sunset",
      impact: "high",
      source_url: "https://sunsetting.example/blog/sunset",
      category: "Databases",
      alternatives: [],
      listing_effect: "ends",
    });
    writeFileSync(path.join(tmp, "index.json"), JSON.stringify(index));
    writeFileSync(path.join(tmp, "deal_changes.json"), JSON.stringify(log));
    const started = await new Promise<{ child: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PORT: "0",
          BASE_URL: "http://localhost",
          AGENTDEALS_INDEX_PATH: path.join(tmp, "index.json"),
          AGENTDEALS_CHANGES_PATH: path.join(tmp, "deal_changes.json"),
        },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    proc = started.child;
    port = started.port;
  });

  after(() => {
    proc?.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("leaves the dated stamp on a product being sunset with no date past", async () => {
    const res = await fetch(`http://localhost:${port}/vendor/${toSlug(SUNSETTING)}`);
    assert.strictEqual(res.status, 200, `/vendor/${toSlug(SUNSETTING)} responded ${res.status}`);
    const html = await res.text();
    const pageMeta = html.match(/<p class="page-meta">([\s\S]*?)<\/p>/)?.[1] ?? "";
    assert.match(pageMeta, new RegExp(`(${CONFIRMED_DATE_LABEL}|${UNCONFIRMED_DATE_LABEL}) [A-Z][a-z]+ \\d{4}`));
    assert.doesNotMatch(pageMeta, /Discontinued/);
    const h1 = html.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
    assert.strictEqual(
      h1.match(/<span class="risk-badge"[^>]*>([a-z ]+)<\/span>/)?.[1] ?? null,
      "deprecated",
      "a product being sunset heads with the label its badge carries",
    );
  });
});
