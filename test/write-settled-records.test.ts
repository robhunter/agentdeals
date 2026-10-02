import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changeEntryDateLabel, dateMeaningOf } from "../dist/change-dates.js";
import { changeIsUnconfirmed, differenceInOurTextSummary } from "../dist/change-confirmation.js";

const { writeSettledRecords, NOT_WRITTEN, STATED_THEN_SEPARATOR } = await import("../scripts/write-settled-records.js");
const { recordKey, settleFirstReadings, SPLIT } = await import("../scripts/settle-discovered-records.js");

type Change = Record<string, any>;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKED = "2026-10-03";

function reading(fields: Change = {}): Change {
  const date = fields.date ?? "2026-08-28";
  return {
    vendor: "Alpha",
    change_type: "limits_reduced",
    date,
    date_source: "discovered",
    summary: "The free plan now allows 1 project, down from 3.",
    tier: "Free",
    tier_direction: "narrowed",
    previous_state: "Free plan: 3 projects",
    current_state: "Free plan: 1 project",
    impact: "medium",
    source_url: "https://alpha.example/pricing",
    category: "Databases",
    alternatives: [],
    detected_by: "reverify-ai",
    recorded_date: date,
    ...fields,
  };
}

function resultFor(record: Change, settled: Change): Change {
  return {
    record_key: recordKey(record),
    vendor: record.vendor,
    date: record.date,
    change_type: record.change_type,
    source_url: record.source_url,
    resolution: null,
    badge: "caution",
    ...settled,
  };
}

const copyOf = (day: string, url = "https://alpha.example/pricing") => `https://web.archive.org/web/${day.replace(/-/g, "")}120000/${url}`;

const theCopyFromOurTextDay = (day: string) => ({ day, gap_days: 10, side: "before", url: copyOf(day) });

const bracket = (last_old: string, first_new: string | null, relative_to_record: string) => ({
  last_old,
  first_new,
  last_old_capture: copyOf(last_old),
  first_new_capture: first_new ? copyOf(first_new) : null,
  narrowed_to_adjacent_captures: true,
  relative_to_record,
});

function vendorChanged(brackets: Change[], date_from_captures?: string): Change {
  return {
    outcome: "vendor_changed",
    previous_state: "Free plan: 3 projects",
    terms_then: ["Free plan: 3 projects"],
    terms_on_record_day: ["Free plan: 1 project"],
    differences: [{ old: "Free plan: 3 projects", new: "Free plan: 1 project" }],
    direction: "narrowed",
    brackets,
    later_moves: [],
    moves_complete: true,
    text_day: "2026-02-10",
    record_day: "2026-08-28",
    capture: theCopyFromOurTextDay("2026-02-01"),
    reads: 4,
    ...(date_from_captures ? { date_from_captures } : {}),
    split: SPLIT.recentVendorChange,
  };
}

const statedThen = [
  { record: "allows 1 project", old: "Free plan: 1 project" },
  { record: "down from 3", old: "Up to 3 projects on Pro" },
];

function writeOne(record: Change, settled: Change, today = CHECKED) {
  return writeSettledRecords([record], [{ today, results: [resultFor(record, settled)] }]);
}

