import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  THUNDER_CLIENT_LANDING_PAGE,
  DOCZILLA_LANDING_PAGE,
  FREEIPAPI_LANDING_PAGE,
  JOINSECRET_OFFERS_PAGE,
  WEAVIATE_PRICING_PAGE,
} from "./vendor-page-fixture.ts";

process.env.AGENTDEALS_REFUSALS_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "refusals-gate-")),
  "change_refusals.json"
);

const {
  describesChange,
  gateCandidates,
  nullComparisons,
  assertsAgreement,
  quantities,
  priceSignals,
  quantifiedAttributes,
  storedDimensionsAbsentFromPage,
  measuredDifferences,
  measuredValue,
  comparedQuantity,
  measuredAgainstItsClaim,
  rejectionCounts,
  parseConfirmation,
  changeConfirmationPrompt,
  BYTE_UNITS,
  RECLASSIFIED_AS_RESTRUCTURE,
  MIN_PRICE_SIGNALS,
  REJECT_NULL_COMPARISON,
  REJECT_STATES_NO_DIFFERENCE,
  REJECT_NO_PRICE_SIGNAL,
  REJECT_PAGE_NOT_ABOUT_VENDOR,
  REJECT_UNQUANTIFIED_LIMIT,
  REJECT_CONFIRMED_UNCHANGED,
  REJECT_MEASURES_NO_CHANGE,
  REJECT_MEASURES_THE_OPPOSITE,
} = await import("../scripts/change-gate.js");

const { runAiMode, summaryLines } = await import("../scripts/reverify-rolling.js");
const { fetchPageText, MAX_PAGE_TEXT_LENGTH, MIN_PAGE_TEXT_LENGTH } = await import("../scripts/verify-freshness.js");
const { CHANGE_TYPES } = await import("../scripts/change-log.js");

const NOW = new Date("2026-08-28T09:00:00Z");

const SAME_TERMS_EITHER_SIDE = {
  vendor: "Abby",
  change_type: "limits_reduced",
  summary:
    "The free tier now has 1 A/B test instead of 1, and the pricing is now explicitly stated as $12/month per project for the Starter tier (previously just 'scale at a fair price').",
  previous_state:
    "Open-Source feature flags & A/B testing. Configuration as Code & Fully Typed Typescript SDKs. Strong integration with Frameworks such as Next.js & React. Free plan: 1,000 events/month, 3 feature flags/remote configs, 1 A/B test, 5 environments.",
  current_state:
    "Free: 1,000 Events / month, 1 A/B Test, 3 Feature Flags / Remote Configs, 5 Environments. Starter: 1,000 Events / month, 1 A/B Test, 3 Feature Flags / Remote Configs, 5 Environments $12 /mo per Project",
  impact: "medium",
};

const SUMMARY_SAYS_IT_MATCHES = {
  vendor: "Cloudflare DNS",
  change_type: "limits_reduced",
  summary:
    "The page confirms a free plan exists, but states a records-per-zone cap of 200 for zones created on or after 2024-09-01, while zones created before that date retain the legacy 1,000-record cap. This matches the stored deal info. However, the page also promotes add-ons that are paid, and the free plan is described as a foundational offering with the option to upgrade.",
  previous_state:
    "Free authoritative DNS hosting — unlimited zones and queries, DDoS protection, free SSL/TLS. Records-per-zone cap is 200 for zones created on or after 2024-09-01; zones created before that date retain the legacy 1,000-record cap.",
  current_state:
    "The free plan offers foundational security and performance. Records-per-zone is capped at 200 for zones created on or after 2024-09-01, and 1,000 for zones created before that date.",
  impact: "medium",
};

const AGREES_ON_ONE_FIGURE_AND_DIFFERS_ON_ANOTHER = {
  vendor: "Algolia",
  change_type: "pricing_restructured",
  summary:
    "The 'Build' tier is no longer explicitly mentioned. The 'Grow' plan offers 10K search requests/month and 100K records included, which aligns with the stored information, but it's now a paid plan with overage fees. A 'Free' plan is available with 10K search requests/month and 50K records, but it has fewer features.",
  previous_state:
    "Search-as-a-service — 10K search requests/month, 1M records, AI recommendations included",
  current_state:
    "A 'Free' plan includes 10K search requests/month and 50K records. The 'Grow' plan includes 10K search requests /month and 100K records, with overages at $0.50/1K requests and $0.40/1K records.",
  impact: "high",
};

const A_LIMIT_ACTUALLY_MOVED = {
  vendor: "Deno Deploy",
  change_type: "limits_reduced",
  summary:
    "Egress bandwidth for the free tier is now 20GiB, down from 100 GB. KV storage remains at 1 GiB, but the free tier now includes 1,000,000 KV read units and 500,000 KV write units. CPU time is now 10 hours, down from 15 hours. Revision storage is 10 GiB.",
  previous_state:
    "Edge runtime — 1M requests/month, 100 GB egress, 1 GiB KV storage, 450K KV reads/month, 15 hours CPU time/month",
  current_state:
    "Free tier includes 1M requests/month, 20GiB egress, 1 GiB KV storage, 1,000,000 KV read units/month, 500,000 KV write units/month, and 10 hr CPU time.",
  impact: "high",
};

const A_DAILY_CAP_WAS_HALVED = {
  vendor: "DB-IP",
  change_type: "limits_reduced",
  summary: "The free tier now has a limit of 500 daily requests, down from 1k.",
  previous_state:
    "Free IP geolocation API with 1k request per IP per day.lite database under the CC-BY 4.0 License is free too.",
  current_state: "The Free API is limited to 500 daily requests.",
  impact: "medium",
};

const A_SUPPORT_CHANNEL_CLOSED = {
  vendor: "Papertrail",
  change_type: "limits_reduced",
  summary: "Support on the free plan is now community forums only.",
  previous_state: "Log aggregation — free plan with email support from the Papertrail team",
  current_state: "The free plan is supported through the community forum.",
  impact: "medium",
};
const A_RETENTION_WINDOW_SHRANK = {
  vendor: "Sematext",
  change_type: "limits_reduced",
  summary: "The free tier now has a 1-day retention instead of 7, and is priced per host. The original deal had no per-host charges.",
  previous_state:
    "Observability platform — Logs: 500 MB/day ingestion, 7-day retention. Monitoring: 3 hosts, 3 containers/host, 30-min data retention, 1 alert rule. Volume-based pricing, no per-host charges on paid plans",
  current_state: "Basic plan is available per host per month with 1 day retention.",
  impact: "medium",
};

const A_FREE_PLAN_BECAME_A_TRIAL = {
  vendor: "Middleware.io",
  change_type: "free_tier_removed",
  summary:
    "The free tier now offers a 14-day free trial with unlimited data ingestion, instead of a 'free forever' plan with specific limits. The original limits of 100 GB/month data, 1,000 RUM sessions/month, 20,000 synthetic checks/month, and 14-day data retention are no longer offered as a permanent free tier.",
  previous_state:
    "Full-stack observability platform — free forever plan: 100 GB/month data (APM, logs, infrastructure, traces, RUM, synthetics, database, serverless), 1,000 RUM sessions/month, 20,000 synthetic checks/month, 14-day data retention, unlimited users",
  current_state: "We provide 14 days free trial with unlimited data ingestion.",
  impact: "high",
};

const THE_CHANGE_WORD_SITS_FAR_FROM_BOTH_FIGURES = {
  vendor: "Farsplit",
  change_type: "pricing_model_change",
  summary:
    "The free tier still lists 10 GB of storage. Billing is now monthly instead of annual, and the storage allowance of 10 GB is unchanged.",
  previous_state: "Free tier: 10 GB storage, billed annually",
  current_state: "Free tier: 10 GB storage, billed monthly",
  impact: "medium",
};

