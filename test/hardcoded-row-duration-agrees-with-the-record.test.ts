import { describe, it } from "node:test";
import assert from "node:assert";
import { hardcodedRowsCarryingASlug, type HardcodedRow } from "./hardcoded-vendor-rows.ts";
import { assertCoversPopulation, rowsCarryingAVendorSlug } from "./population-floor.ts";

const { resolveVendorSlug } = await import("../dist/vendor-slug.js");
const { toSlug } = await import("../dist/slug.js");
const { loadOffers } = await import("../dist/data.js");

type Offer = import("../src/types.ts").Offer;

const offers: Offer[] = loadOffers();
const firstRecordFor = new Map<string, Offer>();
for (const offer of offers) {
  const slug = toSlug(offer.vendor);
  if (slug && !firstRecordFor.has(slug)) firstRecordFor.set(slug, offer);
}

const A_NUMBER_OF_DAYS = /(\d[\d,]*)[\s-]?days?\b/gi;
const HOLDS_MARKUP = /<[a-z!/]/i;

interface StatedDays {
  days: number;
  around: string;
}

export function daysStatedIn(text: string): StatedDays[] {
  return [...text.matchAll(A_NUMBER_OF_DAYS)].map(match => ({
    days: Number(match[1]!.replace(/,/g, "")),
    around: text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 60).trim(),
  }));
}

export function fieldsSpeakingForTheRowsOwnVendor(row: HardcodedRow): Array<[string, string]> {
  return Object.entries(row.fields).filter(([field, value]) => field !== "slug" && !HOLDS_MARKUP.test(value));
}

interface DurationOnARow {
  row: HardcodedRow;
  vendor: string;
  field: string;
  days: number;
  around: string;
  recordStates: number[];
}

function durationsStatedOnRows(rows: HardcodedRow[], recordFor: (slug: string) => Offer | null): DurationOnARow[] {
  const found: DurationOnARow[] = [];
  for (const row of rows) {
    const record = recordFor(row.slug);
    if (!record) continue;
    const recordStates = daysStatedIn(record.description ?? "").map(stated => stated.days);
    if (recordStates.length === 0) continue;
    for (const [field, value] of fieldsSpeakingForTheRowsOwnVendor(row)) {
      for (const stated of daysStatedIn(value)) {
        found.push({ row, vendor: record.vendor, field, days: stated.days, around: stated.around, recordStates });
      }
    }
  }
  return found;
}

type Resolution = ReturnType<typeof resolveVendorSlug>;

function recordTheResolutionReaches(resolution: Resolution): Offer | null {
  if (resolution.type !== "exact" && resolution.type !== "redirect") return null;
  return firstRecordFor.get(resolution.slug) ?? null;
}

function recordTheRowStandsOn(slug: string): Offer | null {
  return recordTheResolutionReaches(resolveVendorSlug(slug));
}

const rows = hardcodedRowsCarryingASlug();
const durations = durationsStatedOnRows(rows, recordTheRowStandsOn);

function statesADurationItsRecordDoesNot(duration: DurationOnARow): boolean {
  return !duration.recordStates.includes(duration.days);
}

function siteOf(duration: DurationOnARow): string {
  return `${duration.row.builder ?? "module"}.${duration.row.array ?? "anonymous"}:${duration.row.line} (${duration.row.slug})`;
}

interface DurationTheRecordDoesNotDescribe {
  builder: string;
  array: string;
  slug: string;
  field: string;
  days: number;
  because: string;
}

const DESCRIBES_A_PLAN_THE_RECORD_DOES_NOT: DurationTheRecordDoesNotDescribe[] = [];

function describesAPlanTheRecordDoesNot(duration: DurationOnARow): DurationTheRecordDoesNotDescribe | null {
  return (
    DESCRIBES_A_PLAN_THE_RECORD_DOES_NOT.find(
      declared =>
        declared.builder === duration.row.builder
        && declared.array === duration.row.array
        && declared.slug === duration.row.slug
        && declared.field === duration.field
        && declared.days === duration.days,
    ) ?? null
  );
}

