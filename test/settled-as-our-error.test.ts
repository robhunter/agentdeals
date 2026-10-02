import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toSlug } from "../dist/vendor-slug.js";
import {
  changeEntryDateLabel,
  changeEntryDateLabelHtml,
  changeEntryLongDateLabel,
  dateMeaningOf,
  dayWeCorrectedIt,
} from "../dist/change-dates.js";
import { feedEntryDateSentence } from "../dist/change-feed.js";
import { differenceInOurTextSummary } from "../dist/change-confirmation.js";
import type { ArchiveCheck, DealChange } from "../dist/types.js";

const CAPTURE = "https://web.archive.org/web/20260412093000/https://example.com/pricing";

const oursCheck = (over: Partial<ArchiveCheck> = {}): ArchiveCheck => ({
  checked: "2026-10-03",
  outcome: "ours",
  capture_day: "2026-04-12",
  recorded_as: "limits_reduced",
  capture: CAPTURE,
  stated_then: "Free plan: 1 GB of storage",
  ...over,
});

const settledAsOurs = (over: Partial<DealChange> = {}): DealChange => ({
  vendor: "Fixture Vendor",
  change_type: "record_corrected",
  date: "2026-08-28",
  summary: differenceInOurTextSummary({ vendor: "Fixture Vendor", capture_day: "2026-04-12", text_day: "2026-05-02", record_date: "2026-08-28" }),
  previous_state: "limits_reduced dated 2026-08-28",
  current_state: "the same record, as our own error",
  impact: "low",
  source_url: "https://example.com/pricing",
  category: "Databases",
  alternatives: [],
  date_source: "discovered",
  recorded_date: "2026-08-28",
  archive_check: oursCheck(),
  ...over,
});

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

describe("a record the archive check settled as a difference in our own text", () => {
  it("says so in a summary that names the copy, our listing and the re-read, with no figures", () => {
    assert.strictEqual(
      differenceInOurTextSummary({ vendor: "Fixture Vendor", capture_day: "2026-04-12", text_day: "2026-05-02", record_date: "2026-08-28" }),
      "Data correction - Not a change by Fixture Vendor. An Internet Archive copy of its page from 2026-04-12 already states the terms this record called new, and our listing of 2026-05-02 did not match them. Our re-read of 2026-08-28 recorded the difference as a change.",
    );
  });

  it("is labelled by the day we recorded it and the day we corrected it, short and long", () => {
    assert.strictEqual(changeEntryDateLabel(settledAsOurs()), "recorded 2026-08-28 · corrected 2026-10-03");
    assert.strictEqual(changeEntryLongDateLabel(settledAsOurs()), "recorded Aug 28, 2026 · corrected Oct 3, 2026");
    assert.strictEqual(changeEntryDateLabelHtml(settledAsOurs(), esc), esc(changeEntryDateLabel(settledAsOurs())));
  });

  it("is dated in the feed by the same two days", () => {
    assert.strictEqual(feedEntryDateSentence(settledAsOurs()), "recorded 2026-08-28 · corrected 2026-10-03.");
  });

  it("keeps the meaning of its date: the day we recorded it", () => {
    assert.strictEqual(dateMeaningOf(settledAsOurs()), "discovered");
  });

  it("takes that label only as our correction with the check's outcome ours, on a record with no effective date", () => {
    assert.strictEqual(dayWeCorrectedIt(settledAsOurs()), "2026-10-03");
    assert.strictEqual(dayWeCorrectedIt(settledAsOurs({ change_type: "limits_reduced" })), null);
    assert.strictEqual(dayWeCorrectedIt(settledAsOurs({ date_source: "hand_written", date: "2026-10-01", recorded_date: "2026-10-01" })), null);
    assert.strictEqual(dayWeCorrectedIt(settledAsOurs({ archive_check: null })), null);
    for (const outcome of ["vendor_changed", "removal_stated_before", "no_usable_capture", "text_day_unknown", "page_unreadable_today"] as const) {
      assert.strictEqual(dayWeCorrectedIt(settledAsOurs({ archive_check: oursCheck({ outcome }) })), null, outcome);
    }
    assert.strictEqual(changeEntryDateLabel(settledAsOurs({ archive_check: null })), "discovered 2026-08-28 · effective date unknown");
  });
});

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 86_400_000;
const daysFromToday = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

const OURS = "Settled Ours Fixture Store";
const CONTROL = "Settled Ours Control Store";
const CAPTURE_DAY = daysFromToday(-150);
const TEXT_DAY = daysFromToday(-140);
const RECORDED = daysFromToday(-30);
const CHECKED = daysFromToday(-2);
const FIXTURE_CAPTURE = `https://web.archive.org/web/${CAPTURE_DAY.replace(/-/g, "")}093000/https://settled-ours-fixture-store.example/pricing`;
const LABEL = `recorded ${RECORDED} · corrected ${CHECKED}`;

function fixtureListing(vendor: string) {
  return {
    vendor,
    category: "Databases",
    description: "Free plan: 1 GB of storage and 100 hours a month.",
    tier: "Free",
    url: `https://${toSlug(vendor)}.example/pricing`,
    tags: [],
    verifiedDate: daysFromToday(-5),
    source_check: { checked: daysFromToday(-5), outcome: "ok", detail: `the page names ${vendor} and states the terms we publish` },
  };
}