const TWO_CAPS_TRADED_PLACES = {
  vendor: "Swapstore",
  change_type: "limits_reduced",
  summary: "Bandwidth is now 10 GB and storage is now 100 GB — the two caps have traded places.",
  previous_state: "Free tier: 100 GB bandwidth, 10 GB storage",
  current_state: "Free tier: 10 GB bandwidth, 100 GB storage",
  impact: "high",
};

const THE_SAME_CAP_WRITTEN_WITHOUT_ITS_SEPARATOR = {
  vendor: "Commacount",
  change_type: "limits_reduced",
  summary: "The daily cap is now 1000 requests, down from 1,000.",
  previous_state: "Free API: 1,000 requests per day",
  current_state: "Free API: 1000 requests per day",
  impact: "medium",
};

const READ_FROM_A_PAGE_WITH_NO_PRICING = {
  vendor: "Thunder Client",
  change_type: "pricing_model_change",
  summary:
    "The pricing information has changed. The page no longer explicitly mentions a free tier. It highlights Git Sync for team collaboration, which was previously a premium feature.",
  previous_state:
    "Lightweight REST API client for VS Code. Free tier includes collections, environments, local storage, and request history. No account required for local use. Premium ($10/yr) adds cloud sync and team collaboration",
  current_state:
    "The page describes Thunder Client as a lightweight REST API client with local storage and Git Sync for team collaboration. It does not mention a free or premium tier, or any pricing.",
  impact: "high",
  source_url: "https://www.thunderclient.com",
};

const READ_FROM_A_PAGE_ABOUT_OTHER_COMPANIES = {
  vendor: "Cloudways",
  change_type: "limits_reduced",
  summary:
    "The offer has been reduced from 30% off for 3 months to a single free deal, with subsequent deals requiring a 99 EUR annual membership.",
  previous_state: "30% off for 3 months. Access via: First deal free, then 99€/year or invite friends",
  current_state: "The page lists a first deal free, then 99€/year or invite friends.",
  impact: "high",
  source_url: "https://www.joinsecret.com/offers",
};

const READ_FROM_A_LANDING_PAGE_THAT_ONLY_LINKS_TO_PRICING = {
  vendor: "Doczilla",
  change_type: "limits_increased",
  summary:
    "The pricing page states there are 'no strict limits' on the number of documents or screenshots, contradicting the stored information of a 250 documents/month limit.",
  previous_state:
    "SaaS API empowering the generation of screenshots or PDFs directly from HTML/CSS/JS code. The free plan allows 250 documents month.",
  current_state: "There are no strict limits to the number of documents or screenshots that can be generated.",
  impact: "high",
  source_url: "https://www.doczilla.app/",
};

const READ_FROM_A_ROOT_THAT_PUBLISHES_ITS_PRICING = {
  vendor: "FreeIPAPI",
  change_type: "limits_reduced",
  summary:
    "While a free tier still exists, it is limited to 60 requests per minute. Paid tiers are now available with higher limits and additional features.",
  previous_state:
    "Free, Fast and Reliable IP Geolocation API for commercial and non-commercial users available in JSON",
  current_state:
    "FreeIPAPI is still FREE with no account required! We're introducing subscriptions for users who want to increase the request limit to more than 60 requests per minute. The free tier includes 60 Requests per minute.",
  impact: "medium",
  source_url: "https://freeipapi.com",
};

const A_LIMIT_CLAIMED_AGAINST_DIFFERENT_ATTRIBUTES = {
  vendor: "Harness CI",
  change_type: "limits_reduced",
  summary:
    "The free plan now has significantly reduced limits compared to the stored information. The stored info stated 2,000 build credits/month, while the current page details limits for concurrent pipeline executions (up to 60), storage (250GB), and organizations (up to 1).",
  previous_state:
    "CI/CD platform — free plan: 2,000 Harness Cloud build credits/month (Linux, macOS, Windows runners), YAML pipelines, secrets management, test intelligence. Requires business email for cloud runners; self-hosted runner alternative available",
  current_state:
    "Free Plan is available for individual developers and small teams. It includes up to 60 concurrent pipeline executions, 250GB storage, up to 1 organization, up to 500 maximum users, up to 5 custom dashboards, unlimited templates, up to 5 custom roles, and policy as code.",
  impact: "high",
};

const A_TRIAL_REPLACED_BY_A_CAPPED_FREE_PLAN = {
  vendor: "Weaviate",
  change_type: "limits_reduced",
  summary:
    "The free tier now has specific limits: 100,000 objects, 1 GB memory, 10 GB disk, 1 collection, up to 3 tenants, 2,000 embedding requests/day, and 1,000 Query Agent requests/month. The original description of a 14-day free sandbox is no longer present.",
  previous_state:
    "Open-source vector database — self-hosted: free forever with full features (hybrid search, multi-tenancy, compression). Cloud: 14-day free sandbox with full access. Paid cloud from $45/mo (Flex)",
  current_state:
    "Always free: $0 /mo. 1 cluster per user, upgrade to paid anytime. 100,000 objects, 1 GB memory, 10 GB disk, 1 collection, up to 3 tenants, 2,000 req/day Embeddings + Query Agent (1,000 req/mo).",
  impact: "medium",
};

const A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE = {
  vendor: "Weaviate",
  change_type: "limits_reduced",
  summary:
    "The free tier now has specific limits: 100,000 objects, 1 GB memory, 10 GB disk, 1 collection, up to 3 tenants, 2,000 embeddings requests/day, and 1,000 Query Agent requests/month. The previous stored information stated 'free forever with full features' for self-hosted and a 14-day free sandbox for cloud. The cloud free tier is now 'Always free' with the above limits.",
  previous_state:
    "Open-source vector database — self-hosted: free forever with full features (hybrid search, multi-tenancy, compression). Cloud: 14-day free sandbox with full access. Paid cloud from $45/mo (Flex)",
  current_state:
    "The free tier now has specific limits: 100,000 objects, 1 GB memory, 10 GB disk, 1 collection, up to 3 tenants, 2,000 embeddings requests/day, and 1,000 Query Agent requests/month.",
  impact: "medium",
};

const RECORDS_THAT_DESCRIBE_A_REAL_CHANGE = [
  AGREES_ON_ONE_FIGURE_AND_DIFFERS_ON_ANOTHER,
  A_LIMIT_ACTUALLY_MOVED,
  A_DAILY_CAP_WAS_HALVED,
  A_RETENTION_WINDOW_SHRANK,
  A_FREE_PLAN_BECAME_A_TRIAL,
  THE_CHANGE_WORD_SITS_FAR_FROM_BOTH_FIGURES,
  TWO_CAPS_TRADED_PLACES,
  A_TRIAL_REPLACED_BY_A_CAPPED_FREE_PLAN,
];

function tempLog(changes: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "change-gate-"));
  const file = path.join(dir, "deal_changes.json");
  writeFileSync(file, JSON.stringify({ changes }, null, 2) + "\n");
  return file;
}

