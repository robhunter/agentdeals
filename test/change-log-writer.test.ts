import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changeLogFreshness as serverFreshness } from "../dist/data.js";

process.env.AGENTDEALS_REFUSALS_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "refusals-writer-")),
  "change_refusals.json"
);

const {
  buildChangeEntry,
  selectNewChanges,
  appendChangeEntries,
  changeLogFreshness,
  changeKey,
  baselineKey,
  CHANGE_TYPES,
  DETECTED_BY_AI,
  SUPPRESSED_SAME_TRANSITION_REGRADED,
} = await import("../scripts/change-log.js");

const { runUrlMode, runAiMode, summaryLines, repickWindowDays, regradeRefusals } = await import("../scripts/reverify-rolling.js");
const { firstSeenDates } = await import("../scripts/backfill-change-recorded-dates.js");
const { report, DEFAULT_THRESHOLD_DAYS, detectorSchedule, flagTokens, DETECTOR_CLI_OPTIONS, WORKFLOW_PATH, changeLogAtRef } = await import("../scripts/check-change-log-staleness.js");
const { VERIFIER_API_KEY_ENV, VERIFIER_MODEL } = await import("../scripts/verify-freshness.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const NOW = new Date("2026-08-27T09:00:00Z");

const OFFER = {
  vendor: "Examplebase",
  category: "Databases",
  tier: "Free",
  description: "500 MB storage and 2 GB egress per month, free forever",
  url: "https://examplebase.dev/pricing",
};

const DETECTION = {
  status: "changed",
  summary: "The free plan is now a 14-day trial",
  change_type: "free_tier_removed",
  current_state: "500 MB for 14 days, then $19/month",
  impact: "high",
  effective_date: "2026-08-01",
};

function tempLog(changes: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "change-log-"));
  const file = path.join(dir, "deal_changes.json");
  writeFileSync(file, JSON.stringify({ changes }, null, 2) + "\n");
  return file;
}