describe("writing a settled record into the change log", () => {
  it("re-types a record settled as a difference in our own text as our correction, keeping its terms, tier, page and dates", () => {
    const record = reading();
    const { changes, written } = writeOne(record, {
      outcome: "ours",
      stated_then: statedThen,
      text_day: "2026-02-10",
      record_day: "2026-08-28",
      capture: theCopyFromOurTextDay("2026-02-01"),
      split: SPLIT.ours,
    });
    assert.deepStrictEqual(changes[0], {
      ...record,
      change_type: "record_corrected",
      summary: differenceInOurTextSummary({ vendor: "Alpha", capture_day: "2026-02-01", text_day: "2026-02-10", record_date: "2026-08-28" }),
      archive_check: {
        checked: CHECKED,
        outcome: "ours",
        capture_day: "2026-02-01",
        recorded_as: "limits_reduced",
        capture: copyOf("2026-02-01"),
        stated_then: "Free plan: 1 project · Up to 3 projects on Pro",
      },
    });
    assert.strictEqual(STATED_THEN_SEPARATOR, " · ");
    assert.deepStrictEqual(written, [{ vendor: "Alpha", date: "2026-08-28", change_type: "limits_reduced", outcome: "ours", retyped: "record_corrected" }]);
    assert.strictEqual(changeEntryDateLabel(changes[0]), `recorded 2026-08-28 · corrected ${CHECKED}`);
  });

  it("keeps the type and badge of a removal the copy from our text's day already states, and stores that copy and its lines", () => {
    const record = reading({ change_type: "product_deprecated", summary: "The product is being shut down." });
    const { changes } = writeOne(record, {
      outcome: "removal_stated_before",
      stated_then: [{ record: "being shut down", old: "We are sunsetting the product" }],
      why: "the capture 2026-02-01 already states the removal, so it predates our text: to be dated",
      text_day: "2026-02-10",
      record_day: "2026-08-28",
      capture: theCopyFromOurTextDay("2026-02-01"),
      split: SPLIT.removalStatedBefore,
    });
    assert.deepStrictEqual(changes[0], {
      ...record,
      archive_check: {
        checked: CHECKED,
        outcome: "removal_stated_before",
        capture_day: "2026-02-01",
        capture: copyOf("2026-02-01"),
        stated_then: "We are sunsetting the product",
      },
    });
    assert.strictEqual(changeIsUnconfirmed(changes[0]), false);
  });

  it("dates a vendor change by the first copy showing the new terms, which then ends its bracketed label", () => {
    const record = reading();
    const { changes, written } = writeOne(record, vendorChanged([bracket("2026-06-15", "2026-06-16", "before")], "2026-06-16"));
    assert.deepStrictEqual(changes[0], {
      ...record,
      date: "2026-06-16",
      archive_check: {
        checked: CHECKED,
        outcome: "vendor_changed",
        brackets: [{ last_old: "2026-06-15", first_new: "2026-06-16", last_old_capture: copyOf("2026-06-15"), first_new_capture: copyOf("2026-06-16") }],
      },
    });
    assert.strictEqual(changes[0].recorded_date, "2026-08-28");
    assert.strictEqual(written[0].dated, "2026-06-16");
    assert.strictEqual(dateMeaningOf(changes[0]), "effective_by");
    assert.strictEqual(changeEntryDateLabel(changes[0]), "effective between 2026-06-15 and 2026-06-16");
  });

  it("keeps the record's own day where no copy before it shows the new terms, or the copies show more than one move", () => {
    const spans = writeOne(reading(), vendorChanged([bracket("2026-08-20", "2026-09-04", "spans")], "2026-09-04")).changes[0];
    assert.strictEqual(spans.date, "2026-08-28");
    assert.strictEqual(changeEntryDateLabel(spans), "effective between 2026-08-20 and 2026-08-28");

    const onlyOurRead = writeOne(reading(), vendorChanged([bracket("2026-08-20", null, "spans")])).changes[0];
    assert.strictEqual(onlyOurRead.date, "2026-08-28");
    assert.deepStrictEqual(onlyOurRead.archive_check.brackets, [{ last_old: "2026-08-20", first_new: null, last_old_capture: copyOf("2026-08-20"), first_new_capture: null }]);

    const twoMoves = writeOne(reading(), vendorChanged([bracket("2026-03-01", "2026-03-02", "before"), bracket("2026-06-15", "2026-06-16", "before")])).changes[0];
    assert.strictEqual(twoMoves.date, "2026-08-28");
    assert.strictEqual(twoMoves.archive_check.brackets.length, 2);
    assert.strictEqual(changeEntryDateLabel(twoMoves), "discovered 2026-08-28 · effective date unknown");
  });

  it("stores only the day and the outcome where no copy settled the record, and that alone marks it unconfirmed", () => {
    const outcomes: Record<string, Change> = {
      no_usable_capture: { outcome: "no_usable_capture", text_day: "2026-02-10", record_day: "2026-08-28", reads: 2, tried: [], why: "no capture settled it", split: SPLIT.noCaptureBadgeToReview },
      text_day_unknown: { outcome: "text_day_unknown", reads: 0, split: SPLIT.textDayUnknown },
      page_unreadable_today: { outcome: "page_unreadable_today", why: "HTTP 403", reads: 0, split: SPLIT.pageUnreadable },
    };
    for (const [outcome, settled] of Object.entries(outcomes)) {
      const record = reading();
      const [written] = writeOne(record, settled).changes;
      assert.deepStrictEqual(written, { ...record, archive_check: { checked: CHECKED, outcome } }, outcome);
      assert.strictEqual(changeIsUnconfirmed(written), outcome === "no_usable_capture", outcome);
    }
  });

  it("writes nothing for a result the next run asks again: a failed reader, or an Archive that did not answer", () => {
    const record = reading();
    for (const settled of [
      { outcome: "reader_failed", why: "the reader failed: 502 Bad Gateway", reads: 2, split: SPLIT.readerFailed },
      { outcome: "no_usable_capture", text_day: "2026-02-10", record_day: "2026-08-28", reads: 0, tried: [], why: "the Archive did not answer: HTTP 503", split: SPLIT.noCaptureBadgeToReview },
    ]) {
      const { changes, written, not_written } = writeOne(record, settled);
      assert.strictEqual(changes[0], record, settled.why);
      assert.deepStrictEqual(written, []);
      assert.deepStrictEqual(not_written.map((entry: Change) => entry.why), [NOT_WRITTEN.askedAgain]);
    }
  });
});

