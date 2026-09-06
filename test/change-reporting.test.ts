import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  changeIsUncited,
  changesCitingAPageTheyCallUnreadable,
  citesAPageItCallsUnreadable,
  summaryCallsItsSourceUnreadable,
  uncitedChanges,
} from "../dist/change-citation.js";
import {
  CHANGE_REPORT_RULE,
  CHANGE_REPORT_SUBJECTS,
  UNCITED_CHANGE_BUDGET_RULE,
  changeReports,
  countsAgainstUncitedBudget,
  ourIndexChangeMayNotCiteASource,
  ourIndexChanges,
  reportsOurIndex,
  uncitedChangesAgainstBudget,
  vendorOfferChanges,
} from "../dist/change-reporting.js";
import {
  QUALITY_BUDGET_NAMES,
  parseQualityBudgets,
  qualityBudget,
  readQualityBudgets,
  serializeQualityBudgets,
} from "../dist/page-reviews.js";
import { loadDealChanges } from "../dist/data.js";
import { openapiSpec } from "../dist/openapi.js";
import type { DealChange } from "../dist/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const changes: DealChange[] = loadDealChanges();

const record = (over: Partial<DealChange> = {}): DealChange => ({
  vendor: "Fixture Vendor",
  change_type: "free_tier_removed",
  date: "2026-08-01",
  summary: "Free tier removed",
  previous_state: "Free tier: 5 GB",
  current_state: "Paid only",
  impact: "high",
  source_url: "https://example.com/pricing",
  category: "Databases",
  alternatives: [],
  date_source: "vendor_page",
  ...over,
});

describe("a record whose summary says its own source cannot be read", () => {
  it("is caught whether the summary names the page, the domain or the homepage", () => {
    const cases = [
      "Removed: source page no longer accessible or deal program discontinued",
      "Domain no longer resolves (DNS ENOTFOUND).",
      "Homepage returns HTTP 502. Removed from index.",
      "The pricing page is gone.",
      "The deal page 404s.",
      "The site is unreachable.",
      "The blog post no longer exists.",
    ];
    for (const summary of cases) {
      assert.ok(
        citesAPageItCallsUnreadable(record({ summary })),
        `"${summary}" reads as a record disowning its own citation and was not caught`,
      );
    }
  });

  it("leaves alone a record whose summary retires the offer rather than the page", () => {
    const cases = [
      "The free tier no longer exists. The lowest tier is now $90/month.",
      "Fauna shut down entirely on May 30, 2025. The serverless document database ceased all operations.",
      "The free tier information is no longer available. The pricing page details three paid tiers.",
      "Firebase Studio shut down March 19, 2026. Existing projects accessible until March 2027 for migration.",
      "Console access redirects to an upgrade page and API calls return 402 or 403.",
      "The old pricing page 404s; the current one is linked here.",
    ];
    for (const summary of cases) {
      assert.strictEqual(
        summaryCallsItsSourceUnreadable(record({ summary })),
        null,
        `"${summary}" is not a record disowning its own citation`,
      );
    }
  });

  it("holds the claim against the page we cite, not against a page someone else's is", () => {
    const summary = "joinsecret.com returns 403 errors and the pricing page 404s.";
    assert.ok(citesAPageItCallsUnreadable(record({ summary, source_url: "https://www.joinsecret.com/offers" })));
    assert.strictEqual(summaryCallsItsSourceUnreadable(record({ summary, source_url: "https://example.com/p" })), null);
  });

  it("asks nothing of a record that cites nothing, since there is no claim to contradict", () => {
    assert.strictEqual(summaryCallsItsSourceUnreadable(record({ summary: "Domain is dead", source_url: "" })), null);
  });

  it("is what the whole change log is held to, not the eight records that exposed it", () => {
    const offenders = changesCitingAPageTheyCallUnreadable(changes).map(
      c => `${c.vendor} ${c.date} -> ${c.source_url} (${summaryCallsItsSourceUnreadable(c)})`,
    );
    assert.deepStrictEqual(offenders, []);
    assert.ok(changes.length > 500, `only ${changes.length} records were checked`);
  });

  it("no longer sends anyone to the startup-deals roundup that named none of its eight vendors", () => {
    const stillCiting = changes
      .filter(c => (c.source_url ?? "").includes("userlike.com/en/blog/startup-deals"))
      .map(c => c.vendor);
    assert.deepStrictEqual(stillCiting, []);
  });
});

