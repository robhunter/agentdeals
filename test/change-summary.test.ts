import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENTDEALS_REFUSALS_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "refusals-summary-")),
  "change_refusals.json"
);

const {
  auditRecord,
  applyAudit,
  classifyClause,
  clauseText,
  describesChange,
  isDomainRoot,
  namesTheDimensionThatChanged,
  redirectedOffDomain,
  reportsSomethingStillFree,
  statesTheSameFigure,
  trimmedToItsFigures,
  withoutStoredReference,
  statesARemoval,
  summaryClauses,
  summaryEvidence,
  summaryFromClauses,
  CLAUSE_ABSENCE,
  CLAUSE_BOOKKEEPING,
  CLAUSE_HEDGE,
  CLAUSE_NARRATION,
  CLAUSE_RESTATEMENT,
  CLAUSE_TERMS,
  FREE_TIER_REMOVED,
  OUTCOME_REFUSED,
  OUTCOME_REWRITTEN,
  OUTCOME_UNCHANGED,
  REJECT_DANGLING_REFERENCE,
  REJECT_FREE_TIER_STILL_OFFERED,
  REJECT_NO_BASELINE,
  REJECT_NO_REMOVAL_EVIDENCE,
  REJECT_REMOVAL_READ_FROM_REDIRECT,
  REJECT_REMOVAL_READ_FROM_ROOT,
  REJECT_STATES_NO_DIFFERENCE,
  REJECT_STATES_NO_TERMS,
  statesARedirect,
} = await import("../scripts/change-gate.js");

const { sweepRecords } = await import("../scripts/sweep-change-summaries.js");

const THE_PAGE_DID_NOT_MENTION_IT = {
  vendor: "Mergify",
  change_type: "free_tier_removed",
  summary:
    "The pricing page does not explicitly mention a free tier for public GitHub repositories. It focuses on features and benefits without detailing specific pricing plans or free options. The page highlights features like Merge Queue, CI Insights, and Test Insights, and encourages users to 'Get started' or 'Talk to our team', suggesting a potential need for a paid plan.",
  previous_state:
    "workflow automation and merge queue for GitHub — Free for public GitHub repositories",
  current_state:
    "The pricing page does not mention a free tier. It highlights features and encourages users to contact the team or get started, implying a paid service.",
  impact: "high",
  source_url: "https://mergify.com",
};

const THE_SUMMARY_REPORTS_A_FREE_TIER_IT_CALLS_REMOVED = {
  vendor: "Activepieces",
  change_type: "free_tier_removed",
  summary:
    "The free tier information is no longer explicitly stated. The page highlights 'Start free' but does not specify any limits on tasks or usage. It mentions '0 per execution' for self-hosting, but this is different from the original free tier.",
  previous_state: "Free up to 5,000 tasks per month",
  current_state:
    "The page promotes a 'Start free' option but does not detail any specific limits or features of a free tier.",
  impact: "high",
  source_url: "https://www.activepieces.com",
};

const A_REMOVAL_READ_FROM_A_HOMEPAGE = {
  vendor: "Integrately",
  change_type: "free_tier_removed",
  summary:
    "The page does not explicitly mention a free tier with 100 tasks and a 15-minute limit. It highlights a $5 premium plan for the first month, but doesn't detail the limitations of that free access.",
  previous_state: "Automate tedious tasks with a single click. Free 100 Tasks, 15 Minute",
  current_state: "The page promotes a $5 premium plan for the first month.",
  impact: "high",
  source_url: "https://integrately.com",
};

const A_REMOVAL_THAT_SAYS_WHAT_REPLACED_IT = {
  vendor: "Segment",
  change_type: "free_tier_removed",
  summary:
    "The Startup Program with $50,000 in credits is no longer listed. Instead, Segment offers a $120/month discount to non-profits.",
  previous_state: "$50,000 in credits toward monthly Team plan for up to 2 years.",
  current_state:
    "Segment offers a $120 per month discount on the monthly Team plan to non-profits, which typically covers 10,000 MTUs per month.",
  impact: "high",
  source_url: "https://segment.com/docs/guides/usage-and-billing/discounts-for-startups-npos/",
};

const A_REMOVAL_WHOSE_PRODUCT_MOVED_TO_ANOTHER_COMPANY = {
  vendor: "Highlight.io",
  change_type: "free_tier_removed",
  summary:
    "The page does not mention a free tier with the previously stated limits (500 sessions, 1K errors, 1M logs, 25M traces/month). It only mentions 'Free trial' and focuses on paid features.",
  previous_state: "500 sessions, 1K errors, 1M logs, 25M traces/month",
  current_state: "The page promotes a free trial and then paid plans.",
  impact: "high",
  source_url: "https://www.highlight.io/pricing",
};

const A_REMOVAL_SOURCED_FROM_NOTHING_BUT_A_REDIRECT = {
  vendor: "Keywords AI",
  change_type: "free_tier_removed",
  summary:
    "The page does not explicitly state a free tier. It showcases features and capabilities of the platform, with mentions of cost savings and budget controls, but does not detail a free usage allowance.",
  previous_state:
    "The best LLM monitoring platform. 10,000 free requests every month and $0 for platform features!",
  current_state: "The page does not explicitly state a free tier.",
  impact: "high",
  source_url: "https://keywordsai.co",
};

const A_MEASURED_CHANGE_READ_AFTER_A_REDIRECT = {
  vendor: "staticforms.xyz",
  change_type: "limits_reduced",
  summary: "The free plan now offers 500 submissions per month instead of 250.",
  previous_state:
    "Integrate HTML forms easily without any server-side code for free. After the user submits the form, an email with the form content will be sent to your registered address.",
  current_state: "Free plan, 500 a month",
  impact: "low",
  source_url: "https://www.staticforms.xyz/",
};

