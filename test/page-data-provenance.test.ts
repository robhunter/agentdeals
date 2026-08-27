import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOGUE_TEXT_FIELDS, CHANGE_LOG_TEXT_FIELDS, PAGE_DATA_SOURCES, UNSOURCED_TIER_A_BASELINE,
  pageSourceViolations, parsePageReviews, perturbTextFields, unsourcedTierAPaths, vendorFactRows,
  type PageReviewRecord, type PageSourceMeasurement,
} from "../src/page-reviews.ts";
import { namedVendorSlug } from "../dist/vendor-slug.js";
import { NEVER_REVIEWED, registerWith, reviewFailedOn, type RegisterFixture } from "./page-review-fixture.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const INDEX_CITATION = /our (?:verified )?index of/i;
const VERIFICATION_CLAIM = /\b(?:verified|cross-referenced) against\b/i;
const NAMES_A_YEAR = /\b(?:19|20)\d{2}\b/;
const COMPILED_NOTICE = /Figures compiled (\d{4}-\d{2}-\d{2}), (?:not re-checked since|last checked (\d{4}-\d{2}-\d{2}))/;

function registeredPages(): PageReviewRecord[] {
  return parsePageReviews(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8")).pages;
}

function perturbStore(name: string, key: string, fields: string[], target: string): number {
  const data = JSON.parse(readFileSync(path.join(REPO, "data", name), "utf-8"));
  const touched = perturbTextFields(data[key], fields);
  writeFileSync(target, JSON.stringify(data));
  return touched;
}

function startServer(env: NodeJS.ProcessEnv): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000", ...env },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc: child, port: parseInt(m[1], 10) });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function visibleBody(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ");
}