describe("a hardcoded row states no number of days its vendor's record does not", () => {
  it("reads every row in the page source that carries a vendor slug", () => {
    assertCoversPopulation(rows.length, rowsCarryingAVendorSlug(), "hardcoded rows this check read");
  });

  it("compares a duration only where the row and the record both state one, over more than one vendor", () => {
    const vendors = new Set(durations.map(duration => duration.vendor));
    const sites = new Set(durations.map(duration => `${duration.row.builder}.${duration.row.array}`));
    assert.ok(
      durations.length > 0,
      "no hardcoded row states a number of days for a vendor whose record states one too, so this rule read an empty population",
    );
    assert.ok(
      vendors.size > 1 && sites.size > 1,
      `${durations.length} durations over ${vendors.size} vendors and ${sites.size} page sites is too narrow to be a population: ${[...vendors].join(", ")}`,
    );
  });

  it("states a number of days the record states, everywhere it states one", () => {
    const overstating = durations
      .filter(statesADurationItsRecordDoesNot)
      .filter(duration => describesAPlanTheRecordDoesNot(duration) === null)
      .map(
        duration =>
          `  ${siteOf(duration)} — ${duration.vendor} — ${duration.field} says ${duration.days} where the record says ${duration.recordStates.join(", ")}: ${duration.around}`,
      );
    assert.deepStrictEqual(
      overstating,
      [],
      `${overstating.length} of ${durations.length} durations on hardcoded rows are not in the record they stand on:\n${overstating.join("\n")}`,
    );
  });
});

describe("the durations this rule is declared not to read", () => {
  it("holds every declared exception to a duration the sweep still finds", () => {
    const stale = DESCRIBES_A_PLAN_THE_RECORD_DOES_NOT.filter(
      exception => !durations.some(duration => describesAPlanTheRecordDoesNot(duration) === exception),
    ).map(exception => `  ${exception.builder}.${exception.array} — ${exception.slug} — ${exception.field} — ${exception.days}`);
    assert.deepStrictEqual(
      stale,
      [],
      `${stale.length} exceptions name a duration no row states, so they hide nothing and say something untrue:\n${stale.join("\n")}`,
    );
  });

  it("names a reason on every one of them", () => {
    for (const exception of DESCRIBES_A_PLAN_THE_RECORD_DOES_NOT) {
      assert.ok(exception.because.length > 20, `${exception.builder}.${exception.array} gives no reason`);
    }
  });

  it("suppresses each duration it names and nothing beside it", () => {
    for (const declared of DESCRIBES_A_PLAN_THE_RECORD_DOES_NOT) {
      const suppressed = durations.find(duration => describesAPlanTheRecordDoesNot(duration) === declared);
      assert.ok(suppressed, `no row states ${declared.days} days at ${declared.builder}.${declared.array} for ${declared.slug}`);
      for (const drifted of [
        { ...suppressed, days: suppressed.days + 1 },
        { ...suppressed, field: `${suppressed.field}Notes` },
        { ...suppressed, row: { ...suppressed.row, builder: "buildSomeOtherPage" } },
        { ...suppressed, row: { ...suppressed.row, array: "someOtherArray" } },
        { ...suppressed, row: { ...suppressed.row, slug: "some-other-vendor" } },
      ]) {
        assert.strictEqual(
          describesAPlanTheRecordDoesNot(drifted),
          null,
          `the exception also suppresses ${drifted.row.builder}.${drifted.row.array} ${drifted.row.slug} ${drifted.field} ${drifted.days}`,
        );
      }
    }
  });
});

const A_ROW_WHOSE_TABLE_PRICES_ANOTHER_VENDOR = `
function buildAComparisonPage() {
  const services = [
    {
      name: "Datadog",
      slug: "datadog",
      free: "5 hosts, 1-day retention",
      serviceMatrixHtml: "<tr><td>Axiom</td><td>500 GB ingest/month, 30-day retention</td></tr>",
    },
  ];
  return services;
}
`;

const A_ROW_OVERSTATING_ITS_RECORD = `
function buildAComparisonPage() {
  const services = [
    { name: "Render", slug: "render", freeTier: "Free web services, free PostgreSQL (90 days)" },
  ];
  return services;
}
`;

