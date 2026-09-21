import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  CHECK_ESTABLISHES,
  CHECK_ESTABLISHES_ON_A_LIST,
  CHECK_ESTABLISHES_ON_THE_REST_OF_A_LIST,
  TERMS_CAME_FROM_CLASS,
  citedSourcesScopeNote,
} = await import("../dist/source-citation.js");
const { RECORD_SOURCE_CLASS } = await import("../dist/change-citation.js");
const {
  CONFIRMED_DATE_LABEL,
  NO_CONFIRMATION_HELD,
  OUTCOME_CONTRADICTING_WHAT_WE_STORE,
  READS_OUR_TERMS_CAN_COME_FROM,
  RESTATED_DATE_LABEL,
  WHAT_A_SETTLED_READ_FOUND,
  WHAT_A_VOIDED_READ_FOUND,
  WHAT_THE_LAST_READ_FOUND,
  whereOurTermsCameFrom,
  whereOurTermsCameFromClause,
} = await import("../dist/read-date.js");
const { toSlug } = await import("../dist/vendor-slug.js");

type Offer = import("../src/types.ts").Offer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "index.json"), "utf-8"),
).offers;

const confirmedOn = new Map<string, string>();
for (const record of JSON.parse(
  readFileSync(path.join(REPO, "data", "verification_state.json"), "utf-8"),
).records) {
  if (record?.last_success) confirmedOn.set(`${record.vendor}|${record.url}`, record.last_success);
}

const primaryFor = new Map<string, Offer>();
for (const offer of offers) if (!primaryFor.has(offer.vendor)) primaryFor.set(offer.vendor, offer);

function restatedFrom(offer: Offer): string | null {
  return offer.restated_from?.reading_date ?? null;
}

function confirmedFor(offer: Offer): string | null {
  return confirmedOn.get(`${offer.vendor}|${offer.url}`) ?? null;
}

function storesDateOurTermsToARead(offer: Offer): boolean {
  return restatedFrom(offer) !== null || confirmedFor(offer) !== null;
}

const primaryForRoute = new Map<string, Offer>();
const primaryForSlug = new Map<string, Offer>();
for (const offer of primaryFor.values()) {
  const slug = toSlug(offer.vendor);
  if (!primaryForSlug.has(slug)) primaryForSlug.set(slug, offer);
  if (!primaryForRoute.has(`/vendor/${slug}`)) primaryForRoute.set(`/vendor/${slug}`, offer);
}

const COMPILED_PAGES_CITING_A_LIST = [
  "/cloud-free-tier-comparison-2026",
  "/database-free-tier-comparison-2026",
  "/cicd-free-tier-comparison-2026",
  "/serverless-free-tier-comparison-2026",
  "/testing-free-tier-comparison-2026",
  "/analytics-free-tier-comparison-2026",
  "/api-development-free-tier-comparison-2026",
  "/security-free-tier-comparison-2026",
  "/hosting-free-tier-comparison-2026",
  "/auth-comparison-2026",
  "/email-comparison-2026",
  "/storage-comparison-2026",
  "/monitoring-comparison-2026",
  "/aws-free-tier-2026",
  "/gcp-free-tier-2026",
  "/azure-free-tier-2026",
  "/digitalocean-free-tier-2026",
  "/ai-coding-pricing-2026",
];

const SOURCE_LINE = /<p class="free-tier-source-line"[\s\S]*?<\/p>/;
const DETAIL_LABEL = /<div class="detail-label">([^<]*)<\/div>/g;
const DETAIL_NOTE = /<div class="detail-note">([^<]*)<\/div>/;
const CITED_ENTRY = /<li id="source-([a-z0-9-]+)">([\s\S]*?)<\/li>/g;

interface Served {
  sourceLine: string;
  labels: string[];
  readNote: string;
}

