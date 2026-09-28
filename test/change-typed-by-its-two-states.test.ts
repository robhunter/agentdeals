import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENTDEALS_REFUSALS_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "refusals-typing-")),
  "change_refusals.json"
);

const {
  describesChange,
  gateCandidates,
  listedTierOf,
  REJECT_NO_TERMS_TO_NARROW,
} = await import("../scripts/change-gate.js");

const FIRST_READING = { date_source: "discovered", impact: "medium", category: "Databases", alternatives: [] };

const A_FREE_PLAN_NOW_ONLY_A_CREDIT = {
  ...FIRST_READING,
  vendor: "CockroachDB",
  change_type: "new_tier",
  tier: "Standard",
  tier_direction: "narrowed",
  summary:
    "The page offers a 30-day free trial with $400 in credit for new Cloud organizations, and then moves to paid plans like 'Standard' and 'Mission Critical'.",
  previous_state: "Free serverless distributed SQL — 50M Request Units + 10 GiB storage/month, scales to zero",
  current_state: "Start free with a $400 credit today $0.092 per vCPU-hour* ≈ $203/mo based on 2 vCPU · 100 GB",
  source_url: "https://www.cockroachlabs.com/pricing/",
};

const A_TRIAL_NOW_FREE_FOR_GOOD = {
  ...FIRST_READING,
  vendor: "Weaviate",
  change_type: "pricing_restructured",
  summary:
    "The free tier now has specific limits: 100,000 objects, 1 GB memory, 10 GB disk, 1 collection, up to 3 tenants, 2,000 embedding requests/day, and 1,000 Query Agent requests/month. The cloud offering is now structured into 'Free', 'Flex', and 'Premium' tiers.",
  previous_state:
    "Open-source vector database — self-hosted: free forever with full features (hybrid search, multi-tenancy, compression). Cloud: 14-day free sandbox with full access. Paid cloud from $45/mo (Flex)",
  current_state:
    "Always free: $0 /mo. 1 cluster per user, upgrade to paid anytime. 100,000 objects, 1 GB memory, 10 GB disk, 1 collection, up to 3 tenants, 2,000 req/day Embeddings + Query Agent (1,000 req/mo).",
  source_url: "https://weaviate.io/pricing",
};

const A_FREE_BAND_CUT = {
  ...FIRST_READING,
  vendor: "Foursquare",
  change_type: "pricing_restructured",
  summary:
    "The Spatial Desktop Basic plan is $0/month through 2026, includes $1 of agent tokens, 3 GB of cloud storage, and 5 shared projects. The Places API free tier is now 10,000 free calls on Pro endpoints. The pricing for Pro and Premium endpoints has been updated with specific CPMs based on call volume.",
  previous_state:
    "Location discovery, venue search, and context-aware content. Places API: 10,000 free calls/mo on Pro endpoints ($0.00 CPM), then pay-per-call. New users get $200 in free credits. Spatial Studio Community (always free: 1 GB cloud storage, limited data catalog, public-only map publishing). Spatial Desktop Basic ($0/mo through 2026, includes $1 of agent tokens to preview FSQ Spatial Agent, 5 shared projects, 3 GB cloud storage). Spatial Workbench 30-day free trial (pay only for compute/storage used).",
  current_state:
    "Places API Pro endpoints: 0-500 Calls $0.00 CPM, 501 to 100,000 Calls $15.00 CPM, 100,001 to 500,000 Calls $12.00 CPM, 500,001+ Calls $9.00 CPM. Places API Premium endpoints: 0-100,000 Calls $18.75 CPM, 100,001 to 500,000 Calls $15.00 CPM, 500,001+ Calls $11.25 CPM.",
  source_url: "https://foursquare.com/pricing/",
};

const A_REDUCTION_THAT_ALSO_WIDENED = {
  ...FIRST_READING,
  vendor: "Liveblocks",
  change_type: "limits_reduced",
  summary:
    "The free tier now includes 3,000 realtime collaboration minutes, and 200 comments. It also includes 1 GB of realtime data storage and 512 MB of file storage.",
  previous_state:
    "Real-time collaboration infrastructure — unlimited MAU, 500 monthly active rooms, 256 MB realtime data + 512 MB file storage, 3 dashboard seats, 10 projects. Presence, cursors, comments, notifications, text editor components",
  current_state:
    "Free tier includes: Unlimited MAU, Unlimited monthly active rooms, 3,000 realtime collaboration minutes, 200 comments, 1 GB realtime data storage, 512 MB file storage, 3 dashboard seats, 10 projects.",
  source_url: "https://liveblocks.io/pricing",
};