describe("what a change record reports", () => {
  it("is a field, so a reader of the data does not have to parse the summary to tell", () => {
    const shipped = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
    const marked = shipped.filter((c: DealChange) => c.reports === "our_index");
    assert.ok(marked.length > 0, "no shipped record says it reports our own index");
    assert.strictEqual(marked.length, ourIndexChanges(changes).length);
    for (const c of marked) {
      assert.strictEqual(c.current_state, "Removed from index", `${c.vendor} is marked but describes something else`);
    }
  });

  it("defaults to the vendor's offer, so an unmarked record keeps the meaning it always had", () => {
    assert.strictEqual(changeReports(record()), "vendor_offer");
    assert.strictEqual(changeReports(record({ reports: undefined })), "vendor_offer");
    assert.strictEqual(reportsOurIndex(record()), false);
    assert.strictEqual(vendorOfferChanges(changes).length + ourIndexChanges(changes).length, changes.length);
  });

  it("names both sides and says what each one means", () => {
    assert.deepStrictEqual([...CHANGE_REPORT_SUBJECTS], ["vendor_offer", "our_index"]);
    for (const subject of CHANGE_REPORT_SUBJECTS) {
      assert.ok(CHANGE_REPORT_RULE[subject].length > 20, `${subject} carries no rule`);
    }
  });

  it("is published in the API schema, so an agent can drop it from a market-activity figure", () => {
    const schema = openapiSpec.components.schemas.DealChange.properties.reports;
    assert.deepStrictEqual(schema.enum, [...CHANGE_REPORT_SUBJECTS]);
    for (const subject of CHANGE_REPORT_SUBJECTS) {
      assert.ok(schema.description.includes(subject), `the schema does not say what ${subject} means`);
    }
  });

  it("leaves the deprecations that report a vendor's own shutdown on the vendor side", () => {
    const deprecations = changes.filter(c => c.change_type === "product_deprecated");
    const vendorSide = vendorOfferChanges(deprecations);
    assert.ok(vendorSide.length > 30, `only ${vendorSide.length} product deprecations still report a vendor`);
    assert.ok(vendorSide.some(c => c.vendor === "Fauna"), "a real vendor shutdown was swept up as index cleanup");
  });
});

describe("the budget on records citing no source", () => {
  it("counts the records that report a vendor's offer, and says why the others are outside it", () => {
    const measured = uncitedChangesAgainstBudget(changes);
    assert.strictEqual(measured.length, uncitedChanges(changes).length - ourIndexChanges(changes).length);
    assert.ok(measured.length <= qualityBudget("uncited_change_records"));
    assert.ok(UNCITED_CHANGE_BUDGET_RULE.includes("our own"), "the rule does not state what it leaves out");
  });

  it("cannot be dodged by calling a vendor's change our own index cleanup", () => {
    const smuggled = record({ reports: "our_index", source_url: "" });
    assert.strictEqual(countsAgainstUncitedBudget(smuggled), false);
    assert.strictEqual(ourIndexChangeMayNotCiteASource(smuggled), false);
    assert.strictEqual(ourIndexChangeMayNotCiteASource(record({ reports: "our_index" })), true);
  });

  it("holds every record reporting our own index to citing nothing at all", () => {
    const cited = ourIndexChanges(changes).filter(c => !changeIsUncited(c)).map(c => c.vendor);
    assert.deepStrictEqual(cited, []);
    assert.ok(ourIndexChanges(changes).length > 0, "no record reports our own index, so nothing exercises the rule");
  });

  it("refuses a reason for a budget nothing reads, and a reason that says nothing", () => {
    const budgets = Object.fromEntries(QUALITY_BUDGET_NAMES.map(n => [n, 1]));
    assert.throws(
      () => parseQualityBudgets(
        JSON.stringify({ version: 1, budgets, raised_because: { uncited_change_recrods: "typo" } }),
        "fixture",
      ),
      /uncited_change_recrods/,
    );
    assert.throws(
      () => parseQualityBudgets(
        JSON.stringify({ version: 1, budgets, raised_because: { uncited_change_records: "  " } }),
        "fixture",
      ),
      /no reason for raising uncited_change_records/,
    );
  });

  it("records in the budgets file why it was last raised, and keeps that through a ratchet", () => {
    const shipped = readQualityBudgets();
    const reason = shipped.raised_because.uncited_change_records;
    assert.ok(typeof reason === "string" && reason.length > 40, "the raise carries no reason");
    assert.match(reason!, /\b95 to 98\b/);
    assert.strictEqual(
      serializeQualityBudgets(shipped),
      readFileSync(path.join(REPO, "data", "quality_budgets.json"), "utf-8"),
    );
  });
});