describe("change log writer", () => {
  describe("buildChangeEntry", () => {
    it("produces every field the stored record shape requires", () => {
      const { entry } = buildChangeEntry(OFFER, DETECTION, { now: NOW });
      const required = [
        "vendor", "change_type", "date", "summary", "previous_state",
        "current_state", "impact", "source_url", "category", "alternatives",
      ];
      for (const field of required) {
        assert.ok(entry[field] !== undefined && entry[field] !== null, `missing ${field}`);
      }
      assert.strictEqual(entry.vendor, OFFER.vendor);
      assert.strictEqual(entry.category, OFFER.category);
      assert.strictEqual(entry.source_url, OFFER.url);
      assert.deepStrictEqual(entry.alternatives, []);
    });

    it("takes previous_state from the stored record and current_state from the page reading", () => {
      const { entry } = buildChangeEntry(OFFER, DETECTION, { now: NOW });
      assert.strictEqual(entry.previous_state, OFFER.description);
      assert.strictEqual(entry.current_state, DETECTION.current_state);
      assert.notStrictEqual(entry.current_state, OFFER.description);
    });

    it("marks the entry as machine-written and stamps when it was recorded", () => {
      const { entry } = buildChangeEntry(OFFER, DETECTION, { now: NOW });
      assert.strictEqual(entry.detected_by, DETECTED_BY_AI);
      assert.strictEqual(entry.recorded_date, "2026-08-27");
    });

    it("keeps the recorded date separate from the date the terms changed", () => {
      const { entry } = buildChangeEntry(OFFER, DETECTION, { now: NOW });
      assert.strictEqual(entry.date, "2026-08-01");
      assert.strictEqual(entry.recorded_date, "2026-08-27");
    });

    it("falls back to the recorded date when the page gives no effective date", () => {
      const { effective_date, ...noDate } = DETECTION;
      const { entry } = buildChangeEntry(OFFER, noDate, { now: NOW });
      assert.strictEqual(entry.date, "2026-08-27");
    });

    it("ignores an effective date that is not an ISO day", () => {
      const { entry } = buildChangeEntry(OFFER, { ...DETECTION, effective_date: "last summer" }, { now: NOW });
      assert.strictEqual(entry.date, "2026-08-27");
    });

    it("writes no entry when the change type is not one we publish", () => {
      const { entry, missing } = buildChangeEntry(OFFER, { ...DETECTION, change_type: "got_worse" }, { now: NOW });
      assert.strictEqual(entry, null);
      assert.deepStrictEqual(missing, ["change_type"]);
    });

    it("writes no entry when the page reading produced no current state", () => {
      const { entry, missing } = buildChangeEntry(OFFER, { ...DETECTION, current_state: "  " }, { now: NOW });
      assert.strictEqual(entry, null);
      assert.deepStrictEqual(missing, ["current_state"]);
    });

    it("writes no entry when there is no summary", () => {
      const { summary, ...noSummary } = DETECTION;
      const { entry, missing } = buildChangeEntry(OFFER, noSummary, { now: NOW });
      assert.strictEqual(entry, null);
      assert.deepStrictEqual(missing, ["summary"]);
    });

    it("reports every field it needed rather than only the first", () => {
      const { missing } = buildChangeEntry(OFFER, { status: "changed" }, { now: NOW });
      assert.deepStrictEqual(missing, ["change_type", "summary", "current_state"]);
    });

    it("accepts every change type the published catalogue uses", () => {
      for (const changeType of CHANGE_TYPES) {
        const { entry } = buildChangeEntry(OFFER, { ...DETECTION, change_type: changeType }, { now: NOW });
        assert.ok(entry, `${changeType} was rejected`);
        assert.strictEqual(entry.change_type, changeType);
      }
    });

    it("defaults impact rather than inventing one when the model omits it", () => {
      const { impact, ...noImpact } = DETECTION;
      const { entry } = buildChangeEntry(OFFER, noImpact, { now: NOW });
      assert.strictEqual(entry.impact, "medium");
    });
  });

  describe("selectNewChanges", () => {
    const candidate = () => buildChangeEntry(OFFER, DETECTION, { now: NOW }).entry;

    it("records a change nothing in the log already covers", () => {
      const { fresh, suppressed } = selectNewChanges([], [candidate()]);
      assert.strictEqual(fresh.length, 1);
      assert.strictEqual(suppressed.length, 0);
    });

    it("does not write the same change twice", () => {
      const existing = candidate();
      const { fresh, suppressed } = selectNewChanges([existing], [candidate()]);
      assert.strictEqual(fresh.length, 0);
      assert.strictEqual(suppressed[0].reason, "already_recorded");
    });

    it("does not write a second copy when the same record is re-read before the catalogue comes round again", () => {
      const yesterday = { ...candidate(), recorded_date: "2026-08-26", date: "2026-08-26" };
      const today = { ...candidate(), recorded_date: "2026-08-27", date: "2026-08-27" };
      const { fresh, suppressed } = selectNewChanges([yesterday], [today], { windowDays: 21 });
      assert.strictEqual(fresh.length, 0);
      assert.strictEqual(suppressed[0].reason, "recorded_within_repick_window");
    });

    it("records a later change of the same kind once the window has passed", () => {
      const old = { ...candidate(), recorded_date: "2026-06-01", date: "2026-06-01" };
      const now = { ...candidate(), recorded_date: "2026-08-27", date: "2026-08-27" };
      const { fresh } = selectNewChanges([old], [now], { windowDays: 21 });
      assert.strictEqual(fresh.length, 1);
    });

    it("suppresses a repeat against a hand-written entry that carries no recorded date", () => {
      const handWritten = { ...candidate(), date: "2026-08-20" };
      delete handWritten.recorded_date;
      delete handWritten.detected_by;
      const { fresh, suppressed } = selectNewChanges([handWritten], [
        { ...candidate(), date: "2026-08-27", recorded_date: "2026-08-27" },
      ], { windowDays: 21 });
      assert.strictEqual(fresh.length, 0);
      assert.strictEqual(suppressed[0].reason, "recorded_within_repick_window");
    });

    it("does not write the same change twice within one batch", () => {
      const { fresh, suppressed } = selectNewChanges([], [candidate(), candidate()]);
      assert.strictEqual(fresh.length, 1);
      assert.strictEqual(suppressed.length, 1);
    });

    it("keeps changes for different vendors apart", () => {
      const other = { ...candidate(), vendor: "Otherbase" };
      const { fresh } = selectNewChanges([candidate()], [other]);
      assert.strictEqual(fresh.length, 1);
    });

    it("blocks an exact repeat even with the re-pick window switched off", () => {
      const { fresh, suppressed } = selectNewChanges([], [candidate(), candidate()], { windowDays: 0 });
      assert.strictEqual(fresh.length, 1);
      assert.strictEqual(suppressed[0].reason, "already_recorded");
    });

    it("blocks an exact repeat against the stored log with the window switched off", () => {
      const { fresh, suppressed } = selectNewChanges([candidate()], [candidate()], { windowDays: 0 });
      assert.strictEqual(fresh.length, 0);
      assert.strictEqual(suppressed[0].reason, "already_recorded");
    });

    it("writes one record for one transition however the re-read grades it", () => {
      const first = candidate();
      const regraded = { ...candidate(), change_type: "limits_increased" };
      const { fresh, suppressed } = selectNewChanges([first], [regraded], { windowDays: 0 });
      assert.strictEqual(fresh.length, 0);
      assert.strictEqual(suppressed[0].reason, SUPPRESSED_SAME_TRANSITION_REGRADED);
      assert.strictEqual(suppressed[0].collidedWith, changeKey(first));
    });

    it("holds one transition to one record within a single batch", () => {
      const graded = (change_type: string) => ({ ...candidate(), change_type });
      const { fresh, suppressed } = selectNewChanges(
        [],
        [graded("limits_reduced"), graded("limits_increased"), graded("new_free_tier")],
        { windowDays: 0 }
      );
      assert.strictEqual(fresh.length, 1);
      assert.strictEqual(fresh[0].change_type, "limits_reduced");
      assert.deepStrictEqual(
        suppressed.map((s: any) => s.reason),
        [SUPPRESSED_SAME_TRANSITION_REGRADED, SUPPRESSED_SAME_TRANSITION_REGRADED]
      );
    });

    it("writes both records when one pricing page moves two products", () => {
      const vps = {
        ...candidate(),
        change_type: "pricing_restructured",
        previous_state: "VPS-1 $4.90/mo, VPS-2 ~$8/mo, VPS-4 $26.00/mo",
      };
      const cloud = {
        ...candidate(),
        change_type: "limits_reduced",
        previous_state: "Standard pricing on Public Cloud instances and Bare Metal",
      };
      const { fresh, suppressed } = selectNewChanges([vps], [cloud], { windowDays: 0 });
      assert.strictEqual(fresh.length, 1);
      assert.strictEqual(suppressed.length, 0);
    });

    it("does not read two records with no baseline as one transition", () => {
      const stored = { ...candidate(), previous_state: "" };
      const incoming = { ...candidate(), change_type: "limits_increased", previous_state: "" };
      assert.strictEqual(baselineKey(stored), null);
      const { fresh, suppressed } = selectNewChanges([stored], [incoming], { windowDays: 0 });
      assert.strictEqual(fresh.length, 1);
      assert.strictEqual(suppressed.length, 0);
    });

    it("hands the collided key to the refusal log", () => {
      const first = candidate();
      const { suppressed } = selectNewChanges([first], [{ ...candidate(), change_type: "limits_increased" }], {
        windowDays: 0,
      });
      const refusals = regradeRefusals(suppressed);
      assert.strictEqual(refusals.length, 1);
      assert.strictEqual(refusals[0].reason, SUPPRESSED_SAME_TRANSITION_REGRADED);
      assert.strictEqual(refusals[0].collidedWith, changeKey(first));
      assert.match(refusals[0].detail, /previous_state/);
    });

    it("leaves the other suppression reasons out of the refusal log", () => {
      const { suppressed } = selectNewChanges([candidate()], [candidate()], { windowDays: 0 });
      assert.strictEqual(suppressed[0].reason, "already_recorded");
      assert.deepStrictEqual(regradeRefusals(suppressed), []);
    });
  });

  describe("one transition holds one record across the whole stored log", () => {
    const stored = JSON.parse(
      readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")
    ).changes as Array<Record<string, string>>;

    it("stores no two records for one vendor, date, page and baseline", () => {
      const groups = new Map<string, Array<Record<string, string>>>();
      for (const change of stored) {
        const key = baselineKey(change);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(change);
      }
      const collisions = [...groups.values()]
        .filter(group => group.length > 1)
        .map(group => `${group[0].vendor} ${group[0].date}: ${group.map(c => c.change_type).join(" + ")}`);
      assert.deepStrictEqual(collisions, []);
    });

    it("keeps both records where one page moved two products on one day", () => {
      const pair = stored.filter(c => c.vendor === "OVHcloud" && c.date === "2026-04-01");
      assert.strictEqual(pair.length, 2);
      assert.strictEqual(pair[0].source_url, pair[1].source_url);
      assert.notStrictEqual(pair[0].previous_state, pair[1].previous_state);
      assert.notStrictEqual(baselineKey(pair[0]), baselineKey(pair[1]));
    });

    it("is not vacuous — most of the log carries a baseline the rule can read", () => {
      const withBaseline = stored.filter(c => baselineKey(c) !== null);
      assert.ok(withBaseline.length > stored.length / 2, `records carrying a baseline: ${withBaseline.length}`);
    });
  });

  describe("what the run tells whoever reads the log", () => {
    const urlResult = { verified: 3, flagged: 1, changed: 0, changes: [], recorded: [], suppressed: [], unclassified: [] };
    const aiResult = { verified: 1, flagged: 0, changed: 2, changes: [{}], recorded: [{}], suppressed: [{}], unclassified: [{}] };
    const context = { checked: 4, oldestRemaining: "2026-04-05", total: 1580 };

    it("states that URL mode cannot detect a change rather than printing a count of zero", () => {
      const lines = summaryLines(urlResult, { ...context, useAi: false });
      assert.ok(lines.some((l: string) => /URL mode compares nothing and cannot report a change/.test(l)));
      assert.ok(!lines.some((l: string) => /^Changed/.test(l)), "URL mode printed a change count");
    });

    it("reports what AI mode wrote, what it withheld and what it could not classify", () => {
      const lines = summaryLines(aiResult, { ...context, useAi: true });
      assert.ok(lines.includes("Recorded to data/deal_changes.json: 1"));
      assert.ok(lines.includes("Already recorded, not written again: 1"));
      assert.ok(lines.includes("Detected but not recordable: 1"));
    });

    it("counts a re-read that agreed apart from one that graded the same transition differently", () => {
      const suppressed = [
        { candidate: {}, reason: "already_recorded" },
        { candidate: {}, reason: "recorded_within_repick_window" },
        { candidate: {}, reason: SUPPRESSED_SAME_TRANSITION_REGRADED, collidedWith: "k" },
      ];
      const lines = summaryLines({ ...aiResult, suppressed }, { ...context, useAi: true });
      assert.ok(lines.includes("Already recorded, not written again: 2"));
      assert.ok(lines.includes("Same transition re-read and graded differently, not written again: 1"));
    });

    it("derives the re-pick window from how long the catalogue takes to come round", () => {
      assert.strictEqual(repickWindowDays(1580, 75), 22);
      assert.strictEqual(repickWindowDays(150, 75), 2);
    });

    it("never derives a window that switches the guard off", () => {
      assert.strictEqual(repickWindowDays(0, 75), 1);
      assert.strictEqual(repickWindowDays(1580, 0), 1);
      assert.ok(repickWindowDays(10, 1000) >= 1);
    });
  });

  describe("appendChangeEntries", () => {
    it("adds the entry to the file on disk", () => {
      const file = tempLog([]);
      const { entry } = buildChangeEntry(OFFER, DETECTION, { now: NOW });
      const result = appendChangeEntries([entry], { path: file });
      assert.strictEqual(result.appended.length, 1);
      const written = JSON.parse(readFileSync(file, "utf-8"));
      assert.strictEqual(written.changes.length, 1);
      assert.strictEqual(written.changes[0].vendor, OFFER.vendor);
      assert.strictEqual(written.changes[0].detected_by, DETECTED_BY_AI);
      rmSync(path.dirname(file), { recursive: true, force: true });
    });

    it("preserves entries that were already in the file", () => {
      const existing = { ...buildChangeEntry({ ...OFFER, vendor: "Priorbase" }, DETECTION, { now: NOW }).entry };
      const file = tempLog([existing]);
      const { entry } = buildChangeEntry(OFFER, DETECTION, { now: NOW });
      appendChangeEntries([entry], { path: file });
      const written = JSON.parse(readFileSync(file, "utf-8"));
      assert.strictEqual(written.changes.length, 2);
      assert.strictEqual(written.changes[0].vendor, "Priorbase");
      rmSync(path.dirname(file), { recursive: true, force: true });
    });

    it("writes nothing on a dry run", () => {
      const file = tempLog([]);
      const { entry } = buildChangeEntry(OFFER, DETECTION, { now: NOW });
      const result = appendChangeEntries([entry], { path: file, dryRun: true });
      assert.strictEqual(result.appended.length, 1);
      const written = JSON.parse(readFileSync(file, "utf-8"));
      assert.strictEqual(written.changes.length, 0);
      rmSync(path.dirname(file), { recursive: true, force: true });
    });
  });

  describe("URL mode reports no change because it compares nothing", () => {
    const picked = [
      { index: 0, offer: { ...OFFER, verifiedDate: "2026-01-01" } },
      { index: 1, offer: { ...OFFER, vendor: "Otherbase", verifiedDate: "2026-01-02" } },
    ];

    const reachable = async (batch: any[]) => ({
      verified: batch.map((b) => ({ index: b.index, vendor: b.offer.vendor })),
      flagged: [],
    });
    const namesEveryone = async () => ({
      ok: true,
      text: "Examplebase and Otherbase both cost $10/month.",
    });

    it("returns a change count of zero even when every entry is reachable", async () => {
      const data = { offers: picked.map((p) => ({ ...p.offer })) };
      const result = await runUrlMode(picked, data, false, NOW, {
        batchFn: reachable,
        fetchFn: namesEveryone,
      });
      assert.strictEqual(result.verified, 2);
      assert.strictEqual(result.changed, 0);
      assert.deepStrictEqual(result.changes, []);
      assert.deepStrictEqual(result.recorded, []);
    });

    it("returns a change count of zero when every entry fails its fetch", async () => {
      const data = { offers: picked.map((p) => ({ ...p.offer })) };
      const batchFn = async (batch: any[]) => ({
        verified: [],
        flagged: batch.map((b) => ({ vendor: b.offer.vendor, url: b.offer.url, error: "HTTP 500" })),
      });
      const result = await runUrlMode(picked, data, false, NOW, { batchFn });
      assert.strictEqual(result.flagged, 2);
      assert.strictEqual(result.changed, 0);
      assert.deepStrictEqual(result.changes, []);
    });

    it("stamps a fresh verifiedDate on a page that answered and named the vendor", async () => {
      const data = { offers: picked.map((p) => ({ ...p.offer })) };
      await runUrlMode(picked, data, false, NOW, { batchFn: reachable, fetchFn: namesEveryone });
      assert.notStrictEqual(data.offers[0].verifiedDate, "2026-01-01");
      assert.strictEqual(data.offers[0].source_check.outcome, "ok");
    });

    it("holds verifiedDate in AI mode too, on a page a model confirmed", async () => {
      const sourcedFromAnAggregator = {
        index: 0,
        offer: { ...OFFER, url: "https://dealmarket.example/offers", verifiedDate: "2026-01-01" },
      };
      const data = { offers: [{ ...sourcedFromAnAggregator.offer }] };
      const result = await runAiMode([sourcedFromAnAggregator], data, false, NOW, {
        fetchFn: async () => ({ ok: true, text: "Deals for startups. Save 30% on 400 tools." }),
        verifyFn: async () => ({ status: "confirmed" }),
        confirmFn: async () => ({ verdict: "yes", reason: null }),
        rateLimitMs: 0,
      });
      assert.strictEqual(result.verified, 0);
      assert.strictEqual(data.offers[0].verifiedDate, "2026-01-01");
      assert.strictEqual(data.offers[0].source_check.outcome, "does_not_name_vendor");
    });

    it("holds verifiedDate where the page that answered names somebody else", async () => {
      const sourcedFromAnAggregator = [
        {
          index: 0,
          offer: { ...OFFER, url: "https://dealmarket.example/offers", verifiedDate: "2026-01-01" },
        },
      ];
      const data = { offers: [{ ...sourcedFromAnAggregator[0].offer }] };
      const result = await runUrlMode(sourcedFromAnAggregator, data, false, NOW, {
        batchFn: reachable,
        fetchFn: async () => ({ ok: true, text: "Deals for startups. Save 30% on 400 tools." }),
      });
      assert.strictEqual(result.verified, 0);
      assert.strictEqual(data.offers[0].verifiedDate, "2026-01-01");
      assert.strictEqual(data.offers[0].source_check.outcome, "does_not_name_vendor");
      assert.strictEqual(data.offers[0].source_check.checked, "2026-08-27");
    });
  });

  describe("AI mode is the only mode that can write a change", () => {
    const picked = [{ index: 0, offer: { ...OFFER, verifiedDate: "2026-01-01" } }];
    const fetchFn = async () => ({ ok: true, text: "500 MB for 14 days, then $19/month" });

    it("writes the detected change to the log", async () => {
      const file = tempLog([]);
      const data = { offers: [{ ...OFFER, verifiedDate: "2026-01-01" }] };
      const result = await runAiMode(picked, data, false, NOW, {
        fetchFn,
        verifyFn: async () => DETECTION,
        rateLimitMs: 0,
        changesPath: file,
      });
      assert.strictEqual(result.changed, 1);
      assert.strictEqual(result.recorded.length, 1);
      const written = JSON.parse(readFileSync(file, "utf-8"));
      assert.strictEqual(written.changes.length, 1);
      rmSync(path.dirname(file), { recursive: true, force: true });
    });

    it("leaves a changed record carrying its stale verification date", async () => {
      const file = tempLog([]);
      const data = { offers: [{ ...OFFER, verifiedDate: "2026-01-01" }] };
      await runAiMode(picked, data, false, NOW, {
        fetchFn,
        verifyFn: async () => DETECTION,
        rateLimitMs: 0,
        changesPath: file,
      });
      assert.strictEqual(data.offers[0].verifiedDate, "2026-01-01");
      rmSync(path.dirname(file), { recursive: true, force: true });
    });

    it("counts a detection it cannot classify instead of writing a guess", async () => {
      const file = tempLog([]);
      const data = { offers: [{ ...OFFER, verifiedDate: "2026-01-01" }] };
      const result = await runAiMode(picked, data, false, NOW, {
        fetchFn,
        verifyFn: async () => ({ status: "changed", summary: "something moved" }),
        rateLimitMs: 0,
        changesPath: file,
      });
      assert.strictEqual(result.changed, 1);
      assert.strictEqual(result.recorded.length, 0);
      assert.strictEqual(result.unclassified.length, 1);
      const written = JSON.parse(readFileSync(file, "utf-8"));
      assert.strictEqual(written.changes.length, 0);
      rmSync(path.dirname(file), { recursive: true, force: true });
    });

    it("writes nothing when the reading confirms the record", async () => {
      const file = tempLog([]);
      const data = { offers: [{ ...OFFER, verifiedDate: "2026-01-01" }] };
      const result = await runAiMode(picked, data, false, NOW, {
        fetchFn,
        verifyFn: async () => ({ status: "confirmed" }),
        rateLimitMs: 0,
        changesPath: file,
      });
      assert.strictEqual(result.verified, 1);
      assert.strictEqual(result.recorded.length, 0);
      assert.ok(
        ["2026-08-25", "2026-08-26", "2026-08-27"].includes(data.offers[0].verifiedDate),
        `confirmed record was stamped ${data.offers[0].verifiedDate}`
      );
      rmSync(path.dirname(file), { recursive: true, force: true });
    });
  });
});

