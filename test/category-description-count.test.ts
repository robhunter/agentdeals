import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchBadgeVerdicts, type SiteFreeTierVerdict } from "./badge-verdicts.ts";
import { assertCoversPopulation, assertPopulationFloor, categoriesInTheCatalogue } from "./population-floor.ts";
import { assertAheadOfTheVendorList, vendorsNamedAsUncontradicted } from "./snippet-order.ts";

const { getCategories } = await import("../dist/data.js");
const { toSlug } = await import("../dist/vendor-slug.js");
const {
  measuredNoDifferenceClause,
  measuredNoDifferenceThenReadAgainClause,
  readHadNoStandingClause,
  readHadNoStandingThenReadAgainClause,
  unreconciledReadClause,
  unreconciledReadThenReadAgainClause,
  REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING,
  WHAT_A_VOIDED_READ_FOUND,
} = await import("../dist/change-refusal.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const LONGEST_DESCRIPTION_BEFORE_THIS_RULE = 307;

const COUNT_OPENING = "We could not confirm today's terms for";
const SPLIT_SENTENCE = new RegExp(
  `${COUNT_OPENING} (\\d+) of them`
  + `(?:: on (\\d+) the page we cite did not answer, and on (\\d+) our own read did not confirm them`
  + `|, and on all (\\d+) (?:the page we cite did not answer|our own read did not confirm them))\\.`,
);

const REASON_CLASSES = ["listing-read-contradicts", "listing-terms-unconfirmed", "listing-link-unreachable"];
const CONFIRMED_PRICE_CLASS = "listing-terms-free-price";
const CONFIRMS_THE_PRICE = "which confirms the price";

const WHAT_A_READ_OF_OURS_FOUND = [
  "we found a change we could not reconcile with the terms we publish",
  "we refused the change we considered recording because it named no figure that had moved",
  ...[...new Set(Object.values(WHAT_A_VOIDED_READ_FOUND) as string[])].map((found) => `we ${found}`),
];

const REFUSAL_CLAUSES = [
  unreconciledReadClause("2026-01-01"),
  measuredNoDifferenceClause("2026-01-01"),
  unreconciledReadThenReadAgainClause("2026-01-01", "2026-01-02"),
  measuredNoDifferenceThenReadAgainClause("2026-01-01", "2026-01-02"),
  ...REFUSAL_REASONS_THAT_VOID_THE_READS_STANDING.flatMap((reason: string) => [
    readHadNoStandingClause("2026-01-01", WHAT_A_VOIDED_READ_FOUND[reason]),
    readHadNoStandingThenReadAgainClause("2026-01-01", "2026-01-02", WHAT_A_VOIDED_READ_FOUND[reason]),
  ]),
];

let port = 0;
let proc: ChildProcess | null = null;
let verdicts: Map<string, SiteFreeTierVerdict> = new Map();

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

const unescape = (text: string): string =>
  text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const descriptionOf = (html: string): string =>
  unescape(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "");

interface ListedRow {
  slug: string;
  counted: string | null;
  reasons: string[];
  namesAReadOfOurs: boolean;
  saysTheReadConfirmedThePrice: boolean;
}

function reasonSpansIn(row: string): Array<{ kind: string; sentence: string }> {
  return [...row.matchAll(/class="listing-(read-contradicts|terms-unconfirmed|link-unreachable)"[^>]*>([^<]*)</g)]
    .map((m) => ({ kind: m[1], sentence: m[2] }));
}

function rowsOn(html: string): ListedRow[] {
  return html.split("<tr").slice(1)
    .filter((row) => row.includes("/vendor/"))
    .map((row) => ({
      slug: row.match(/\/vendor\/([a-z0-9-]+)"/)?.[1] ?? "",
      counted: row.match(/^ data-unconfirmed="([a-z_]+)"/)?.[1] ?? null,
      reasons: REASON_CLASSES.filter((c) => row.includes(`class="${c}"`)),
      namesAReadOfOurs: reasonSpansIn(row).some((span) =>
        span.kind === "read-contradicts" || WHAT_A_READ_OF_OURS_FOUND.some((found) => span.sentence.includes(found))),
      saysTheReadConfirmedThePrice: row.includes(`class="${CONFIRMED_PRICE_CLASS}"`),
    }));
}

interface CategoryPage {
  slug: string;
  html: string;
  description: string;
  rows: ListedRow[];
  standing: ListedRow[];
}

let pages: CategoryPage[] = [];

before(async () => {
  proc = await startServer();
  verdicts = await fetchBadgeVerdicts(port);
  pages = [];
  for (const { name } of getCategories()) {
    const slug = toSlug(name);
    const html = await (await fetch(`http://localhost:${port}/category/${slug}`)).text();
    const rows = rowsOn(html);
    pages.push({
      slug,
      html,
      description: descriptionOf(html),
      rows,
      standing: rows.filter((row) => verdicts.get(row.slug) !== "ended"),
    });
  }
});

after(() => { proc?.kill(); });

const statedCountOn = (page: CategoryPage): number | null => {
  const stated = page.description.match(SPLIT_SENTENCE);
  return stated ? Number(stated[1]) : null;
};

describe("a category description counts the terms it could not confirm", () => {
  it("states the count ahead of the vendor list wherever it states both", () => {
    let ordered = 0;
    for (const page of pages) {
      if (!page.description.includes(COUNT_OPENING)) continue;
      if (assertAheadOfTheVendorList(page.description, COUNT_OPENING, `/category/${page.slug}`)) ordered++;
    }
    assertCoversPopulation(pages.length, categoriesInTheCatalogue(), "category pages read for the ordering");
    assertPopulationFloor(ordered, 30, "category descriptions stating both the count and a vendor list");
  });

  it("names the parts that make up the count, and they sum to it", () => {
    let split = 0;
    for (const page of pages) {
      if (!page.description.includes(COUNT_OPENING)) continue;
      const stated = page.description.match(SPLIT_SENTENCE);
      assert.ok(stated, `/category/${page.slug} states a count with no parts behind it: ${page.description}`);
      const count = Number(stated[1]);
      const parts = [stated[2], stated[3], stated[4]].filter((n) => n !== undefined).map(Number);
      assert.ok(parts.length > 0, `/category/${page.slug} names no part of its count: ${page.description}`);
      assert.strictEqual(
        parts.reduce((total, part) => total + part, 0),
        count,
        `/category/${page.slug} names ${parts.join(" and ")} against a count of ${count}`,
      );
      if (parts.length > 1) split++;
    }
    assertPopulationFloor(split, 30, "descriptions separating the page from our own read");
  });

  it("counts every standing row that gives a reason, and no other", () => {
    let counted = 0;
    const silent: string[] = [];
    const uncounted: string[] = [];
    const disagreeing: string[] = [];
    for (const page of pages) {
      for (const row of page.standing) {
        if (row.counted !== null && row.reasons.length === 0) silent.push(`/category/${page.slug} ${row.slug}`);
        if (row.counted === null && row.reasons.length > 0) uncounted.push(`/category/${page.slug} ${row.slug}`);
        if (row.counted !== null) counted++;
      }
      const stated = statedCountOn(page);
      const attributed = page.standing.filter((row) => row.counted !== null).length;
      if ((stated ?? 0) !== attributed) {
        disagreeing.push(`/category/${page.slug} states ${stated} against ${attributed} rows`);
      }
    }
    assert.deepStrictEqual(silent, [], `a counted row renders no reason: ${silent.join("; ")}`);
    assert.deepStrictEqual(uncounted, [], `a row renders a reason its page does not count: ${uncounted.join("; ")}`);
    assert.deepStrictEqual(disagreeing, [], `a description states a count the rows do not carry: ${disagreeing.join("; ")}`);
    assertPopulationFloor(counted, 600, "listed rows the category descriptions count");
  });

  it("puts every counted row under one of the two parts its description names", () => {
    const parts = new Map<string, number>();
    for (const page of pages) {
      const stated = page.description.match(SPLIT_SENTENCE);
      if (!stated) continue;
      const named = new Map<string, number>([
        ["the_page_did_not_answer", 0],
        ["our_read_did_not_confirm", 0],
      ]);
      for (const row of page.standing) {
        if (row.counted === null) continue;
        assert.ok(named.has(row.counted), `/category/${page.slug} counts ${row.slug} under ${row.counted}`);
        named.set(row.counted, named.get(row.counted)! + 1);
        parts.set(row.counted, (parts.get(row.counted) ?? 0) + 1);
      }
      const spoken = [stated[2], stated[3], stated[4]].filter((n) => n !== undefined).map(Number);
      const held = [...named.values()].filter((n) => n > 0);
      assert.deepStrictEqual(
        spoken,
        held,
        `/category/${page.slug} names ${spoken.join(" and ")} against ${held.join(" and ")} on its own rows`,
      );
    }
    assertPopulationFloor(parts.get("the_page_did_not_answer") ?? 0, 400, "rows counted because the page did not answer");
    assertPopulationFloor(parts.get("our_read_did_not_confirm") ?? 0, 150, "rows counted because our own read did not confirm");
  });

  it("puts a row under our own read only where the row says what that read found", () => {
    for (const clause of REFUSAL_CLAUSES) {
      assert.ok(
        WHAT_A_READ_OF_OURS_FOUND.some((found) => clause.includes(found)),
        `a refused read is published as "${clause}", which states neither finding this test reads for`,
      );
    }
    const misplaced: string[] = [];
    let ours = 0;
    let theirs = 0;
    for (const page of pages) {
      for (const row of page.standing) {
        if (row.counted === null) continue;
        const namesARead = row.counted === "our_read_did_not_confirm";
        if (namesARead) ours++; else theirs++;
        if (namesARead !== row.namesAReadOfOurs) {
          misplaced.push(`/category/${page.slug} ${row.slug} counted under ${row.counted}`);
        }
      }
    }
    assert.deepStrictEqual(
      misplaced,
      [],
      `a row is counted under a part its own sentence does not support: ${misplaced.join("; ")}`,
    );
    assertPopulationFloor(ours, 150, "rows counted because a read of ours did not confirm the terms");
    assertPopulationFloor(theirs, 400, "rows counted because the page we cite did not answer");
  });

  it("counts no row whose read confirmed the price and left nothing else unsettled", () => {
    let confirming = 0;
    let alsoHoldingAReason = 0;
    const counted: string[] = [];
    const doubled: string[] = [];
    for (const page of pages) {
      for (const row of page.rows) {
        if (!row.saysTheReadConfirmedThePrice) continue;
        confirming++;
        const sentence = page.html.split("<tr").find((r) => r.includes(`/vendor/${row.slug}"`)) ?? "";
        assert.ok(
          sentence.includes(CONFIRMS_THE_PRICE),
          `/category/${page.slug} ${row.slug} carries the confirmed-price class over another sentence`,
        );
        if (row.reasons.includes("listing-terms-unconfirmed")) {
          doubled.push(`/category/${page.slug} ${row.slug}`);
        }
        if (row.reasons.length > 0) { alsoHoldingAReason++; continue; }
        if (row.counted !== null) counted.push(`/category/${page.slug} ${row.slug}`);
      }
    }
    assert.deepStrictEqual(counted, [], `a description counts a row whose read confirmed the price: ${counted.join("; ")}`);
    assert.deepStrictEqual(
      doubled,
      [],
      `a row says the read confirmed the price and that we could not confirm the terms: ${doubled.join("; ")}`,
    );
    assert.ok(
      alsoHoldingAReason > 0,
      "no row holds a confirmed price beside another reason, so the narrower rule is read on nothing",
    );
    assertPopulationFloor(confirming, 20, "listed rows whose read confirmed the price");
  });

  it("names as uncontradicted only vendors its own rows leave uncounted", () => {
    let vouched = 0;
    const contradicted: string[] = [];
    for (const page of pages) {
      for (const vendor of vendorsNamedAsUncontradicted(page.description)) {
        vouched++;
        const row = page.standing.find((r) => r.slug === toSlug(vendor));
        if (row === undefined || row.counted !== null) {
          contradicted.push(`/category/${page.slug} ${vendor}`);
        }
      }
    }
    assert.deepStrictEqual(
      contradicted,
      [],
      `a description vouches for a vendor its own page counts: ${contradicted.join("; ")}`,
    );
    assertPopulationFloor(vouched, 60, "vendor slots a category description vouches for");
  });

  it("publishes no description longer than the longest we published before this rule", () => {
    const over = pages
      .filter((page) => page.description.length > LONGEST_DESCRIPTION_BEFORE_THIS_RULE)
      .map((page) => `/category/${page.slug} at ${page.description.length}`);
    assert.deepStrictEqual(
      over,
      [],
      `a description runs past ${LONGEST_DESCRIPTION_BEFORE_THIS_RULE} characters: ${over.join("; ")}`,
    );
    assertPopulationFloor(pages.length, 40, "category descriptions measured against the cap");
  });
});