const A_NARROWING_OF_TERMS_NEVER_STATED = {
  ...FIRST_READING,
  vendor: "Composio",
  change_type: "limits_reduced",
  tier: "Free",
  tier_direction: "narrowed",
  summary: "The free tier now has limits: 100,000 tool calls, 50,000 triggers, and 3 team members per month.",
  previous_state: "Integration platform for AI Agents and LLMs. Integrate over 200+ tools across the agentic internet.",
  current_state: "Free $0 No credit card required 100,000 tool calls / mo 50,000 triggers / mo 3 team members",
  source_url: "https://composio.dev/pricing",
};

const A_CHANGE_TO_PAID_PLANS_ONLY = {
  ...FIRST_READING,
  vendor: "DBOS",
  change_type: "pricing_restructured",
  summary:
    "The pricing for DBOS Pro and DBOS Teams has been updated. DBOS Pro is $99/month for 2 user seats, 3 apps, and 1M checkpoints. DBOS Teams is $499/month for 10 user seats, 10 apps, and 10M checkpoints.",
  previous_state:
    "Open-source durable workflow orchestration library (DBOS Transact) — free forever for TypeScript, Python, Go, Java, Kotlin. Self-host with PostgreSQL backend; community support via Discord. Managed DBOS Cloud is paid-only (Pro from $99/mo: 3 seats, 5 apps, 1M checkpoints/mo).",
  current_state:
    "DBOS Pro is $99/month (2 user seats, 3 apps, 1M checkpoints). DBOS Teams is $499/month (10 user seats, 10 apps, 10M checkpoints). DBOS Cloud is a serverless hosting option.",
  source_url: "https://www.dbos.dev/pricing",
};

const A_PAID_PLAN_PRICE_CUT = {
  ...FIRST_READING,
  vendor: "Codecov",
  change_type: "pricing_restructured",
  summary:
    "The Team plan is now $5 per user/month, down from the stored $12 per user/month. The Team plan is limited to 10 users, and is not visible if you have more than 10 activated users.",
  previous_state:
    "Code coverage reporting and analytics — Developer plan free for 1 user with unlimited public and private repos, 250 private uploads/month. Always free and unlimited for open-source. PR comments, status checks, patch coverage. Paid Team plan $12/user/month.",
  current_state: "Team $5 per user/month. Limited to 10 users. If you have more than 10 activated users, the Team plan will not be visible.",
  source_url: "https://about.codecov.io/pricing/",
};

const judged = (record: object, listedTier?: string) => describesChange(record, { listedTier });