describe("change log freshness", () => {
  const changes = [
    { vendor: "A", change_type: "restriction", date: "2026-01-01", recorded_date: "2026-08-01", date_source: "hand_written" },
    { vendor: "B", change_type: "restriction", date: "2026-02-01", recorded_date: "2026-08-20", detected_by: DETECTED_BY_AI, date_source: "vendor_page" },
    { vendor: "C", change_type: "restriction", date: "2026-03-01", recorded_date: "2026-06-01", date_source: "discovered" },
  ];

  it("carries every provenance the field can hold, so agreement is not agreement on an empty field", () => {
    assert.deepStrictEqual(
      [...new Set(changes.map((c) => c.date_source))].sort(),
      ["discovered", "hand_written", "vendor_page"]
    );
  });

  it("counts an entry whose date is only a discovery", () => {
    const freshness = changeLogFreshness(changes, NOW);
    assert.strictEqual(freshness.discovered_date_total, 1);
    assert.strictEqual(freshness.entries_without_date_source, 0);
  });

  it("treats an entry with no provenance as one whose date it cannot vouch for", () => {
    const freshness = changeLogFreshness([{ vendor: "A", change_type: "restriction", date: "2026-01-01" }], NOW);
    assert.strictEqual(freshness.discovered_date_total, 1);
    assert.strictEqual(freshness.entries_without_date_source, 1);
  });

  it("counts days since anything was added, not days since the newest change date", () => {
    const freshness = changeLogFreshness(changes, NOW);
    assert.strictEqual(freshness.last_recorded_date, "2026-08-20");
    assert.strictEqual(freshness.days_since_last_recorded, 7);
  });

  it("reports what the detector produced separately from the log as a whole", () => {
    const freshness = changeLogFreshness(changes, NOW);
    assert.strictEqual(freshness.machine_detected_total, 1);
    assert.strictEqual(freshness.last_detected_date, "2026-08-20");
    assert.strictEqual(freshness.recorded_last_30_days, 2);
  });

  it("says the age is unmeasurable rather than zero when nothing carries a recorded date", () => {
    const freshness = changeLogFreshness([{ vendor: "A", change_type: "restriction", date: "2026-01-01" }], NOW);
    assert.strictEqual(freshness.last_recorded_date, null);
    assert.strictEqual(freshness.days_since_last_recorded, null);
    assert.strictEqual(freshness.entries_without_recorded_date, 1);
  });

  it("agrees with the copy the server publishes from the same entries", () => {
    assert.deepStrictEqual(changeLogFreshness(changes, NOW), serverFreshness(changes as any, NOW));
  });

  it("agrees with the server on the published change log", () => {
    const published = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
    assert.deepStrictEqual(changeLogFreshness(published, NOW), serverFreshness(published, NOW));
  });
});