describe("finding the record a result settles", () => {
  const unconfirmed = { outcome: "no_usable_capture", why: "no capture settled it", reads: 1, tried: [], split: SPLIT.noCapture };

  it("matches the vendor as well as the record's key, which two vendors' records can share", () => {
    const generic = { change_type: "product_deprecated", summary: "Removed: source page no longer accessible", date: "2026-04-12" };
    const alpha = reading({ vendor: "Alpha", ...generic });
    const beta = reading({ vendor: "Beta", ...generic, source_url: "https://beta.example/pricing" });
    assert.strictEqual(recordKey(alpha), recordKey(beta));
    const { changes } = writeSettledRecords([alpha, beta], [{ today: CHECKED, results: [resultFor(beta, unconfirmed)] }]);
    assert.strictEqual(changes[0], alpha);
    assert.strictEqual(changes[1].archive_check.outcome, "no_usable_capture");
  });

  it("writes nothing where no record or more than one has the vendor and key, the record is no longer in force, or the result names no key", () => {
    const record = reading();
    const twin = reading({ source_url: "https://alpha.example/plans" });
    const other = reading({ summary: "A different reading." });
    const retractedSinceTheRun = reading({ resolution: { state: "retracted", date: "2026-10-02", detail: "describes no change" } });
    const cases: Array<[Change[], Change, string]> = [
      [[other], resultFor(record, unconfirmed), NOT_WRITTEN.noSuchRecord],
      [[record, twin], resultFor(record, unconfirmed), NOT_WRITTEN.severalRecords],
      [[retractedSinceTheRun], resultFor(record, unconfirmed), NOT_WRITTEN.noLongerInForce],
      [[record], { ...resultFor(record, unconfirmed), record_key: undefined }, NOT_WRITTEN.noRecordKey],
    ];
    for (const [changes, result, why] of cases) {
      const outcome = writeSettledRecords(changes, [{ today: CHECKED, results: [result] }]);
      assert.deepStrictEqual(outcome.changes, changes, why);
      assert.deepStrictEqual(outcome.not_written.map((entry: Change) => entry.why), [why]);
    }
  });

  it("leaves a record that already carries an archive check as it is, including when two reports settle it", () => {
    const checkedBefore = reading({ archive_check: { checked: "2026-09-30", outcome: "vendor_changed", brackets: [] } });
    const removalStated = {
      outcome: "removal_stated_before",
      stated_then: [{ record: "shut down", old: "We are sunsetting the product" }],
      capture: theCopyFromOurTextDay("2026-02-01"),
      why: "the capture 2026-02-01 already states the removal, so it predates our text: to be dated",
      split: SPLIT.removalStatedBefore,
    };
    const first = writeSettledRecords([checkedBefore], [{ today: CHECKED, results: [resultFor(checkedBefore, removalStated)] }]);
    assert.strictEqual(first.changes[0], checkedBefore);
    assert.deepStrictEqual(first.not_written.map((entry: Change) => entry.why), [NOT_WRITTEN.alreadyChecked]);
    assert.deepStrictEqual(first.review, []);

    const record = reading();
    const twice = writeSettledRecords([record], [
      { today: CHECKED, results: [resultFor(record, unconfirmed)] },
      { today: "2026-10-04", results: [resultFor(record, { outcome: "page_unreadable_today", why: "HTTP 403", reads: 0, split: SPLIT.pageUnreadable })] },
    ]);
    assert.deepStrictEqual(twice.changes[0].archive_check, { checked: CHECKED, outcome: "no_usable_capture" });
    assert.deepStrictEqual(twice.not_written.map((entry: Change) => `${entry.outcome}: ${entry.why}`), [`page_unreadable_today: ${NOT_WRITTEN.alreadyChecked}`]);
  });

  it("refuses a report that does not give the day it ran", () => {
    const record = reading();
    assert.throws(() => writeSettledRecords([record], [{ results: [resultFor(record, unconfirmed)] }]), /must give the day it ran/);
  });
});

