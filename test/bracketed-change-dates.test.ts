import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toSlug } from "../dist/vendor-slug.js";
import {
  ARCHIVE_CAPTURE_CLASS,
  BRACKETED_CHANGE_DATING,
  archiveBracketOf,
  changeDateClause,
  changeDateLabel,
  changeEntryDateLabel,
  changeEntryDateLabelHtml,
  changeEntryLongDateLabel,
  coveringBracketedChanges,
  dateMeaningOf,
} from "../dist/change-dates.js";
import { feedEntryDateSentence } from "../dist/change-feed.js";
import type { ArchiveBracket, DealChange } from "../dist/types.js";

const LAST_OLD_CAPTURE = "https://web.archive.org/web/20260616093000/https://example.com/pricing";
const FIRST_NEW_CAPTURE = "https://web.archive.org/web/20260828120000/https://example.com/pricing";

const bracket = (over: Partial<ArchiveBracket> = {}): ArchiveBracket => ({
  last_old: "2026-06-16",
  first_new: "2026-08-28",
  last_old_capture: LAST_OLD_CAPTURE,
  first_new_capture: FIRST_NEW_CAPTURE,
  ...over,
});

const discovered = (over: Partial<DealChange> = {}): DealChange => ({
  vendor: "Fixture Vendor",
  change_type: "limits_reduced",
  date: "2026-08-28",
  summary: "Free plan storage cut from 2 GB to 1 GB",
  previous_state: "Free plan: 2 GB",
  current_state: "Free plan: 1 GB",
  impact: "medium",
  source_url: "https://example.com/pricing",
  category: "Databases",
  alternatives: [],
  date_source: "discovered",
  recorded_date: "2026-09-10",
  ...over,
});

const bracketed = (over: Partial<DealChange> = {}): DealChange =>
  discovered({ archive_check: { checked: "2026-10-01", outcome: "vendor_changed", brackets: [bracket()] }, ...over });

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

describe("a discovered change that archived copies of the vendor's page bracket", () => {
  it("runs from the last copy with the old terms to the record's date, with each copy kept", () => {
    assert.deepStrictEqual(archiveBracketOf(bracketed()), {
      from: "2026-06-16",
      to: "2026-08-28",
      from_capture: LAST_OLD_CAPTURE,
      to_capture: FIRST_NEW_CAPTURE,
    });
  });

  it("has no bracket unless the check found one vendor change between two copies", () => {
    assert.strictEqual(archiveBracketOf(discovered()), null);
    for (const outcome of ["ours", "removal_stated_before", "no_usable_capture", "text_day_unknown", "page_unreadable_today"] as const) {
      assert.strictEqual(archiveBracketOf(bracketed({ archive_check: { checked: "2026-10-01", outcome, brackets: [bracket()] } })), null, outcome);
    }
    assert.strictEqual(archiveBracketOf(bracketed({ archive_check: { checked: "2026-10-01", outcome: "vendor_changed", brackets: [] } })), null);
    const twoMoves = [bracket({ first_new: "2026-07-01" }), bracket({ last_old: "2026-07-20" })];
    assert.strictEqual(archiveBracketOf(bracketed({ archive_check: { checked: "2026-10-01", outcome: "vendor_changed", brackets: twoMoves } })), null);
  });

  it("keeps a vendor-dated record's own date, whatever its archive check says", () => {
    const vendorDated = bracketed({ date_source: "vendor_page" });
    assert.strictEqual(archiveBracketOf(vendorDated), null);
    assert.strictEqual(dateMeaningOf(vendorDated), "effective");
    assert.strictEqual(changeEntryDateLabel(vendorDated), "effective 2026-08-28");
  });

  it("means the latest day the change can have taken effect", () => {
    assert.strictEqual(dateMeaningOf(bracketed()), "effective_by");
    assert.strictEqual(dateMeaningOf(discovered()), "discovered");
  });

  it("is labelled effective between its two days, short and long", () => {
    assert.strictEqual(changeDateLabel(bracketed()), "effective between 2026-06-16 and 2026-08-28");
    assert.strictEqual(changeEntryDateLabel(bracketed()), "effective between 2026-06-16 and 2026-08-28");
    assert.strictEqual(changeDateClause(bracketed()), "effective between 2026-06-16 and 2026-08-28");
    assert.strictEqual(changeEntryLongDateLabel(bracketed()), "effective between Jun\u00a016,\u00a02026 and Aug\u00a028,\u00a02026");
    assert.strictEqual(changeEntryDateLabel(discovered()), "discovered 2026-08-28 \u00b7 effective date unknown");
  });

  it("links each day to the archived copy that shows it, where the check kept the copy", () => {
    const html = changeEntryDateLabelHtml(bracketed(), esc);
    assert.strictEqual(
      html,
      `effective between <a href="${LAST_OLD_CAPTURE}" target="_blank" rel="noopener" class="${ARCHIVE_CAPTURE_CLASS}">2026-06-16</a>` +
        ` and <a href="${FIRST_NEW_CAPTURE}" target="_blank" rel="noopener" class="${ARCHIVE_CAPTURE_CLASS}">2026-08-28</a>`,
    );
    const uncaptured = bracketed({ archive_check: { checked: "2026-10-01", outcome: "vendor_changed", brackets: [bracket({ first_new_capture: null })] } });
    assert.ok(changeEntryDateLabelHtml(uncaptured, esc).endsWith(" and 2026-08-28"), changeEntryDateLabelHtml(uncaptured, esc));
    assert.strictEqual(changeEntryDateLabelHtml(discovered(), esc), esc(changeEntryDateLabel(discovered())));
  });

  it("is dated in the feed by its bracket and the day we recorded it", () => {
    assert.strictEqual(feedEntryDateSentence(bracketed()), "effective between 2026-06-16 and 2026-08-28 \u00b7 recorded 2026-09-10.");
    assert.ok(feedEntryDateSentence(discovered()).startsWith("discovered 2026-08-28 \u00b7 effective date unknown"));
  });
});