describe("the staleness alarm", () => {
  const freshnessAt = (detectedDaysAgo: number | null, recordedDaysAgo = 1) => ({
    total: 289,
    last_recorded_date: "2026-08-01",
    days_since_last_recorded: recordedDaysAgo,
    last_detected_date: detectedDaysAgo === null ? null : "2026-08-01",
    days_since_last_detected: detectedDaysAgo,
    recorded_last_30_days: 1,
    machine_detected_total: detectedDaysAgo === null ? 0 : 1,
    entries_without_recorded_date: 0,
    discovered_date_total: 0,
    entries_without_date_source: 0,
  });

  const SCHEDULED = { known: true, scheduled: true, reason: null };
  const NOT_SCHEDULED = { known: true, scheduled: false, reason: null };

  it("stays quiet inside the threshold once the detector is scheduled", () => {
    const r = report(freshnessAt(DEFAULT_THRESHOLD_DAYS), DEFAULT_THRESHOLD_DAYS, SCHEDULED);
    assert.strictEqual(r.failJob, false);
  });

  it("fires one day past the threshold once the detector is scheduled", () => {
    const r = report(freshnessAt(DEFAULT_THRESHOLD_DAYS + 1), DEFAULT_THRESHOLD_DAYS, SCHEDULED);
    assert.strictEqual(r.failJob, true);
  });

  it("would have fired long before the gap the log actually had", () => {
    assert.ok(DEFAULT_THRESHOLD_DAYS < 127);
    assert.strictEqual(report(freshnessAt(127), DEFAULT_THRESHOLD_DAYS, SCHEDULED).failJob, true);
  });

  it("fires when a scheduled detector has never recorded anything", () => {
    assert.strictEqual(report(freshnessAt(null), DEFAULT_THRESHOLD_DAYS, SCHEDULED).failJob, true);
  });

  it("cannot be silenced by a hand-written entry", () => {
    const handWrittenToday = freshnessAt(127, 0);
    const r = report(handWrittenToday, DEFAULT_THRESHOLD_DAYS, SCHEDULED);
    assert.strictEqual(r.failJob, true, "a fresh recorded_date must not clear a stale detector");
    assert.match(r.text, /hand-written entry does not clear this/);
  });

  it("does not fail the daily run while no detector is scheduled", () => {
    const r = report(freshnessAt(null, 127), DEFAULT_THRESHOLD_DAYS, NOT_SCHEDULED);
    assert.strictEqual(r.failJob, false, "a day counter cannot measure a detector that is off");
    assert.strictEqual(r.openAbsenceIssue, true);
  });

  it("signals the absence exactly once rather than every day", () => {
    const scheduled = report(freshnessAt(1), DEFAULT_THRESHOLD_DAYS, SCHEDULED);
    assert.strictEqual(scheduled.openAbsenceIssue, false);
  });

  it("refuses to pick an alarm when it cannot read the schedule", () => {
    const undecidable = { known: false, scheduled: false, reason: "no invocation found" };
    const r = report(freshnessAt(1), DEFAULT_THRESHOLD_DAYS, undecidable);
    assert.strictEqual(r.undecidable, true);
    assert.strictEqual(r.failJob, false);
    assert.strictEqual(r.openAbsenceIssue, false);
    assert.match(r.text, /Refusing to guess/);
  });
});

