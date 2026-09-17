import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertCoversPopulation, assertPopulationFloor, pagesOnTheReviewRegister } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOGUE_TEXT_FIELDS, CHANGE_LOG_TEXT_FIELDS, PAGE_DATA_SOURCES, PERTURBATION_SENTINEL,
  OUR_RECORDS_FOR, citesOurRecords, deniesTheCatalogueSupplied, everyFigureComesFromOurRecords, partialRecordsCitation,
  pageSourceViolations, parsePageReviews, perturbTextFields, readableTableText, readableText,
  unsourcedTierAPaths, vendorFactRows,
  type PageReviewRecord, type PageSourceMeasurement,
} from "../src/page-reviews.ts";
import { censusTableFigures } from "../dist/table-figures.js";
import { namedVendorSlug } from "../dist/vendor-slug.js";
import { NEVER_REVIEWED, registerWith, reviewFailedOn, type RegisterFixture } from "./page-review-fixture.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const INDEX_CITATION = /our (?:verified )?index of/i;
const VERIFICATION_CLAIM = /\b(?:verified|cross-referenced) against\b/i;
const NAMES_A_YEAR = /\b(?:19|20)\d{2}\b/;
const COMPILED_NOTICE = /Figures compiled (\d{4}-\d{2}-\d{2})(?:, (?:not re-checked since|last checked (\d{4}-\d{2}-\d{2})))?/;

const INDEX_SIZE: number = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers.length;

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

