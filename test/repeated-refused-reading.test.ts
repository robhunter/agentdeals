import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.AGENTDEALS_REFUSALS_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "refusals-repeat-")),
  "change_refusals.json"
);
process.env.AGENTDEALS_CORROBORATION_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "corroboration-repeat-")),
  "change_corroboration.json"
);

const { refusedReadingItRepeats, gateCandidates, REJECT_REPEATS_A_REFUSED_READING } = await import(
  "../scripts/change-gate.js"
);
const { runAiMode } = await import("../scripts/reverify-rolling.js");
const { auditPublishedRecords } = await import("../scripts/gate-report.js");

const FEEDBEAR_PAGE = "https://www.feedbear.com/pricing";

const FEEDBEAR_REFUSED = {
  vendor: "FeedBear",
  change_type: "pricing_restructured",
  reason: "confirmed_unchanged",
  refused_date: "2026-09-19",
  source_url: FEEDBEAR_PAGE,
  current_state:
    "The Startup plan costs $49/month billed monthly or $40/month billed annually. It includes everything in the Lite plan plus 3 team members, unlimited boards, a custom domain, and integrations with Intercom, Slack, Trello, Jira and Zapier.",
};

const FEEDBEAR_READ = {
  vendor: "FeedBear",
  change_type: "pricing_restructured",
  date: "2026-10-03",
  recorded_date: "2026-10-03",
  date_source: "discovered",
  source_url: FEEDBEAR_PAGE,
  previous_state:
    "There is no startup program and no free tier: feedbear.com/early-stage redirects to the pricing page, where Startup is the second of four paid plans at $49/month, described as being for early stage businesses that need more powerful community features. Checked 2026-09-02, entry is a 14-day trial. The former record read that price as a startup discount.",
  current_state:
    "The Startup plan costs $49/month billed monthly or $40/month billed annually. It includes 3 team members, unlimited boards, a custom domain, and integrations with Intercom, Slack, Trello, Jira and Zapier.",
  summary:
    "The Startup plan exists but has different pricing. The current pricing page lists the Startup plan at $49/month (or $40/year).",
  impact: "medium",
  category: "Feedback",
};

const PULUMI_REFUSED = {
  vendor: "Pulumi",
  change_type: "limits_reduced",
  reason: "confirmed_unchanged",
  refused_date: "2026-08-28",
  source_url: "https://www.pulumi.com/pricing/",
  current_state:
    "Individual: $0 forever, 1 user, Unlimited projects, stacks, and environments, Unlimited updates and history, Up to 500 workflow minutes, Pulumi Neo with 5M free tokens/month, Max # of secrets 25, Max # of API calls 10K / month",
};

const PULUMI_READ = {
  vendor: "Pulumi",
  change_type: "limits_reduced",
  date: "2026-09-26",
  recorded_date: "2026-09-26",
  source_url: "https://www.pulumi.com/pricing/",
  previous_state:
    "Individual: \"Free forever for individuals ... Includes: 1 user IaC state management Unlimited projects, stacks, and environments Unlimited updates and history Up to 500 workflow minutes Pulumi Neo with 5M free tokens/month\" (pricing page, capture of 2026-09-13)",
  current_state:
    "Free: \"Includes: 1 user IaC state management Pulumi Deployments Basic Pulumi ESC Unlimited projects, stacks, and environments Unlimited updates and history Up to 500 workflow minutes\"; the feature table marks Pulumi Neo as not included on Free and \"$3/M tokens\" on Essentials, Pro and Enterprise (pricing page, read 2026-09-28)",
  summary:
    "Pulumi dropped Pulumi Neo's 5M free tokens a month from its free plan, which it renamed from Individual to Free, between the Internet Archive's capture of its pricing page on 2026-09-13 and our reading of 2026-09-26.",
};

const SEMATEXT_REFUSED = {
  vendor: "Sematext",
  change_type: "limits_reduced",
  reason: "confirmed_unchanged",
  refused_date: "2026-09-20",
  source_url: "https://sematext.com/pricing",
  current_state: "Basic $0.1/GB Data Received, $0.15/GB Data Stored, Retention 7 days, Daily Volume ? 500 MB/day",
};

const SEMATEXT_READ = {
  vendor: "Sematext",
  change_type: "pricing_restructured",
  date: "2026-10-03",
  recorded_date: "2026-10-03",
  source_url: "https://sematext.com/pricing",
  current_state: "Basic plan is $0.1/GB received and $0.15/GB stored, with a 500 MB/day limit and 7-day retention.",
};