describe("reading the detector's schedule out of the workflow", () => {
  const withCommand = (cmd: string) => `jobs:\n  reverify:\n    steps:\n      - run: |\n          ${cmd}\n`;

  it("reads the shipped workflow rather than a flag someone must remember to set", () => {
    const yaml = readFileSync(WORKFLOW_PATH, "utf-8");
    const schedule = detectorSchedule(yaml);
    assert.strictEqual(schedule.known, true);
    assert.strictEqual(schedule.scheduled, true, "the shipped workflow passes --ai to the daily run");
  });

  it("hands the detector the credential the same step needs to use it", () => {
    const yaml = readFileSync(WORKFLOW_PATH, "utf-8");
    assert.match(
      yaml,
      new RegExp(`${VERIFIER_API_KEY_ENV}: \\$\\{\\{ secrets\\.${VERIFIER_API_KEY_ENV} \\}\\}`),
      `the step that passes --ai must also receive ${VERIFIER_API_KEY_ENV}`
    );
  });

  it("sees a scheduled detector when the invocation passes --ai", () => {
    const schedule = detectorSchedule(withCommand('node scripts/reverify-rolling.js --ai --limit "$LIMIT"'));
    assert.deepStrictEqual({ known: schedule.known, scheduled: schedule.scheduled }, { known: true, scheduled: true });
  });

  it("does not mistake a longer flag for --ai", () => {
    const schedule = detectorSchedule(withCommand('node scripts/reverify-rolling.js --ai-dry-run --limit "5"'));
    assert.strictEqual(schedule.scheduled, false);
  });

  it("refuses when it cannot find the invocation at all", () => {
    assert.strictEqual(detectorSchedule("jobs:\n  reverify:\n    steps: []\n").known, false);
  });

  it("refuses when a shell variable stands where the flag would go", () => {
    const schedule = detectorSchedule(
      withCommand('node scripts/reverify-rolling.js --limit "$LIMIT" $AI_FLAG')
    );
    assert.strictEqual(schedule.known, false);
    assert.match(schedule.reason, /\$AI_FLAG/);
  });

  it("refuses when a workflow expression stands where the flag would go", () => {
    const schedule = detectorSchedule(
      withCommand(
        "node scripts/reverify-rolling.js --limit \"$LIMIT\" ${{ inputs.mode == 'ai' && '--ai' || '' }}"
      )
    );
    assert.strictEqual(schedule.known, false);
    assert.match(schedule.reason, /inputs\.mode/);
  });

  it("refuses on a quoted variable standing alone, which expands to one whole argument", () => {
    const schedule = detectorSchedule(withCommand('node scripts/reverify-rolling.js "$AI_FLAG"'));
    assert.strictEqual(schedule.known, false);
    assert.match(schedule.reason, /AI_FLAG/);
  });

  it("refuses on a braced shell variable in the same position", () => {
    assert.strictEqual(
      detectorSchedule(withCommand("node scripts/reverify-rolling.js ${AI_FLAG}")).known,
      false
    );
  });

  it("still answers when the only variable is the value of an option that takes one", () => {
    const on = detectorSchedule(withCommand('node scripts/reverify-rolling.js --ai --limit "$LIMIT"'));
    assert.deepStrictEqual({ known: on.known, scheduled: on.scheduled }, { known: true, scheduled: true });
    const off = detectorSchedule(withCommand('node scripts/reverify-rolling.js --limit "$LIMIT"'));
    assert.deepStrictEqual({ known: off.known, scheduled: off.scheduled }, { known: true, scheduled: false });
  });

  it("reads a quoted flag by what the shell passes, not by the quotes around it", () => {
    for (const cmd of [
      "node scripts/reverify-rolling.js --limit 50 '--ai'",
      'node scripts/reverify-rolling.js --limit 50 "--ai"',
    ]) {
      const schedule = detectorSchedule(withCommand(cmd));
      assert.deepStrictEqual(
        { known: schedule.known, scheduled: schedule.scheduled },
        { known: true, scheduled: true },
        cmd
      );
    }
  });

  it("reads a quoted option name too, so the expansion after it is still a value", () => {
    const schedule = detectorSchedule(withCommand("node scripts/reverify-rolling.js '--limit' \"$LIMIT\""));
    assert.deepStrictEqual(
      { known: schedule.known, scheduled: schedule.scheduled },
      { known: true, scheduled: false }
    );
  });

  it("sees a literal flag standing where a value would go, because the detector scans every argument", () => {
    const source = readFileSync(path.join(REPO, "scripts", "reverify-rolling.js"), "utf-8");
    assert.match(
      source,
      /args\.includes\("--ai"\)/,
      "the detector no longer scans every argument for --ai, so this expectation needs rewriting"
    );
    const schedule = detectorSchedule(withCommand("node scripts/reverify-rolling.js --limit --ai"));
    assert.deepStrictEqual(
      { known: schedule.known, scheduled: schedule.scheduled },
      { known: true, scheduled: true }
    );
  });

  it("refuses on an unquoted expansion in value position, which the shell can split into two arguments", () => {
    for (const cmd of [
      "node scripts/reverify-rolling.js --limit $AI_FLAG",
      "node scripts/reverify-rolling.js --limit ${{ inputs.limit }}",
    ]) {
      assert.strictEqual(detectorSchedule(withCommand(cmd)).known, false, cmd);
    }
  });

  it("keeps answering for a quoted expansion in value position, which cannot split", () => {
    const schedule = detectorSchedule(
      withCommand('node scripts/reverify-rolling.js --limit "${{ inputs.limit }}"')
    );
    assert.deepStrictEqual(
      { known: schedule.known, scheduled: schedule.scheduled },
      { known: true, scheduled: false }
    );
  });

  it("stops reading at the pipe, so what the log is written to cannot decide this", () => {
    const schedule = detectorSchedule(
      withCommand('node scripts/reverify-rolling.js --limit "$LIMIT" | tee "$LOGFILE"')
    );
    assert.deepStrictEqual(
      { known: schedule.known, scheduled: schedule.scheduled },
      { known: true, scheduled: false }
    );
  });

  it("drops an option's value only when it is an expansion that cannot split", () => {
    assert.deepStrictEqual(
      flagTokens(' --limit "$LIMIT" --ai').map((t: { text: string }) => t.text),
      ["--limit", "--ai"]
    );
    assert.deepStrictEqual(
      flagTokens(" --limit 50 --ai").map((t: { text: string }) => t.text),
      ["--limit", "50", "--ai"]
    );
    assert.deepStrictEqual(
      flagTokens(" --limit $AI_FLAG").map((t: { text: string }) => t.text),
      ["--limit", "$AI_FLAG"]
    );
  });

  it("knows the same option grammar the detector itself parses", () => {
    const source = readFileSync(path.join(REPO, "scripts", "reverify-rolling.js"), "utf-8");
    const parsed = [
      ...new Set([...source.matchAll(/args\.(?:includes|indexOf)\("(--[a-z-]+)"\)/g)].map((m) => m[1])),
    ].sort();
    const declared = [...DETECTOR_CLI_OPTIONS.takesValue, ...DETECTOR_CLI_OPTIONS.boolean].sort();
    assert.ok(parsed.length > 0, "found no option literals in the detector, so the comparison proves nothing");
    assert.deepStrictEqual(parsed, declared);
  });

  it("exits 2 on a workflow whose schedule it cannot read", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "detector-schedule-"));
    try {
      const workflow = path.join(dir, "reverify.yml");
      writeFileSync(workflow, withCommand('node scripts/reverify-rolling.js --limit "$LIMIT" $AI_FLAG'));
      const run = spawnSync("node", [path.join(REPO, "scripts", "check-change-log-staleness.js")], {
        env: { ...process.env, AGENTDEALS_REVERIFY_WORKFLOW_PATH: workflow },
        encoding: "utf-8",
      });
      assert.strictEqual(run.status, 2, run.stdout + run.stderr);
      assert.match(run.stdout, /Refusing to guess/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when only some invocations pass --ai", () => {
    const yaml =
      withCommand('node scripts/reverify-rolling.js --limit "5"') +
      withCommand('node scripts/reverify-rolling.js --ai --limit "5"');
    const schedule = detectorSchedule(yaml);
    assert.strictEqual(schedule.known, false);
    assert.match(schedule.reason, /1 of 2/);
  });

  it("changes meaning at the same commit that changes the behaviour", () => {
    const on = readFileSync(WORKFLOW_PATH, "utf-8");
    const off = on.replace("reverify-rolling.js --ai --limit", "reverify-rolling.js --limit");
    assert.notStrictEqual(on, off, "expected the shipped invocation to be rewritable");
    const stale = freshnessNeverDetected();
    assert.strictEqual(report(stale, DEFAULT_THRESHOLD_DAYS, detectorSchedule(off)).failJob, false);
    assert.strictEqual(report(stale, DEFAULT_THRESHOLD_DAYS, detectorSchedule(on)).failJob, true);
  });

  it("refuses to start the detector without the credential, before fetching anything", async () => {
    const saved = process.env[VERIFIER_API_KEY_ENV];
    delete process.env[VERIFIER_API_KEY_ENV];
    let fetched = 0;
    try {
      await assert.rejects(
        () =>
          runAiMode(
            [{ index: 0, offer: { vendor: "V", category: "Hosting", url: "http://localhost:19999/x", tier: "Free", description: "d" } }],
            { offers: [{ vendor: "V" }] },
            true,
            NOW,
            { fetchFn: async () => { fetched += 1; return { ok: true, text: "text" }; } }
          ),
        new RegExp(VERIFIER_API_KEY_ENV)
      );
    } finally {
      if (saved !== undefined) process.env[VERIFIER_API_KEY_ENV] = saved;
    }
    assert.strictEqual(fetched, 0, "a run that cannot read a vendor's terms should not fetch any");
  });

  function freshnessNeverDetected() {
    return {
      total: 289,
      last_recorded_date: "2026-08-01",
      days_since_last_recorded: 1,
      last_detected_date: null,
      days_since_last_detected: null,
      recorded_last_30_days: 1,
      machine_detected_total: 0,
      entries_without_recorded_date: 0,
      discovered_date_total: 0,
      entries_without_date_source: 0,
    };
  }
});

