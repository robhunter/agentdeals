import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENTDEALS_REFUSALS_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "refusals-zero-")),
  "change_refusals.json"
);

const {
  describesChange,
  zeroedAllowances,
  gateCandidates,
  GATE_REASONS,
  REJECT_ZERO_ALLOWANCE,
} = await import("../scripts/change-gate.js");

const { buildRefusalEntry } = await import("../scripts/change-refusals.js");

const REPO = path.join(import.meta.dirname, "..");

const RECORDED = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")
).changes as Array<Record<string, any>>;

const THE_BATCH_THAT_WAS_REVIEWED = "2026-09-05";

const A_PLAN_CONFIGURATOR_AT_ITS_ZERO_POSITION = {
  vendor: "Windscribe",
  change_type: "limits_reduced",
  date: THE_BATCH_THAT_WAS_REVIEWED,
  date_source: "discovered",
  summary:
    "The free tier now offers 0 GB/month and requires purchasing additional data via location-based subscriptions (10GB per location at $1/month).",
  previous_state:
    "10 GB/month free data. 11 server locations. Ad/tracker blocker (R.O.B.E.R.T.). Firewall (kill switch). WireGuard, IKEv2, OpenVPN. Browser extension included. Additional 5 GB for tweeting about them.",
  current_state: "0 GB/Month 0 Location(s)",
  impact: "high",
  source_url: "https://windscribe.com/upgrade",
  category: "VPN & Privacy",
};

const A_COUNTER_THAT_NEVER_RESOLVED = {
  vendor: "Proton Pass",
  change_type: "limits_reduced",
  date: THE_BATCH_THAT_WAS_REVIEWED,
  date_source: "discovered",
  summary:
    "The free tier now has limits on vaults (0 vaults) and secure sharing (0 others). The free tier also includes password health alerts and dark web monitoring.",
  previous_state:
    "Unlimited logins, notes, and devices. 10 hide-my-email aliases. Integrated 2FA/TOTP. Passkey support. Vault sharing. End-to-end encrypted. Web, browser extension, mobile, and desktop apps. No credit card storage or unlimited aliases on free.",
  current_state:
    "Proton Free includes unlimited logins, notes and credit cards, unlimited devices, browser, mobile, and desktop apps, password generator, 10 hide-my-email aliases, alerts for weak and reused passwords, passkeys supported on all devices, and easy password import. It also includes 0 vaults and the ability to share with 0 others.",
  impact: "medium",
  source_url: "https://proton.me/pass/pricing",
  category: "Password Managers",
};

const AN_UNRENDERED_TEMPLATE_VARIABLE_BESIDE_A_TRUE_CLAIM = {
  vendor: "MEGA",
  change_type: "pricing_restructured",
  date: THE_BATCH_THAT_WAS_REVIEWED,
  date_source: "discovered",
  summary: "The transfer quota is now 'Limited' instead of 1 GB replenishing.",
  previous_state:
    "20 GB permanent storage. End-to-end encrypted. MEGA Chat. File sharing with encryption. Desktop and mobile sync. 1 GB transfer quota that replenishes. Up to 5 GB additional via achievements (temporary).",
  current_state: "The free plan offers !{freePlanStorage} storage and limited transfer for €0 forever.",
  impact: "high",
  source_url: "https://mega.io/pricing",
  category: "Cloud Storage",
};

const A_FEATURE_THAT_MOVED_BEHIND_THE_PAID_PLAN = {
  vendor: "Phase Two",
  change_type: "limits_reduced",
  date: "2026-04-12",
  date_source: "discovered",
  summary:
    "Free tier significantly reduced: users from 1,000 to 100, SSO connections from 10 to 0 (now requires paid Premium tier)",
  previous_state: "1,000 users, 10 SSO connections",
  current_state: "100 users, 0 SSO connections (SSO requires $749/month Premium)",
  impact: "medium",
  source_url: "https://phasetwo.io/pricing",
  category: "Authentication",
};

const WINDSCRIBE_UPGRADE_PAGE = `Windscribe — Build a Plan
Choose your locations and data. 0 GB/Month 0 Location(s)
? Unlimited Data + R.O.B.E.R.T
Build a plan from $1/month per location, or go Pro for $9/month.
Your old subscription will be cancelled and a partial refund will be applied.`;