describe("a reading that states what a refused reading of the same page already stated", () => {
  it("refuses FeedBear's 2026-10-03 reading, which states the figures its 2026-09-19 refusal read", () => {
    assert.strictEqual(refusedReadingItRepeats(FEEDBEAR_READ, [FEEDBEAR_REFUSED]), FEEDBEAR_REFUSED);
  });

  it("publishes Pulumi's 2026-09-26 reading, which no longer states the free tokens its 2026-08-28 refusal read", () => {
    assert.strictEqual(refusedReadingItRepeats(PULUMI_READ, [PULUMI_REFUSED]), null);
  });

  it("reads a figure as the same figure whichever word the reader set beside it", () => {
    assert.strictEqual(refusedReadingItRepeats(SEMATEXT_READ, [SEMATEXT_REFUSED]), SEMATEXT_REFUSED);
  });

  it("publishes a reading that no longer states one of the refused reading's figures", () => {
    const dropped = { ...FEEDBEAR_READ, current_state: "The Startup plan costs $49/month billed monthly or $40/month billed annually." };
    assert.strictEqual(refusedReadingItRepeats(dropped, [FEEDBEAR_REFUSED]), null);
  });

  it("publishes a reading that states a figure the refused reading did not", () => {
    const added = { ...FEEDBEAR_READ, current_state: `${FEEDBEAR_READ.current_state} It allows 5 custom domains.` };
    assert.strictEqual(refusedReadingItRepeats(added, [FEEDBEAR_REFUSED]), null);
  });

  it("publishes a reading whose figure moved", () => {
    const moved = { ...FEEDBEAR_READ, current_state: FEEDBEAR_READ.current_state.replace("$40/month", "$39/month") };
    assert.strictEqual(refusedReadingItRepeats(moved, [FEEDBEAR_REFUSED]), null);
  });

  it("publishes a reading in which a price and a count traded values", () => {
    const refused = { ...FEEDBEAR_REFUSED, current_state: "The Team plan costs $5 and includes 10 seats." };
    const read = { ...FEEDBEAR_READ, current_state: "The Team plan costs $10 and includes 5 seats." };
    assert.strictEqual(refusedReadingItRepeats(read, [refused]), null);
  });

  it("compares only readings of the same page of the same vendor", () => {
    assert.strictEqual(refusedReadingItRepeats({ ...FEEDBEAR_READ, source_url: "https://www.feedbear.com/" }, [FEEDBEAR_REFUSED]), null);
    assert.strictEqual(refusedReadingItRepeats({ ...FEEDBEAR_READ, vendor: "Canny" }, [FEEDBEAR_REFUSED]), null);
    assert.strictEqual(refusedReadingItRepeats({ ...FEEDBEAR_READ, vendor: "feedbear" }, [FEEDBEAR_REFUSED]), FEEDBEAR_REFUSED);
  });

  it("compares only refusals from before the date the reading gives", () => {
    assert.strictEqual(refusedReadingItRepeats(FEEDBEAR_READ, [{ ...FEEDBEAR_REFUSED, refused_date: "2026-10-03" }]), null);
    assert.strictEqual(refusedReadingItRepeats(FEEDBEAR_READ, [{ ...FEEDBEAR_REFUSED, refused_date: "2026-10-04" }]), null);
    assert.strictEqual(refusedReadingItRepeats({ ...FEEDBEAR_READ, date: "2026-09-10" }, [FEEDBEAR_REFUSED]), null);
  });

  it("compares nothing where either reading states no figure", () => {
    const silent = { ...FEEDBEAR_REFUSED, current_state: "The page describes FeedBear as a feedback board and states no plan or price." };
    assert.strictEqual(refusedReadingItRepeats({ ...FEEDBEAR_READ, current_state: silent.current_state }, [silent]), null);
    assert.strictEqual(refusedReadingItRepeats(FEEDBEAR_READ, [silent]), null);
  });

  it("names the latest refusal the reading repeats", () => {
    const earlier = { ...FEEDBEAR_REFUSED, refused_date: "2026-09-02", reason: "measures_no_change" };
    assert.strictEqual(refusedReadingItRepeats(FEEDBEAR_READ, [FEEDBEAR_REFUSED, earlier]), FEEDBEAR_REFUSED);
    assert.strictEqual(refusedReadingItRepeats(FEEDBEAR_READ, [earlier, FEEDBEAR_REFUSED]), FEEDBEAR_REFUSED);
  });

  it("finds the repeat in a reading typed as a correction to our own record, which would publish the refused figures as the terms our listing missed", () => {
    assert.strictEqual(refusedReadingItRepeats({ ...FEEDBEAR_READ, change_type: "record_corrected" }, [FEEDBEAR_REFUSED]), FEEDBEAR_REFUSED);
  });

  it("leaves a published correction to our own record alone in an audit of published records, since it already says the vendor did not change", () => {
    const audit = { auditingPublishedRecords: true };
    assert.strictEqual(refusedReadingItRepeats({ ...FEEDBEAR_READ, change_type: "record_corrected" }, [FEEDBEAR_REFUSED], audit), null);
    assert.strictEqual(refusedReadingItRepeats(FEEDBEAR_READ, [FEEDBEAR_REFUSED], audit), FEEDBEAR_REFUSED);
  });
});