function oursRecord() {
  return {
    vendor: OURS,
    change_type: "record_corrected",
    date: RECORDED,
    summary: differenceInOurTextSummary({ vendor: OURS, capture_day: CAPTURE_DAY, text_day: TEXT_DAY, record_date: RECORDED }),
    previous_state: `limits_reduced dated ${RECORDED}`,
    current_state: "the same record, as our own error",
    impact: "low",
    source_url: `https://${toSlug(OURS)}.example/pricing`,
    category: "Databases",
    alternatives: [],
    recorded_date: RECORDED,
    date_source: "discovered",
    archive_check: {
      checked: CHECKED,
      outcome: "ours",
      capture_day: CAPTURE_DAY,
      recorded_as: "limits_reduced",
      capture: FIXTURE_CAPTURE,
      stated_then: "Free plan: 1 GB of storage",
    },
  };
}

function startServer(env: NodeJS.ProcessEnv): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 120000);
    child.stderr!.on("data", (data: Buffer) => {
      const found = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(found[1]!, 10) }); }
    });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

function decoded(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&middot;/g, "·")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const COMPARE_TOOL_CONSTANTS =
  /var (?:EFFECTIVE_DATE_PREFIX|DISCOVERED_DATE_PREFIX|UNKNOWN_EFFECTIVE_DATE_MARKER|EFFECTIVE_BY_DATE_MEANING|BRACKETED_DATE_PREFIX|RECORDED_DATE_PREFIX|CORRECTED_DATE_PREFIX|CORRECTION_TO_OUR_OWN_RECORD|OURS_ARCHIVE_OUTCOME) = [^;]+;/g;

describe("every surface that dates a record the archive check settled as ours", () => {
  let tmp = "";
  let server: { proc: ChildProcess; port: number } | undefined;
  const get = async (route: string) => fetch(`http://localhost:${server!.port}${route}`);

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "settled-as-our-error-"));
    const index = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    index.offers.push(fixtureListing(OURS), fixtureListing(CONTROL));
    const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
    changes.changes.push(oursRecord());
    writeFileSync(path.join(tmp, "index.json"), JSON.stringify(index));
    writeFileSync(path.join(tmp, "deal_changes.json"), JSON.stringify(changes));
    server = await startServer({
      AGENTDEALS_INDEX_PATH: path.join(tmp, "index.json"),
      AGENTDEALS_CHANGES_PATH: path.join(tmp, "deal_changes.json"),
    });
  });

  after(() => {
    server?.proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  for (const route of [`/vendor/${toSlug(OURS)}`, "/changes", "/pricing-changes"]) {
    it(`labels the record on ${route} by the day we recorded it and the day we corrected it`, async () => {
      const page = decoded(await (await get(route)).text());
      const at = page.indexOf(`Not a change by ${OURS}.`);
      assert.ok(at >= 0, `${route} does not list the record`);
      const row = page.slice(Math.max(0, at - 300), at);
      assert.ok(row.includes(LABEL), `${route} does not print ${LABEL} beside the record: ${row}`);
    });
  }

  it("dates the record's feed entry by the same two days", async () => {
    const feed = await (await get(`/pricing-changes/feed.xml?vendor=${encodeURIComponent(OURS)}`)).text();
    const summaries = [...feed.matchAll(/<summary>([^<]*)<\/summary>/g)].map((m) => m[1]!);
    assert.ok(summaries.some((summary) => summary.startsWith(`${LABEL}. Data correction - Not a change by ${OURS}.`)), summaries.join(" | "));
  });

  it("serves the check's copy, the line it states and the type our re-read recorded on /api/changes", async () => {
    const body = await (await get(`/api/changes?vendor=${encodeURIComponent(OURS)}&since=2020-01-01`)).json();
    const entry = body.changes.find((c: { vendor: string }) => c.vendor === OURS);
    assert.ok(entry, JSON.stringify(body).slice(0, 300));
    assert.strictEqual(entry.date_meaning, "discovered");
    assert.deepStrictEqual(entry.archive_check, oursRecord().archive_check);
  });

  it("labels the record in the compare tool's browser code as the server labels it", async () => {
    const tool = await (await get("/compare-tool")).text();
    const constants = [...tool.matchAll(COMPARE_TOOL_CONSTANTS)];
    const labeller = tool.match(/function changeEntryDateLabel\(c\) \{[\s\S]*?\n  \}/);
    assert.ok(labeller && constants.length === 9, "the compare tool no longer labels dates in the browser");
    const label = new Function(`${constants.map((m) => m[0]).join("\n")}\n${labeller![0]}\nreturn changeEntryDateLabel;`)();
    const compared = await (await get(`/api/compare?a=${encodeURIComponent(OURS)}&b=${encodeURIComponent(CONTROL)}`)).json();
    const served = compared.vendor_a.deal_changes.find((c: { change_type: string }) => c.change_type === "record_corrected");
    assert.ok(served, JSON.stringify(compared).slice(0, 300));
    assert.strictEqual(label(served), LABEL);
  });
});