function startServer(): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${m[1]}` });
      }
    });
    proc.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("a page never disclaims provenance our records hold", () => {
  let server: { proc: ChildProcess; base: string };
  const served = new Map<string, Served>();
  const compiled = new Map<string, string>();

  before(async () => {
    server = await startServer();
    for (const route of primaryForRoute.keys()) {
      const res = await fetch(`${server.base}${route}`);
      const html = await res.text();
      if (res.status !== 200) continue;
      served.set(route, {
        sourceLine: html.match(SOURCE_LINE)?.[0] ?? "",
        labels: [...html.matchAll(DETAIL_LABEL)].map(m => m[1]!),
        readNote: html.match(DETAIL_NOTE)?.[1] ?? "",
      });
    }
    for (const route of COMPILED_PAGES_CITING_A_LIST) {
      const res = await fetch(`${server.base}${route}`);
      assert.strictEqual(res.status, 200, route);
      compiled.set(route, await res.text());
    }
  });

  after(() => server?.proc.kill());

  it("holds both halves of the catalogue in large enough numbers to sweep", () => {
    const cited = [...served.entries()].filter(([, page]) => page.sourceLine !== "");
    const dated = cited.filter(([route]) => storesDateOurTermsToARead(primaryForRoute.get(route)!));
    assertPopulationFloor(dated.length, 300, "cited records our stores date to a read of the page");
    assertPopulationFloor(cited.length - dated.length, 150, "cited records whose figures are our own");
  });

  it("disclaims the figures on exactly the records our stores do not date to a read", () => {
    const disclaimedAnyway: string[] = [];
    const leftUnattributed: string[] = [];
    for (const [route, page] of served) {
      if (page.sourceLine === "") continue;
      const disclaimed = page.sourceLine.includes(CHECK_ESTABLISHES);
      if (storesDateOurTermsToARead(primaryForRoute.get(route)!)) {
        if (disclaimed) disclaimedAnyway.push(route);
      } else if (!disclaimed) leftUnattributed.push(route);
    }
    assert.deepStrictEqual(disclaimedAnyway.slice(0, 10), []);
    assert.deepStrictEqual(leftUnattributed.slice(0, 10), []);
  });

  it("never disclaims the figures beside a date card that sources them to a read", () => {
    const contradicting: string[] = [];
    let publishing = 0;
    for (const [route, page] of served) {
      if (page.sourceLine === "") continue;
      if (!page.labels.includes(CONFIRMED_DATE_LABEL) && !page.labels.includes(RESTATED_DATE_LABEL)) continue;
      publishing++;
      if (page.sourceLine.includes(CHECK_ESTABLISHES)) contradicting.push(route);
    }
    assert.deepStrictEqual(contradicting.slice(0, 10), []);
    assertPopulationFloor(publishing, 300, "cited pages dating their figures on a date card");
  });

  it("keeps the disclaimer on every state that leaves the figures ours alone", () => {
    const contradiction = WHAT_THE_LAST_READ_FOUND[OUTCOME_CONTRADICTING_WHAT_WE_STORE]!;
    const statesThatLeaveTheFiguresOurs: Record<string, readonly string[]> = {
      the_read_contradicted_the_terms: [contradiction],
      a_refusal_settled_the_read: Object.values(WHAT_A_SETTLED_READ_FOUND),
      the_read_found_no_terms_to_compare: [
        ...Object.values(WHAT_A_VOIDED_READ_FOUND),
        ...Object.values(WHAT_THE_LAST_READ_FOUND).filter(found => found !== contradiction),
      ],
      no_read_of_ours_reported_anything: [],
    };
    const seen: Record<string, number> = {};
    const silent: string[] = [];
    for (const [route, page] of served) {
      if (page.sourceLine === "" || storesDateOurTermsToARead(primaryForRoute.get(route)!)) continue;
      if (!page.readNote.includes(NO_CONFIRMATION_HELD)) continue;
      for (const [state, sentences] of Object.entries(statesThatLeaveTheFiguresOurs)) {
        const inThisState = sentences.length === 0
          ? Object.values(statesThatLeaveTheFiguresOurs).flat().every(s => !page.readNote.includes(s))
          : sentences.some(s => page.readNote.includes(s));
        if (!inThisState) continue;
        seen[state] = (seen[state] ?? 0) + 1;
        if (!page.sourceLine.includes(CHECK_ESTABLISHES)) silent.push(`${route} — ${state}`);
      }
    }
    assert.deepStrictEqual(silent.slice(0, 10), []);
    const unpinned = Object.keys(statesThatLeaveTheFiguresOurs).filter(state => !seen[state]);
    assert.deepStrictEqual(unpinned, []);
  });

  it("scopes a list of sources to the services whose figures are our own", () => {
    const wrongNote: string[] = [];
    const wrongEntry: string[] = [];
    let dated = 0;
    let ours = 0;
    for (const [route, html] of compiled) {
      const entries = [...html.matchAll(CITED_ENTRY)].map(m => ({ slug: m[1]!, body: m[2]! }));
      assert.ok(entries.length > 0, route);
      const datedHere = entries.filter(e => {
        const offer = primaryForSlug.get(e.slug);
        return offer !== undefined
          && e.body.includes(`class="${RECORD_SOURCE_CLASS}"`)
          && storesDateOurTermsToARead(offer);
      });
      const oursHere = entries.filter(e => !datedHere.includes(e));
      dated += datedHere.length;
      ours += oursHere.length;
      const blanket = html.includes(CHECK_ESTABLISHES_ON_A_LIST);
      const scoped = html.includes(CHECK_ESTABLISHES_ON_THE_REST_OF_A_LIST);
      const expected = oursHere.length === 0 ? "none" : datedHere.length === 0 ? "blanket" : "scoped";
      const rendered = blanket ? "blanket" : scoped ? "scoped" : "none";
      if (rendered !== expected) wrongNote.push(`${route} — ${rendered} where ${expected} belongs`);
      for (const entry of datedHere) {
        if (!entry.body.includes(`class="${TERMS_CAME_FROM_CLASS}"`)) wrongEntry.push(`${route} — ${entry.slug} says nothing`);
      }
      for (const entry of oursHere) {
        if (entry.body.includes(`class="${TERMS_CAME_FROM_CLASS}"`)) wrongEntry.push(`${route} — ${entry.slug} speaks out of turn`);
      }
    }
    assert.deepStrictEqual(wrongNote.slice(0, 10), []);
    assert.deepStrictEqual(wrongEntry.slice(0, 10), []);
    assertPopulationFloor(dated, 90, "cited services a list dates to a read of the vendor's page");
    assertPopulationFloor(ours, 70, "cited services whose figures a list leaves as our own");
  });

  it("names the reading a restated entry was taken from, not the read that followed it", () => {
    const flattened: string[] = [];
    let checked = 0;
    for (const [route, html] of compiled) {
      for (const m of html.matchAll(CITED_ENTRY)) {
        if (!m[2]!.includes(`class="${RECORD_SOURCE_CLASS}"`)) continue;
        const offer = primaryForSlug.get(m[1]!);
        const reading = offer ? restatedFrom(offer) : null;
        if (!offer || reading === null) continue;
        checked++;
        if (!m[2]!.includes(reading)) flattened.push(`${route} — ${m[1]}`);
      }
    }
    assert.deepStrictEqual(flattened.slice(0, 10), []);
    assertPopulationFloor(checked, 35, "restated services cited in a list");
  });
});

describe("where our terms came from is read off the record, not off the page", () => {
  const record = {
    vendor: "Example",
    url: "https://example.com/pricing",
    verifiedDate: "2026-08-01",
  };

  it("names the reading a record restates its terms from", () => {
    const provenance = whereOurTermsCameFrom({ ...record, restated_from: { reading_date: "2026-09-03" } });
    assert.deepStrictEqual(provenance, { read: "a_read_we_restated_them_from", on: "2026-09-03" });
  });

  it("holds nothing for a record with no restatement and no stored confirmation", () => {
    assert.strictEqual(whereOurTermsCameFrom(record), null);
    assert.strictEqual(whereOurTermsCameFrom(null), null);
  });

  it("states every reading a record's terms can be dated to", () => {
    for (const read of READS_OUR_TERMS_CAN_COME_FROM) {
      const clause = whereOurTermsCameFromClause({ read, on: "2026-09-03" }, "2026-09-18");
      assert.ok(clause.includes("2026-09-03"), read);
      assert.ok(clause.trim() === clause && clause.endsWith("."), read);
    }
  });

  it("says a later read did not confirm terms restated from an earlier one", () => {
    const clause = whereOurTermsCameFromClause(
      { read: "a_read_we_restated_them_from", on: "2026-09-03" },
      "2026-09-18",
    );
    assert.match(clause, /2026-09-03/);
    assert.match(clause, /2026-09-18/);
    assert.match(clause, /without confirming them/);
  });
});

describe("a list disclaims the services it still speaks for and no others", () => {
  const service = (vendor: string, termsCameFrom: string | null) => ({
    vendor,
    slug: vendor.toLowerCase(),
    source: { cited: false as const, kind: "no_record" as const, clause: "no record" },
    termsCameFrom,
  });

  it("disclaims the whole list where no entry dates its own figures", () => {
    assert.strictEqual(
      citedSourcesScopeNote([service("A", null), service("B", null)]),
      CHECK_ESTABLISHES_ON_A_LIST,
    );
  });

  it("disclaims nothing where every entry dates its own figures", () => {
    assert.strictEqual(citedSourcesScopeNote([service("A", "read on 2026-09-03"), service("B", "read on 2026-09-04")]), null);
    assert.strictEqual(citedSourcesScopeNote([]), null);
  });

  it("stands the disclaimer down over the entries that date their own figures", () => {
    assert.strictEqual(
      citedSourcesScopeNote([service("A", "read on 2026-09-03"), service("B", null)]),
      CHECK_ESTABLISHES_ON_THE_REST_OF_A_LIST,
    );
  });
});