describe("recovering when each entry was first written", () => {
  const entry = (vendor: string) => ({
    vendor, change_type: "restriction", date: "2026-01-01",
    source_url: "https://example.com/pricing",
  });

  it("dates an entry from the commit that introduced it, not the one that last touched it", () => {
    const commits = [
      { sha: "a", date: "2026-02-25" },
      { sha: "b", date: "2026-04-21" },
      { sha: "c", date: "2026-08-26" },
    ];
    const files: Record<string, any[]> = {
      a: [entry("First")],
      b: [entry("First"), entry("Second")],
      c: [entry("First"), entry("Second"), entry("Third")],
    };
    const seen = firstSeenDates(commits, (sha: string) => files[sha]);
    assert.strictEqual(seen.get(changeKey(entry("First"))), "2026-02-25");
    assert.strictEqual(seen.get(changeKey(entry("Second"))), "2026-04-21");
    assert.strictEqual(seen.get(changeKey(entry("Third"))), "2026-08-26");
  });

  it("keeps the original date for an entry that was later edited", () => {
    const commits = [{ sha: "a", date: "2026-02-25" }, { sha: "b", date: "2026-08-26" }];
    const files: Record<string, any[]> = {
      a: [{ ...entry("First"), summary: "as first written" }],
      b: [{ ...entry("First"), summary: "reworded much later" }],
    };
    const seen = firstSeenDates(commits, (sha: string) => files[sha]);
    assert.strictEqual(seen.get(changeKey(entry("First"))), "2026-02-25");
  });

  it("skips commits from before the file existed", () => {
    const commits = [{ sha: "missing", date: "2026-01-01" }, { sha: "a", date: "2026-02-25" }];
    const seen = firstSeenDates(commits, (sha: string) => {
      if (sha === "missing") throw new Error("path does not exist in this commit");
      return [entry("First")];
    });
    assert.strictEqual(seen.get(changeKey(entry("First"))), "2026-02-25");
  });
});

