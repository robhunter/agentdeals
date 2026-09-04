import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.AGENTDEALS_REFUSALS_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "refusals-free-tier-removal-")),
  "change_refusals.json"
);

const {
  clauseStatingAPlanIsStillFree,
  describesChange,
  FREE_TIER_REMOVED,
  REJECT_FREE_PLAN_STILL_DESCRIBED,
} = await import("../scripts/change-gate.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FORMBRICKS = {
  vendor: "Formbricks",
  change_type: FREE_TIER_REMOVED,
  date: "2026-08-28",
  summary:
    "The Community/Free tier with unlimited surveys and responses no longer exists. The free tier, 'Hobby', offers 250 responses per month and core survey features.",
  previous_state:
    "Community Edition (self-hosted): unlimited seats, unlimited surveys, unlimited responses, all question types",
  current_state:
    "The Hobby plan is free and includes 1 Workspace, 250 responses per month, and core survey features like all question types, conditional logic, and full API access.",
  impact: "high",
  source_url: "https://formbricks.com/pricing",
};

const MISTRAL = {
  vendor: "Mistral AI",
  change_type: FREE_TIER_REMOVED,
  date: "2026-09-03",
  summary:
    "Previously 2 RPM and 1B tokens/month with no credit card required. The free tier now provides limited access to Vibe, including chat, search, creation, and Vibe for code.",
  previous_state: "Access to all Mistral models — 2 RPM, 1B tokens/month. No credit card required",
  current_state:
    "The free plan provides limited access to Vibe, including chat, search, creation, and Vibe for code. $10 /mo in API credits is also available.",
  impact: "high",
  source_url: "https://mistral.ai/pricing",
};

const HIGHLIGHT = {
  vendor: "Highlight.io",
  change_type: FREE_TIER_REMOVED,
  date: "2026-08-28",
  summary: "Highlight.io's own page now redirects to launchdarkly.com.",
  previous_state: "500 sessions, 1K errors, 1M logs, 25M traces/month",
  current_state:
    "LaunchDarkly's Developer plan is $0/month forever and includes 5,000 session replays and 5,000 errors a month, 1 project and 3 environments, with 14-day data retention.",
  impact: "high",
  source_url: "https://www.highlight.io/pricing",
};

const A_TRIAL_REPLACED_THE_FREE_PLAN = {
  vendor: "Middleware.io",
  change_type: FREE_TIER_REMOVED,
  date: "2026-08-28",
  summary:
    "The free tier has been replaced by a 14 days free trial with unlimited data ingestion and full platform access.",
  previous_state: "Free forever tier with 1 GB of logs a month",
  current_state: "14 days free trial with unlimited data ingestion, then paid plans from $0.30 per GB.",
  impact: "high",
  source_url: "https://middleware.io/pricing",
};

const THE_ONLY_FREE_PLAN_IS_THE_ONE_TAKEN_AWAY = {
  vendor: "bonsai.io",
  change_type: FREE_TIER_REMOVED,
  date: "2026-09-04",
  summary:
    "The free tier no longer exists. The lowest tier is now a 'Staging' plan at $15/month with 1 GB storage and 256 MB memory.",
  previous_state: "Free Sandbox plan with 35 MB storage",
  current_state:
    "The lowest available plan is 'Staging' at $15/month, offering 1 GB storage, 256 MB memory, and 100k documents.",
  impact: "high",
  source_url: "https://bonsai.io/pricing",
};

const A_METERED_RATE_OF_A_CENT = {
  vendor: "Momento",
  change_type: FREE_TIER_REMOVED,
  date: "2026-09-04",
  summary:
    "Momento Cache Flex starts at $13 per GB-month. Pub/sub Topics are priced at $1 per 1M operations. Data transfer is $0.01 per GB for Valkey Router.",
  previous_state: "5 GB per month free, then $0.15 per GB",
  current_state: "Momento Cache Flex from $13 per GB-month. Valkey Router $0.01 per GB of data transfer.",
  impact: "high",
  source_url: "https://www.gomomento.com/pricing",
};

