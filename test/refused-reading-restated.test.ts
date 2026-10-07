import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AGENTDEALS_REFUSALS_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "refusals-restated-")),
  "change_refusals.json"
);
process.env.AGENTDEALS_CORROBORATION_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "corroboration-restated-")),
  "change_corroboration.json"
);

const {
  refusedReadingItRepeats,
  refusedReadingItRestates,
  gateCandidates,
  SAME_CURRENT_STATE,
  SAME_CLAIM,
  REJECT_REPEATS_A_REFUSED_READING,
  REJECT_REPEATS_A_REFUSED_CLAIM,
} = await import("../scripts/change-gate.js");
const { runAiMode, summaryLines } = await import("../scripts/reverify-rolling.js");
const { proposalsBeside, readProposals } = await import("../scripts/change-proposals.js");
const { auditPublishedRecords } = await import("../scripts/gate-report.js");
const { refusedReadRegister, WHAT_A_VOIDED_READ_FOUND } = await import("../dist/change-refusal.js");

const AIVEN_REFUSED = {
  vendor: "Aiven",
  change_type: "limits_reduced",
  reason: "measures_no_change",
  refused_date: "2026-08-29",
  source_url: "https://aiven.io/pricing",
  previous_state:
    "Managed PostgreSQL, MySQL, or Valkey (Redis-compatible) — 1 CPU, 1 GB RAM, 1 GB disk per service. No time limit",
  current_state:
    "Free $0 / month Get building 1 dedicated VM 1 CPU per VM 1 GB RAM per VM 1 GB total storage Cannot select a specific cloud or region No integrations or connection pooling",
};

const AIVEN_READ = {
  vendor: "Aiven",
  change_type: "limits_reduced",
  date: "2026-10-06",
  recorded_date: "2026-10-06",
  date_source: "discovered",
  source_url: "https://aiven.io/pricing",
  previous_state: AIVEN_REFUSED.previous_state,
  current_state:
    "1 dedicated VM, 1 CPU per VM, 1 GB RAM per VM, 1 GB total storage. Cannot select a specific cloud or region. No integrations or connection pooling.",
  summary:
    "The free tier now has a limit of 1 dedicated VM, 1 CPU per VM, 1 GB RAM per VM, and 1 GB total storage.",
  impact: "medium",
  category: "Databases",
};

const GOFILE_REFUSED = {
  vendor: "GoFile.io",
  change_type: "limits_reduced",
  reason: "confirmed_unchanged",
  refused_date: "2026-09-14",
  source_url: "https://gofile.io/",
  previous_state:
    "Free file sharing and storage platform can be used via web-based UI & also API. unlimited file size, bandwidth, download count, etc. But it will be deleted when a file becomes inactive (no download for more than ten days).",
  current_state:
    "Gofile is free to use — upload and share files instantly, no account required. Files are kept temporarily, perfect for quick shares.",
};

const GOFILE_READ = {
  vendor: "GoFile.io",
  change_type: "limits_reduced",
  date: "2026-10-06",
  recorded_date: "2026-10-06",
  date_source: "discovered",
  source_url: "https://gofile.io/",
  previous_state: GOFILE_REFUSED.previous_state,
  current_state: GOFILE_REFUSED.current_state,
  summary:
    "The free tier is now described as temporary storage, with files kept 'temporarily, perfect for quick shares'. Previously 'unlimited' storage with a 10-day inactivity deletion policy.",
  impact: "medium",
  category: "Storage",
};

const CALCOM_REFUSED = {
  vendor: "Cal.com",
  change_type: "limits_increased",
  reason: "states_no_difference",
  refused_date: "2026-08-29",
  source_url: "https://cal.com/pricing",
  current_state:
    "Individuals Free Everything you could need for scheduling as an individual. Use for free *Free forever Free features: 1 user Unlimited event types & calendars Email & SMS notifications Integrate with 100+ apps Mobile App Browser Extension Accept Stripe & PayPal payments Two-way Salesforce & HubSpot sync 1-click import Calendly events",
};

const CALCOM_PUBLISHED = {
  vendor: "Cal.com",
  change_type: "limits_reduced",
  date: "2026-04-13",
  recorded_date: "2026-09-13",
  source_url: "https://cal.com/pricing",
  previous_state:
    "Open-source scheduling — unlimited event types, unlimited bookings, unlimited calendar connections, routing forms, workflow automation, payment processing, Cal Video conferencing. 1 user",
  current_state: CALCOM_REFUSED.current_state,
};

const repeatsOf = (rejected: Array<{ reason: string }>) =>
  rejected.filter((r) => r.reason === REJECT_REPEATS_A_REFUSED_READING || r.reason === REJECT_REPEATS_A_REFUSED_CLAIM);