const A_REAL_REDUCTION_WEARING_OUR_SUBJECT = {
  vendor: "Basecamp",
  change_type: "limits_reduced",
  summary:
    "The free tier now allows only 1 project and a maximum of 5 users, whereas the stored information stated 3 projects and 20 users.",
  previous_state: "Up to 3 projects, 20 users, and 1GB of storage space.",
  current_state: "Free plan includes 1 project, 1 GB of storage space, and a maximum of 5 users.",
  impact: "high",
  source_url: "https://basecamp.com/personal",
};

const ONE_WORD_OF_DIFFERENCE_ON_THE_SAME_FIGURE = {
  vendor: "LaunchDarkly",
  change_type: "limits_reduced",
  summary:
    "The Developer tier exists, but the limits have changed. The stored information states 1K client MAU, while the current pricing page states 1K client-side MAU. The stored information states 5K session replays/month, while the current pricing page states 5K session replays /mo.",
  previous_state: "unlimited seats and flags, 1K client MAU, 5K session replays/month",
  current_state: "Developer: $0 / mo, forever. 1K client-side MAU /mo, 5K session replays /mo.",
  impact: "medium",
  source_url: "https://launchdarkly.com/pricing/",
};

const THE_SUMMARY_STATES_AGREEMENT = {
  vendor: "Paddle",
  change_type: "restriction",
  summary:
    "The pricing is 5% + $0.50 per transaction, which matches the stored information. However, the page mentions custom pricing for products under $10 and for invoicing, suggesting the standard pricing may not apply in those cases.",
  previous_state: "Merchant of record — no monthly fee, 5% + $0.50 per transaction.",
  current_state:
    "5% + 50¢ per Checkout transaction. Custom pricing is available for products under $10 or if invoicing is required.",
  impact: "medium",
  source_url: "https://www.paddle.com/pricing",
};

const A_FALSE_ABSENCE_BESIDE_TWO_REAL_MOVES = {
  vendor: "Infisical",
  change_type: "limits_reduced",
  summary:
    "The free tier now offers unlimited projects instead of 3. The number of secret syncs is now 10 instead of 100+. The number of third-party integrations is not specified in the free tier, but was previously 10.",
  previous_state: "5 identities, 3 projects, 3 environments, 10 integrations",
  current_state:
    "Free tier includes 5 identities, unlimited projects, 10 secret syncs, and an unspecified number of third-party integrations.",
  impact: "medium",
  source_url: "https://infisical.com/pricing",
};

const A_DEPRECATION_THAT_NAMES_NO_FIGURE = {
  vendor: "AWS",
  change_type: "product_deprecated",
  summary:
    "AWS App Mesh end of support. Service mesh for ECS/EKS being fully retired. All configurations, virtual nodes, and routes will stop functioning.",
  previous_state: "Service mesh for ECS and EKS.",
  current_state: "AWS App Mesh reaches end of support.",
  impact: "medium",
  source_url: "https://docs.aws.amazon.com/app-mesh/",
};

const AN_INCREASE_WHOSE_BASELINE_HANGS_OFF_IT = {
  vendor: "Hotjar",
  change_type: "limits_increased",
  summary:
    "The free plan now offers 200k sessions per month, a significant increase from the previously stated 20,000 sessions. It also includes features like error monitoring, funnels, and 10+ integrations, which were not mentioned in the stored information. The free plan also includes a 15-day trial of the Growth plan.",
  previous_state:
    "Website Analytics and Reports. Now part of Contentsquare. Free Plan allows 20,000 sessions.",
  current_state:
    "The Contentsquare Free plan includes 200k sessions per month, heatmaps, session replay, surveys, error monitoring, funnels, and 10+ integrations. It also includes a 15-day trial of the Growth plan.",
  impact: "high",
  source_url: "https://www.hotjar.com/pricing/",
};

const A_REDUCTION_WHOSE_BASELINE_TRAILS = {
  vendor: "Bitrise",
  change_type: "limits_reduced",
  summary:
    "The Hobby plan now has a monthly build credit limit and a build timeout of 210 minutes, and includes access to Linux Medium and macOS Medium build compute types. The stored information stated 300 credits/month and 90-minute build timeout.",
  previous_state:
    "Mobile CI/CD platform — free Hobby plan: 300 credits/month, 1 private app, 1 user, 5 concurrent builds, 90-minute build timeout.",
  current_state:
    "Hobby: Free, Access for a team of one, Linux Medium, M2 Pro Medium, macOS Medium build compute types, 2 GB dependency cache storage, 210 minute build timeout.",
  impact: "medium",
  source_url: "https://bitrise.io/pricing",
};

const A_MARKETING_FIGURE_WEARING_THE_ABSENCE = {
  vendor: "aikido.dev",
  change_type: "pricing_restructured",
  summary:
    "The pricing page does not explicitly mention a free tier with the same limits as the stored information (2 users, 10 repos, 1 cloud, 2 containers, 1 domain). It broadly advertises a 'Start for Free' option with 'No CC required' and mentions scanning results in 32 seconds, but doesn't detail the limits of that free offering.",
  previous_state: "Free plan includes two users, scanning of 10 repos, 1 cloud, 2 containers.",
  current_state:
    "The page offers a 'Start for Free' option with no credit card required and claims scan results in 32 seconds.",
  impact: "high",
  source_url: "https://www.aikido.dev/pricing",
};