describe("the gate refuses the repeat and names the refusal it repeats", () => {
  it("refuses FeedBear's reading under its own reason, naming 2026-09-19", async () => {
    const { accepted, rejected } = await gateCandidates([FEEDBEAR_READ], { refusals: [FEEDBEAR_REFUSED] });
    assert.deepStrictEqual(accepted, []);
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].reason, REJECT_REPEATS_A_REFUSED_READING);
    assert.match(rejected[0].detail, /refused on 2026-09-19 \(confirmed_unchanged\)/);
  });

  it("asks no second opinion about a reading it refused as a repeat", async () => {
    let asked = 0;
    await gateCandidates([FEEDBEAR_READ], {
      refusals: [FEEDBEAR_REFUSED],
      confirmFn: async () => {
        asked++;
        return { verdict: "yes", reason: null };
      },
    });
    assert.strictEqual(asked, 0);
  });

  it("does not refuse Pulumi's reading as a repeat", async () => {
    const { rejected } = await gateCandidates([PULUMI_READ], { refusals: [PULUMI_REFUSED] });
    assert.deepStrictEqual(
      rejected.filter((r: { reason: string }) => r.reason === REJECT_REPEATS_A_REFUSED_READING),
      [],
    );
  });

  it("still refuses a repeat that it would otherwise have retyped as a correction to our own record", async () => {
    const retypable = {
      ...FEEDBEAR_READ,
      change_type: "restriction",
      summary: "Our entry stated the Startup plan's price incorrectly.",
    };
    const unrefused = await gateCandidates([retypable], {});
    assert.deepStrictEqual(unrefused.reclassified.map((r: { to: string }) => r.to), ["record_corrected"]);
    const { accepted, rejected } = await gateCandidates([retypable], { refusals: [FEEDBEAR_REFUSED] });
    assert.deepStrictEqual(accepted, []);
    assert.deepStrictEqual(rejected.map((r: { reason: string }) => r.reason), [REJECT_REPEATS_A_REFUSED_READING]);
  });

  it("refuses a reading typed as a correction to our own record that repeats a refused reading", async () => {
    const { accepted, rejected } = await gateCandidates([{ ...FEEDBEAR_READ, change_type: "record_corrected" }], { refusals: [FEEDBEAR_REFUSED] });
    assert.deepStrictEqual(accepted, []);
    assert.deepStrictEqual(rejected.map((r: { reason: string }) => r.reason), [REJECT_REPEATS_A_REFUSED_READING]);
  });

  it("refuses no repeat when it is handed no refusals", async () => {
    const { rejected } = await gateCandidates([FEEDBEAR_READ], {});
    assert.deepStrictEqual(
      rejected.filter((r: { reason: string }) => r.reason === REJECT_REPEATS_A_REFUSED_READING),
      [],
    );
  });
});