describe("a note about undated changes that covers a bracketed one", () => {
  const note = "We hold no effective date for these changes.";

  it("says how the bracketed change is dated", () => {
    assert.strictEqual(
      BRACKETED_CHANGE_DATING,
      "Where archived copies of the vendor's page bracket a change, it is dated by the first copy that shows the new terms.",
    );
    assert.strictEqual(coveringBracketedChanges(note, [discovered(), bracketed()]), `${note} ${BRACKETED_CHANGE_DATING}`);
  });

  it("is left as it was where it covers no bracketed change", () => {
    assert.strictEqual(coveringBracketedChanges(note, [discovered()]), note);
    assert.strictEqual(coveringBracketedChanges(note, []), note);
  });
});

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 86_400_000;
const daysFromToday = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

const BRACKETED = "Bracketed Change Fixture Store";
const CONTROL = "Bracketed Change Control Store";
const LAST_OLD = daysFromToday(-60);
const FIRST_NEW = daysFromToday(-20);
const RECORDED = daysFromToday(-10);
const OLD_COPY = `https://web.archive.org/web/${LAST_OLD.replace(/-/g, "")}093000/https://bracketed-change-fixture-store.example/pricing`;
const NEW_COPY = `https://web.archive.org/web/${FIRST_NEW.replace(/-/g, "")}120000/https://bracketed-change-fixture-store.example/pricing`;

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