describe("the two readings of 2026-10-06 that the figure rule let through", () => {
  it("lets both through on figures alone", () => {
    assert.strictEqual(refusedReadingItRepeats(AIVEN_READ, [AIVEN_REFUSED]), null);
    assert.strictEqual(refusedReadingItRepeats(GOFILE_READ, [GOFILE_REFUSED]), null);
  });

  it("sends Aiven's reading to review as the change refused on 2026-08-29, claimed again against the same stored description", async () => {
    const { accepted, rejected } = await gateCandidates([AIVEN_READ], { refusals: [AIVEN_REFUSED] });
    assert.deepStrictEqual(accepted, []);
    assert.deepStrictEqual(rejected.map((r: { reason: string }) => r.reason), [REJECT_REPEATS_A_REFUSED_CLAIM]);
    assert.match(rejected[0].detail, /refused on 2026-08-29 \(measures_no_change\) claimed the same change, limits_reduced, against the same stored description/);
  });

  it("sends GoFile.io's reading to review as the reading refused on 2026-09-14, stated again word for word", async () => {
    const { accepted, rejected } = await gateCandidates([GOFILE_READ], { refusals: [GOFILE_REFUSED] });
    assert.deepStrictEqual(accepted, []);
    assert.deepStrictEqual(rejected.map((r: { reason: string }) => r.reason), [REJECT_REPEATS_A_REFUSED_READING]);
    assert.match(rejected[0].detail, /refused on 2026-09-14 \(confirmed_unchanged\) stated the same current state, word for word/);
  });

  it("asks no second opinion about either", async () => {
    let asked = 0;
    await gateCandidates([AIVEN_READ, GOFILE_READ], {
      refusals: [AIVEN_REFUSED, GOFILE_REFUSED],
      confirmFn: async () => {
        asked++;
        return { verdict: "yes", reason: null };
      },
    });
    assert.strictEqual(asked, 0);
  });
});

describe("a reading that claims a refused change again with different figures", () => {
  const readsOtherFigures = { ...AIVEN_READ, current_state: "1 dedicated VM, 1 CPU per VM, 512 MB RAM per VM, 1 GB total storage." };

  it("goes to review rather than publishing, since the vendor may have changed after the refusal", async () => {
    const { accepted, rejected } = await gateCandidates([readsOtherFigures], { refusals: [AIVEN_REFUSED] });
    assert.deepStrictEqual(accepted, []);
    assert.deepStrictEqual(rejected.map((r: { reason: string }) => r.reason), [REJECT_REPEATS_A_REFUSED_CLAIM]);
    assert.match(rejected[0].detail, /refused on 2026-08-29 \(measures_no_change\)/);
    assert.match(rejected[0].detail, /the two readings state different figures, so the vendor may have changed since$/);
  });

  it("says nothing about different figures when the figures are the same", async () => {
    const sameFigures = { ...AIVEN_REFUSED, current_state: `${AIVEN_READ.current_state} Sign up today.` };
    const { rejected } = await gateCandidates([AIVEN_READ], { refusals: [{ ...sameFigures, source_url: "https://aiven.io/free-tier" }] });
    assert.deepStrictEqual(rejected.map((r: { reason: string }) => r.reason), [REJECT_REPEATS_A_REFUSED_CLAIM]);
    assert.match(rejected[0].detail, /against the same stored description$/);
  });

  it("is never described on a vendor page as having found the same terms", () => {
    assert.strictEqual(refusedReadRegister({ reason: REJECT_REPEATS_A_REFUSED_CLAIM }), "could_not_reconcile_the_change");
    assert.strictEqual(refusedReadRegister({ reason: REJECT_REPEATS_A_REFUSED_READING }), "had_no_standing_to_contradict");
    assert.match(WHAT_A_VOIDED_READ_FOUND[REJECT_REPEATS_A_REFUSED_READING], /the same terms/);
  });
});