describe("an audit of published records", () => {
  it("does not flag a published correction to our own record as a repeat", async () => {
    const { rejected } = await auditPublishedRecords([{ ...FEEDBEAR_READ, change_type: "record_corrected" }], { refusals: [FEEDBEAR_REFUSED] });
    assert.deepStrictEqual(
      rejected.filter((r: { reason: string }) => r.reason === REJECT_REPEATS_A_REFUSED_READING),
      [],
    );
  });

  it("flags a published record that repeats a refused reading", async () => {
    const { rejected } = await auditPublishedRecords([FEEDBEAR_READ], { refusals: [FEEDBEAR_REFUSED] });
    assert.deepStrictEqual(rejected.map((r: { reason: string }) => r.reason), [REJECT_REPEATS_A_REFUSED_READING]);
  });

  it("is what the gate report runs over the change log", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "repeat-report-"));
    const published = { ...FEEDBEAR_READ, detected_by: "reverify-ai" };
    writeFileSync(path.join(dir, "changes.json"), JSON.stringify({ changes: [published, { ...published, change_type: "record_corrected" }] }));
    writeFileSync(path.join(dir, "refusals.json"), JSON.stringify({ refusals: [FEEDBEAR_REFUSED] }));
    writeFileSync(path.join(dir, "index.json"), JSON.stringify({ offers: [] }));
    try {
      const report = execFileSync(process.execPath, ["scripts/gate-report.js"], {
        env: {
          ...process.env,
          AGENTDEALS_CHANGES_PATH: path.join(dir, "changes.json"),
          AGENTDEALS_REFUSALS_PATH: path.join(dir, "refusals.json"),
          AGENTDEALS_INDEX_PATH: path.join(dir, "index.json"),
        },
        encoding: "utf-8",
      });
      const verdictOn = (changeType: string) => report.split("\n").find((line) => line.includes(`FeedBear (${changeType})`));
      assert.match(verdictOn("pricing_restructured") ?? "", new RegExp(`^DROP  FeedBear \\(pricing_restructured\\) — ${REJECT_REPEATS_A_REFUSED_READING}`));
      assert.ok(verdictOn("record_corrected"));
      assert.doesNotMatch(verdictOn("record_corrected") ?? "", new RegExp(REJECT_REPEATS_A_REFUSED_READING));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function readFeedBearOnceAs(changeType: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "repeat-run-"));
  const changesPath = path.join(dir, "deal_changes.json");
  const refusalsPath = path.join(dir, "change_refusals.json");
  writeFileSync(changesPath, JSON.stringify({ changes: [] }, null, 2) + "\n");
  writeFileSync(refusalsPath, JSON.stringify({ refusals: [{ ...FEEDBEAR_REFUSED, detail: null, summary: null, previous_state: null, category: "Feedback" }] }, null, 2) + "\n");
  const offer = {
    vendor: "FeedBear",
    category: "Feedback",
    tier: "Startup",
    description: FEEDBEAR_READ.previous_state,
    url: FEEDBEAR_PAGE,
    verifiedDate: "2026-09-02",
  };
  try {
    const result = await runAiMode([{ index: 0, offer }], { offers: [{ ...offer }] }, false, new Date("2026-10-03T09:00:00Z"), {
      fetchFn: async () => ({ ok: true, text: `FeedBear pricing — ${FEEDBEAR_READ.current_state}` }),
      verifyFn: async () => ({
        status: "changed",
        summary: FEEDBEAR_READ.summary,
        change_type: changeType,
        current_state: FEEDBEAR_READ.current_state,
        impact: "medium",
      }),
      rateLimitMs: 0,
      changesPath,
      refusalsPath,
    });
    const stored = JSON.parse(readFileSync(refusalsPath, "utf-8")).refusals;
    return { result, stored };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the rolling re-read hands the gate the refusals it holds", () => {
  it("refuses a reading that repeats a refusal in its store, and stores that refusal too", async () => {
    const { result, stored } = await readFeedBearOnceAs(FEEDBEAR_READ.change_type);
    assert.strictEqual(result.recorded.length, 0);
    assert.deepStrictEqual(result.rejected.map((r: { reason: string }) => r.reason), [REJECT_REPEATS_A_REFUSED_READING]);
    const repeat = stored.find((r: { refused_date: string }) => r.refused_date === "2026-10-03");
    assert.ok(repeat, "the run stored no refusal for the repeated reading");
    assert.strictEqual(repeat.reason, REJECT_REPEATS_A_REFUSED_READING);
    assert.match(repeat.detail, /2026-09-19/);
  });

  it("refuses a reading it typed as a correction to our own record when that reading repeats a refusal in its store", async () => {
    const { result, stored } = await readFeedBearOnceAs("record_corrected");
    assert.strictEqual(result.recorded.length, 0);
    assert.deepStrictEqual(result.rejected.map((r: { reason: string }) => r.reason), [REJECT_REPEATS_A_REFUSED_READING]);
    assert.ok(stored.some((r: { refused_date: string; reason: string }) => r.refused_date === "2026-10-03" && r.reason === REJECT_REPEATS_A_REFUSED_READING));
  });
});