describe("a demoting record that grants zero of a resource", () => {
  it("is refused under a reason the refusals file can carry", () => {
    assert.ok(GATE_REASONS.includes(REJECT_ZERO_ALLOWANCE));
  });

  it("refuses the plan configurator read at its zero position, naming the quantity it read", () => {
    const verdict = describesChange(A_PLAN_CONFIGURATOR_AT_ITS_ZERO_POSITION, {});
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, REJECT_ZERO_ALLOWANCE);
    assert.match(verdict.detail, /"0 GB"/);
    assert.match(verdict.detail, /"0 Location"/);
  });

  it("refuses the plan table whose counters had not resolved, naming the quantity it read", () => {
    const verdict = describesChange(A_COUNTER_THAT_NEVER_RESOLVED, {});
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, REJECT_ZERO_ALLOWANCE);
    assert.match(verdict.detail, /"0 vaults"/);
  });

  it("still refuses when the page itself was read and states terms", () => {
    const verdict = describesChange(A_PLAN_CONFIGURATOR_AT_ITS_ZERO_POSITION, {
      pageText: WINDSCRIBE_UPGRADE_PAGE,
      pageComplete: true,
    });
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, REJECT_ZERO_ALLOWANCE);
  });

  it("refuses a withdrawal recorded the same way", () => {
    const withdrawn = {
      ...A_PLAN_CONFIGURATOR_AT_ITS_ZERO_POSITION,
      change_type: "free_tier_removed",
      summary: "Free data is no longer offered — the page now sells data by location only.",
    };
    const verdict = describesChange(withdrawn, {});
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, REJECT_ZERO_ALLOWANCE);
  });

  it("writes the refusal where the next reader can check it without re-running the job", async () => {
    const result = await gateCandidates([A_PLAN_CONFIGURATOR_AT_ITS_ZERO_POSITION]);
    assert.strictEqual(result.accepted.length, 0);
    assert.strictEqual(result.rejected.length, 1);
    const entry = buildRefusalEntry(result.rejected[0], { now: new Date("2026-09-05T14:00:00Z") });
    assert.strictEqual(entry.vendor, "Windscribe");
    assert.strictEqual(entry.reason, REJECT_ZERO_ALLOWANCE);
    assert.strictEqual(entry.current_state, "0 GB/Month 0 Location(s)");
    assert.strictEqual(entry.source_url, "https://windscribe.com/upgrade");
    assert.match(entry.detail, /"0 GB"/);
  });
});

describe("what the zero rule must not refuse", () => {
  it("accepts a quantified claim carried beside an unrendered template variable", () => {
    const verdict = describesChange(AN_UNRENDERED_TEMPLATE_VARIABLE_BESIDE_A_TRUE_CLAIM, {});
    assert.strictEqual(verdict.ok, true, JSON.stringify(verdict));
    assert.deepStrictEqual(
      zeroedAllowances(AN_UNRENDERED_TEMPLATE_VARIABLE_BESIDE_A_TRUE_CLAIM.current_state),
      []
    );
  });

  it("reads a zero price as the point of a free tier rather than an allowance", () => {
    assert.deepStrictEqual(zeroedAllowances("Free forever. $0/month for 5 users."), []);
    assert.deepStrictEqual(zeroedAllowances("The free plan costs €0 and includes 3 projects."), []);
  });

  it("accepts a feature moved behind the paid plan beside an allowance that still stands", () => {
    const verdict = describesChange(A_FEATURE_THAT_MOVED_BEHIND_THE_PAID_PLAN, {});
    assert.strictEqual(verdict.ok, true, JSON.stringify(verdict));
    assert.deepStrictEqual(
      zeroedAllowances(A_FEATURE_THAT_MOVED_BEHIND_THE_PAID_PLAN.current_state),
      []
    );
  });

  it("leaves a clock reading alone", () => {
    assert.deepStrictEqual(
      zeroedAllowances("100,000 reads/day and 1 GB stored. All limits reset daily at 00:00 UTC."),
      []
    );
  });

  it("says nothing about a record that is not demoting", () => {
    const increased = { ...A_PLAN_CONFIGURATOR_AT_ITS_ZERO_POSITION, change_type: "limits_increased" };
    assert.notStrictEqual(describesChange(increased, {}).reason, REJECT_ZERO_ALLOWANCE);
  });
});

describe("the batch this rule was written against", () => {
  const batch = RECORDED.filter((change) => change.date === THE_BATCH_THAT_WAS_REVIEWED);

  it("holds the records the rule was measured over", () => {
    assert.ok(batch.length >= 26, `${batch.length} records dated ${THE_BATCH_THAT_WAS_REVIEWED}`);
  });

  it("refuses the two read from a page that had not rendered and nothing else in the batch", () => {
    const refused = batch
      .filter((change) => describesChange(change, {}).reason === REJECT_ZERO_ALLOWANCE)
      .map((change) => change.vendor)
      .sort();
    assert.deepStrictEqual(refused, ["Proton Pass", "Windscribe"]);
  });

  it("leaves every other verdict in the batch as it found it", () => {
    const refusals: Record<string, string> = {};
    for (const change of batch) {
      const verdict = describesChange(change, {});
      if (!verdict.ok) refusals[change.vendor] = verdict.reason;
    }
    assert.deepStrictEqual(refusals, {
      MEGA: "states_no_terms",
      "Proton Pass": REJECT_ZERO_ALLOWANCE,
      Windscribe: REJECT_ZERO_ALLOWANCE,
    });
    assert.strictEqual(
      batch.filter((change) => describesChange(change, {}).ok).length,
      batch.length - 3
    );
  });
});

describe("the published change log", () => {
  it("carries no standing record this rule would refuse", () => {
    const standing = RECORDED.filter((change) => change.resolution?.state !== "retracted").filter(
      (change) => describesChange(change, {}).reason === REJECT_ZERO_ALLOWANCE
    );
    assert.deepStrictEqual(
      standing.map((change) => `${change.vendor} ${change.date}`),
      []
    );
  });
});