describe("a recorded change must describe a change", () => {
  describe("both sides of the comparison hold the same value", () => {
    it("finds the equal pair the summary puts either side of a change word", () => {
      const found = nullComparisons(SAME_TERMS_EITHER_SIDE.summary);
      assert.strictEqual(found.length, 1);
      assert.strictEqual(found[0].value, 1);
      assert.strictEqual(found[0].connective, "instead of");
    });

    it("refuses the record whose free tier is unchanged on every figure", () => {
      const verdict = describesChange(SAME_TERMS_EITHER_SIDE);
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_NULL_COMPARISON);
    });

    it("keeps a record whose change word separates two different values", () => {
      assert.deepStrictEqual(nullComparisons(A_DAILY_CAP_WAS_HALVED.summary), []);
      assert.strictEqual(describesChange(A_DAILY_CAP_WAS_HALVED).ok, true);
    });

    it("reads no pair across a change word with nothing numeric beside it", () => {
      assert.deepStrictEqual(nullComparisons(A_FREE_PLAN_BECAME_A_TRIAL.summary), []);
    });

    it("pairs a change word only with the figures beside it", () => {
      assert.deepStrictEqual(nullComparisons(THE_CHANGE_WORD_SITS_FAR_FROM_BOTH_FIGURES.summary), []);
      assert.strictEqual(describesChange(THE_CHANGE_WORD_SITS_FAR_FROM_BOTH_FIGURES).ok, true);
    });

    it("refuses a cap restated with and without its thousands separator", () => {
      const verdict = describesChange(THE_SAME_CAP_WRITTEN_WITHOUT_ITS_SEPARATOR);
      assert.strictEqual(verdict.ok, false, "a cap of 1,000 and a cap of 1000 were read as different figures");
      assert.strictEqual(verdict.reason, REJECT_NULL_COMPARISON);
    });

    it("does not read the equal figure as a null comparison where a figure vanished", () => {
      const droppedAlongside = {
        ...SAME_TERMS_EITHER_SIDE,
        current_state: "Free: 1 A/B Test, 3 Feature Flags, 5 Environments",
      };
      assert.deepStrictEqual(nullComparisons(droppedAlongside.summary).length, 1);
      assert.notStrictEqual(describesChange(droppedAlongside).reason, REJECT_NULL_COMPARISON);
    });
  });

  describe("the summary says the page agrees with what we stored", () => {
    it("reads the agreement the summary states outright", () => {
      assert.strictEqual(assertsAgreement(SUMMARY_SAYS_IT_MATCHES.summary), true);
    });

    it("refuses a reduced-limits record in which no figure moved", () => {
      const verdict = describesChange(SUMMARY_SAYS_IT_MATCHES);
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_STATES_NO_DIFFERENCE);
    });

    it("keeps a record that agrees on one figure and differs on another", () => {
      assert.strictEqual(assertsAgreement(AGREES_ON_ONE_FIGURE_AND_DIFFERS_ON_ANOTHER.summary), true);
      assert.strictEqual(describesChange(AGREES_ON_ONE_FIGURE_AND_DIFFERS_ON_ANOTHER).ok, true);
    });

    it("keeps a reduced-limits record whose caps traded places rather than agreeing", () => {
      assert.deepStrictEqual(
        quantities(TWO_CAPS_TRADED_PLACES.previous_state).sort(),
        quantities(TWO_CAPS_TRADED_PLACES.current_state).sort()
      );
      assert.strictEqual(assertsAgreement(TWO_CAPS_TRADED_PLACES.summary), false);
      assert.strictEqual(describesChange(TWO_CAPS_TRADED_PLACES).ok, true);
    });

    it("refuses an agreeing record whose type is not a claim about figures", () => {
      const notAQuantityClaim = { ...SUMMARY_SAYS_IT_MATCHES, change_type: "rebranded" };
      const verdict = describesChange(notAQuantityClaim);
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_STATES_NO_DIFFERENCE);
    });

    it("reads the same figures on both sides of the record it refuses", () => {
      assert.deepStrictEqual(
        quantities(SUMMARY_SAYS_IT_MATCHES.previous_state).sort(),
        quantities(SUMMARY_SAYS_IT_MATCHES.current_state).sort()
      );
    });
  });

  describe("records that describe a real change survive the gate", () => {
    for (const record of RECORDS_THAT_DESCRIBE_A_REAL_CHANGE) {
      it(`keeps the ${record.vendor} record`, () => {
        const verdict = describesChange(record);
        assert.strictEqual(verdict.ok, true, `${record.vendor} was refused as ${verdict.reason}`);
      });
    }

    it("refuses exactly the two records that describe nothing", async () => {
      const all = [SAME_TERMS_EITHER_SIDE, SUMMARY_SAYS_IT_MATCHES, ...RECORDS_THAT_DESCRIBE_A_REAL_CHANGE];
      const { accepted, rejected } = await gateCandidates(all);
      assert.deepStrictEqual(rejected.map((r: any) => r.candidate.vendor), ["Abby", "Cloudflare DNS"]);
      assert.strictEqual(accepted.length, RECORDS_THAT_DESCRIBE_A_REAL_CHANGE.length);
    });
  });

  describe("the page it read states no terms at all", () => {
    it("finds no price signal on a landing page whose only pricing is a nav link", () => {
      assert.deepStrictEqual(priceSignals(THUNDER_CLIENT_LANDING_PAGE), []);
    });

    it("counts download and country totals as no kind of price", () => {
      assert.ok(THUNDER_CLIENT_LANDING_PAGE.includes("6M+ Downloads"));
      assert.ok(THUNDER_CLIENT_LANDING_PAGE.includes("100+ Countries"));
      assert.strictEqual(priceSignals(THUNDER_CLIENT_LANDING_PAGE).length, 0);
    });

    it("does not read a hyphenated word ending in free as a tier", () => {
      assert.ok(DOCZILLA_LANDING_PAGE.includes("hassle-free"));
      assert.deepStrictEqual(priceSignals(DOCZILLA_LANDING_PAGE), []);
    });

    it("finds every amount and rate a root that does publish its pricing states", () => {
      const signals = priceSignals(FREEIPAPI_LANDING_PAGE);
      assert.ok(signals.length >= MIN_PRICE_SIGNALS);
      assert.ok(signals.includes("€0"));
      assert.ok(signals.includes("€9.90"));
      assert.ok(signals.includes("€99.00"));
      assert.ok(signals.some((s: string) => /60 [Rr]equests per minute/.test(s)));
    });

    it("reads an allowance written as an adjective rather than with per", () => {
      const noTierWordAndNoAmount = "The cap is 500 daily requests.";
      assert.deepStrictEqual(priceSignals(noTierWordAndNoAmount), ["500 daily r"]);
    });

    it("reads the cap a page states without an amount or the word per", () => {
      const asDbIpWritesIt = "The Free API is a fast and easy way to implement IP geolocation in a prototype or small website. It provides a simple IP to country, state and city mapping and is limited to 500 daily requests.";
      assert.ok(priceSignals(asDbIpWritesIt).some((s: string) => s.startsWith("500 daily")));
    });

    it("refuses the record read from a page with no pricing on it", () => {
      const verdict = describesChange(READ_FROM_A_PAGE_WITH_NO_PRICING, {
        pageText: THUNDER_CLIENT_LANDING_PAGE,
      });
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_NO_PRICE_SIGNAL);
    });

    it("refuses the record read from a landing page that only links to its pricing", () => {
      const verdict = describesChange(READ_FROM_A_LANDING_PAGE_THAT_ONLY_LINKS_TO_PRICING, {
        pageText: DOCZILLA_LANDING_PAGE,
      });
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_NO_PRICE_SIGNAL);
    });

    it("keeps the record read from a root that does publish its pricing", () => {
      const verdict = describesChange(READ_FROM_A_ROOT_THAT_PUBLISHES_ITS_PRICING, {
        pageText: FREEIPAPI_LANDING_PAGE,
      });
      assert.strictEqual(verdict.ok, true, `refused as ${verdict.reason}`);
    });

    it("cannot refuse a record for a page nobody supplied", () => {
      const verdict = describesChange(READ_FROM_A_PAGE_WITH_NO_PRICING);
      assert.strictEqual(verdict.ok, true);
    });
  });

  describe("a limit is claimed to have moved without being cited on both sides", () => {
    it("refuses a reduction whose current state quantifies only other attributes", () => {
      const verdict = describesChange(A_LIMIT_CLAIMED_AGAINST_DIFFERENT_ATTRIBUTES);
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_UNQUANTIFIED_LIMIT);
    });

    it("refuses an increase whose current state quantifies nothing at all", () => {
      const verdict = describesChange(READ_FROM_A_LANDING_PAGE_THAT_ONLY_LINKS_TO_PRICING);
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_UNQUANTIFIED_LIMIT);
    });

    it("keeps a restructure that states a price on both sides", () => {
      const verdict = describesChange(A_TRIAL_REPLACED_BY_A_CAPPED_FREE_PLAN);
      assert.strictEqual(verdict.ok, true, `refused as ${verdict.reason}`);
    });

    it("treats an amount as an attribute of its own so a restructure is not read as a silent side", () => {
      const previous = quantifiedAttributes("Paid cloud from $45/mo (Flex)");
      const current = quantifiedAttributes("Always free: $0 /mo.");
      assert.ok(previous.some((a: any) => a.words.includes("currency")));
      assert.ok(current.some((a: any) => a.words.includes("currency")));
    });

    it("keeps a reduction whose stored state quantified nothing to cite", () => {
      const verdict = describesChange(READ_FROM_A_ROOT_THAT_PUBLISHES_ITS_PRICING);
      assert.strictEqual(verdict.ok, true, `refused as ${verdict.reason}`);
      assert.deepStrictEqual(quantifiedAttributes(READ_FROM_A_ROOT_THAT_PUBLISHES_ITS_PRICING.previous_state), []);
    });

    it("keeps a reduction that cites the same attribute in a different unit", () => {
      const verdict = describesChange(A_RETENTION_WINDOW_SHRANK);
      assert.strictEqual(verdict.ok, true, `refused as ${verdict.reason}`);
    });

    it("leaves a change type that claims no quantity alone", () => {
      const verdict = describesChange({
        ...A_LIMIT_CLAIMED_AGAINST_DIFFERENT_ATTRIBUTES,
        change_type: "pricing_restructured",
      });
      assert.strictEqual(verdict.ok, true, `refused as ${verdict.reason}`);
    });

    it("refuses the trial-replaced record when nothing but the two states is supplied", () => {
      const verdict = describesChange(A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE);
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_UNQUANTIFIED_LIMIT);
    });
  });

  describe("the whole page was read and the stored dimension is not on it", () => {
    const WHOLE_PAGE = { pageText: WEAVIATE_PRICING_PAGE, pageComplete: true };

    it("finds the word the stored figure measured missing from the page", () => {
      const absent = storedDimensionsAbsentFromPage(
        A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE,
        WEAVIATE_PRICING_PAGE
      );
      assert.deepStrictEqual(
        absent.map((a: any) => a.measured),
        ["sandbox"]
      );
    });

    it("does not call an amount missing from a page that states amounts", () => {
      const absent = storedDimensionsAbsentFromPage(
        A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE,
        WEAVIATE_PRICING_PAGE
      );
      assert.ok(!absent.some((a: any) => a.measured === "currency"));
    });

    it("records the trial-replaced record as a restructure rather than dropping it", () => {
      const verdict = describesChange(A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE, WHOLE_PAGE);
      assert.strictEqual(verdict.ok, true, `refused as ${verdict.reason}`);
      assert.strictEqual(verdict.reclassifyAs, RECLASSIFIED_AS_RESTRUCTURE);
    });

    it("keeps refusing when only part of the page was read", () => {
      const verdict = describesChange(A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE, {
        pageText: WEAVIATE_PRICING_PAGE,
        pageComplete: false,
      });
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_UNQUANTIFIED_LIMIT);
    });

    it("keeps refusing when the stored dimension is still on the page", () => {
      const stillThere = {
        ...A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE,
        previous_state: "Cloud: 3 tenants per cluster. Paid cloud from $45/mo (Flex)",
        current_state: "The free tier is described without naming how many of them are included.",
      };
      const verdict = describesChange(stillThere, WHOLE_PAGE);
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_UNQUANTIFIED_LIMIT);
    });

    it("carries the reclassification through the gate onto the accepted record", async () => {
      const { accepted, rejected, reclassified } = await gateCandidates(
        [A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE],
        {
          pageTextFor: () => WEAVIATE_PRICING_PAGE,
          pageCompleteFor: () => true,
        }
      );
      assert.strictEqual(rejected.length, 0);
      assert.strictEqual(accepted[0].change_type, "pricing_restructured");
      assert.strictEqual(reclassified[0].from, "limits_reduced");
      assert.strictEqual(reclassified[0].to, "pricing_restructured");
    });

    it("reclassifies to a type that is not the one the record already had", () => {
      assert.notStrictEqual(RECLASSIFIED_AS_RESTRUCTURE, "limits_reduced");
      assert.notStrictEqual(RECLASSIFIED_AS_RESTRUCTURE, "limits_increased");
      assert.ok(CHANGE_TYPES.includes(RECLASSIFIED_AS_RESTRUCTURE));
    });

    it("leaves the record it was built from unaltered", async () => {
      const original = { ...A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE };
      await gateCandidates([original], {
        pageTextFor: () => WEAVIATE_PRICING_PAGE,
        pageCompleteFor: () => true,
      });
      assert.strictEqual(original.change_type, "limits_reduced");
    });
  });

  describe("the reader of the page says whether it read all of it", () => {
    const html = (chars: number) => `<html><body><p>${"pricing detail ".repeat(chars)}</p></body></html>`;

    async function readWith(body: string) {
      const original = globalThis.fetch;
      globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
      try {
        return await fetchPageText("https://example.test/pricing");
      } finally {
        globalThis.fetch = original;
      }
    }

    it("says a short page was read whole", async () => {
      const repeats = Math.ceil(MIN_PAGE_TEXT_LENGTH / "pricing detail ".length);
      const page = await readWith(html(repeats));
      assert.strictEqual(page.ok, true);
      assert.strictEqual(page.truncated, false);
      assert.ok(page.text.length < MAX_PAGE_TEXT_LENGTH);
    });

    it("says a page longer than the verifier's prompt limit was also read whole", async () => {
      const page = await readWith(html(2000));
      assert.strictEqual(page.ok, true);
      assert.strictEqual(page.truncated, false);
      assert.ok(page.text.length > MAX_PAGE_TEXT_LENGTH);
    });
  });

  describe("a figure measured in binary units against one measured in decimal", () => {
    const sized = (value: string, unit: string) => ({
      value,
      words: ["x"],
      unit,
      scale: BYTE_UNITS.get(unit),
      period: null,
    });

    it("reads the unit written against the figure", () => {
      const [egress] = quantifiedAttributes("20GiB egress").filter((a: any) => a.unit);
      assert.strictEqual(egress.unit, "gib");
      assert.strictEqual(measuredValue(egress), 20 * 1024 ** 3);
    });

    it("scales each binary unit above its decimal namesake", () => {
      for (const [binary, decimal] of [["kib", "kb"], ["mib", "mb"], ["gib", "gb"], ["tib", "tb"]]) {
        const one = measuredValue(sized("1", binary));
        const other = measuredValue(sized("1", decimal));
        assert.ok(one > other, `${binary} did not exceed ${decimal}`);
      }
    });

    it("reads 20 GiB as smaller than 100 GB and 200 GiB as larger", () => {
      assert.strictEqual(comparedQuantity(sized("20", "gib"), sized("100", "gb")).direction, "increase");
      assert.strictEqual(comparedQuantity(sized("200", "gib"), sized("100", "gb")).direction, "decrease");
    });

    it("reads 1 TiB as larger than 1,000 GB and 1 TB as exactly that", () => {
      assert.strictEqual(comparedQuantity(sized("1", "tib"), sized("1,000", "gb")).direction, "decrease");
      assert.strictEqual(comparedQuantity(sized("1", "tb"), sized("1,000", "gb")).direction, "equal");
    });

    it("reads a figure written without a size unit at its face value", () => {
      const [requests] = quantifiedAttributes("500 requests");
      assert.strictEqual(requests.unit, null);
      assert.strictEqual(measuredValue(requests), 500);
    });

    it("measures the egress the two states state in different units", () => {
      const difference = measuredDifferences(A_LIMIT_ACTUALLY_MOVED).find(
        (d: any) => d.attribute === "egres"
      );
      assert.strictEqual(difference.direction, "decrease");
      assert.strictEqual(difference.from, 100e9);
      assert.strictEqual(difference.to, 20 * 1024 ** 3);
    });

    it("does not read the unit itself as the thing being measured", () => {
      assert.ok(!measuredDifferences(A_LIMIT_ACTUALLY_MOVED).some((d: any) => BYTE_UNITS.has(d.attribute)));
    });

    it("measures no difference between two states that state the same size", () => {
      assert.deepStrictEqual(
        measuredDifferences({
          previous_state: "1 GiB KV storage",
          current_state: "1 GiB KV storage, plus new read units",
        }),
        []
      );
    });

    it("reads a retention window shrinking although neither state carries a size unit", () => {
      const window = measuredDifferences(A_RETENTION_WINDOW_SHRANK).find(
        (d: any) => d.previous === "7 retention"
      );
      assert.strictEqual(window.direction, "decrease");
      assert.strictEqual(window.from, 7 * 86400);
      assert.strictEqual(window.to, 86400);
    });

    it("measures nothing between two states that share no quantified term", () => {
      assert.deepStrictEqual(measuredDifferences(A_SUPPORT_CHANNEL_CLOSED), []);
    });

    it("keeps a record whose figures the second opinion read backwards", async () => {
      const { accepted, rejected, overruled } = await gateCandidates([A_LIMIT_ACTUALLY_MOVED], {
        confirmFn: async () => ({
          verdict: "no",
          reason: "Egress increased from 100GB to 20GiB. It is actually an increase, not a decrease.",
        }),
      });
      assert.strictEqual(rejected.length, 0);
      assert.strictEqual(accepted.length, 1);
      assert.strictEqual(overruled[0].difference.attribute, "egres");
      assert.match(overruled[0].opinion, /increase/);
    });

    it("still refuses a record the second opinion calls unchanged and no figure contradicts", async () => {
      const { accepted, rejected, overruled } = await gateCandidates([A_SUPPORT_CHANNEL_CLOSED], {
        confirmFn: async () => ({ verdict: "no", reason: "the page restates the stored terms" }),
      });
      assert.strictEqual(accepted.length, 0);
      assert.strictEqual(overruled.length, 0);
      assert.strictEqual(rejected[0].reason, REJECT_CONFIRMED_UNCHANGED);
    });
  });

  describe("#1136 the direction comes from the quantities, not from the prose", () => {
    const DOCKER_HUB_REBASED_THE_PERIOD = {
      vendor: "Docker Hub",
      change_type: "limits_reduced",
      summary:
        "The Docker Hub Personal tier now includes 100 Docker Hub pulls/hr instead of 200 pulls per 6-hour window. It also includes 1 Docker Scout-enabled repo.",
      previous_state:
        "1 private repository, unlimited public repositories. 200 pulls per 6-hour window (authenticated). No automated builds on free tier",
      current_state:
        "Docker Personal $0 $0 ... Includes: 100 Docker Hub pulls/hr* 1 private Docker Hub repo 1 Docker Scout-enabled repo*",
      impact: "medium",
    };

    const A_CAP_APPEARED_BESIDE_A_RISE = {
      vendor: "Zoho Meeting",
      change_type: "limits_reduced",
      summary:
        "The free tier now has a 60-minute meeting limit and supports up to 100 participants. Previously unlimited meeting duration with up to 3 meeting participants & 10 Webinar attendees.",
      previous_state: "Meetings with upto 3 meeting participants & 10 Webinar attendees.",
      current_state: "Free plan offers up to 60 minutes of meetings and 100 meeting participants.",
      impact: "high",
    };

    const A_REAL_TENFOLD_CUT = {
      vendor: "Alibaba Cloud Qwen Code",
      change_type: "limits_reduced",
      summary: "The free tier now offers 100 requests/day, down from 1,000 requests/day.",
      previous_state: "Free tier: 1,000 requests/day with the Qwen Code CLI, no token cap",
      current_state: "The free tier offers 100 requests/day with the Qwen Code CLI.",
      impact: "high",
    };

    it("reads 200 per 6 hours against 100 per hour as a rise", () => {
      const [pulls] = measuredDifferences(DOCKER_HUB_REBASED_THE_PERIOD);
      assert.strictEqual(pulls.attribute, "pull");
      assert.strictEqual(pulls.direction, "increase");
    });

    it("refuses a reduction whose only compared quantity rose", () => {
      const verdict = describesChange(DOCKER_HUB_REBASED_THE_PERIOD);
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_MEASURES_THE_OPPOSITE);
      assert.match(verdict.detail, /200 pull per 6 hours/);
    });

    it("takes the direction from the matched quantity, not from a cap the page added", () => {
      assert.strictEqual(
        measuredAgainstItsClaim(A_CAP_APPEARED_BESIDE_A_RISE).reason,
        REJECT_MEASURES_THE_OPPOSITE
      );
    });

    it("keeps a reduction whose matched quantity really fell", () => {
      assert.strictEqual(measuredAgainstItsClaim(A_REAL_TENFOLD_CUT), null);
      assert.strictEqual(describesChange(A_REAL_TENFOLD_CUT).ok, true);
    });

    it("keeps a record whose contradicting figures the summary never puts to the reader", () => {
      const buriedInTheStates = {
        ...A_CAP_APPEARED_BESIDE_A_RISE,
        summary: "The free tier now has a 60-minute meeting limit.",
      };
      assert.strictEqual(measuredAgainstItsClaim(buriedInTheStates), null);
    });

    it("keeps a record where one figure contradicts the claim and another supports it", () => {
      const mixed = {
        ...A_REAL_TENFOLD_CUT,
        summary: "The free tier now offers 100 requests/day, down from 1,000 requests/day, and 5 seats, up from 2 seats.",
        previous_state: "Free tier: 1,000 requests/day with the Qwen Code CLI, 2 seats",
        current_state: "The free tier offers 100 requests/day with the Qwen Code CLI, 5 seats",
      };
      const [requests, seats] = measuredDifferences(mixed);
      assert.strictEqual(requests.direction, "decrease");
      assert.strictEqual(seats.direction, "increase");
      assert.strictEqual(measuredAgainstItsClaim(mixed), null);
    });

    it("reads what a figure measures from past the period written against it", () => {
      const [minutes] = quantifiedAttributes("10 per 6 hours of build time");
      assert.deepStrictEqual(minutes.words, ["build", "time"]);
      assert.strictEqual(minutes.period.unit, "hour");
    });

    it("does not read a period's own count as a quantity of its own", () => {
      const [pulls, ...rest] = quantifiedAttributes("200 pulls per 6-hour window");
      assert.strictEqual(rest.length, 0);
      assert.strictEqual(pulls.value, "200");
      assert.strictEqual(pulls.period.count, "6");
    });

    it("does not compare a price with a count of the same value", () => {
      const [price] = quantifiedAttributes("$9 per project");
      const [projects] = quantifiedAttributes("9 projects");
      assert.strictEqual(comparedQuantity(price, projects), null);
    });

    it("does not let a paid plan's price decide the direction", () => {
      const pricedAlongside = {
        vendor: "deployhq.com",
        change_type: "limits_reduced",
        summary: "The free tier still offers 3 projects. Unlimited deployments now start at $9/month.",
        previous_state: "Free plan: 3 projects with unlimited deployments. Paid plans from $5/month",
        current_state: "Start free with 3 projects. Unlimited deployments from $9/month.",
        impact: "high",
      };
      assert.strictEqual(
        measuredAgainstItsClaim(pricedAlongside).reason,
        REJECT_MEASURES_NO_CHANGE
      );
    });
  });

  describe("#1136 a directional record whose figures did not move", () => {
    const NOTATION_ONLY = {
      vendor: "Bugsnag",
      change_type: "limits_reduced",
      summary:
        "The free tier now includes 7.5K events and 1M spans per month, and 1 user. Previously 7,500 events/month and 1M spans/month, 1 user.",
      previous_state: "Error monitoring — 7,500 events/month and 1M spans/month on free plan, 1 user",
      current_state: "Includes: 1 user 7.5K events and 1M spans per month 50+ platforms",
      impact: "medium",
    };

    const A_RATE_RESTATED_IN_ANOTHER_PERIOD = {
      vendor: "Imitate Email",
      change_type: "limits_increased",
      summary: "The free tier now offers 450 test emails a month, instead of 15 emails a day.",
      previous_state: "Sandbox email server. Free accounts get 15 emails a day forever.",
      current_state: "Get started with 450 test emails a month, free forever",
      impact: "medium",
    };

    it("reads 7.5K as the same figure as 7,500", () => {
      assert.strictEqual(measuredAgainstItsClaim(NOTATION_ONLY).reason, REJECT_MEASURES_NO_CHANGE);
    });

    it("reads 450 a month as the same rate as 15 a day", () => {
      assert.strictEqual(
        measuredAgainstItsClaim(A_RATE_RESTATED_IN_ANOTHER_PERIOD).reason,
        REJECT_MEASURES_NO_CHANGE
      );
    });

    it("keeps a record whose summary states a figure that is in neither comparison", () => {
      const alsoNamesANewCap = {
        ...NOTATION_ONLY,
        summary: `${NOTATION_ONLY.summary} The Agent now has a 10 message limit per week.`,
      };
      assert.strictEqual(measuredAgainstItsClaim(alsoNamesANewCap), null);
    });

    it("keeps a record whose equal figures sit beside one that moved", () => {
      const oneOfThemMoved = {
        ...NOTATION_ONLY,
        current_state: "Includes: 1 user 7.5K events and 500K spans per month 50+ platforms",
      };
      assert.strictEqual(measuredAgainstItsClaim(oneOfThemMoved), null);
    });

    it("refuses a record whose only comparison the summary itself states, at the same value", () => {
      const twoAgainstTwo = {
        vendor: "OnlineOrNot",
        change_type: "limits_reduced",
        summary: "The free tier now only includes up to 2 users instead of 2 team members.",
        previous_state:
          "Uptime monitoring — free plan: 3 monitors, 3-minute check interval, 2 team members, 1 status page, SSL monitoring",
        current_state:
          "Hobby (Free) includes up to 2 users, a 3-minute check interval, a limited status page, and basic alerting.",
        impact: "medium",
      };
      assert.strictEqual(
        measuredAgainstItsClaim(twoAgainstTwo).reason,
        REJECT_MEASURES_NO_CHANGE,
        "the summary states 2 against 2 and no compared quantity moved"
      );
    });

    it("does not read a figure's subject past the clause it sits in", () => {
      const acrossAComma = quantifiedAttributes(
        "Hobby (Free) includes up to 2 users, a 3-minute check interval, a limited status page"
      );
      const interval = acrossAComma.find((a: any) => a.value === "3");
      assert.ok(!interval.words.includes("statu"), interval.words.join("/"));
    });

    it("does not read what a figure is measured per as the thing it measures", () => {
      const [subscribers] = quantifiedAttributes("Max 10,000 subscribers per send");
      const [sends] = quantifiedAttributes("10,000 sends a month");
      assert.deepStrictEqual(subscribers.words, ["subscriber"]);
      assert.strictEqual(comparedQuantity(subscribers, sends), null);
    });

    it("keeps a record whose stated figures name nothing our comparison can reach", () => {
      const ratesWithNoSubject = {
        vendor: "codehooks.io",
        change_type: "limits_reduced",
        summary: "The free tier now has significantly reduced API call limits (1/sec, 500/day). Previously 60/minute.",
        previous_state: "Serverless backend — free plan: 1 developer, 150 MB database storage",
        current_state: "The free plan includes 1 Developer, 150 MB Database Storage",
        impact: "high",
      };
      assert.strictEqual(measuredAgainstItsClaim(ratesWithNoSubject), null);
    });

    it("judges the figures the rewritten summary states, not the ones the gate dropped", () => {
      const baselineInADroppedClause = {
        ...NOTATION_ONLY,
        summary:
          "The free tier now includes 7.5K events and 1M spans per month, and 1 user. The stored information does not mention the 90-day retention the page states.",
      };
      assert.strictEqual(
        measuredAgainstItsClaim(baselineInADroppedClause),
        null,
        "the raw summary states 90, which is in no comparison"
      );
      assert.strictEqual(describesChange(baselineInADroppedClause).reason, REJECT_MEASURES_NO_CHANGE);
    });
  });

  describe("the page it read is about a different company", () => {
    it("refuses a record read from a marketplace page that never names the vendor", () => {
      const verdict = describesChange(READ_FROM_A_PAGE_ABOUT_OTHER_COMPANIES, {
        pageText: JOINSECRET_OFFERS_PAGE,
      });
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_PAGE_NOT_ABOUT_VENDOR);
    });

    it("refuses it although that page carries more price signals than one it accepts", () => {
      assert.ok(
        priceSignals(JOINSECRET_OFFERS_PAGE).length > priceSignals(FREEIPAPI_LANDING_PAGE).length
      );
      assert.strictEqual(
        describesChange(READ_FROM_A_PAGE_ABOUT_OTHER_COMPANIES, { pageText: JOINSECRET_OFFERS_PAGE }).reason,
        REJECT_PAGE_NOT_ABOUT_VENDOR
      );
    });

    it("keeps a record read from a thin page that is the vendor's own", () => {
      const verdict = describesChange(A_LIMIT_ACTUALLY_MOVED, {
        pageText: "Deno Deploy free plan: 20GiB egress, 10 hours CPU time per month.",
      });
      assert.strictEqual(verdict.ok, true);
    });
  });

  describe("the run reports each refusal under its own heading", () => {
    it("counts the two new refusals separately", async () => {
      const { rejected } = await gateCandidates(
        [READ_FROM_A_PAGE_WITH_NO_PRICING, A_LIMIT_CLAIMED_AGAINST_DIFFERENT_ATTRIBUTES, A_LIMIT_ACTUALLY_MOVED],
        { pageTextFor: (c: any) => (c.vendor === "Thunder Client" ? THUNDER_CLIENT_LANDING_PAGE : undefined) }
      );
      const counts = rejectionCounts(rejected);
      assert.strictEqual(counts.get(REJECT_NO_PRICE_SIGNAL), 1);
      assert.strictEqual(counts.get(REJECT_UNQUANTIFIED_LIMIT), 1);
      assert.strictEqual(counts.get(REJECT_NULL_COMPARISON), 0);
    });

    it("counts a page about other companies under its own heading", async () => {
      const { rejected } = await gateCandidates(
        [READ_FROM_A_PAGE_ABOUT_OTHER_COMPANIES, READ_FROM_A_PAGE_WITH_NO_PRICING],
        {
          pageTextFor: (c: any) =>
            c.vendor === "Cloudways" ? JOINSECRET_OFFERS_PAGE : THUNDER_CLIENT_LANDING_PAGE,
        }
      );
      const counts = rejectionCounts(rejected);
      assert.strictEqual(counts.get(REJECT_PAGE_NOT_ABOUT_VENDOR), 1);
      assert.strictEqual(counts.get(REJECT_NO_PRICE_SIGNAL), 1);

      const text = summaryLines(
        { verified: 0, flagged: 0, changed: 2, recorded: [], suppressed: [], unclassified: [], unchecked: [], rejected },
        { useAi: true, checked: 2, oldestRemaining: "2026-07-05", total: 1580 }
      ).join("\n");
      assert.match(text, /Rejected \(page does not name the vendor\): 1/);
    });

    it("puts both counts in the run summary under the total they belong to", () => {
      const lines = summaryLines(
        {
          verified: 0,
          flagged: 0,
          changed: 3,
          recorded: [],
          suppressed: [],
          unclassified: [],
          unchecked: [],
          rejected: [
            { candidate: READ_FROM_A_PAGE_WITH_NO_PRICING, reason: REJECT_NO_PRICE_SIGNAL, detail: "" },
            { candidate: READ_FROM_A_LANDING_PAGE_THAT_ONLY_LINKS_TO_PRICING, reason: REJECT_NO_PRICE_SIGNAL, detail: "" },
            { candidate: A_LIMIT_CLAIMED_AGAINST_DIFFERENT_ATTRIBUTES, reason: REJECT_UNQUANTIFIED_LIMIT, detail: "" },
          ],
        },
        { useAi: true, checked: 3, oldestRemaining: "2026-07-05", total: 1580 }
      );
      const text = lines.join("\n");
      assert.match(text, /Rejected \(no change described\): 3/);
      assert.match(text, /page carried no pricing: 2/);
      assert.match(text, /quantified on one side only: 1/);
    });
  });
});