describe("a free tier a record still describes has not been removed", () => {
  describe("the rule reads the record's own account of what is on offer", () => {
    it("flags a removal whose current state names a plan it calls free", () => {
      assert.strictEqual(
        clauseStatingAPlanIsStillFree(FORMBRICKS),
        "The free tier, 'Hobby', offers 250 responses per month and core survey features."
      );
    });

    it("flags a removal whose summary says the free tier provides something now", () => {
      assert.match(String(clauseStatingAPlanIsStillFree(MISTRAL)), /^The free tier now provides limited access/);
    });

    it("flags a removal that prices a plan at zero a month", () => {
      assert.match(String(clauseStatingAPlanIsStillFree(HIGHLIGHT)), /\$0\/month forever/);
    });

    it("keeps a removal whose replacement is a trial of a stated length", () => {
      assert.strictEqual(clauseStatingAPlanIsStillFree(A_TRIAL_REPLACED_THE_FREE_PLAN), null);
    });

    it("keeps a removal whose only free plan is the one it says is gone", () => {
      assert.strictEqual(clauseStatingAPlanIsStillFree(THE_ONLY_FREE_PLAN_IS_THE_ONE_TAKEN_AWAY), null);
    });

    it("reads a rate of a cent per gigabyte as a price rather than as a plan costing nothing", () => {
      assert.strictEqual(clauseStatingAPlanIsStillFree(A_METERED_RATE_OF_A_CENT), null);
    });

    it("requires a trial qualifier to sit beside the free claim, not merely in the same sentence", () => {
      const theTrialIsOnADifferentPlan = {
        ...FORMBRICKS,
        summary: "",
        current_state:
          "The Hobby plan is free and includes 1 Workspace and 250 responses per month, and the Pro tier can be evaluated with a 14-day free trial.",
      };
      assert.ok(
        clauseStatingAPlanIsStillFree(theTrialIsOnADifferentPlan),
        "a trial offered on another plan was read as the free plan itself being temporary"
      );
    });

    it("keeps a removal a vendor announced while still describing the plan going away", () => {
      const announcedButNotYetGone = {
        ...FORMBRICKS,
        summary: "",
        current_state:
          "The free plan offers 500 MB of storage and is being removed for all workspaces on 1 October.",
      };
      assert.strictEqual(clauseStatingAPlanIsStillFree(announcedButNotYetGone), null);
    });

    it("reads no plan on offer in a record that states neither summary nor current state", () => {
      assert.strictEqual(clauseStatingAPlanIsStillFree({ change_type: FREE_TIER_REMOVED }), null);
    });
  });

  describe("the gate refuses such a record when it is written", () => {
    it("refuses a removal that describes a free plan on offer now", () => {
      const verdict = describesChange(FORMBRICKS);
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_FREE_PLAN_STILL_DESCRIBED);
    });

    it("names the clause it refused so the reading can be checked", () => {
      assert.match(String(describesChange(MISTRAL).detail), /The free tier now provides limited access/);
    });

    it("admits a removal that states what stands where the free tier was", () => {
      assert.notStrictEqual(
        describesChange(THE_ONLY_FREE_PLAN_IS_THE_ONE_TAKEN_AWAY).reason,
        REJECT_FREE_PLAN_STILL_DESCRIBED
      );
    });
  });

  describe("every free tier removal we have stored survives its own rule", () => {
    const stored = JSON.parse(
      readFileSync(path.join(__dirname, "..", "data", "deal_changes.json"), "utf-8")
    ).changes as Array<Record<string, any>>;
    const removals = stored.filter(c => c.change_type === FREE_TIER_REMOVED);

    it("holds no removal still in force that describes a free plan on offer", () => {
      const failing = removals
        .filter(c => !c.resolution)
        .map(c => ({ record: c, clause: clauseStatingAPlanIsStillFree(c) }))
        .filter(({ clause }) => clause)
        .map(({ record, clause }) => `${record.vendor} ${record.date}: ${clause}`);
      assert.deepStrictEqual(failing, [], `stored removals describing a free plan:\n${failing.join("\n")}`);
    });

    it("still holds the removals the control set names", () => {
      const kept = new Set(removals.filter(c => !c.resolution).map(c => c.vendor));
      for (const vendor of ["Middleware.io", "Survicate", "ScraperAPI", "Burnermail"]) {
        assert.ok(kept.has(vendor), `${vendor} keeps its free tier removal record`);
      }
    });

    it("checks more than a handful of records", () => {
      assert.ok(removals.length >= 80, `only ${removals.length} free tier removal records were checked`);
    });
  });
});
