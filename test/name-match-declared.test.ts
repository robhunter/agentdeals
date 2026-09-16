import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, type Population } from "./population-floor.ts";
import { getDealChanges, getPersonalizedChanges } from "../dist/data.js";
import { NAME_MATCH_SENTENCE, type NameMatchFilter } from "../dist/name-match.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const WHOLE_LOG = "1900-01-01";

type Record = { vendor: string; category?: string };

const served = (): Record[] => getDealChanges(WHOLE_LOG).changes as Record[];

const vendorNames = (): string[] => [...new Set(served().map((c) => c.vendor))].sort();

const categoryNames = (): string[] =>
  [...new Set(served().map((c) => c.category ?? ""))].filter(Boolean).sort();

function vendorsTheChangeLogNames(): Population {
  return { size: vendorNames().length, read: "vendors the served change log names" };
}

function categoriesTheChangeLogNames(): Population {
  return { size: categoryNames().length, read: "categories the served change log names" };
}

const byVendor = (name: string) => getDealChanges(WHOLE_LOG, undefined, name);
const byCategory = (name: string) => getDealChanges(WHOLE_LOG, undefined, undefined, undefined, name);

const contains = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

function soleFilter(result: { name_match: { applied: boolean; filters: NameMatchFilter[] } }): NameMatchFilter {
  assert.ok(result.name_match.applied, "a name filter ran and name_match says none did");
  assert.strictEqual(result.name_match.filters.length, 1, "one name filter ran and name_match describes another number");
  return result.name_match.filters[0];
}

function textNobodyIsNamed(names: readonly string[]): { asked: string; holder: string } | null {
  const taken = new Set(names.map((n) => n.toLowerCase()));
  for (const name of names) {
    for (let length = name.length - 1; length >= 3; length--) {
      for (let from = 0; from + length <= name.length; from++) {
        const candidate = name.slice(from, from + length).trim();
        if (candidate.length < 3) continue;
        if (taken.has(candidate.toLowerCase())) continue;
        return { asked: candidate, holder: name };
      }
    }
  }
  return null;
}