describe("the record a row is read against", () => {
  it("reads a row against the record its slug names", () => {
    const named = rows.find(row => resolveVendorSlug(row.slug).type === "exact");
    assert.ok(named, "no hardcoded row carries a slug naming a record, so this rule reads nothing");
    assert.ok(recordTheRowStandsOn(named.slug), `${named.slug} names a record and the rule reached none`);
  });

  it("reads a row against the record its slug reaches through a recorded rename", () => {
    const renamed = rows.find(row => resolveVendorSlug(row.slug).type === "redirect");
    assert.ok(renamed, "no hardcoded row carries a slug the merge registry redirects, so this rule reads none");
    const record = recordTheRowStandsOn(renamed.slug);
    assert.ok(record, `${renamed.slug} is redirected by the merge registry and the rule reached no record for it`);
  });

  it("reads a row against no record where the only record its slug reaches is another product", () => {
    const ended = rows.find(row => resolveVendorSlug(row.slug).type === "onlyMatchHasEnded");
    assert.ok(ended, "no hardcoded row carries a slug whose only match has ended, so this narrowing shows nothing");
    assert.strictEqual(
      recordTheRowStandsOn(ended.slug),
      null,
      `${ended.slug} reaches only a record of a product that is not the one the row names, and the rule read its durations`,
    );
  });

  it("reads a row against no record where its slug names none", () => {
    const unknown = rows.find(row => resolveVendorSlug(row.slug).type === "none");
    assert.ok(unknown, "every hardcoded row's slug reaches a record, so this narrowing shows nothing");
    assert.strictEqual(recordTheRowStandsOn(unknown.slug), null, `${unknown.slug} reaches no record and the rule found one`);
  });
});

describe("the rule read against rows and a record written for it", () => {
  const recordSaying = (description: string) => (): Offer => ({ vendor: "Fixture", description }) as Offer;

  it("reads a duration out of a field that speaks for the row's own vendor", () => {
    const row = hardcodedRowsCarryingASlug(A_ROW_WHOSE_TABLE_PRICES_ANOTHER_VENDOR)[0]!;
    const fields = fieldsSpeakingForTheRowsOwnVendor(row).map(([field]) => field);
    assert.ok(fields.includes("free"), `the fixture row's own allowance field was not read: ${fields.join(", ")}`);
  });

  it("reads no duration out of a field holding a table of other vendors", () => {
    const rowsRead = hardcodedRowsCarryingASlug(A_ROW_WHOSE_TABLE_PRICES_ANOTHER_VENDOR);
    const row = rowsRead[0]!;
    assert.ok(
      daysStatedIn(row.fields.serviceMatrixHtml!).some(stated => stated.days === 30),
      "the fixture no longer states another vendor's retention in a markup field, so it shows nothing",
    );
    const found = durationsStatedOnRows(rowsRead, recordSaying("5 hosts with 1-day metric retention"));
    assert.deepStrictEqual(
      found.map(duration => duration.days),
      [1],
      `the rule read ${found.map(duration => `${duration.field}=${duration.days}`).join(", ")}, and a duration in a table of other vendors is not this row's`,
    );
  });

  it("refuses a row stating more days than the record it stands on", () => {
    const found = durationsStatedOnRows(
      hardcodedRowsCarryingASlug(A_ROW_OVERSTATING_ITS_RECORD),
      recordSaying("free PostgreSQL (256 MB RAM, 30-day expiry)"),
    );
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0]!.days, 90);
    assert.deepStrictEqual(found[0]!.recordStates, [30]);
    assert.ok(statesADurationItsRecordDoesNot(found[0]!), "the rule read 90 days against a record of 30 and let it stand");
  });

  it("accepts the same row once it states the number of days the record states", () => {
    const found = durationsStatedOnRows(
      hardcodedRowsCarryingASlug(A_ROW_OVERSTATING_ITS_RECORD.replace("(90 days)", "(30 days)")),
      recordSaying("free PostgreSQL (256 MB RAM, 30-day expiry)"),
    );
    assert.strictEqual(found.length, 1);
    assert.ok(!statesADurationItsRecordDoesNot(found[0]!), "the rule refused a row that states exactly what the record states");
  });

  it("reads nothing off a row whose record states no number of days", () => {
    const found = durationsStatedOnRows(
      hardcodedRowsCarryingASlug(A_ROW_OVERSTATING_ITS_RECORD),
      recordSaying("free PostgreSQL (256 MB RAM)"),
    );
    assert.deepStrictEqual(found, [], "a record that states no duration is silence, not the opposite claim");
  });
});