function bracketedRecord() {
  return {
    vendor: BRACKETED,
    change_type: "limits_reduced",
    date: FIRST_NEW,
    summary: "Free plan storage cut from 2 GB to 1 GB.",
    previous_state: "Free plan: 2 GB of storage and 100 hours a month.",
    current_state: "Free plan: 1 GB of storage and 100 hours a month.",
    impact: "medium",
    source_url: `https://${toSlug(BRACKETED)}.example/pricing`,
    category: "Databases",
    alternatives: [],
    recorded_date: RECORDED,
    date_source: "discovered",
    archive_check: {
      checked: daysFromToday(-5),
      outcome: "vendor_changed",
      brackets: [{ last_old: LAST_OLD, first_new: FIRST_NEW, last_old_capture: OLD_COPY, first_new_capture: NEW_COPY }],
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
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&middot;/g, "\u00b7")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("every surface that dates a bracketed change", () => {
  let tmp = "";
  let server: { proc: ChildProcess; port: number } | undefined;
  const get = async (route: string) => fetch(`http://localhost:${server!.port}${route}`);
  const linkedLabel =
    `effective between <a href="${OLD_COPY}" target="_blank" rel="noopener" class="${ARCHIVE_CAPTURE_CLASS}">${LAST_OLD}</a>` +
    ` and <a href="${NEW_COPY}" target="_blank" rel="noopener" class="${ARCHIVE_CAPTURE_CLASS}">${FIRST_NEW}</a>`;

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "bracketed-change-dates-"));
    const index = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    index.offers.push(fixtureListing(BRACKETED), fixtureListing(CONTROL));
    const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
    changes.changes.push(bracketedRecord());
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

  it("labels the vendor page's history row with both days", async () => {
    const page = decoded(await (await get(`/vendor/${toSlug(BRACKETED)}`)).text());
    assert.ok(page.includes(`effective between ${LAST_OLD} and ${FIRST_NEW}`), "the history row prints the bracket");
    assert.ok(!page.includes(`discovered ${FIRST_NEW}`), "the history row still prints the bracketed change as discovered");
  });

  for (const route of ["/changes", "/pricing-changes"]) {
    it(`links each day on ${route} to its archived copy and says how the change is dated`, async () => {
      const html = await (await get(route)).text();
      assert.ok(html.includes(linkedLabel), `${route} does not link the bracket to its copies`);
      const undated = html.slice(html.indexOf("month-group-undated"));
      assert.ok(decoded(undated).includes(BRACKETED_CHANGE_DATING), `${route}'s undated note does not say how the bracketed change is dated`);
    });
  }

  it("declares the date effective_by on /api/changes and in the schema", async () => {
    const body = await (await get(`/api/changes?vendor=${encodeURIComponent(BRACKETED)}&since=2020-01-01`)).json();
    const entry = body.changes.find((c: { vendor: string }) => c.vendor === BRACKETED);
    assert.strictEqual(entry?.date_meaning, "effective_by", JSON.stringify(body).slice(0, 300));
    assert.strictEqual(entry.date, FIRST_NEW);
    assert.ok(body.date_provenance.note.endsWith(BRACKETED_CHANGE_DATING), body.date_provenance.note);
    const schema = JSON.parse(await (await get("/openapi.json")).text());
    const meaning = schema.components.schemas.PublishedDealChange.allOf[1].properties.date_meaning;
    assert.ok(meaning.enum.includes("effective_by"), JSON.stringify(meaning.enum));
    assert.match(meaning.description, /"effective_by": the latest day the change can have taken effect\./);
    const brackets = schema.components.schemas.PublishedDealChange.allOf[1].properties.archive_check.properties.brackets;
    assert.deepStrictEqual(Object.keys(brackets.items.properties), Object.keys(bracketedRecord().archive_check.brackets[0]));
    assert.match(brackets.description, /date_meaning is effective_by: the change took effect after last_old and on or before date\./);
  });

  it("carries the archive check on the risk cause it rates the vendor by, so its date can be read", async () => {
    const risk = await (await get(`/api/vendor-risk/${encodeURIComponent(BRACKETED)}`)).json();
    assert.strictEqual(risk.risk_cause?.date, FIRST_NEW, JSON.stringify(risk).slice(0, 300));
    assert.deepStrictEqual(risk.risk_cause.archive_check, bracketedRecord().archive_check);
    const schema = JSON.parse(await (await get("/openapi.json")).text());
    const cause = schema.paths["/api/vendor-risk/{vendor}"].get.responses["200"].content["application/json"].schema.properties.risk_cause;
    assert.deepStrictEqual(
      cause.properties.archive_check,
      schema.components.schemas.PublishedDealChange.allOf[1].properties.archive_check,
    );
  });

  for (const route of ["/free-tier-risk", "/state-of-free-tiers"]) {
    it(`says how the bracketed change is dated where ${route} counts undated changes by month`, async () => {
      assert.ok(decoded(await (await get(route)).text()).includes(BRACKETED_CHANGE_DATING), route);
    });
  }

  it("labels the change in the compare tool's browser code as the server labels it", async () => {
    const tool = await (await get("/compare-tool")).text();
    const constants = [...tool.matchAll(/var (?:EFFECTIVE_DATE_PREFIX|DISCOVERED_DATE_PREFIX|UNKNOWN_EFFECTIVE_DATE_MARKER|EFFECTIVE_BY_DATE_MEANING|BRACKETED_DATE_PREFIX|RECORDED_DATE_PREFIX|CORRECTED_DATE_PREFIX|CORRECTION_TO_OUR_OWN_RECORD|OURS_ARCHIVE_OUTCOME) = [^;]+;/g)];
    const labeller = tool.match(/function changeEntryDateLabel\(c\) \{[\s\S]*?\n  \}/);
    assert.ok(labeller && constants.length === 9, "the compare tool no longer labels dates in the browser");
    const label = new Function(`${constants.map((m) => m[0]).join("\n")}\n${labeller![0]}\nreturn changeEntryDateLabel;`)();
    const compared = await (await get(`/api/compare?a=${encodeURIComponent(BRACKETED)}&b=${encodeURIComponent(CONTROL)}`)).json();
    const served = compared.vendor_a.deal_changes.find((c: { date: string }) => c.date === FIRST_NEW);
    assert.ok(served, JSON.stringify(compared).slice(0, 300));
    assert.strictEqual(label(served), `effective between ${LAST_OLD} and ${FIRST_NEW}`);
  });
});