describe("what counts as repeating a refused reading", () => {
  it("reads the current state with whitespace and case set aside", () => {
    const shouted = { ...GOFILE_READ, current_state: `  ${GOFILE_READ.current_state.toUpperCase().replace(/ /g, " \n\t ")}  ` };
    assert.deepStrictEqual(refusedReadingItRestates(shouted, [GOFILE_REFUSED]), { refusal: GOFILE_REFUSED, repeats: SAME_CURRENT_STATE });
  });

  it("reads the stored description with whitespace and case set aside", () => {
    const respaced = { ...AIVEN_READ, previous_state: AIVEN_READ.previous_state.toLowerCase().replace(/ /g, "  ") };
    assert.deepStrictEqual(refusedReadingItRestates(respaced, [AIVEN_REFUSED]), { refusal: AIVEN_REFUSED, repeats: SAME_CLAIM });
  });

  it("needs the same change type for the same stored description", () => {
    assert.strictEqual(refusedReadingItRestates({ ...AIVEN_READ, change_type: "pricing_restructured" }, [AIVEN_REFUSED]), null);
  });

  it("needs the same stored description for the same change type", () => {
    assert.strictEqual(refusedReadingItRestates({ ...AIVEN_READ, previous_state: "Managed PostgreSQL — 1 CPU, 2 GB RAM, 5 GB disk." }, [AIVEN_REFUSED]), null);
  });

  it("finds a word-for-word repeat whatever change type either reading claimed", () => {
    assert.deepStrictEqual(refusedReadingItRestates({ ...GOFILE_READ, change_type: "free_tier_removed" }, [GOFILE_REFUSED]), { refusal: GOFILE_REFUSED, repeats: SAME_CURRENT_STATE });
  });

  it("finds a word-for-word repeat against whatever stored description either reading had", () => {
    assert.deepStrictEqual(refusedReadingItRestates({ ...GOFILE_READ, previous_state: "Free file sharing." }, [GOFILE_REFUSED]), { refusal: GOFILE_REFUSED, repeats: SAME_CURRENT_STATE });
  });

  it("compares nothing that is empty", () => {
    const blank = { ...GOFILE_REFUSED, current_state: " ", previous_state: null };
    assert.strictEqual(refusedReadingItRestates({ ...GOFILE_READ, current_state: "", previous_state: undefined }, [blank]), null);
    assert.strictEqual(refusedReadingItRestates({ ...GOFILE_READ, current_state: "\n" }, [{ ...blank, current_state: "" }]), null);
  });

  it("compares only refusals of the same vendor, by name in any case", () => {
    assert.strictEqual(refusedReadingItRestates({ ...GOFILE_READ, vendor: "Gofile" }, [GOFILE_REFUSED]), null);
    assert.deepStrictEqual(refusedReadingItRestates({ ...GOFILE_READ, vendor: "gofile.io" }, [GOFILE_REFUSED])?.refusal, GOFILE_REFUSED);
  });

  it("compares refusals of the same vendor read from another of its pages", () => {
    assert.deepStrictEqual(refusedReadingItRestates({ ...GOFILE_READ, source_url: "https://gofile.io/premium" }, [GOFILE_REFUSED])?.refusal, GOFILE_REFUSED);
  });

  it("compares only refusals from before the day of the reading", () => {
    assert.strictEqual(refusedReadingItRestates(GOFILE_READ, [{ ...GOFILE_REFUSED, refused_date: "2026-10-06" }]), null);
    assert.strictEqual(refusedReadingItRestates(GOFILE_READ, [{ ...GOFILE_REFUSED, refused_date: "2026-10-07" }]), null);
    assert.deepStrictEqual(refusedReadingItRestates(GOFILE_READ, [{ ...GOFILE_REFUSED, refused_date: "2026-10-05" }])?.repeats, SAME_CURRENT_STATE);
  });

  it("takes the day of the reading from when it was recorded, not from the date an archive check gave the change", () => {
    assert.deepStrictEqual(refusedReadingItRestates(CALCOM_PUBLISHED, [CALCOM_REFUSED]), { refusal: CALCOM_REFUSED, repeats: SAME_CURRENT_STATE });
    const { recorded_date: _recorded, ...dated } = CALCOM_PUBLISHED;
    assert.strictEqual(refusedReadingItRestates(dated, [CALCOM_REFUSED]), null);
  });

  it("names the latest refusal the reading repeats", () => {
    const earlier = { ...AIVEN_REFUSED, refused_date: "2026-08-01", reason: "unquantified_limit" };
    const later = { ...AIVEN_REFUSED, refused_date: "2026-09-20", reason: "measures_the_opposite" };
    assert.strictEqual(refusedReadingItRestates(AIVEN_READ, [earlier, later, AIVEN_REFUSED])?.refusal, later);
    assert.strictEqual(refusedReadingItRestates(AIVEN_READ, [later, AIVEN_REFUSED, earlier])?.refusal, later);
  });

  it("names a word-for-word repeat over a later refusal of the same claim", () => {
    const sameClaimLater = { ...AIVEN_REFUSED, refused_date: "2026-09-30", current_state: "Free plan: 2 CPU." };
    const sameText = { ...AIVEN_REFUSED, current_state: AIVEN_READ.current_state, refused_date: "2026-09-01", reason: "confirmed_unchanged" };
    assert.deepStrictEqual(refusedReadingItRestates(AIVEN_READ, [sameClaimLater, sameText]), { refusal: sameText, repeats: SAME_CURRENT_STATE });
  });

  it("leaves the figure rule to name the refusal when it applies", async () => {
    const sameFiguresSamePage = { ...AIVEN_REFUSED, current_state: `${AIVEN_READ.current_state} Sign up today.` };
    const { rejected } = await gateCandidates([AIVEN_READ], { refusals: [sameFiguresSamePage] });
    assert.deepStrictEqual(rejected.map((r: { reason: string }) => r.reason), [REJECT_REPEATS_A_REFUSED_READING]);
    assert.match(rejected[0].detail, /stated the same \d+ figures/);
  });
});

