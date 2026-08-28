import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  THUNDER_CLIENT_LANDING_PAGE,
  DOCZILLA_LANDING_PAGE,
  FREEIPAPI_LANDING_PAGE,
  JOINSECRET_OFFERS_PAGE,
} from "./vendor-page-fixture.ts";

const {
  describesChange,
  gateCandidates,
  nullComparisons,
  assertsAgreement,
  quantities,
  priceSignals,
  quantifiedAttributes,
  rejectionCounts,
  parseConfirmation,
  changeConfirmationPrompt,
  MIN_PRICE_SIGNALS,
  REJECT_NULL_COMPARISON,
  REJECT_STATES_NO_DIFFERENCE,
  REJECT_NO_PRICE_SIGNAL,
  REJECT_PAGE_NOT_ABOUT_VENDOR,
  REJECT_UNQUANTIFIED_LIMIT,
  REJECT_CONFIRMED_UNCHANGED,
} = await import("../scripts/change-gate.js");

const { runAiMode, summaryLines } = await import("../scripts/reverify-rolling.js");

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

    it("keeps a record where the equal figure sits beside a figure that vanished", () => {
      const droppedAlongside = {
        ...SAME_TERMS_EITHER_SIDE,
        current_state: "Free: 1 A/B Test, 3 Feature Flags, 5 Environments",
      };
      assert.deepStrictEqual(nullComparisons(droppedAlongside.summary).length, 1);
      assert.strictEqual(describesChange(droppedAlongside).ok, true);
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

    it("keeps a record whose figures match but whose type is not a claim about figures", () => {
      const notAQuantityClaim = { ...SUMMARY_SAYS_IT_MATCHES, change_type: "rebranded" };
      assert.strictEqual(describesChange(notAQuantityClaim).ok, true);
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
    const { accepted, rejected } = await gateCandidates([A_LIMIT_ACTUALLY_MOVED], {
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
      { verified: 3, flagged: 1, changed: 4, recorded: [{}, {}], suppressed: [], unclassified: [], rejected: [{}, {}], unchecked: [{}] },
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