const A_SURVIVOR_THAT_OPENS_ON_WHAT_WAS_DROPPED = {
  vendor: "PostHog",
  change_type: "startup_program_expanded",
  summary:
    "The YC deal is no longer explicitly mentioned. It's a general free tier available to all, not specifically a YC deal.",
  previous_state: "$50,000/year in credits for Y Combinator companies.",
  current_state: "PostHog offers a free tier with limits of 1M events for analytics.",
  impact: "high",
  source_url: "https://posthog.com/pricing",
};

describe("a change record must state a term the vendor's page carries now", () => {
  describe("a summary is read one clause at a time", () => {
    it("breaks a summary at its sentences and at its contrasting connectives", () => {
      assert.deepStrictEqual(
        summaryClauses("Free tier is now 5 GB, down from 10. The paid plan is unchanged.").map(clauseText),
        ["Free tier is now 5 GB, down from 10.", "The paid plan is unchanged."]
      );
    });

    it("splits the clause that compares the page against what we hold", () => {
      const clauses = summaryClauses(A_REAL_REDUCTION_WEARING_OUR_SUBJECT.summary);
      assert.strictEqual(clauses.length, 2);
      assert.match(clauses[1], /whereas the stored information/);
    });

    it("splits a bookkeeping comparison the writer joined with 'compared to'", () => {
      const clauses = summaryClauses(
        "The free tier now has reduced API call limits (1/sec, 500/day) compared to the stored information (60/minute)."
      );
      assert.strictEqual(clauses.length, 2);
      assert.match(clauses[0], /1\/sec, 500\/day/);
    });

    it("names each clause for what it is about", () => {
      assert.strictEqual(
        classifyClause("The page does not explicitly mention a free tier."),
        CLAUSE_ABSENCE
      );
      assert.strictEqual(
        classifyClause("whereas the stored information stated 3 projects"),
        CLAUSE_BOOKKEEPING
      );
      assert.strictEqual(classifyClause("which equates to 200 requests/day"), CLAUSE_HEDGE);
      assert.strictEqual(
        classifyClause("The page highlights features and encourages users to get started"),
        CLAUSE_NARRATION
      );
      assert.strictEqual(
        classifyClause("The free tier now allows only 1 project"),
        CLAUSE_TERMS
      );
    });

    it("keeps a clause about the page that carries a figure the reader can use", () => {
      assert.strictEqual(
        classifyClause("The page now highlights a starting plan at €19/month"),
        CLAUSE_TERMS
      );
    });

    it("rebuilds a summary from the clauses that survive", () => {
      assert.strictEqual(
        summaryFromClauses(summaryEvidence(A_REAL_REDUCTION_WEARING_OUR_SUBJECT.summary).kept),
        "The free tier now allows only 1 project and a maximum of 5 users."
      );
    });
  });

  describe("the page failed to mention it", () => {
    it("refuses a record whose every clause reports the reading", () => {
      const verdict = auditRecord(THE_PAGE_DID_NOT_MENTION_IT);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_STATES_NO_TERMS);
    });

    it("refuses the same record at the gate", () => {
      const verdict = describesChange(THE_PAGE_DID_NOT_MENTION_IT);
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_STATES_NO_TERMS);
    });

    it("keeps a record that names a term with no figure in it at all", () => {
      assert.strictEqual(auditRecord(A_DEPRECATION_THAT_NAMES_NO_FIGURE).outcome, OUTCOME_UNCHANGED);
    });
  });

  describe("a free tier is not removed by a page that fails to mention it", () => {
    it("reads a domain root as a URL with nothing on it but a homepage", () => {
      assert.strictEqual(isDomainRoot("https://integrately.com"), true);
      assert.strictEqual(isDomainRoot("https://integrately.com/pricing"), false);
    });

    it("refuses a removal read from a homepage that states no price in its place", () => {
      const verdict = auditRecord(A_REMOVAL_READ_FROM_A_HOMEPAGE);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_REMOVAL_READ_FROM_ROOT);
    });

    it("refuses a removal on a pricing page whose only evidence is the silence", () => {
      const onAPricingPage = {
        ...A_REMOVAL_READ_FROM_A_HOMEPAGE,
        source_url: "https://integrately.com/pricing",
      };
      const verdict = auditRecord(onAPricingPage);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_NO_REMOVAL_EVIDENCE);
    });

    it("refuses a removal whose own summary reports the page still offering one", () => {
      const verdict = auditRecord(THE_SUMMARY_REPORTS_A_FREE_TIER_IT_CALLS_REMOVED);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_FREE_TIER_STILL_OFFERED);
    });

    it("does not read a free trial as a free tier still on offer", () => {
      assert.strictEqual(reportsSomethingStillFree("The page now highlights a 14-day free trial"), false);
      assert.strictEqual(reportsSomethingStillFree("The page highlights 'Start free'"), true);
    });

    it("reads the call to action for a trial as the trial and not as a free tier", () => {
      assert.strictEqual(
        reportsSomethingStillFree("The only call to action is 'Start free trial'"),
        false,
        "the words start and free either side of trial were read as an offer of a free tier"
      );
      assert.strictEqual(reportsSomethingStillFree("The only call to action is 'Start free'"), true);
    });

    it("keeps a removal that states what stands where the free tier was", () => {
      assert.strictEqual(statesARemoval(A_REMOVAL_THAT_SAYS_WHAT_REPLACED_IT.summary), true);
      assert.strictEqual(auditRecord(A_REMOVAL_THAT_SAYS_WHAT_REPLACED_IT).outcome, OUTCOME_UNCHANGED);
    });

    it("refuses a removal whose only price sat in a clause the rewrite drops", () => {
      const theEvidenceIsHedged = {
        vendor: "DatoCMS",
        change_type: FREE_TIER_REMOVED,
        summary:
          "The free tier is no longer explicitly mentioned. The page states that agency partners get a 30% discount starting from €39/month, implying a paid model. It also mentions 5M API calls and 2TB traffic monthly, which suggests limits beyond a basic free tier.",
        previous_state: "Offers free tier for small projects. On the lower tier, 100k/month calls.",
        current_state: "Agency partners get a 30% discount starting from €39/month.",
        impact: "high",
        source_url: "https://www.datocms.com/",
      };
      const verdict = auditRecord(theEvidenceIsHedged);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(
        verdict.reason,
        REJECT_REMOVAL_READ_FROM_ROOT,
        "the price that made this a removal was dropped as a hedge and the record was published without it"
      );
    });

    it("keeps a removal read from a homepage that states a price in its place", () => {
      const priced = {
        ...A_REMOVAL_READ_FROM_A_HOMEPAGE,
        summary:
          "The free tier is no longer explicitly mentioned. The page now lists paid plans starting at $4.99/mo.",
      };
      assert.notStrictEqual(auditRecord(priced).outcome, OUTCOME_REFUSED);
    });
  });

  describe("a product that moved to another company", () => {
    it("reads a redirect onto a different registrable domain", () => {
      assert.strictEqual(
        redirectedOffDomain("https://www.highlight.io/pricing", "https://launchdarkly.com/"),
        true
      );
      assert.strictEqual(
        redirectedOffDomain("https://highlight.io/pricing", "https://www.highlight.io/plans"),
        false
      );
    });

    it("refuses a removal whose only evidence is silence when nothing redirected", () => {
      const verdict = auditRecord(A_REMOVAL_WHOSE_PRODUCT_MOVED_TO_ANOTHER_COMPANY);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
    });

    it("reads a clause that reports where a page moved to", () => {
      assert.strictEqual(statesARedirect("Highlight.io's own page now redirects to launchdarkly.com."), true);
      assert.strictEqual(statesARedirect("The free plan now offers 500 submissions per month."), false);
    });

    it("refuses a removal whose only surviving evidence is that the page moved", () => {
      const verdict = auditRecord(A_REMOVAL_WHOSE_PRODUCT_MOVED_TO_ANOTHER_COMPANY, {
        finalUrl: "https://launchdarkly.com/",
      });
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_REMOVAL_READ_FROM_REDIRECT);
    });

    it("refuses it again when re-read from the summary the redirect already produced", () => {
      const asPublished = {
        ...A_REMOVAL_WHOSE_PRODUCT_MOVED_TO_ANOTHER_COMPANY,
        summary: "Highlight.io's own page now redirects to launchdarkly.com.",
      };
      const verdict = auditRecord(asPublished, { finalUrl: "https://launchdarkly.com/" });
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_REMOVAL_READ_FROM_REDIRECT);
    });

    it("refuses a removal read from a root that redirects, which no gate below the redirect could reach", () => {
      const verdict = auditRecord(A_REMOVAL_SOURCED_FROM_NOTHING_BUT_A_REDIRECT, {
        finalUrl: "https://www.respan.ai",
      });
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_REMOVAL_READ_FROM_ROOT);
    });

    it("refuses the same record at the gate", () => {
      const verdict = describesChange(A_REMOVAL_SOURCED_FROM_NOTHING_BUT_A_REDIRECT, {
        finalUrl: "https://www.respan.ai",
      });
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, REJECT_REMOVAL_READ_FROM_ROOT);
    });

    it("keeps a measured change that survives alongside the redirect, and states both", () => {
      const verdict = auditRecord(A_MEASURED_CHANGE_READ_AFTER_A_REDIRECT, {
        finalUrl: "https://www.staticforms.dev/",
      });
      assert.strictEqual(verdict.outcome, OUTCOME_REWRITTEN);
      assert.strictEqual(
        verdict.summary,
        "staticforms.xyz's own page now redirects to staticforms.dev. The free plan now offers 500 submissions per month instead of 250."
      );
    });

    it("states the redirect once when the summary it audits already carries it", () => {
      const asPublished = applyAudit(
        A_MEASURED_CHANGE_READ_AFTER_A_REDIRECT,
        auditRecord(A_MEASURED_CHANGE_READ_AFTER_A_REDIRECT, {
          finalUrl: "https://www.staticforms.dev/",
        })
      );
      const verdict = auditRecord(asPublished, { finalUrl: "https://www.staticforms.dev/" });
      assert.strictEqual(verdict.outcome, OUTCOME_UNCHANGED);
      assert.strictEqual(applyAudit(asPublished, verdict).summary, asPublished.summary);
    });

    it("keeps a removal whose one surviving clause states the removal as well as the redirect", () => {
      const statesWhereItWentAndWhatIsLeft = {
        ...A_REMOVAL_WHOSE_PRODUCT_MOVED_TO_ANOTHER_COMPANY,
        summary: "The pricing page now redirects to a subscription-only replacement",
      };
      const verdict = auditRecord(statesWhereItWentAndWhatIsLeft);
      assert.notStrictEqual(verdict.outcome, OUTCOME_REFUSED);
    });

    it("keeps a removal that names what the destination charges beside the redirect", () => {
      const namesThePriceItLandedOn = {
        ...A_REMOVAL_WHOSE_PRODUCT_MOVED_TO_ANOTHER_COMPANY,
        summary:
          "Highlight.io's own page now redirects to launchdarkly.com. The entry plan is $89 per month.",
      };
      const verdict = auditRecord(namesThePriceItLandedOn, {
        finalUrl: "https://launchdarkly.com/",
      });
      assert.notStrictEqual(verdict.outcome, OUTCOME_REFUSED);
    });

    it("still refuses a removal for its own change type when the page redirects", () => {
      const stillOffered = {
        ...A_REMOVAL_SOURCED_FROM_NOTHING_BUT_A_REDIRECT,
        source_url: "https://keywordsai.co/pricing",
        summary: "Sign up for free with 100k logs. The page no longer names the old allowance.",
      };
      const verdict = auditRecord(stillOffered, { finalUrl: "https://www.respan.ai" });
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_FREE_TIER_STILL_OFFERED);
    });
  });

  describe("a summary states the vendor's terms, not our record", () => {
    it("keeps the true clause of a real change wearing the wrong subject", () => {
      const verdict = auditRecord(A_REAL_REDUCTION_WEARING_OUR_SUBJECT);
      assert.strictEqual(verdict.outcome, OUTCOME_REWRITTEN);
      assert.strictEqual(
        verdict.summary,
        "The free tier now allows only 1 project and a maximum of 5 users. Previously 3 projects and 20 users."
      );
      assert.doesNotMatch(verdict.summary, /stored information/);
    });

    it("drops a false absence standing beside two real moves", () => {
      const verdict = auditRecord(A_FALSE_ABSENCE_BESIDE_TWO_REAL_MOVES);
      assert.strictEqual(verdict.outcome, OUTCOME_REWRITTEN);
      assert.strictEqual(
        verdict.summary,
        "The free tier now offers unlimited projects instead of 3. The number of secret syncs is now 10 instead of 100+."
      );
    });

    it("carries the rewrite onto the record", () => {
      const verdict = auditRecord(A_REAL_REDUCTION_WEARING_OUR_SUBJECT);
      const rewritten = applyAudit(A_REAL_REDUCTION_WEARING_OUR_SUBJECT, verdict);
      assert.strictEqual(rewritten.summary, verdict.summary);
      assert.strictEqual(rewritten.vendor, "Basecamp");
      assert.strictEqual(
        A_REAL_REDUCTION_WEARING_OUR_SUBJECT.summary.includes("stored information"),
        true,
        "the record the rewrite was built from was altered in place"
      );
    });

    it("restates a leading baseline in place and opens the next sentence at its own clause", () => {
      const theTrueClauseTrails = {
        ...A_REAL_REDUCTION_WEARING_OUR_SUBJECT,
        summary:
          "The stored information stated 3 projects and 20 users, but the free tier now allows only 1 project.",
      };
      const verdict = auditRecord(theTrueClauseTrails);
      assert.strictEqual(verdict.outcome, OUTCOME_REWRITTEN);
      assert.strictEqual(
        verdict.summary,
        "Previously 3 projects and 20 users. The free tier now allows only 1 project."
      );
    });

    it("leaves a summary that already states the vendor's terms alone", () => {
      const verdict = auditRecord(A_REMOVAL_THAT_SAYS_WHAT_REPLACED_IT);
      assert.strictEqual(verdict.outcome, OUTCOME_UNCHANGED);
      assert.strictEqual(verdict.summary, null);
    });
  });

  describe("the figure the change was measured against", () => {
    it("strips our record from in front of the figure it introduces", () => {
      assert.strictEqual(
        withoutStoredReference("whereas the stored information stated 3 projects and 20 users"),
        "whereas previously 3 projects and 20 users"
      );
      assert.strictEqual(
        withoutStoredReference("a significant increase from the previously stated 20,000 sessions"),
        "a significant increase from 20,000 sessions"
      );
    });

    it("keeps an increase measured against a figure in the same clause", () => {
      const verdict = auditRecord(AN_INCREASE_WHOSE_BASELINE_HANGS_OFF_IT);
      assert.strictEqual(verdict.outcome, OUTCOME_REWRITTEN);
      assert.match(verdict.summary, /200k sessions per month, a significant increase from 20,000/);
    });

    it("keeps a trailing baseline when nothing left standing measures the reduction", () => {
      const verdict = auditRecord(A_REDUCTION_WHOSE_BASELINE_TRAILS);
      assert.strictEqual(verdict.outcome, OUTCOME_REWRITTEN);
      assert.match(verdict.summary, /Previously 300 credits\/month and 90-minute build timeout/);
    });

    it("keeps a trailing baseline even where the surviving clause states the new figure", () => {
      const verdict = auditRecord(A_REAL_REDUCTION_WEARING_OUR_SUBJECT);
      assert.strictEqual(
        verdict.summary,
        "The free tier now allows only 1 project and a maximum of 5 users. Previously 3 projects and 20 users."
      );
    });

    it("restates the figure rather than the clause that introduced it", () => {
      const theClauseTrailsOffIntoOurReading = {
        ...A_REDUCTION_WHOSE_BASELINE_TRAILS,
        summary:
          "The free tier now offers 5GB of storage. The original deal also mentioned a 1GB upload limit which is not present on the current pricing page.",
      };
      const verdict = auditRecord(theClauseTrailsOffIntoOurReading);
      assert.strictEqual(
        verdict.summary,
        "The free tier now offers 5GB of storage. Previously a 1GB upload limit."
      );
    });

    it("cuts the restated figure loose from the predicate that follows it", () => {
      assert.strictEqual(
        trimmedToItsFigures(
          "previously 100 GB/month data, 1,000 RUM sessions/month, and 14-day data retention are no longer offered as a permanent free tier."
        ),
        "previously 100 GB/month data, 1,000 RUM sessions/month, and 14-day data retention."
      );
      assert.strictEqual(
        trimmedToItsFigures("previously 300 credits/month and 90-minute build timeout."),
        "previously 300 credits/month and 90-minute build timeout."
      );
    });

    it("does not restate a figure a surviving clause already carries on the same attribute", () => {
      assert.strictEqual(
        statesTheSameFigure("previously 1K client MAU", ["the page states 1K client-side MAU"]),
        true
      );
      assert.strictEqual(
        statesTheSameFigure("previously 3 projects and 20 users", [
          "the free tier now allows only 1 project and a maximum of 5 users",
        ]),
        false,
        "a baseline was read as already stated by figures that differ from it"
      );
      assert.strictEqual(
        statesTheSameFigure("previously 10 of each", ["20 uptime monitors and 10 servers"]),
        false,
        "a baseline naming no attribute was read as already stated"
      );
      assert.strictEqual(
        statesTheSameFigure("previously 3 projects", ["the free tier now includes 3 pages"]),
        false,
        "two figures of equal value on different attributes were read as the same figure"
      );
      assert.strictEqual(
        statesTheSameFigure("previously 1K client MAU and 5K session replays", [
          "the page states 1K client-side MAU",
        ]),
        false,
        "a baseline was read as already stated when only one of its figures was"
      );
    });

    it("leaves the baseline out where a surviving clause already carries the same figure", () => {
      const theBaselineRepeatsWhatStands = {
        ...A_REDUCTION_WHOSE_BASELINE_TRAILS,
        summary:
          "The free tier now offers 1GB storage, 1 gateway, and 10k requests per month. The original deal stated 1GB storage and API access.",
      };
      const verdict = auditRecord(theBaselineRepeatsWhatStands);
      assert.strictEqual(
        verdict.summary,
        "The free tier now offers 1GB storage, 1 gateway, and 10k requests per month."
      );
    });

    it("restates a baseline that names no attribute only where the clause it follows survives", () => {
      const verdict = auditRecord({
        ...A_REAL_REDUCTION_WEARING_OUR_SUBJECT,
        vendor: "SweetUptime",
        change_type: "limits_increased",
        summary:
          "The free tier now offers 20 uptime monitors, 20 domain & SSL checks, and 10 servers, whereas the stored information stated 10 of each.",
        previous_state: "Monitor 10 server, 10 uptime, and 10 domain for free.",
      });
      assert.strictEqual(
        verdict.summary,
        "The free tier now offers 20 uptime monitors, 20 domain & SSL checks, and 10 servers. Previously 10 of each."
      );
      assert.strictEqual(
        auditRecord(A_FALSE_ABSENCE_BESIDE_TWO_REAL_MOVES).summary,
        "The free tier now offers unlimited projects instead of 3. The number of secret syncs is now 10 instead of 100+.",
        "a bare figure was restated behind the absence clause that named what it measured"
      );
    });

    it("refuses rather than restating a clause that carries no earlier figure", () => {
      const nothingToRestore = {
        ...A_REDUCTION_WHOSE_BASELINE_TRAILS,
        summary:
          "The Hobby plan now has a build timeout of 210 minutes. The stored information mentioned none of this. The previous stored information stated 300 credits/month.",
      };
      const verdict = auditRecord(nothingToRestore);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_NO_BASELINE);
    });

    it("refuses a summary whose only figure sits in a clause stating no change", () => {
      const noChangeToRestate = {
        ...A_REDUCTION_WHOSE_BASELINE_TRAILS,
        summary: "The stored information stated 300 credits/month and a 90-minute build timeout.",
      };
      const verdict = auditRecord(noChangeToRestate);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_STATES_NO_TERMS);
    });

    it("refuses a reduction whose baseline was only ever a restatement", () => {
      const everyFigureRestatedButOne = {
        ...ONE_WORD_OF_DIFFERENCE_ON_THE_SAME_FIGURE,
        summary: `${ONE_WORD_OF_DIFFERENCE_ON_THE_SAME_FIGURE.summary} The stored information does not mention AgentControl features, while the current pricing page includes 5k AI runs/mo.`,
      };
      const verdict = auditRecord(everyFigureRestatedButOne);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_NO_BASELINE);
    });

    it("keeps a change whose only clause wore our record's subject", () => {
      const oneClauseCarryingBoth = {
        vendor: "Mockplus iDoc",
        change_type: "limits_increased",
        summary:
          "The free plan now includes up to 10 users and active projects, an increase from the previously stated three users and five projects.",
        previous_state: "Free Plan includes three users and five projects.",
        current_state: "Everyone can register for the basic free plan for up to 10 users.",
        impact: "medium",
        source_url: "https://www.mockplus.com/pricing",
      };
      const verdict = auditRecord(oneClauseCarryingBoth);
      assert.strictEqual(verdict.outcome, OUTCOME_REWRITTEN);
      assert.strictEqual(
        verdict.summary,
        "The free plan now includes up to 10 users and active projects, an increase from three users and five projects."
      );
    });

    it("does not restate a baseline onto a record that never claimed a direction", () => {
      const verdict = auditRecord({
        ...A_REDUCTION_WHOSE_BASELINE_TRAILS,
        change_type: "pricing_restructured",
      });
      assert.strictEqual(verdict.outcome, OUTCOME_REWRITTEN);
      assert.doesNotMatch(verdict.summary, /Previously 300 credits/);
    });
  });

  describe("a reduction left describing something else", () => {
    const A_LIMIT_TRADED_FOR_AN_ELIGIBILITY_RULE = {
      vendor: "Stream",
      change_type: "limits_reduced",
      summary:
        "The chat limit is now 2,000 monthly active users and 100 concurrent connections, down from 2,000 MAU with no mention of concurrent connections. The Maker Account now has requirements of 5 or less team members, less than $100k in funding, and less than $10k/mo revenue.",
      previous_state:
        "Chat, Activity Feeds, and Video APIs. Maker Account (free): 2,000 MAU chat, 125K API calls/month feeds, 333K participant-minutes/month video.",
      current_state:
        "Maker Account Details If your company has five or less team members, less than $100k in funding and has taken less than $10k/mo revenue, Stream is free.",
      impact: "medium",
      source_url: "https://getstream.io/pricing/",
    };

    it("refuses a reduction whose surviving sentence measures none of the terms we stored", () => {
      const verdict = auditRecord(A_LIMIT_TRADED_FOR_AN_ELIGIBILITY_RULE);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_NO_BASELINE);
    });

    it("keeps a reduction that still names a term the stored description measured", () => {
      const verdict = auditRecord({
        ...A_LIMIT_TRADED_FOR_AN_ELIGIBILITY_RULE,
        summary:
          "The chat limit is now 500 monthly active users with no mention of concurrent connections. The Maker Account allows 250 MAU chat.",
      });
      assert.notStrictEqual(verdict.outcome, OUTCOME_REFUSED);
    });

    it("keeps a reduction that states a baseline of its own, whatever it is measured on", () => {
      const verdict = auditRecord({
        ...A_LIMIT_TRADED_FOR_AN_ELIGIBILITY_RULE,
        summary:
          "The chat limit is now 2,000 monthly active users and 100 concurrent connections, down from 2,000 MAU with no mention of concurrent connections. The Maker Account now requires 5 or less team members, down from 10.",
      });
      assert.notStrictEqual(verdict.outcome, OUTCOME_REFUSED);
    });

    it("reads a removal by what the summary says, not by the figures we stored", () => {
      const theRemovalNamesNoStoredFigure = {
        vendor: "Burnermail",
        change_type: FREE_TIER_REMOVED,
        summary:
          "The 5 burner addresses are no longer mentioned. Burner Mail is removing its free plan, and paid plans now start at $2.99/month.",
        previous_state: "Free plan with 5 burner addresses and 1 mailbox.",
        current_state: "Plans start at $2.99/month. The free plan is being retired.",
        impact: "high",
        source_url: "https://burnermail.io/pricing",
      };
      const verdict = auditRecord(theRemovalNamesNoStoredFigure);
      assert.strictEqual(verdict.outcome, OUTCOME_REWRITTEN);
      assert.strictEqual(
        verdict.summary,
        "Burner Mail is removing its free plan, and paid plans now start at $2.99/month."
      );
    });

    it("keeps a record whose stored description measured nothing to lose", () => {
      const verdict = auditRecord({
        ...A_LIMIT_TRADED_FOR_AN_ELIGIBILITY_RULE,
        previous_state: "Chat, Activity Feeds, and Video APIs. Maker Account is free for makers.",
      });
      assert.notStrictEqual(verdict.outcome, OUTCOME_REFUSED);
    });

    it("leaves alone a record the gate never took a measured term out of", () => {
      const nothingWasDropped = {
        ...A_LIMIT_TRADED_FOR_AN_ELIGIBILITY_RULE,
        summary:
          "The Maker Account now has requirements of 5 or less team members and less than $100k in funding.",
      };
      const verdict = auditRecord(nothingWasDropped);
      assert.strictEqual(verdict.outcome, OUTCOME_UNCHANGED);
    });

    it("reads the stored description for the terms the claim was measured on", () => {
      const storedTheChatLimit = {
        change_type: "limits_reduced",
        previous_state: "Maker Account (free): 2,000 MAU chat, 125K API calls/month feeds.",
      };
      assert.strictEqual(
        namesTheDimensionThatChanged(storedTheChatLimit, "The chat limit is now 500 MAU."),
        true
      );
      assert.strictEqual(
        namesTheDimensionThatChanged(
          storedTheChatLimit,
          "The Maker Account now requires 5 or less team members."
        ),
        false,
        "a summary naming none of the stored terms was read as naming the change"
      );
      assert.strictEqual(
        namesTheDimensionThatChanged(
          { change_type: "limits_reduced", previous_state: "Free for makers." },
          "The Maker Account now requires 5 or less team members."
        ),
        true,
        "a stored description that measures nothing was read as naming a term the summary lost"
      );
    });
  });

  describe("the sentence that travels alone needs a subject", () => {
    it("refuses a summary left opening on a clause that was dropped", () => {
      const verdict = auditRecord(A_SURVIVOR_THAT_OPENS_ON_WHAT_WAS_DROPPED);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_DANGLING_REFERENCE);
    });

    it("keeps a pronoun the summary opened on before the gate touched it", () => {
      const verdict = auditRecord({
        ...A_SURVIVOR_THAT_OPENS_ON_WHAT_WAS_DROPPED,
        summary: "It now offers 1M events for analytics on a free tier open to everyone.",
      });
      assert.notStrictEqual(verdict.outcome, OUTCOME_REFUSED);
    });

    it("keeps a restored baseline standing in front of the pronoun it explains", () => {
      const verdict = auditRecord(AN_INCREASE_WHOSE_BASELINE_HANGS_OFF_IT);
      assert.strictEqual(verdict.outcome, OUTCOME_REWRITTEN);
      assert.match(verdict.summary, /^The free plan now offers/);
    });
  });

  describe("a figure that measures the marketing rather than the offer", () => {
    it("refuses a record left carrying only a claim about how fast the product is", () => {
      const verdict = auditRecord(A_MARKETING_FIGURE_WEARING_THE_ABSENCE);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_STATES_NO_TERMS);
    });

    it("keeps a duration that is a term of the offer", () => {
      const verdict = auditRecord({
        ...A_MARKETING_FIGURE_WEARING_THE_ABSENCE,
        summary:
          "The page does not state the free tier limits. The free plan advertises a 210 minute build timeout.",
      });
      assert.strictEqual(verdict.outcome, OUTCOME_REWRITTEN);
      assert.match(verdict.summary, /210 minute build timeout/);
    });
  });

  describe("one word of difference on the same figure", () => {
    it("drops the page half of a comparison against our record that restates its figure", () => {
      const evidence = summaryEvidence(ONE_WORD_OF_DIFFERENCE_ON_THE_SAME_FIGURE.summary);
      const restated = evidence.dropped.filter(({ kind }) => kind === CLAUSE_RESTATEMENT);
      assert.strictEqual(restated.length, 2);
      assert.match(restated[0].clause, /1K client-side MAU/);
    });

    it("refuses the record once every figure it carried was a restatement", () => {
      const verdict = auditRecord(ONE_WORD_OF_DIFFERENCE_ON_THE_SAME_FIGURE);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_STATES_NO_DIFFERENCE);
    });

    it("keeps the page half when it states a figure our record did not", () => {
      const evidence = summaryEvidence(
        "The stored information states 1K client MAU, while the current pricing page states 2K client MAU."
      );
      assert.strictEqual(evidence.kept.length, 1);
      assert.match(evidence.kept[0], /2K client MAU/);
    });
  });

  describe("the summary asserts agreement", () => {
    it("refuses a record that states the page agrees and names nothing new", () => {
      const verdict = auditRecord(THE_SUMMARY_STATES_AGREEMENT);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_STATES_NO_DIFFERENCE);
    });

    it("reads agreement stated without naming our record at all", () => {
      const saysTheTierStillExists = {
        vendor: "Cal.com",
        change_type: "limits_increased",
        summary:
          "The free tier still exists. The current pricing page details many features included in the free tier.",
        previous_state: "Open-source scheduling — 1 user",
        current_state: "Individuals Free. 1 user. Unlimited event types & calendars.",
        impact: "medium",
        source_url: "https://cal.com/pricing",
      };
      const verdict = auditRecord(saysTheTierStillExists);
      assert.strictEqual(verdict.outcome, OUTCOME_REFUSED);
      assert.strictEqual(verdict.reason, REJECT_STATES_NO_DIFFERENCE);
    });

    it("keeps an agreeing record whose surviving clauses lift a cap off a limit", () => {
      const nowUnlimited = {
        vendor: "Notion",
        change_type: "limits_increased",
        summary:
          "The free tier still exists. The free tier now includes unlimited file uploads, whereas it was previously limited to 5MB.",
        previous_state: "Free plan — 5MB file uploads, 10 guest collaborators",
        current_state: "Free plan includes unlimited file uploads and unlimited guests.",
        impact: "high",
        source_url: "https://www.notion.com/pricing",
      };
      assert.strictEqual(auditRecord(nowUnlimited).outcome, OUTCOME_REWRITTEN);
      assert.strictEqual(
        auditRecord(nowUnlimited).summary,
        "The free tier still exists. The free tier now includes unlimited file uploads. It was previously limited to 5MB."
      );
    });

    it("keeps a record that agrees on one figure and names another the record never held", () => {
      const alsoNamesANewFigure = {
        ...THE_SUMMARY_STATES_AGREEMENT,
        summary:
          "The pricing is 5% + $0.50 per transaction, which matches the stored information. The payout fee is now $2.50 per withdrawal.",
      };
      assert.notStrictEqual(auditRecord(alsoNamesANewFigure).outcome, OUTCOME_REFUSED);
    });
  });

  describe("the records already written are swept the same way", () => {
    it("moves a refused record out of the log and leaves a rewritten one in it", () => {
      const { kept, refused, rewritten } = sweepRecords([
        THE_PAGE_DID_NOT_MENTION_IT,
        A_REAL_REDUCTION_WEARING_OUR_SUBJECT,
        A_REMOVAL_THAT_SAYS_WHAT_REPLACED_IT,
      ]);
      assert.deepStrictEqual(
        kept.map((record) => record.vendor),
        ["Basecamp", "Segment"]
      );
      assert.deepStrictEqual(
        refused.map(({ candidate }) => candidate.vendor),
        ["Mergify"]
      );
      assert.strictEqual(refused[0].reason, REJECT_STATES_NO_TERMS);
      assert.strictEqual(rewritten.length, 1);
      assert.strictEqual(
        kept[0].summary,
        "The free tier now allows only 1 project and a maximum of 5 users. Previously 3 projects and 20 users."
      );
    });

    it("has nothing left to do on a second pass over what it kept", () => {
      const once = sweepRecords([
        THE_PAGE_DID_NOT_MENTION_IT,
        A_REAL_REDUCTION_WEARING_OUR_SUBJECT,
        A_FALSE_ABSENCE_BESIDE_TWO_REAL_MOVES,
        ONE_WORD_OF_DIFFERENCE_ON_THE_SAME_FIGURE,
        A_REMOVAL_THAT_SAYS_WHAT_REPLACED_IT,
        A_DEPRECATION_THAT_NAMES_NO_FIGURE,
        AN_INCREASE_WHOSE_BASELINE_HANGS_OFF_IT,
        A_REDUCTION_WHOSE_BASELINE_TRAILS,
        A_MARKETING_FIGURE_WEARING_THE_ABSENCE,
        A_SURVIVOR_THAT_OPENS_ON_WHAT_WAS_DROPPED,
      ]);
      const twice = sweepRecords(once.kept);
      assert.strictEqual(twice.refused.length, 0, "a summary the sweep wrote was refused by the sweep");
      assert.strictEqual(twice.rewritten.length, 0, "a summary the sweep wrote was rewritten again");
    });

    it("leaves the records it was given unaltered", () => {
      const before = JSON.stringify(A_REAL_REDUCTION_WEARING_OUR_SUBJECT);
      sweepRecords([A_REAL_REDUCTION_WEARING_OUR_SUBJECT]);
      assert.strictEqual(JSON.stringify(A_REAL_REDUCTION_WEARING_OUR_SUBJECT), before);
    });
  });
});