describe("a name filter says what it matched (issue #1688)", () => {
  it("accounts for every record it returns, over every vendor the change log names", () => {
    const names = vendorNames();
    let walked = 0;
    for (const name of names) {
      const result = byVendor(name);
      const filter = soleFilter(result);
      walked++;

      assert.strictEqual(
        filter.records_under_a_name_you_asked_for + filter.records_under_another_name,
        result.total,
        `vendor=${name} returns ${result.total} records and accounts for a different number`,
      );
      assert.strictEqual(filter.matched_names_omitted, 0, `vendor=${name} matched more names than it lists`);
      assert.deepStrictEqual(filter.asked, [name]);

      const listed = new Map(filter.matched.map((m) => [m.name, m]));
      for (const record of result.changes as Record[]) {
        const entry = listed.get(record.vendor);
        assert.ok(entry, `vendor=${name} returned a ${record.vendor} record and does not list ${record.vendor}`);
        assert.strictEqual(
          entry.how,
          record.vendor.toLowerCase() === name.toLowerCase() ? "exact" : "contains",
          `vendor=${name} calls its ${record.vendor} match the wrong kind`,
        );
      }
      const counted = filter.matched.reduce((sum, m) => sum + m.records, 0);
      assert.strictEqual(counted, result.total, `vendor=${name} lists counts that do not add to its total`);
    }
    assertCoversPopulation(walked, vendorsTheChangeLogNames(), "vendor names walked");
  });

  it("returns the same records it returned before it named them", () => {
    const records = served();
    let checked = 0;
    for (const name of vendorNames()) {
      const expected = records.filter((c) => contains(c.vendor, name)).length;
      assert.strictEqual(byVendor(name).total, expected, `vendor=${name} no longer returns every record containing it`);
      checked++;
    }
    assertCoversPopulation(checked, vendorsTheChangeLogNames(), "vendor names whose record count was re-derived");

    let categoriesChecked = 0;
    for (const name of categoryNames()) {
      const expected = records.filter((c) => contains(c.category ?? "", name)).length;
      assert.strictEqual(
        byCategory(name).total,
        expected,
        `categories=${name} no longer returns every record containing it`,
      );
      categoriesChecked++;
    }
    assertCoversPopulation(
      categoriesChecked,
      categoriesTheChangeLogNames(),
      "category names whose record count was re-derived",
    );
  });

  it("tells a caller whose records these are when the text they asked for is nobody's name", () => {
    const pick = textNobodyIsNamed(vendorNames());
    assert.ok(pick, "every substring of every vendor name is itself a vendor name, so this control cannot run");

    const result = byVendor(pick.asked);
    const filter = soleFilter(result);
    assert.ok(result.total > 0, `vendor=${pick.asked} returns nothing, so there is no unasked-for name to declare`);
    assert.strictEqual(
      filter.records_under_a_name_you_asked_for,
      0,
      `${pick.asked} is nobody's name and the response counts records under it`,
    );
    assert.strictEqual(filter.records_under_another_name, result.total);
    assert.match(filter.note, /Not one of these/);
    assert.match(filter.note, new RegExp(pick.holder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(
      filter.matched.every((m) => m.how === "contains"),
      `vendor=${pick.asked} calls one of its matches exact`,
    );
  });

  it("says the match was exact rather than staying silent", () => {
    const exactOnly = vendorNames().filter((name) => {
      const filter = soleFilter(byVendor(name));
      return filter.records_under_another_name === 0 && filter.records_under_a_name_you_asked_for > 0;
    });
    assertPopulationFloor(exactOnly.length, 100, "vendor names whose records are all their own");

    for (const name of exactOnly.slice(0, 50)) {
      const filter = soleFilter(byVendor(name));
      assert.match(filter.note, /All \d+ of these records are under a vendor name you asked for/);
      assert.match(filter.note, /contains your text/);
    }
  });

  it("names the other companies a vendor filter reached, and how many records each holds", () => {
    const records = served();
    const reaching = vendorNames().filter((name) =>
      records.some((c) => contains(c.vendor, name) && c.vendor.toLowerCase() !== name.toLowerCase()),
    );
    assertPopulationFloor(reaching.length, 12, "vendor names that reach another vendor's records");

    for (const name of reaching) {
      const filter = soleFilter(byVendor(name));
      const foreign = filter.matched.filter((m) => m.how === "contains");
      assert.ok(foreign.length > 0, `vendor=${name} reaches another name and lists none`);
      for (const other of foreign) {
        const held = records.filter((c) => c.vendor === other.name).length;
        assert.strictEqual(other.records, held, `vendor=${name} miscounts ${other.name}'s records`);
        assert.ok(contains(other.name, name), `vendor=${name} lists ${other.name}, which does not contain it`);
      }
      assert.match(filter.note, /contains your text/);
    }
  });

  it("marks the categories a category filter reached by letters rather than by name", () => {
    const filter = soleFilter(byCategory("ai"));
    const foreign = filter.matched.filter((m) => m.how === "contains");
    assert.ok(
      foreign.some((m) => !/\bAI\b|AI\//i.test(m.name)),
      "categories=ai no longer reaches a category that is not about AI, so this control says nothing",
    );
    assert.strictEqual(filter.records_under_a_name_you_asked_for, 0, "ai is not a category name we publish");
    assert.strictEqual(filter.records_under_another_name, byCategory("ai").total);
    for (const match of foreign) {
      assert.ok(contains(match.name, "ai"), `categories=ai lists ${match.name}, which does not contain it`);
    }
  });

  it("counts the names it could not list, and lists every name the caller asked for", () => {
    const asked = "a";
    const result = byVendor(asked);
    const filter = soleFilter(result);
    const reached = new Set((result.changes as Record[]).map((c) => c.vendor));
    assert.ok(
      reached.size > filter.matched.length,
      `vendor=${asked} reaches ${reached.size} names and lists them all, so this control says nothing`,
    );
    assert.strictEqual(filter.matched_names_omitted, reached.size - filter.matched.length);
    assert.strictEqual(
      filter.records_under_a_name_you_asked_for + filter.records_under_another_name,
      result.total,
      "a capped list stopped the counts adding to total",
    );

    const named = served().find((c) => c.vendor);
    assert.ok(named, "the change log names no vendor, so this control cannot run");
    const both = getDealChanges(WHOLE_LOG, undefined, undefined, `${asked},${named.vendor}`);
    const bothFilter = soleFilter(both);
    assert.ok(
      bothFilter.matched_names_omitted > 0,
      "this request lists every name it matched, so a dropped exact match could not show here",
    );
    assert.ok(
      bothFilter.matched.some((m) => m.name === named.vendor && m.how === "exact"),
      `vendors=${asked},${named.vendor} dropped the name the caller asked for to make room`,
    );
  });

  it("describes both filters when a request names a vendor and a category", () => {
    const record = served().find((c) => c.category);
    assert.ok(record, "no served record carries a category, so this control cannot run");
    const result = getDealChanges(WHOLE_LOG, undefined, record.vendor, undefined, record.category);
    assert.ok(result.name_match.applied);
    assert.deepStrictEqual(
      result.name_match.filters.map((f) => f.parameter),
      ["vendor", "categories"],
    );
    for (const filter of result.name_match.filters) {
      assert.strictEqual(
        filter.records_under_a_name_you_asked_for + filter.records_under_another_name,
        result.total,
      );
    }
  });

  it("says no name filter ran when none did", () => {
    const result = getDealChanges(WHOLE_LOG);
    assert.strictEqual(result.name_match.applied, false);
    assert.strictEqual(result.name_match.rule, null);
    assert.deepStrictEqual(result.name_match.filters, []);
    assert.match(result.name_match.note, /No vendor or category filter was applied/);
  });

  it("carries the same declaration on the personalized shape", () => {
    const name = vendorNames()[0];
    const personalized = getPersonalizedChanges(WHOLE_LOG, undefined, undefined, name, "Databases");
    assert.ok(personalized.name_match.applied, "the personalized shape drops name_match");
    assert.deepStrictEqual(
      personalized.name_match.filters.map((f) => f.parameter),
      ["vendors", "categories"],
    );
  });

  it("states the rule wherever the parameter is declared", () => {
    assert.match(NAME_MATCH_SENTENCE, /substring/);
    assert.match(NAME_MATCH_SENTENCE, /name_match/);

    const declarations = [
      { file: "src/server.ts", why: "the tool schema the in-process MCP server publishes" },
      { file: "src/server-remote.ts", why: "the tool schema the stdio proxy publishes" },
      { file: "src/serve.ts", why: "the reference /llms-full.txt serves" },
      { file: "src/openapi.ts", why: "the parameters /openapi.json declares" },
    ];
    for (const { file, why } of declarations) {
      const source = readFileSync(path.join(REPO, file), "utf8");
      assert.ok(
        source.includes("NAME_MATCH_SENTENCE"),
        `${why} declares a name filter without saying it matches by substring (${file})`,
      );
      assert.ok(
        !/Filter to one vendor \(case-insensitive\)/.test(source),
        `${why} still calls the vendor filter case-insensitive, which reads as exact (${file})`,
      );
      assert.ok(
        !/Case-insensitive partial match\./.test(source),
        `${why} still says partial match without saying what comes back (${file})`,
      );
    }
  });
});