describe("the second opinion on whether a report describes a change", () => {
  it("asks about the report rather than about the vendor", () => {
    const prompt = changeConfirmationPrompt(SUMMARY_SAYS_IT_MATCHES);
    assert.ok(prompt.includes(SUMMARY_SAYS_IT_MATCHES.previous_state));
    assert.ok(prompt.includes(SUMMARY_SAYS_IT_MATCHES.current_state));
    assert.ok(prompt.includes(SUMMARY_SAYS_IT_MATCHES.summary));
  });

  it("reads a bare verdict", () => {
    assert.deepStrictEqual(parseConfirmation('{"change":"yes"}'), { verdict: "yes", reason: null });
  });

  it("reads a verdict wrapped in a code fence around an object the loose match cannot read", () => {
    const fenced = '```json\n{"change":"no","meta":{"k":1},"reason":"same terms"}\n```';
    assert.deepStrictEqual(parseConfirmation(fenced), { verdict: "no", reason: "same terms" });
  });

  it("reads a verdict a sentence has been wrapped around", () => {
    assert.deepStrictEqual(parseConfirmation('Here you go: {"change":"no"} — hope that helps'), {
      verdict: "no",
      reason: null,
    });
  });

  it("returns no verdict rather than a guess when the answer is prose", () => {
    assert.strictEqual(parseConfirmation("I think the terms are basically the same").verdict, "unparsed");
  });

  it("returns no verdict for a shape that answers a different question", () => {
    assert.strictEqual(parseConfirmation('{"status":"confirmed"}').verdict, "unparsed");
  });

  it("refuses a record the second opinion calls unchanged", async () => {
    const { accepted, rejected } = await gateCandidates([A_SUPPORT_CHANNEL_CLOSED], {
      confirmFn: async () => ({ verdict: "no", reason: "the page restates the stored terms" }),
    });
    assert.strictEqual(accepted.length, 0);
    assert.strictEqual(rejected[0].reason, REJECT_CONFIRMED_UNCHANGED);
    assert.strictEqual(rejected[0].detail, "the page restates the stored terms");
  });

  it("keeps a record the second opinion calls changed", async () => {
    const { accepted, rejected, unchecked } = await gateCandidates([A_LIMIT_ACTUALLY_MOVED], {
      confirmFn: async () => ({ verdict: "yes", reason: null }),
    });
    assert.strictEqual(accepted.length, 1);
    assert.strictEqual(rejected.length, 0);
    assert.strictEqual(unchecked.length, 0);
  });

  it("holds a record the second opinion could not be asked about, and says so", async () => {
    const { accepted, unchecked } = await gateCandidates([A_LIMIT_ACTUALLY_MOVED], {
      confirmFn: async () => {
        throw new Error("HTTP 503");
      },
    });
    assert.strictEqual(accepted.length, 1);
    assert.strictEqual(unchecked.length, 1);
    assert.strictEqual(unchecked[0].error, "HTTP 503");
  });

  it("holds a record whose second opinion came back unreadable, and says so", async () => {
    const { accepted, unchecked } = await gateCandidates([A_LIMIT_ACTUALLY_MOVED], {
      confirmFn: async () => ({ verdict: "unparsed", reason: null }),
    });
    assert.strictEqual(accepted.length, 1);
    assert.strictEqual(unchecked.length, 1);
  });

  it("spends no second opinion on a record the first layer already refused", async () => {
    let asked = 0;
    await gateCandidates([SAME_TERMS_EITHER_SIDE], {
      confirmFn: async () => {
        asked++;
        return { verdict: "yes", reason: null };
      },
    });
    assert.strictEqual(asked, 0);
  });
});