describe("writing the report a settle run produced", () => {
  const page = (terms: string) => `<html><body><p>TERMS=${terms}</p><p>${"Plans and limits. ".repeat(40)}</p></body></html>`;
  const termsOf = (text: string) => text.match(/TERMS=(\w+)/)?.[1];
  const termsPairReader = () => async (older: { text: string }, newer: { text: string }) => {
    const was = termsOf(older.text);
    const now = termsOf(newer.text);
    if (!was || !now) return { status: "unquotable", side: "both", why: "no terms on the page" };
    const quoted = { old_terms: [`TERMS=${was}`], new_terms: [`TERMS=${now}`] };
    return was === now ? { status: "same", ...quoted } : { status: "differ", ...quoted, differences: [{ old: `TERMS=${was}`, new: `TERMS=${now}` }] };
  };
  const urlOf = (vendor: string) => `https://${vendor.toLowerCase()}.example/pricing`;
  const backlogRecord = (vendor: string, date: string, fields: Change = {}) =>
    reading({ vendor, date, previous_state: "TERMS=A", current_state: "TERMS=B", source_url: urlOf(vendor), ...fields });

  it("writes each outcome as the settle run reported it", async () => {
    const changes = [
      backlogRecord("Alpha", "2026-09-01"),
      backlogRecord("Beta", "2026-09-02"),
      backlogRecord("Gamma", "2026-09-03"),
      backlogRecord("Delta", "2026-09-03"),
      backlogRecord("Epsilon", "2026-09-04", { change_type: "product_deprecated" }),
      backlogRecord("Zeta", "2026-09-05"),
    ];
    const termsOn = (url: string, day: string) => (url === urlOf("Alpha") && day <= "2026-05-01" ? "A" : "B");
    const archive = {
      captures: async (url: string) => ({
        captures: url === urlOf("Delta") ? [] : ["20260201120000", "20260501120000", "20260502120000", "20260901120000"].map((timestamp) => ({ timestamp, original: url, statuscode: "200", mimetype: "text/html" })),
      }),
      captureHtml: async ({ timestamp, original }: { timestamp: string; original: string }) => ({
        html: page(termsOn(original, `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`)),
      }),
    };
    const statedReaderForRecord = (record: Change) => async () => {
      if (record.vendor === "Zeta") throw new Error("502 Bad Gateway");
      if (record.vendor === "Epsilon") return { status: "removal_stated", stated_then: [{ record: "shut down", old: "We are sunsetting the product" }] };
      return { status: "stated", stated_then: [{ record: "TERMS=B", old: "TERMS=B" }] };
    };
    const report = await settleFirstReadings({
      changes,
      offers: [],
      today: "2026-09-28",
      archive,
      pairReaderForListing: termsPairReader,
      statedReaderForRecord,
      fetchToday: async (url: string) => (url === urlOf("Gamma") ? { ok: false, error: "HTTP 403" } : { ok: true, text: "TERMS=B" }),
      textDayOf: () => "2026-02-10",
      badgeSetBy: (record: Change) => ({ Gamma: "risky", Delta: "caution", Zeta: "risky" } as Record<string, string>)[record.vendor] ?? null,
    });
    assert.deepStrictEqual(report.results.map((r: Change) => `${r.vendor} ${r.outcome}`), [
      "Alpha vendor_changed",
      "Beta ours",
      "Gamma page_unreadable_today",
      "Delta no_usable_capture",
      "Epsilon removal_stated_before",
      "Zeta reader_failed",
    ]);

    const { changes: written, not_written, review } = writeSettledRecords(changes, [JSON.parse(JSON.stringify(report))]);
    assert.deepStrictEqual(review.map((entry: Change) => `${entry.vendor} ${entry.badge}`), ["Gamma risky", "Delta caution", "Epsilon null"]);
    const byVendor = Object.fromEntries(written.map((change: Change) => [change.vendor, change]));

    assert.strictEqual(byVendor.Alpha.date, "2026-05-02");
    assert.strictEqual(changeEntryDateLabel(byVendor.Alpha), "effective between 2026-05-01 and 2026-05-02");
    assert.deepStrictEqual(byVendor.Alpha.archive_check.brackets, [{
      last_old: "2026-05-01",
      first_new: "2026-05-02",
      last_old_capture: "https://web.archive.org/web/20260501120000/https://alpha.example/pricing",
      first_new_capture: "https://web.archive.org/web/20260502120000/https://alpha.example/pricing",
    }]);

    assert.strictEqual(byVendor.Beta.change_type, "record_corrected");
    assert.strictEqual(byVendor.Beta.summary, differenceInOurTextSummary({ vendor: "Beta", capture_day: "2026-02-01", text_day: "2026-02-10", record_date: "2026-09-02" }));
    assert.deepStrictEqual(byVendor.Beta.archive_check, {
      checked: "2026-09-28",
      outcome: "ours",
      capture_day: "2026-02-01",
      recorded_as: "limits_reduced",
      capture: "https://web.archive.org/web/20260201120000/https://beta.example/pricing",
      stated_then: "TERMS=B",
    });
    assert.strictEqual(changeEntryDateLabel(byVendor.Beta), "recorded 2026-09-02 · corrected 2026-09-28");

    assert.deepStrictEqual(byVendor.Gamma.archive_check, { checked: "2026-09-28", outcome: "page_unreadable_today" });
    assert.deepStrictEqual(byVendor.Delta.archive_check, { checked: "2026-09-28", outcome: "no_usable_capture" });
    assert.strictEqual(changeIsUnconfirmed(byVendor.Delta), true);
    assert.deepStrictEqual(byVendor.Epsilon.archive_check, {
      checked: "2026-09-28",
      outcome: "removal_stated_before",
      capture_day: "2026-02-01",
      capture: "https://web.archive.org/web/20260201120000/https://epsilon.example/pricing",
      stated_then: "We are sunsetting the product",
    });
    assert.strictEqual(byVendor.Epsilon.change_type, "product_deprecated");
    assert.strictEqual(byVendor.Zeta, changes[5]);
    assert.deepStrictEqual(not_written.map((entry: Change) => `${entry.vendor}: ${entry.why}`), [`Zeta: ${NOT_WRITTEN.askedAgain}`]);
  });

  it("rewrites the change log the run names in the format the log is kept in, and prints what it wrote", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "write-settled-records-"));
    try {
      const record = reading();
      const untouched = reading({ vendor: "Beta", source_url: "https://beta.example/pricing" });
      const log = path.join(dir, "deal_changes.json");
      const reportFile = path.join(dir, "settled-first-readings.json");
      writeFileSync(log, `${JSON.stringify({ changes: [record, untouched] }, null, 2)}\n`);
      writeFileSync(reportFile, JSON.stringify({ today: CHECKED, results: [resultFor(record, vendorChanged([bracket("2026-06-15", "2026-06-16", "before")], "2026-06-16"))] }));
      const run = spawnSync("node", ["scripts/write-settled-records.js", reportFile], {
        cwd: REPO,
        env: { ...process.env, AGENTDEALS_CHANGES_PATH: log },
        encoding: "utf-8",
      });
      assert.strictEqual(run.status, 0, run.stderr);
      const expected = writeSettledRecords([record, untouched], [JSON.parse(readFileSync(reportFile, "utf-8"))]).changes;
      assert.strictEqual(readFileSync(log, "utf-8"), `${JSON.stringify({ changes: expected }, null, 2)}\n`);
      assert.match(run.stdout, /Wrote an archive check on 1 records to /);
      assert.match(run.stdout, /\n {2}vendor_changed: 1\n/);
      assert.match(run.stdout, /dated by the first copy showing the new terms: 1\n/);
      assert.match(run.stdout, /Not written: 0\n/);
      assert.match(run.stdout, /For review: 0\n/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
