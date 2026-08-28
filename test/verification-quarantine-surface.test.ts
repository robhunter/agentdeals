import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "quarantine-surface-"));
const statePath = join(dir, "verification_state.json");
const previous = process.env.AGENTDEALS_VERIFICATION_STATE_PATH;

const RECORDS = [
  {
    vendor: "Blocked",
    url: "https://blocked.example/startup",
    last_attempt_at: "2026-08-26",
    last_outcome: "fetch_failed",
    last_error: "timeout",
    failure_category: "timeout",
    consecutive_failures: 3,
    last_success: "2026-06-01",
    quarantined_since: "2026-08-26",
  },
  {
    vendor: "Blocked",
    url: "https://blocked.example/pricing",
    last_attempt_at: "2026-08-24",
    last_outcome: "fetch_failed",
    last_error: "HTTP 403",
    failure_category: "bot_block",
    consecutive_failures: 14,
    last_success: "2026-03-01",
    quarantined_since: "2026-05-02",
  },
  {
    vendor: "Gone",
    url: "https://gone.example/pricing",
    last_attempt_at: "2026-08-20",
    last_outcome: "fetch_failed",
    last_error: "HTTP 404",
    failure_category: "unreachable",
    consecutive_failures: 6,
    last_success: null,
    quarantined_since: "2026-08-10",
  },
  {
    vendor: "Patchy",
    url: "https://patchy.example/pricing",
    last_attempt_at: "2026-08-27",
    last_outcome: "unclear",
    last_error: "the page states no limits",
    failure_category: "ai_undecided",
    consecutive_failures: 2,
    last_success: "2026-08-02",
    quarantined_since: null,
  },
  {
    vendor: "Patchy",
    url: "https://patchy.example/docs",
    last_attempt_at: "2026-08-27",
    last_outcome: "unclear",
    last_error: "the page states no limits",
    failure_category: "ai_undecided",
    consecutive_failures: 1,
    last_success: "2026-08-20",
    quarantined_since: null,
  },
  {
    vendor: "Wobbly",
    url: "https://wobbly.example/pricing",
    last_attempt_at: "2026-08-27",
    last_outcome: "unclear",
    last_error: "the page states no limits",
    failure_category: "ai_undecided",
    consecutive_failures: 1,
    last_success: "2026-08-01",
    quarantined_since: null,
  },
  {
    vendor: "Fine",
    url: "https://fine.example/pricing",
    last_attempt_at: "2026-08-28",
    last_outcome: "confirmed",
    last_error: null,
    failure_category: null,
    consecutive_failures: 0,
    last_success: "2026-08-28",
    quarantined_since: null,
  },
];

writeFileSync(statePath, JSON.stringify({ generated_at: "2026-08-28", records: RECORDS }, null, 2));
process.env.AGENTDEALS_VERIFICATION_STATE_PATH = statePath;

const { verificationLedger, quarantineSummary, loadVerificationState, resetVerificationStateCache, nextRetryDate } =
  await import("../dist/verification-state.js");
const { rankOffers } = await import("../dist/ranking.js");
const { getFreshnessMetrics, resetCache } = await import("../dist/data.js");

before(() => resetVerificationStateCache());
after(() => {
  resetVerificationStateCache();
  rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.AGENTDEALS_VERIFICATION_STATE_PATH;
  else process.env.AGENTDEALS_VERIFICATION_STATE_PATH = previous;
});

describe("the verification state the site reads", () => {
  it("keys one entry per offer, not per vendor", () => {
    assert.strictEqual(loadVerificationState().size, RECORDS.length);
  });

  it("builds a ranking ledger only from records that are currently failing", () => {
    const ledger = verificationLedger();
    assert.strictEqual(ledger.has("fine"), false);
    assert.strictEqual(ledger.has("wobbly"), true);
    assert.strictEqual(ledger.has("gone"), true);
  });

  it("reports the worst failure a vendor has, whichever of its URLs holds it", () => {
    const ledger = verificationLedger();
    assert.strictEqual(ledger.get("blocked").consecutive_failures, 14);
    assert.strictEqual(ledger.get("blocked").last_error, "HTTP 403");
    assert.strictEqual(ledger.get("patchy").consecutive_failures, 2);
    assert.strictEqual(ledger.get("patchy").url, "https://patchy.example/pricing");
  });

  it("turns the stale-verification demerit into a statement about attempts, not silence", () => {
    const offer = {
      vendor: "Blocked",
      category: "Storage",
      tier: "Free",
      description: "Free tier: 10 GB",
      url: "https://blocked.example/pricing",
      verifiedDate: "2026-03-01",
    };
    const ranked = rankOffers([offer], {
      queryKey: "quarantine-surface",
      changes: [],
      date: "2026-08-28",
      verificationLedger: verificationLedger(),
    });
    const demerit = [...ranked.ranked, ...ranked.demoted][0].demerits.find(
      (d: any) => d.code === "stale_verification",
    );
    assert.ok(demerit, "an offer this stale must still carry the demerit");
    assert.match(demerit.reason, /14 consecutive re-check attempts have failed/);
    assert.match(demerit.reason, /HTTP 403/);
    assert.match(demerit.reason, /last confirmed 2026-03-01/);
    assert.strictEqual(demerit.about_us, true);
  });

  it("scores the demerit the same whether or not we know why we failed", () => {
    const offer = {
      vendor: "Blocked",
      category: "Storage",
      tier: "Free",
      description: "Free tier: 10 GB",
      url: "https://blocked.example/pricing",
      verifiedDate: "2026-03-01",
    };
    const opts = { queryKey: "quarantine-surface", changes: [], date: "2026-08-28" };
    const bare = rankOffers([offer], opts);
    const informed = rankOffers([offer], { ...opts, verificationLedger: verificationLedger() });
    const total = (r: any) => [...r.ranked, ...r.demoted][0].demerit_total;
    assert.strictEqual(total(bare), total(informed));
  });
});

describe("the quarantine list", () => {
  it("counts only the records held back, and says why each one is", () => {
    const summary = quarantineSummary();
    assert.strictEqual(summary.count, 3);
    assert.deepStrictEqual(summary.by_reason, { bot_block: 1, timeout: 1, unreachable: 1 });
  });

  it("names every held record rather than a sample of them", () => {
    const summary = quarantineSummary();
    assert.strictEqual(summary.entries.length, summary.count);
    assert.deepStrictEqual(
      summary.entries.map((e: any) => e.url).sort(),
      ["https://blocked.example/pricing", "https://blocked.example/startup", "https://gone.example/pricing"],
    );
  });

  it("gives each held record the date it is next due", () => {
    const summary = quarantineSummary();
    const gone = summary.entries.find((e: any) => e.vendor === "Gone");
    assert.strictEqual(gone.next_retry, "2026-08-27");
    assert.strictEqual(gone.last_success, null);
    assert.strictEqual(summary.retry_after_days, 7);
  });

  it("gives a record that is not held back no retry date", () => {
    const wobbly = RECORDS.find((r) => r.vendor === "Wobbly");
    assert.strictEqual(nextRetryDate(wobbly), null);
  });

  it("reaches the freshness endpoint's payload", () => {
    resetCache();
    const metrics = getFreshnessMetrics();
    assert.strictEqual(metrics.quarantine.count, 3);
    assert.strictEqual(metrics.quarantine.entries.length, 3);
    assert.ok(metrics.total_offers > 0);
    resetCache();
  });
});