function statesProvenance(html: string): boolean {
  return citesOurRecords(html, INDEX_SIZE) || COMPILED_NOTICE.test(visibleBody(html));
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
  let bothBlind: { proc: ChildProcess; port: number };
  const pages = registeredPages();
  const bodies = new Map<string, string>();
  const perturbedBodies = new Map<string, string>();
  const consumesIndex = new Map<string, boolean>();
  const measured = new Map<string, PageSourceMeasurement>();

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "page-data-provenance-"));
    const perturbedIndex = path.join(tmp, "index.json");
    const perturbedChanges = path.join(tmp, "deal_changes.json");
    const touchedIndex = perturbStore("index.json", "offers", CATALOGUE_TEXT_FIELDS, perturbedIndex);
    const touchedChanges = perturbStore("deal_changes.json", "changes", CHANGE_LOG_TEXT_FIELDS, perturbedChanges);
    assertPopulationFloor(touchedIndex, 1001, "catalogue fields perturbed for the comparison below");
    assertPopulationFloor(touchedChanges, 101, "change-log fields perturbed for the comparison below");
    [real, perturbed, changesBlind, bothBlind] = await Promise.all([
      startServer({}),
      startServer({ AGENTDEALS_INDEX_PATH: perturbedIndex }),
      startServer({ AGENTDEALS_CHANGES_PATH: perturbedChanges }),
      startServer({ AGENTDEALS_INDEX_PATH: perturbedIndex, AGENTDEALS_CHANGES_PATH: perturbedChanges }),
    ]);
    for (const page of pages) {
      const [a, b, c, d] = await Promise.all([
        fetch(`http://localhost:${real.port}${page.path}`).then((r) => r.text()),
        fetch(`http://localhost:${perturbed.port}${page.path}`).then((r) => r.text()),
        fetch(`http://localhost:${changesBlind.port}${page.path}`).then((r) => r.text()),
        fetch(`http://localhost:${bothBlind.port}${page.path}`).then((r) => r.text()),
      ]);
      bodies.set(page.path, a);
      perturbedBodies.set(page.path, b);
      consumesIndex.set(page.path, a !== b);
      measured.set(page.path, {
        reads_index: a !== b,
        tables_read_index: readableTableText(a) !== readableTableText(b),
        ...censusTableFigures(a, d),
        reads_changes: a !== c,
        vendor_fact_rows: vendorFactRows(a, namedVendorSlug).length,
      });
    }
  });

  after(() => {
    real?.proc.kill();
    perturbed?.proc.kill();
    changesBlind?.proc.kill();
    bothBlind?.proc.kill();
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
    assert.deepStrictEqual(
      pageSourceViolations(pages, measured, unsourcedTierAPaths(pages).length).map((v) => `${v.path} ${v.problem}`),
      []
    );
  });

  it("cannot admit one more tier-A page that asserts vendor facts and reads no catalogue record", () => {
    const unsourced = unsourcedTierAPaths(pages);
    assert.ok(unsourced.length > 0, "no page on the register is unsourced, so nothing here is exercised");
    const admitted = [...pages, {
      ...pages.find((p) => p.tier === "A")!,
      path: "/a-page-that-does-not-exist",
      data_source: "unsourced" as const,
      reads_index: false,
      tables_read_index: false,
      table_figures: 0,
      table_figures_from_records: 0,
      reads_changes: false,
    }];
    const withOneMore = new Map(measured);
    withOneMore.set("/a-page-that-does-not-exist", {
      reads_index: false, tables_read_index: false, table_figures: 0, table_figures_from_records: 0,
      reads_changes: false, vendor_fact_rows: 0,
    });
    assert.ok(
      pageSourceViolations(admitted, withOneMore, unsourced.length).length > 0,
      `a ${unsourced.length + 1}th unsourced tier-A page passed, so the ratchet allows the number to grow`
    );
  });

  it("refuses an editorial exemption on a page that puts a number beside a vendor", () => {
    const withFalseExemption = pages.map((p) =>
      p.path === "/storage-comparison-2026"
        ? { ...p, data_source: "editorial" as const, data_source_reason: "no vendor facts here" }
        : p
    );
    const problems = pageSourceViolations(withFalseExemption, measured, unsourcedTierAPaths(pages).length - 1);
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
      assertPopulationFloor(bodies.get(page.path)!.length, 1001, `characters of rendered body on ${page.path}`);
    }
    const measuredRows = pages.filter((p) => measured.get(p.path)!.vendor_fact_rows > 0);
    assert.ok(
      measuredRows.length > 20,
      `only ${measuredRows.length} pages were found to put a number beside a vendor, so the exemption check has almost nothing to refuse`
    );
  });

  it("names the catalogue alone nowhere, because a page's figures come from the change log as often as from it", () => {
    const offenders: string[] = [];
    for (const page of pages) {
      for (const sentence of visibleSentences(bodies.get(page.path)!)) {
        if (INDEX_CITATION.test(sentence)) offenders.push(`${page.path}: ${sentence}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("names the source where the figures came from one, so the rule above is not vacuous", () => {
    const naming = pages.filter(
      (p) => p.table_figures_from_records > 0 && readableText(bodies.get(p.path)!).includes(OUR_RECORDS_FOR)
    );
    assertPopulationFloor(naming.length, 34, "registered pages naming the records their table figures came from");
    const silent = pages.filter(
      (p) => p.table_figures_from_records === 0 && readableText(bodies.get(p.path)!).includes(OUR_RECORDS_FOR)
    );
    assert.deepStrictEqual(silent.map((p) => p.path), []);
  });

  it("claims every figure came from our records only where every figure did", () => {
    const overclaiming = pages
      .filter((p) => citesOurRecords(bodies.get(p.path)!, INDEX_SIZE))
      .filter((p) => !everyFigureComesFromOurRecords(measured.get(p.path)!))
      .map((p) => `${p.path}: ${measured.get(p.path)!.table_figures_from_records} of ${measured.get(p.path)!.table_figures} table figures move with our stores`);
    assert.deepStrictEqual(overclaiming, []);
  });

  it("states the proportion the perturbation measured wherever the figures are mixed", () => {
    const wrong: string[] = [];
    let stating = 0;
    for (const page of pages) {
      const seen = measured.get(page.path)!;
      const body = readableText(bodies.get(page.path)!);
      const mixed = seen.table_figures_from_records > 0 && !everyFigureComesFromOurRecords(seen);
      const stated = body.match(/(\d+) of (\d+) figures in the tables below come from our records for/);
      if (!mixed) {
        if (stated) wrong.push(`${page.path}: states ${stated[1]} of ${stated[2]} and its figures are not mixed`);
        continue;
      }
      if (!stated) continue;
      stating += 1;
      if (Number(stated[1]) !== seen.table_figures_from_records || Number(stated[2]) !== seen.table_figures) {
        wrong.push(`${page.path}: states ${stated[1]} of ${stated[2]}, the perturbation says ${seen.table_figures_from_records} of ${seen.table_figures}`);
      }
    }
    assert.deepStrictEqual(wrong, []);
    assert.ok(stating >= 5, `only ${stating} pages state a proportion, so the rule has almost nothing to check`);
  });

  it("puts the proportion where the reader is, not only in the register", () => {
    const mixedAndPublishing = pages.filter(
      (p) => p.table_figures_from_records > 0
        && !everyFigureComesFromOurRecords(p)
        && readableText(bodies.get(p.path)!).includes(OUR_RECORDS_FOR)
    );
    const silent = mixedAndPublishing
      .filter((p) => !readableText(bodies.get(p.path)!).includes(
        partialRecordsCitation(p.table_figures_from_records, p.table_figures, INDEX_SIZE)
      ))
      .map((p) => p.path);
    assert.deepStrictEqual(silent, []);
    assert.ok(
      mixedAndPublishing.length >= 5,
      `only ${mixedAndPublishing.length} mixed pages name our index, so the rule reaches almost nothing`
    );
  });

  it("keeps the unqualified claim on every page that earns it", () => {
    const earned = pages.filter((p) => everyFigureComesFromOurRecords(measured.get(p.path)!));
    assertPopulationFloor(earned.length, 6, "registered pages whose every table figure moves with our stores");
    const silenced = earned
      .filter((p) => statesProvenance(bodies.get(p.path)!) && !citesOurRecords(bodies.get(p.path)!, INDEX_SIZE))
      .map((p) => p.path);
    assert.deepStrictEqual(silenced, []);
  });

  it("offers no verification claim beside a byline saying the page was never reviewed", () => {
    const contradicting: string[] = [];
    for (const page of pages) {
      const byline = bodies.get(page.path)!.match(/<p class="pub-date"[^>]*>[\s\S]*?<\/p>/g) ?? [];
      for (const line of byline.map(readableText)) {
        if (/Not yet reviewed/.test(line) && /\bverified\b/i.test(line)) contradicting.push(`${page.path}: ${line}`);
      }
    }
    assert.deepStrictEqual(contradicting, []);
    const neverReviewed = pages.filter((p) => p.reviewed_at === null);
    assert.ok(neverReviewed.length > 10, `only ${neverReviewed.length} pages are unreviewed, so the pairing can barely arise`);
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

  function datesItsOwnCompilation(page: PageReviewRecord): boolean {
    if (page.tier !== "A" || everyFigureComesFromOurRecords(page)) return false;
    return !page.tables_read_index || statesProvenance(bodies.get(page.path)!);
  }

  it("tells the reader when the figures were compiled on every page it did not wholly supply", () => {
    const wrong: string[] = [];
    for (const page of pages.filter(datesItsOwnCompilation)) {
      const found = visibleBody(bodies.get(page.path)!).match(COMPILED_NOTICE);
      if (!found) wrong.push(`${page.path}: no compiled notice`);
      else if (found[1] !== page.published) wrong.push(`${page.path}: notice says ${found[1]}, compiled ${page.published}`);
    }
    assert.deepStrictEqual(wrong, []);
    assertPopulationFloor(
      pages.filter(datesItsOwnCompilation).length,
      34,
      "tier-A pages carrying a compiled notice because our records do not supply every figure they publish",
    );
  });

  it("offers a check date only where the review that made it cleared the page, and never claims none has happened on a page a review read", () => {
    const wrong: string[] = [];
    let cleared = 0;
    let readWithoutClearing = 0;
    for (const page of pages.filter(datesItsOwnCompilation)) {
      const body = visibleBody(bodies.get(page.path)!);
      const found = body.match(COMPILED_NOTICE)!;
      const claimed = found[2] ?? null;
      const clearedByItsReview = page.reviewed_at !== null && page.review_outcome !== "fail";
      const expected = clearedByItsReview ? page.reviewed_at : null;
      if (claimed !== expected) {
        wrong.push(`${page.path}: notice says last checked ${claimed}, its ${page.review_outcome ?? "absent"} review on ${page.reviewed_at} supports ${expected}`);
      }
      if (page.reviewed_at !== null && /not re-checked since/.test(found[0])) {
        wrong.push(`${page.path}: says none has happened, and a review read it on ${page.reviewed_at}`);
      }
      if (clearedByItsReview) cleared += 1;
      if (page.reviewed_at !== null && !clearedByItsReview) readWithoutClearing += 1;
    }
    assert.deepStrictEqual(wrong, []);
    assert.ok(readWithoutClearing > 0, "no blind tier-A page records a review that found it wrong, so the branch above is never taken");
    assert.strictEqual(cleared + readWithoutClearing > 0, true);
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
      if (page.review_outcome === "fail" && saysChecked) {
        offenders.push(`${page.path}: offers ${saysChecked[1]} as the date it was last checked, and that review found it wrong`);
      }
    }
    assert.deepStrictEqual(offenders, []);
    assert.ok(claiming > 15, `only ${claiming} pages make a re-check claim at all, so the rule has almost nothing to check`);
  });

  it("says corrections are outstanding wherever a review recorded a failure, and nowhere else", () => {
    const failing = pages.filter((p) => p.review_outcome === "fail").map((p) => p.path);
    const saying = pages.filter((p) => /corrections outstanding/.test(visibleBody(bodies.get(p.path)!))).map((p) => p.path);
    assert.deepStrictEqual(saying.sort(), failing.sort());
  });

  it("does not put the compiled notice on a page whose every table figure the catalogue supplies", () => {
    const wrong = pages.filter((p) => everyFigureComesFromOurRecords(p) && COMPILED_NOTICE.test(visibleBody(bodies.get(p.path)!)));
    assert.deepStrictEqual(wrong.map((p) => p.path), []);
  });

  it("never publishes the index byline on a page that also tells the reader the tables were compiled by hand", () => {
    const contradicting = pages
      .filter((p) => citesOurRecords(bodies.get(p.path)!, INDEX_SIZE) && deniesTheCatalogueSupplied(bodies.get(p.path)!))
      .map((p) => p.path);
    assert.deepStrictEqual(contradicting, []);
  });

  it("keeps enough pages saying the tables were compiled by hand for the rule above to have something to catch", () => {
    const denying = pages.filter((p) => deniesTheCatalogueSupplied(bodies.get(p.path)!));
    assertPopulationFloor(denying.length, 18, "registered pages telling the reader their tables were compiled by hand");
    const citing = pages.filter((p) => citesOurRecords(bodies.get(p.path)!, INDEX_SIZE));
    assert.ok(citing.length >= 5, `only ${citing.length} pages cite the index, so the pairing cannot arise`);
  });

  it("gives the index byline to a page it states provenance for exactly when the catalogue moves every figure in its tables", () => {
    const stating = pages.filter((p) => statesProvenance(bodies.get(p.path)!));
    assert.ok(stating.length > 40, `only ${stating.length} pages state provenance at all, so the rule reaches almost nothing`);
    const disagreeing = stating
      .filter((p) => citesOurRecords(bodies.get(p.path)!, INDEX_SIZE) !== everyFigureComesFromOurRecords(measured.get(p.path)!))
      .map((p) => `${p.path} cites=${citesOurRecords(bodies.get(p.path)!, INDEX_SIZE)} figures moving=${measured.get(p.path)!.table_figures_from_records}/${measured.get(p.path)!.table_figures}`);
    assert.deepStrictEqual(disagreeing, []);
    const citing = stating.filter((p) => citesOurRecords(bodies.get(p.path)!, INDEX_SIZE));
    assert.ok(citing.length >= 5, `only ${citing.length} of them cite the index, so one arm of the rule is empty`);
    assert.ok(citing.length < stating.length, "every page stating provenance cites the index, so the other arm is empty");
  });

  it("separates a page whose tables the catalogue supplies from one it only supplies a source link to", () => {
    const linkOnly = pages.filter((p) => measured.get(p.path)!.reads_index && !measured.get(p.path)!.tables_read_index);
    assertPopulationFloor(linkOnly.length, 16, "pages the catalogue reaches without supplying a figure in any table");
    const everySentinelOutsideTables = linkOnly.filter(
      (p) => perturbedBodies.get(p.path)!.includes(PERTURBATION_SENTINEL)
        && !readableTableText(perturbedBodies.get(p.path)!).includes(PERTURBATION_SENTINEL)
    );
    assert.ok(
      everySentinelOutsideTables.length >= 15,
      `only ${everySentinelOutsideTables.length} of those carry perturbed catalogue text outside their tables, so the narrower measurement is not being exercised`
    );
  });

  it("credits a figure our stores moved without printing perturbed text in the table, which no count of that text could find", () => {
    const silentlySourced = pages.filter(
      (p) => measured.get(p.path)!.table_figures_from_records > 0
        && !readableTableText(perturbedBodies.get(p.path)!).includes(PERTURBATION_SENTINEL)
    );
    assert.ok(
      silentlySourced.length > 0,
      "every page we credit prints perturbed catalogue text in its tables, so a sentinel count would do and this measurement is untested"
    );
    const stating = silentlySourced.filter((p) => statesProvenance(bodies.get(p.path)!));
    assert.ok(
      stating.length > 0,
      "no page sourced this way states its provenance, so nothing here exercises the byline"
    );
    for (const page of stating) {
      assert.ok(
        readableText(bodies.get(page.path)!).includes(OUR_RECORDS_FOR),
        `${page.path} names no source for the figures that move with our stores without quoting them`
      );
    }
  });
});

describe("a review that found defects reaches the reader", () => {
  const SUBJECT = "/database-pricing";
  const CONTROL = "/vector-database-pricing";
  const REVIEWED_ON = "2026-08-26";
  const FAILED = new RegExp(`Reviewed ${REVIEWED_ON}, corrections outstanding`);
  const EVERY_FAILED = new RegExp(FAILED.source, "g");
  const pages = registeredPages();
  let fixture: RegisterFixture;
  let server: { proc: ChildProcess; port: number };
  const rendered = new Map<string, string>();

  before(async () => {
    fixture = registerWith(REPO, "failed-review-", {
      ...Object.fromEntries(pages.map((p) => [p.path, reviewFailedOn(REVIEWED_ON)])),
      [CONTROL]: NEVER_REVIEWED,
    });
    server = await startServer({ AGENTDEALS_PAGE_REVIEWS_PATH: fixture.file });
    for (const page of pages) {
      rendered.set(page.path, await fetch(`http://localhost:${server.port}${page.path}`).then((r) => r.text()));
    }
  });

  after(() => {
    server?.proc.kill();
    if (fixture) rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("says so on the page whose review failed", () => {
    assert.match(rendered.get(SUBJECT)!, new RegExp(`Reviewed ${REVIEWED_ON}, corrections outstanding`));
  });

  it("reaches every path the register holds, so a page joining the register cannot skip the byline", () => {
    const failed = pages.filter((p) => p.path !== CONTROL);
    const silent = failed.filter((p) => !FAILED.test(visibleBody(rendered.get(p.path)!))).map((p) => p.path);
    assert.deepStrictEqual(silent, []);
    assertCoversPopulation(
      failed.length + 1,
      pagesOnTheReviewRegister(),
      "registered paths that carried the review the fixture recorded",
    );
  });

  it("says it once per page, so a page served through two passes does not repeat itself", () => {
    const repeated = pages
      .filter((p) => p.path !== CONTROL)
      .map((p) => ({ path: p.path, times: visibleBody(rendered.get(p.path)!).match(EVERY_FAILED)?.length ?? 0 }))
      .filter((p) => p.times !== 1);
    assert.deepStrictEqual(repeated, []);
  });

  it("names no check date beside the compiled figures, and claims none has happened nowhere", () => {
    const compiled = fixture.row(SUBJECT).published;
    const html = rendered.get(SUBJECT)!;

    assert.match(html, new RegExp(`Figures compiled ${compiled}`));
    assert.doesNotMatch(html, new RegExp(`Figures compiled ${compiled}, last checked ${REVIEWED_ON}(?![\\s\\S]{0,40}corrections outstanding)`));
    assert.doesNotMatch(html, new RegExp(`Figures compiled ${compiled}, not re-checked since`));
    assert.match(html, new RegExp(`Reviewed ${REVIEWED_ON}, corrections outstanding`));
  });

  it("says corrections are outstanding beside every check date it does name", () => {
    const html = rendered.get(SUBJECT)!;
    const offered = [...html.matchAll(/last checked (\d{4}-\d{2}-\d{2})([\s\S]{0,40})/g)];

    assert.ok(offered.length > 0, "the page names no check date anywhere, so the rule below is never taken");
    for (const [, date, following] of offered) {
      assert.match(following, /corrections outstanding/,
        `a check date of ${date} is offered without saying the review that made it found the page wrong`);
    }
  });

  it("leaves a page the fixture set as never reviewed saying it was never re-checked", () => {
    assert.match(rendered.get(CONTROL)!, /not re-checked since/);
    assert.doesNotMatch(rendered.get(CONTROL)!, /corrections outstanding/);
  });
});