describe("the published change log", () => {
  const published = JSON.parse(
    readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")
  ).changes;

  it("stamps every entry with the day it was recorded", () => {
    const missing = published.filter((c: any) => !c.recorded_date);
    assert.deepStrictEqual(missing.map((c: any) => c.vendor), []);
  });

  it("uses ISO days for every recorded date", () => {
    for (const change of published) {
      assert.match(change.recorded_date, /^\d{4}-\d{2}-\d{2}$/, `${change.vendor} has ${change.recorded_date}`);
    }
  });

  it("holds a measurable age", () => {
    const freshness = changeLogFreshness(published, NOW);
    assert.strictEqual(freshness.entries_without_recorded_date, 0);
    assert.ok(typeof freshness.days_since_last_recorded === "number");
  });

  it("keeps a key that identifies an entry across revisions of the file", () => {
    const keys = new Set(published.map((c: any) => changeKey(c)));
    assert.ok(keys.size >= published.length - 1, `${published.length - keys.size} entries share a key`);
  });
});

describe("the change log's age reaches the surfaces that publish freshness", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;

  before(async () => {
    proc = await new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  });

  after(() => { if (proc) proc.kill(); });

  it("puts the age on /api/changes", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/changes`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.change_log_freshness, "no change_log_freshness on /api/changes");
    assert.strictEqual(typeof body.change_log_freshness.days_since_last_recorded, "number");
    assert.match(body.change_log_freshness.last_recorded_date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("reports the age separately from the count of changes", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/changes`);
    const body = await res.json() as any;
    assert.notStrictEqual(body.change_log_freshness.days_since_last_recorded, body.all_time_total);
    assert.strictEqual(typeof body.all_time_total, "number");
    assert.strictEqual(typeof body.change_log_freshness.total, "number");
  });

  it("puts the age on a personalized /api/changes response too", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/changes?vendors=vercel`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.ok(body.change_log_freshness, "no change_log_freshness on the personalized response");
  });

  it("puts the age on /api/metrics", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/metrics`);
    const body = await res.json() as any;
    assert.ok(body.change_log_freshness, "no change_log_freshness on /api/metrics");
  });

  it("tells a reader of /changes when the log was last written", async () => {
    const res = await fetch(`http://localhost:${serverPort}/changes`);
    const html = await res.text();
    assert.match(html, /class="log-freshness"/);
    assert.match(html, /We last added an entry to this log/);
  });

  it("tells a reader of /expiring when the log was last written", async () => {
    const res = await fetch(`http://localhost:${serverPort}/expiring`);
    const html = await res.text();
    assert.match(html, /class="log-freshness"/);
    assert.match(html, /We last added an entry to this log/);
  });
});