describe("a reading typed by what its two states support", () => {
  it("types a free plan that became only a trial and a credit as a removal", () => {
    const verdict = judged(A_FREE_PLAN_NOW_ONLY_A_CREDIT, "Basic");
    assert.strictEqual(verdict.ok, true, `refused as ${verdict.reason}`);
    assert.strictEqual(verdict.reclassifyAs, "free_tier_removed");
  });

  it("types a trial that became a plan free for good as a new free tier", () => {
    const verdict = judged(A_TRIAL_NOW_FREE_FOR_GOOD, "Open Source");
    assert.strictEqual(verdict.ok, true, `refused as ${verdict.reason}`);
    assert.strictEqual(verdict.reclassifyAs, "new_free_tier");
  });

  it("types a free band cut in a price table as a reduction of the free tier", () => {
    const verdict = judged(A_FREE_BAND_CUT, "Free");
    assert.strictEqual(verdict.ok, true, `refused as ${verdict.reason}`);
    assert.strictEqual(verdict.reclassifyAs, "limits_reduced");
  });

  it("types a reduction whose stored allowances also grew as a restructure", () => {
    const verdict = judged(A_REDUCTION_THAT_ALSO_WIDENED, "Free");
    assert.strictEqual(verdict.ok, true, `refused as ${verdict.reason}`);
    assert.strictEqual(verdict.reclassifyAs, "pricing_restructured");
  });

  it("refuses a narrowing measured against a description that states no terms", () => {
    const verdict = judged(A_NARROWING_OF_TERMS_NEVER_STATED, "Free");
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, REJECT_NO_TERMS_TO_NARROW);
  });

  it("refuses the same reading under any narrowing type", () => {
    for (const change_type of ["pricing_restructured", "pricing_model_change"]) {
      const verdict = judged({ ...A_NARROWING_OF_TERMS_NEVER_STATED, change_type }, "Free");
      assert.strictEqual(verdict.reason, REJECT_NO_TERMS_TO_NARROW, change_type);
    }
  });

  it("leaves the listed free tier standing when the reading names only paid plans", () => {
    for (const [record, tier] of [
      [A_CHANGE_TO_PAID_PLANS_ONLY, "Free (open-source library; managed cloud is paid-only)"],
      [A_PAID_PLAN_PRICE_CUT, "Developer"],
    ] as const) {
      const verdict = judged(record, tier);
      assert.strictEqual(verdict.ok, true, `${record.vendor} refused as ${verdict.reason}`);
      assert.strictEqual(verdict.reclassifyAs, undefined, record.vendor);
      assert.strictEqual(verdict.tierDirection, "unchanged", record.vendor);
    }
  });

  it("carries each type and direction onto the candidate the re-read records", async () => {
    const candidates = [A_FREE_PLAN_NOW_ONLY_A_CREDIT, A_TRIAL_NOW_FREE_FOR_GOOD, A_PAID_PLAN_PRICE_CUT];
    const offers = [
      { vendor: "CockroachDB", url: A_FREE_PLAN_NOW_ONLY_A_CREDIT.source_url, tier: "Basic" },
      { vendor: "Weaviate", url: A_TRIAL_NOW_FREE_FOR_GOOD.source_url, tier: "Open Source" },
      { vendor: "Codecov", url: A_PAID_PLAN_PRICE_CUT.source_url, tier: "Developer" },
    ];
    const result = await gateCandidates(candidates, { offers });
    const recorded = new Map(result.accepted.map((c: any) => [c.vendor, c]));
    assert.strictEqual(recorded.get("CockroachDB").change_type, "free_tier_removed");
    assert.strictEqual(recorded.get("Weaviate").change_type, "new_free_tier");
    assert.strictEqual(recorded.get("Codecov").change_type, "pricing_restructured");
    assert.strictEqual(recorded.get("Codecov").tier_direction, "unchanged");
    assert.deepStrictEqual(
      result.reclassified.map((r: any) => `${r.candidate.vendor}: ${r.from} -> ${r.to}`).sort(),
      ["CockroachDB: new_tier -> free_tier_removed", "Weaviate: pricing_restructured -> new_free_tier"]
    );
    assert.deepStrictEqual(result.untiered.map((u: any) => u.candidate.vendor), ["Codecov"]);
  });

  it("finds the listed tier by the vendor and the page the reading cites", () => {
    const offers = [
      { vendor: "Codecov", url: "https://docs.codecov.com/", tier: "Enterprise" },
      { vendor: "Codecov", url: A_PAID_PLAN_PRICE_CUT.source_url, tier: "Developer" },
    ];
    assert.strictEqual(listedTierOf(offers, A_PAID_PLAN_PRICE_CUT), "Developer");
    assert.strictEqual(listedTierOf(offers, { vendor: "Codecov", source_url: "https://codecov.io/" }), undefined);
  });
});