describe("the run does not write a change the gate refused", () => {
  const offer = {
    vendor: "Abby",
    category: "Feature Flags",
    tier: "Free",
    description: SAME_TERMS_EITHER_SIDE.previous_state,
    url: "https://abby.example/pricing",
    verifiedDate: "2026-01-01",
  };
  const picked = [{ index: 0, offer }];
  const fetchFn = async () => ({ ok: true, text: SAME_TERMS_EITHER_SIDE.current_state });
  const detection = {
    status: "changed",
    summary: SAME_TERMS_EITHER_SIDE.summary,
    change_type: SAME_TERMS_EITHER_SIDE.change_type,
    current_state: SAME_TERMS_EITHER_SIDE.current_state,
    impact: "medium",
  };

  it("leaves the change log empty", async () => {
    const file = tempLog([]);
    const data = { offers: [{ ...offer }] };
    const result = await runAiMode(picked, data, false, NOW, {
      fetchFn,
      verifyFn: async () => detection,
      rateLimitMs: 0,
      changesPath: file,
    });
    assert.strictEqual(result.changed, 1);
    assert.strictEqual(result.recorded.length, 0);
    assert.strictEqual(result.rejected.length, 1);
    assert.strictEqual(result.rejected[0].reason, REJECT_NULL_COMPARISON);
    const written = JSON.parse(readFileSync(file, "utf-8"));
    assert.strictEqual(written.changes.length, 0);
    rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("writes the refusal where the next run and the next reader can find it", async () => {
    const changes = tempLog([]);
    const refusals = path.join(path.dirname(changes), "change_refusals.json");
    const data = { offers: [{ ...offer }] };
    await runAiMode(picked, data, false, NOW, {
      fetchFn,
      verifyFn: async () => detection,
      rateLimitMs: 0,
      changesPath: changes,
      refusalsPath: refusals,
    });
    const [stored] = JSON.parse(readFileSync(refusals, "utf-8")).refusals;
    assert.strictEqual(stored.vendor, "Abby");
    assert.strictEqual(stored.reason, REJECT_NULL_COMPARISON);
    assert.strictEqual(stored.source_url, "https://abby.example/pricing");
    assert.strictEqual(stored.previous_state, SAME_TERMS_EITHER_SIDE.previous_state);
    assert.strictEqual(stored.refused_date, "2026-08-28");
    rmSync(path.dirname(changes), { recursive: true, force: true });
  });

  it("writes no refusal on a dry run", async () => {
    const changes = tempLog([]);
    const refusals = path.join(path.dirname(changes), "change_refusals.json");
    const data = { offers: [{ ...offer }] };
    await runAiMode(picked, data, true, NOW, {
      fetchFn,
      verifyFn: async () => detection,
      rateLimitMs: 0,
      changesPath: changes,
      refusalsPath: refusals,
    });
    assert.strictEqual(existsSync(refusals), false);
    rmSync(path.dirname(changes), { recursive: true, force: true });
  });

  it("names the refused vendor in the run summary", async () => {
    const changes = tempLog([]);
    const refusals = path.join(path.dirname(changes), "change_refusals.json");
    const data = { offers: [{ ...offer }] };
    const result = await runAiMode(picked, data, false, NOW, {
      fetchFn,
      verifyFn: async () => detection,
      rateLimitMs: 0,
      changesPath: changes,
      refusalsPath: refusals,
    });
    const text = summaryLines(result, {
      useAi: true,
      checked: 1,
      oldestRemaining: "2026-07-05",
      total: 1580,
    }).join("\n");
    assert.match(text, new RegExp(`refused as ${REJECT_NULL_COMPARISON}: Abby`));
    rmSync(path.dirname(changes), { recursive: true, force: true });
  });

  describe("the run tells the gate how much of the page it read", () => {
    const weaviate = {
      vendor: "Weaviate",
      category: "Databases",
      tier: "Free",
      description: A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE.previous_state,
      url: "https://weaviate.io/pricing",
      verifiedDate: "2026-07-05",
    };
    const detection = {
      status: "changed",
      summary: A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE.summary,
      change_type: A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE.change_type,
      current_state: A_TRIAL_REPLACED_BY_A_FREE_PLAN_STATING_NO_PRICE.current_state,
      impact: "medium",
    };

    async function runReading(truncated: boolean) {
      const changes = tempLog([]);
      const refusals = path.join(path.dirname(changes), "change_refusals.json");
      const result = await runAiMode([{ index: 0, offer: weaviate }], { offers: [{ ...weaviate }] }, false, NOW, {
        fetchFn: async () => ({ ok: true, text: WEAVIATE_PRICING_PAGE, truncated }),
        verifyFn: async () => detection,
        rateLimitMs: 0,
        changesPath: changes,
        refusalsPath: refusals,
      });
      rmSync(path.dirname(changes), { recursive: true, force: true });
      return result;
    }

    it("records the restructure when it read the page in full", async () => {
      const result = await runReading(false);
      assert.strictEqual(result.rejected.length, 0, JSON.stringify(result.rejected));
      assert.strictEqual(result.recorded.length, 1);
      assert.strictEqual(result.recorded[0].change_type, "pricing_restructured");
    });

    it("refuses the same reading when the page was cut at the fetch limit", async () => {
      const result = await runReading(true);
      assert.strictEqual(result.recorded.length, 0);
      assert.strictEqual(result.rejected[0].reason, REJECT_UNQUANTIFIED_LIMIT);
    });
  });

  it("still writes a change that describes one", async () => {
    const movedOffer = {
      ...offer,
      vendor: "Deno Deploy",
      url: "https://deno.com/deploy/pricing",
      description: A_LIMIT_ACTUALLY_MOVED.previous_state,
    };
    const file = tempLog([]);
    const data = { offers: [{ ...movedOffer }] };
    const result = await runAiMode([{ index: 0, offer: movedOffer }], data, false, NOW, {
      fetchFn: async () => ({ ok: true, text: A_LIMIT_ACTUALLY_MOVED.current_state }),
      verifyFn: async () => ({
        status: "changed",
        summary: A_LIMIT_ACTUALLY_MOVED.summary,
        change_type: A_LIMIT_ACTUALLY_MOVED.change_type,
        current_state: A_LIMIT_ACTUALLY_MOVED.current_state,
        impact: "high",
      }),
      rateLimitMs: 0,
      changesPath: file,
    });
    assert.strictEqual(result.recorded.length, 1);
    assert.strictEqual(result.rejected.length, 0);
    rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("refuses the record when the page it actually read states no terms", async () => {
    const silentOffer = {
      ...offer,
      vendor: "Thunder Client",
      description: READ_FROM_A_PAGE_WITH_NO_PRICING.previous_state,
      url: READ_FROM_A_PAGE_WITH_NO_PRICING.source_url,
    };
    const file = tempLog([]);
    const data = { offers: [{ ...silentOffer }] };
    const result = await runAiMode([{ index: 0, offer: silentOffer }], data, false, NOW, {
      fetchFn: async () => ({ ok: true, text: THUNDER_CLIENT_LANDING_PAGE }),
      verifyFn: async () => ({
        status: "changed",
        summary: READ_FROM_A_PAGE_WITH_NO_PRICING.summary,
        change_type: READ_FROM_A_PAGE_WITH_NO_PRICING.change_type,
        current_state: READ_FROM_A_PAGE_WITH_NO_PRICING.current_state,
        impact: "high",
      }),
      rateLimitMs: 0,
      changesPath: file,
    });
    assert.strictEqual(result.changed, 1);
    assert.strictEqual(result.recorded.length, 0);
    assert.strictEqual(result.rejected[0].reason, REJECT_NO_PRICE_SIGNAL);
    assert.strictEqual(JSON.parse(readFileSync(file, "utf-8")).changes.length, 0);
    rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("records the same report when the page it read does state terms", async () => {
    const pricedOffer = {
      ...offer,
      vendor: "FreeIPAPI",
      description: READ_FROM_A_ROOT_THAT_PUBLISHES_ITS_PRICING.previous_state,
      url: READ_FROM_A_ROOT_THAT_PUBLISHES_ITS_PRICING.source_url,
    };
    const file = tempLog([]);
    const data = { offers: [{ ...pricedOffer }] };
    const result = await runAiMode([{ index: 0, offer: pricedOffer }], data, false, NOW, {
      fetchFn: async () => ({ ok: true, text: FREEIPAPI_LANDING_PAGE }),
      verifyFn: async () => ({
        status: "changed",
        summary: READ_FROM_A_ROOT_THAT_PUBLISHES_ITS_PRICING.summary,
        change_type: READ_FROM_A_ROOT_THAT_PUBLISHES_ITS_PRICING.change_type,
        current_state: READ_FROM_A_ROOT_THAT_PUBLISHES_ITS_PRICING.current_state,
        impact: "medium",
      }),
      rateLimitMs: 0,
      changesPath: file,
    });
    assert.strictEqual(result.recorded.length, 1);
    assert.strictEqual(result.rejected.length, 0);
    rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("counts the refusals in the run summary", () => {
    const lines = summaryLines(
      {
        verified: 3,
        flagged: 1,
        changed: 4,
        recorded: [{}, {}],
        suppressed: [],
        unclassified: [],
        rejected: [
          { candidate: A_DAILY_CAP_WAS_HALVED, reason: REJECT_CONFIRMED_UNCHANGED, detail: "" },
          { candidate: SAME_TERMS_EITHER_SIDE, reason: REJECT_NULL_COMPARISON, detail: "" },
        ],
        unchecked: [{}],
      },
      { useAi: true, checked: 8, oldestRemaining: "2026-01-01", total: 100 }
    );
    assert.ok(lines.includes("Rejected (no change described): 2"), lines.join("\n"));
    assert.ok(lines.includes("Recorded without a second opinion: 1"), lines.join("\n"));
  });

  it("reports no refusals for a mode that cannot detect a change", () => {
    const lines = summaryLines(
      { verified: 3, flagged: 1, changed: 0, recorded: [], suppressed: [], unclassified: [], rejected: [], unchecked: [] },
      { useAi: false, checked: 4, oldestRemaining: "2026-01-01", total: 100 }
    );
    assert.ok(!lines.some((l: string) => l.startsWith("Rejected")), lines.join("\n"));
  });
});