describe("corrections to our own record", () => {
  const correction = { ...GOFILE_READ, change_type: "record_corrected", summary: "Our entry was wrong about how long Gofile keeps files." };

  it("are sent to review at the gate when they repeat a refused reading", async () => {
    const { accepted, rejected } = await gateCandidates([correction], { refusals: [GOFILE_REFUSED] });
    assert.deepStrictEqual(accepted, []);
    assert.deepStrictEqual(rejected.map((r: { reason: string }) => r.reason), [REJECT_REPEATS_A_REFUSED_READING]);
  });

  it("are left alone in an audit of published records, which already say the vendor did not change", async () => {
    const { rejected } = await auditPublishedRecords([correction, GOFILE_READ, AIVEN_READ], { refusals: [GOFILE_REFUSED, AIVEN_REFUSED] });
    assert.deepStrictEqual(
      repeatsOf(rejected).map((r: { candidate: { vendor: string; change_type: string } }) => `${r.candidate.vendor} ${r.candidate.change_type}`),
      ["GoFile.io limits_reduced", "Aiven limits_reduced"],
    );
  });
});

async function readAivenOnce() {
  const dir = mkdtempSync(path.join(tmpdir(), "restated-run-"));
  const changesPath = path.join(dir, "deal_changes.json");
  const refusalsPath = path.join(dir, "change_refusals.json");
  writeFileSync(changesPath, JSON.stringify({ changes: [] }, null, 2) + "\n");
  writeFileSync(refusalsPath, JSON.stringify({ refusals: [{ ...AIVEN_REFUSED, detail: null, summary: null, category: "Databases" }] }, null, 2) + "\n");
  const offer = {
    vendor: "Aiven",
    category: "Databases",
    tier: "Free",
    description: AIVEN_READ.previous_state,
    url: AIVEN_READ.source_url,
    verifiedDate: "2026-08-29",
  };
  try {
    const result = await runAiMode([{ index: 0, offer }], { offers: [{ ...offer }] }, false, new Date("2026-10-06T13:00:00Z"), {
      fetchFn: async () => ({ ok: true, text: `Aiven pricing — Free $0 / month. ${AIVEN_READ.current_state}` }),
      verifyFn: async () => ({
        status: "changed",
        summary: AIVEN_READ.summary,
        change_type: AIVEN_READ.change_type,
        current_state: AIVEN_READ.current_state,
        impact: "medium",
      }),
      rateLimitMs: 0,
      changesPath,
      refusalsPath,
    });
    const stored = JSON.parse(readFileSync(refusalsPath, "utf-8")).refusals;
    const recorded = [
      ...JSON.parse(readFileSync(changesPath, "utf-8")).changes,
      ...readProposals(proposalsBeside(changesPath)).proposals,
    ];
    return { result, stored, recorded };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the rolling re-read", () => {
  it("records nothing for Aiven's reading and stores the refusal, naming the one it repeats, beside it", async () => {
    const { result, stored, recorded } = await readAivenOnce();
    assert.deepStrictEqual(recorded, []);
    assert.deepStrictEqual(result.rejected.map((r: { reason: string }) => r.reason), [REJECT_REPEATS_A_REFUSED_CLAIM]);
    const review = stored.find((r: { refused_date: string }) => r.refused_date === "2026-10-06");
    assert.ok(review, "the run stored no refusal for the repeated claim");
    assert.strictEqual(review.reason, REJECT_REPEATS_A_REFUSED_CLAIM);
    assert.match(review.detail, /refused on 2026-08-29 \(measures_no_change\)/);
    assert.ok(stored.some((r: { refused_date: string }) => r.refused_date === "2026-08-29"), "the refusal it repeats was dropped from the store");
  });

  it("lists the refused vendor under the new reason in its summary", async () => {
    const { result } = await readAivenOnce();
    const lines = summaryLines(result, { useAi: true, checked: 1 });
    assert.ok(lines.includes(`  refused as ${REJECT_REPEATS_A_REFUSED_CLAIM}: Aiven`), lines.join("\n"));
  });
});