function visibleSentences(html: string): string[] {
  const text = visibleBody(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ");
  return text.split(/(?<!\b[a-z]{1,4})\.\s+(?=[A-Z"“])/).map((s) => s.trim()).filter(Boolean);
}

describe("a page may only name the source it actually reads", () => {
  let tmp: string;
  let real: { proc: ChildProcess; port: number };
  let perturbed: { proc: ChildProcess; port: number };
  let changesBlind: { proc: ChildProcess; port: number };
  const pages = registeredPages();
  const bodies = new Map<string, string>();
  const consumesIndex = new Map<string, boolean>();
  const measured = new Map<string, PageSourceMeasurement>();

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "page-data-provenance-"));
    const perturbedIndex = path.join(tmp, "index.json");
    const perturbedChanges = path.join(tmp, "deal_changes.json");
    const touchedIndex = perturbStore("index.json", "offers", CATALOGUE_TEXT_FIELDS, perturbedIndex);
    const touchedChanges = perturbStore("deal_changes.json", "changes", CHANGE_LOG_TEXT_FIELDS, perturbedChanges);
    assert.ok(touchedIndex > 1000, `perturbed only ${touchedIndex} catalogue fields, so the comparison below proves nothing`);
    assert.ok(touchedChanges > 100, `perturbed only ${touchedChanges} change-log fields, so the comparison below proves nothing`);
    [real, perturbed, changesBlind] = await Promise.all([
      startServer({}),
      startServer({ AGENTDEALS_INDEX_PATH: perturbedIndex }),
      startServer({ AGENTDEALS_CHANGES_PATH: perturbedChanges }),
    ]);
    for (const page of pages) {
      const [a, b, c] = await Promise.all([
        fetch(`http://localhost:${real.port}${page.path}`).then((r) => r.text()),
        fetch(`http://localhost:${perturbed.port}${page.path}`).then((r) => r.text()),
        fetch(`http://localhost:${changesBlind.port}${page.path}`).then((r) => r.text()),
      ]);
      bodies.set(page.path, a);
      consumesIndex.set(page.path, a !== b);
      measured.set(page.path, {
        reads_index: a !== b,
        reads_changes: a !== c,
        vendor_fact_rows: vendorFactRows(a, namedVendorSlug).length,
      });
    }
  });

  after(() => {
    real?.proc.kill();
    perturbed?.proc.kill();
    changesBlind?.proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("measures readership by perturbing the catalogue, not by trusting the register", () => {
    const reading = pages.filter((p) => consumesIndex.get(p.path));
    assert.ok(reading.length > 5, `only ${reading.length} pages responded to the catalogue at all`);
    assert.ok(reading.length < pages.length, "every page responded, so the measurement cannot distinguish anything");
    const wrong = pages.filter((p) => p.reads_index !== consumesIndex.get(p.path));
    assert.deepStrictEqual(
      wrong.map((p) => `${p.path} register=${p.reads_index} measured=${consumesIndex.get(p.path)}`),
      []
    );
  });

  it("measures the change log separately, because a page blind to the catalogue may still render records", () => {
    const readingChanges = pages.filter((p) => measured.get(p.path)!.reads_changes);
    assert.ok(readingChanges.length > 5, `only ${readingChanges.length} pages responded to the change log at all`);
    assert.ok(readingChanges.length < pages.length, "every page responded, so the measurement cannot distinguish anything");
    const blindToCatalogue = pages.filter((p) => !p.reads_index);
    const alsoReadingChanges = blindToCatalogue.filter((p) => measured.get(p.path)!.reads_changes);
    assert.ok(
      alsoReadingChanges.length > blindToCatalogue.length / 2,
      "most pages blind to the catalogue read the change log, so the two measurements must stay distinct"
    );
  });

  it("declares a data source for every registered page, and no page may assert one the render denies", () => {
    assert.deepStrictEqual(
      pages.filter((p) => !PAGE_DATA_SOURCES.includes(p.data_source)).map((p) => p.path),
      []
    );
    assert.deepStrictEqual(pageSourceViolations(pages, measured).map((v) => `${v.path} ${v.problem}`), []);
  });

  it("holds the number of tier-A pages that assert vendor facts and read no catalogue record, and cannot admit another", () => {
    const unsourced = unsourcedTierAPaths(pages);
    assert.strictEqual(unsourced.length, UNSOURCED_TIER_A_BASELINE);
    const admitted = [...pages, {
      ...pages.find((p) => p.tier === "A")!,
      path: "/a-page-that-does-not-exist",
      data_source: "unsourced" as const,
      reads_index: false,
      reads_changes: false,
    }];
    const withOneMore = new Map(measured);
    withOneMore.set("/a-page-that-does-not-exist", { reads_index: false, reads_changes: false, vendor_fact_rows: 0 });
    assert.ok(
      pageSourceViolations(admitted, withOneMore).length > 0,
      "a forty-fourth unsourced tier-A page passed, so the ratchet allows the number to grow"
    );
  });

  it("refuses an editorial exemption on a page that puts a number beside a vendor", () => {
    const withFalseExemption = pages.map((p) =>
      p.path === "/storage-comparison-2026"
        ? { ...p, data_source: "editorial" as const, data_source_reason: "no vendor facts here" }
        : p
    );
    const problems = pageSourceViolations(withFalseExemption, measured, UNSOURCED_TIER_A_BASELINE - 1);
    assert.ok(
      problems.some((v) => v.path === "/storage-comparison-2026" && v.problem.includes("table rows")),
      `the exemption was accepted on a comparison page: ${JSON.stringify(problems)}`
    );
  });

  it("counts vendor fact rows on the pages the exemption exists for, so the check is not passing on an empty page", () => {
    const editorial = pages.filter((p) => p.data_source === "editorial");
    assert.ok(editorial.length > 0, "no page declares the editorial exemption, so nothing exercises it");
    for (const page of editorial) {
      assert.ok(page.data_source_reason, `${page.path} claims the exemption without saying why`);
      assert.ok(bodies.get(page.path)!.length > 1000, `${page.path} rendered almost nothing, so its zero fact rows prove nothing`);
    }
    const measuredRows = pages.filter((p) => measured.get(p.path)!.vendor_fact_rows > 0);
    assert.ok(
      measuredRows.length > 20,
      `only ${measuredRows.length} pages were found to put a number beside a vendor, so the exemption check has almost nothing to refuse`
    );
  });

  it("names our index as a source only on the pages that read it", () => {
    const offenders: string[] = [];
    for (const page of pages) {
      if (page.reads_index) continue;
      for (const sentence of visibleSentences(bodies.get(page.path)!)) {
        if (INDEX_CITATION.test(sentence)) offenders.push(`${page.path}: ${sentence}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("still names the index on the pages that do read it, so the rule above is not vacuous", () => {
    const citing = pages.filter(
      (p) => p.reads_index && visibleSentences(bodies.get(p.path)!).some((s) => INDEX_CITATION.test(s))
    );
    assert.ok(citing.length >= 5, `only ${citing.length} pages cite the index, so the check has almost nothing to allow`);
  });

  it("dates every verification claim a page cannot support from a record", () => {
    const offenders: string[] = [];
    for (const page of pages) {
      if (page.reads_index) continue;
      for (const sentence of visibleSentences(bodies.get(page.path)!)) {
        if (VERIFICATION_CLAIM.test(sentence) && !NAMES_A_YEAR.test(sentence)) {
          offenders.push(`${page.path}: ${sentence}`);
        }
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("tells the reader when the figures were compiled on every page that renders no catalogue field", () => {
    const wrong: string[] = [];
    for (const page of pages) {
      if (page.reads_index || page.tier !== "A") continue;
      const found = visibleBody(bodies.get(page.path)!).match(COMPILED_NOTICE);
      if (!found) wrong.push(`${page.path}: no compiled notice`);
      else if (found[1] !== page.published) wrong.push(`${page.path}: notice says ${found[1]}, compiled ${page.published}`);
    }
    assert.deepStrictEqual(wrong, []);
  });

  it("says a reviewed page was checked on the date of the review, rather than never since publication", () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const page of pages) {
      if (page.reads_index || page.tier !== "A") continue;
      const found = visibleBody(bodies.get(page.path)!).match(COMPILED_NOTICE)!;
      const claimed = found[2] ?? null;
      const expected = page.reviewed_at;
      if (claimed !== expected) wrong.push(`${page.path}: notice says last checked ${claimed}, register says ${expected}`);
      if (expected !== null) checked += 1;
    }
    assert.deepStrictEqual(wrong, []);
    assert.ok(checked > 0, "no blind tier-A page carries a review date, so the branch above is never taken");
  });

  it("makes no re-check claim anywhere on a page that the register contradicts", () => {
    const offenders: string[] = [];
    let claiming = 0;
    for (const page of pages) {
      const body = visibleBody(bodies.get(page.path)!);
      const saysNever = /not re-checked since/.test(body);
      const saysChecked = /last checked (\d{4}-\d{2}-\d{2})/.exec(body);
      if (saysNever || saysChecked) claiming += 1;
      if (page.reviewed_at === null && saysChecked) {
        offenders.push(`${page.path}: claims a check on ${saysChecked[1]} with no review on the register`);
      }
      if (page.reviewed_at !== null && saysNever) {
        offenders.push(`${page.path}: says it was never re-checked, reviewed ${page.reviewed_at}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
    assert.ok(claiming > 20, `only ${claiming} pages make a re-check claim at all, so the rule has almost nothing to check`);
  });

  it("says corrections are outstanding wherever a review recorded a failure, and nowhere else", () => {
    const failing = pages.filter((p) => p.review_outcome === "fail").map((p) => p.path);
    const saying = pages.filter((p) => /corrections outstanding/.test(visibleBody(bodies.get(p.path)!))).map((p) => p.path);
    assert.deepStrictEqual(saying.sort(), failing.sort());
  });

  it("does not put the compiled notice on a page that reads the catalogue", () => {
    const wrong = pages.filter((p) => p.reads_index && COMPILED_NOTICE.test(visibleBody(bodies.get(p.path)!)));
    assert.deepStrictEqual(wrong.map((p) => p.path), []);
  });
});

describe("a review that found defects reaches the reader", () => {
  const SUBJECT = "/storage-comparison-2026";
  const CONTROL = "/monitoring-comparison-2026";
  const REVIEWED_ON = "2026-08-26";
  let fixture: RegisterFixture;
  let server: { proc: ChildProcess; port: number };
  const rendered = new Map<string, string>();

  before(async () => {
    fixture = registerWith(REPO, "failed-review-", {
      [SUBJECT]: reviewFailedOn(REVIEWED_ON),
      [CONTROL]: NEVER_REVIEWED,
    });
    server = await startServer({ AGENTDEALS_PAGE_REVIEWS_PATH: fixture.file });
    for (const route of [SUBJECT, CONTROL]) {
      rendered.set(route, await fetch(`http://localhost:${server.port}${route}`).then((r) => r.text()));
    }
  });

  after(() => {
    server?.proc.kill();
    if (fixture) rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("says so on the page whose review failed", () => {
    assert.match(rendered.get(SUBJECT)!, new RegExp(`Reviewed ${REVIEWED_ON}, corrections outstanding`));
  });

  it("names the date the figures were last checked, rather than claiming none has happened", () => {
    const compiled = fixture.row(SUBJECT).published;
    assert.match(rendered.get(SUBJECT)!, new RegExp(`Figures compiled ${compiled}, last checked ${REVIEWED_ON}`));
    assert.doesNotMatch(rendered.get(SUBJECT)!, new RegExp(`Figures compiled ${compiled}, not re-checked since`));
  });

  it("leaves a page the fixture set as never reviewed saying it was never re-checked", () => {
    assert.match(rendered.get(CONTROL)!, /not re-checked since/);
    assert.doesNotMatch(rendered.get(CONTROL)!, /corrections outstanding/);
  });
});