describe("readings the typing leaves as they were recorded", () => {
  const keeps = (record: any, listedTier?: string) => {
    const verdict = judged(record, listedTier);
    assert.strictEqual(verdict.ok, true, `${record.vendor} refused as ${verdict.reason}`);
    assert.strictEqual(verdict.reclassifyAs, undefined, `${record.vendor} retyped as ${verdict.reclassifyAs}`);
    assert.strictEqual(verdict.tierDirection, undefined, `${record.vendor} marked ${verdict.tierDirection}`);
  };

  it("keeps a narrowing of unlimited terms, which a description stating no figure can still carry", () => {
    keeps(
      {
        ...FIRST_READING,
        vendor: "Terrateam",
        change_type: "limits_reduced",
        summary: "Doesn't confirm the original unlimited usage claim.",
        previous_state:
          "GitOps-first Terraform automation with pull request-driven workflows, project isolation via self-hosted runners, and layered runs for ordered operations. Free for unlimited users with unlimited runs and runners.",
        current_state:
          "Terrateam offers a free start with no credit card required. Features include cost estimation, policy enforcement, and self-service.",
        source_url: "https://terrateam.io",
      },
      "Free"
    );
  });

  it("keeps a free tier moved from fixed allowances to a monthly credit", () => {
    keeps(
      {
        ...FIRST_READING,
        vendor: "PandaStack",
        change_type: "pricing_model_change",
        summary: "The free tier now includes a $5.40/mo usage credit instead of a fixed amount of bandwidth and build minutes.",
        previous_state:
          "An eco-system for developers includes web hosting in different formats (static web hosting, container based web hosting, wordpress and so many other managed apps available in couple of clicks ). One free web hosting (static or containered) and one free database with 100GB Bandwidth and 300 Build mins/month.",
        current_state: "Free tier with $5.40/mo usage credit. No card.",
        source_url: "https://www.pandastack.io/",
      },
      "Free"
    );
  });

  it("does not call a startup programme's larger credit grant a removal", () => {
    keeps(
      {
        ...FIRST_READING,
        vendor: "Microsoft for Startups",
        change_type: "limits_increased",
        summary: "The program now offers up to $150,000 in credits.",
        previous_state:
          "Get access to a wide range of benefits—from technical resources and free Azure cloud, to selling alongside Microsoft salespeople and partner channel.",
        current_state: "Access cutting-edge AI models, developer tools, and up to $150,000 in credits",
        source_url: "https://startups.microsoft.com/en-us/",
      },
      "Startup Program"
    );
  });

  it("does not call a trial that stays a trial a removal, whatever the listing says", () => {
    const aTrialStillATrial = {
      ...FIRST_READING,
      vendor: "Storj",
      change_type: "pricing_restructured",
      summary:
        "The free trial now includes 25GB of storage and 2 Object Mount licenses. The page details a $5 minimum monthly fee that is waived during the trial and for accounts paying in STORJ token.",
      previous_state:
        "Distributed S3-compatible object storage. Free trial only: 25 GB free storage for 30 days, no credit card required, and 2 Object Mount licenses. After the trial, $7/TB storage and $7/TB egress with a $5 monthly minimum fee.",
      current_state:
        "Object Storage offers a free trial with 25GB storage and 2 Object Mount licenses for 30 days. Paid plans include Standard ($7/TB storage, $7/TB egress, $5 monthly minimum) and Advanced tiers.",
      source_url: "https://storj.io/pricing",
    };
    keeps(aTrialStillATrial, "Trial");
    keeps(aTrialStillATrial);
  });

  it("does not call a free product a new free tier because another site sells a trial", () => {
    keeps(
      {
        ...FIRST_READING,
        vendor: "Code Time",
        change_type: "pricing_restructured",
        summary:
          "While Code Time remains free for basic use, the offering now includes a 90-day data history limit and pushes users towards a paid antenna.dev account for advanced features and data visualizations.",
        previous_state:
          "Now published only on the Visual Studio Marketplace. software.com/code-time returns 404 via antenna.dev, whose own pricing starts at $15/month per Git user and offers a trial rather than a free tier. Read 2026-09-13, the marketplace listing states Free — an open source plugin for automatic programming metrics and time tracking in Visual Studio Code.",
        current_state:
          "Free for you, forever: We provide 90 days of data history for free, forever. We provide premium plans for advanced features and historical data access.",
        source_url: "https://marketplace.visualstudio.com/items?itemName=softwaredotcom.swdc-vscode",
      },
      "Free"
    );
  });

  it("does not call a page that still sells a trial a new free tier", () => {
    keeps(
      {
        ...FIRST_READING,
        vendor: "Tyk",
        change_type: "pricing_restructured",
        summary:
          "The free tier information has been updated. An open-source option is still mentioned, the page now prominently features a 48-hour free trial of Tyk Cloud and three paid tiers: Core, Professional, and Enterprise.",
        previous_state:
          "Open-source API gateway — self-hosted: free forever under MPL-2.0, includes rate limiting, auth, analytics. Cloud: 48-hour free trial only, paid plans usage-based. Dashboard and developer portal included",
        current_state:
          "Tyk offers three pricing tiers: Core, Professional, and Enterprise, with a free trial so you can test Tyk’s full features with no commitment. Yes, Tyk provides: a free version of its open source API gateway via GitHub . a fully featured, free, 48-hour trial of Tyk Cloud.",
        source_url: "https://tyk.io/pricing/",
      },
      "Open Source"
    );
  });

  it("does not call a plan our text described without the word free a new free tier", () => {
    keeps(
      {
        ...FIRST_READING,
        vendor: "Hex",
        change_type: "limits_reduced",
        summary: "The free tier (Community plan) still exists. The free tier now has restrictions on published apps (up to 5) and shared collections (up to 3).",
        previous_state:
          "Collaborative data platform for notebooks, data apps, and knowledge libraries. Community plan: up to 5 notebooks, up to 5 published apps, Small compute (2 GB RAM, 0.25 CPU), unlimited users, connect any data source, notebook agent trial (limited AI agent access).",
        current_state:
          "The Community plan is free and includes: Unlimited users, Connect any data source, Build with all cell types, Small compute (4 GB RAM, 0.5 CPU), Up to 5 published apps, Up to 3 shared collections.",
        source_url: "https://hex.tech/pricing/",
      },
      "Community"
    );
  });

  it("does not take a listing sold as paid terms for a free tier left standing", () => {
    const aMinimumAdded = {
      ...FIRST_READING,
      vendor: "Turbopuffer",
      change_type: "pricing_restructured",
      summary: "The vendor now has a $16/month minimum usage requirement for the 'scale' tier, effectively removing the truly pay-as-you-go option.",
      previous_state:
        "Serverless vector database — pay-per-use with no minimum. $0.30/M vectors stored/month, $0.04/M vectors queried. No free tier but extremely low entry cost for small workloads",
      current_state: "Includes all database features with a $16/month minimum usage.",
      source_url: "https://turbopuffer.com/pricing",
    };
    keeps(aMinimumAdded, "Pay-as-you-go");
    keeps(aMinimumAdded);
    keeps({ ...A_PAID_PLAN_PRICE_CUT, vendor: "Stripe Atlas" }, "Founder Perks");
  });

  it("does not read perks that left the page as a larger free tier", () => {
    keeps(
      {
        ...FIRST_READING,
        vendor: "Mercury",
        change_type: "limits_reduced",
        summary:
          "The Datadog offer is missing, the AWS credit is reduced to $5k, the Google Cloud credit is missing, and the QuickBooks Online discount is reduced to 90% off.",
        previous_state:
          "1 year free Datadog (up to $100K value), $5K AWS credits, up to $200K Google Cloud credits, and 30% off QuickBooks Online for Mercury banking customers",
        current_state:
          "The page lists $5k AWS credits, and 90% off QuickBooks Online. It also lists other perks like $10k GitHub credits, 3 months free Notion, and various discounts on other software.",
        source_url: "https://mercury.com/perks",
      },
      "Perks"
    );
  });

  it("does not record a removal again for a listing already recorded as a trial or credit", () => {
    keeps(A_FREE_PLAN_NOW_ONLY_A_CREDIT, "Trial");
    keeps(A_FREE_PLAN_NOW_ONLY_A_CREDIT, "Credits");
  });

  it("keeps the recorded type when the reading would be refused under the type its states support", () => {
    const readFromTheDomainRoot = { ...A_FREE_PLAN_NOW_ONLY_A_CREDIT, source_url: "https://www.cockroachlabs.com/" };
    assert.strictEqual(judged({ ...readFromTheDomainRoot, change_type: "free_tier_removed" }, "Basic").ok, false);
    keeps(readFromTheDomainRoot, "Basic");
  });

  it("does not pair figures that one word names in several places", () => {
    keeps(
      {
        ...FIRST_READING,
        vendor: "The Intercom Early Stage Program",
        change_type: "limits_reduced",
        summary: "The number of Fin outcomes and qualifications available in Years 2 and 3 have been reduced.",
        previous_state:
          "Intercom Early Stage pricing starts at $33/month, with 93% off in the first year, 50% off in the second and 25% off in the third. The first year includes 300 Fin outcomes and 15 Fin qualifications per month.",
        current_state:
          "Year 1 includes 300 Fin outcomes and 15 Fin qualifications. Year 2 includes 150 Fin outcomes and 15 Fin qualifications. Year 3 includes 75 Fin outcomes and 15 Fin qualifications.",
        source_url: "https://www.intercom.com/early-stage",
      },
      "Startup Program"
    );
  });

  it("does not read the parts of a fraction, or a count of what a product covers, as figures that moved", () => {
    keeps(
      {
        ...FIRST_READING,
        vendor: "Gel",
        change_type: "limits_reduced",
        summary: "RAM and vCPU limits have changed.",
        previous_state:
          "Graph-relational database (formerly EdgeDB) — free cloud tier: 1/4 compute unit (0.5 GiB RAM), 1 GB storage. Also fully open-source for self-hosting. No credit card required",
        current_state: "Free tier: 1/4 compute unit ( 1/2 GiB RAM, 1/16 vCPU ), Up to 1GB of disk space",
        source_url: "https://www.geldata.com/pricing",
      },
      "Free"
    );
    keeps(
      {
        ...FIRST_READING,
        vendor: "Nango",
        change_type: "limits_reduced",
        summary: "The free tier now has specific limits on connections (10), proxy requests (100k) and API webhooks (100k).",
        previous_state:
          "Integration infrastructure for 600+ APIs — 10 connections, unified auth/data syncing/webhook handling, unlimited development/testing time.",
        current_state: "The Free plan is $0/mo and includes 10 connections, 100k proxy requests, and 100k API webhooks.",
        source_url: "https://www.nango.dev/pricing",
      },
      "Free"
    );
  });
});