describe("#1321 the alarm on a frozen change log reads what main holds", () => {
  let repo: string;

  const entry = (detected: string) => ({
    changes: [
      {
        vendor: "Fixture Vendor",
        change_type: "limits_reduced",
        effective_date: detected,
        recorded_date: detected,
        detected_by: DETECTED_BY_AI,
        summary: "a fixture entry",
      },
    ],
  });

  const gitIn = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
    assert.strictEqual(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  };

  before(() => {
    repo = mkdtempSync(path.join(tmpdir(), "change-log-ref-"));
    spawnSync("git", ["init", "--initial-branch=main", repo], { encoding: "utf-8" });
    gitIn("config", "user.email", "fixture@example.com");
    gitIn("config", "user.name", "fixture");
    spawnSync("mkdir", ["-p", path.join(repo, "data")], { encoding: "utf-8" });
    writeFileSync(path.join(repo, "data", "deal_changes.json"), JSON.stringify(entry("2026-01-01"), null, 2));
    gitIn("add", "-A");
    gitIn("commit", "-m", "what main holds");
    writeFileSync(path.join(repo, "data", "deal_changes.json"), JSON.stringify(entry("2026-08-27"), null, 2));
  });

  after(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("reads the committed log, not the one this run just wrote to disk", () => {
    const onDisk = JSON.parse(readFileSync(path.join(repo, "data", "deal_changes.json"), "utf-8"));
    const onRef = changeLogAtRef("main", path.join(repo, "data", "deal_changes.json"), repo);
    assert.strictEqual(onDisk.changes[0].recorded_date, "2026-08-27");
    assert.strictEqual(onRef.changes[0].recorded_date, "2026-01-01");
  });

  it("calls the log stale from the ref on the same run that calls it fresh from disk", () => {
    const scheduled = { known: true, scheduled: true, reason: null };
    const fromDisk = report(
      changeLogFreshness(JSON.parse(readFileSync(path.join(repo, "data", "deal_changes.json"), "utf-8")).changes, NOW),
      DEFAULT_THRESHOLD_DAYS,
      scheduled
    );
    const fromRef = report(
      changeLogFreshness(changeLogAtRef("main", path.join(repo, "data", "deal_changes.json"), repo).changes, NOW),
      DEFAULT_THRESHOLD_DAYS,
      scheduled
    );
    assert.strictEqual(fromDisk.failJob, false, "the run's own write already looked stale, so the pair proves nothing");
    assert.strictEqual(fromRef.failJob, true, "a log frozen on main since January is still reported as fresh");
  });

  it("refuses to guess when the ref cannot be read", () => {
    assert.throws(
      () => changeLogAtRef("no-such-ref", path.join(repo, "data", "deal_changes.json"), repo),
      /Cannot read data\/deal_changes\.json at no-such-ref/
    );
  });

  it("is what the daily job runs, so the alarm cannot go back to reading its own checkout", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf-8");
    assert.match(workflow, /check-change-log-staleness\.js --from-ref origin\/main/);
    assert.match(workflow, /git fetch origin main/);
  });
});
