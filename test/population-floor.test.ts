import { describe, it } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  asShare,
  assertCoversPopulation,
  assertPopulationFloor,
  assertSharesPopulation,
  bareFloorsIn,
  categoriesInTheCatalogue,
  floorClearsHeadroom,
  passedPopulationsIn,
  recordsInTheCatalogue,
  shareClearsHeadroom,
  REGISTERED_FROM,
  vendorsInTheCatalogue,
} from "./population-floor.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

const asWritten = (expression: string, comparison: string, literal: number) =>
  `assert.ok(${expression} ${comparison} ${literal}, "the message it carries");`;

const COVERAGE = "assertCoversPopulation";

const SHARE = "assertSharesPopulation";

describe("a floor over a live population states headroom it has measured", () => {
  it("passes a floor the population clears by more than a quarter", () => {
    assertPopulationFloor(1572, 300, "vendors publish a badge verdict");
  });

  it("refuses a floor sitting inside the quarter below the population it measured", () => {
    assert.throws(
      () => assertPopulationFloor(604, 601, "records passed their source check"),
      /a floor of 601 leaves under 25% headroom over the 604 it measured — records passed their source check/,
    );
  });

  it("refuses a floor set to exactly what the population measured today", () => {
    assert.throws(() => assertPopulationFloor(27, 27, "records are dated that day"), /headroom/);
  });

  it("still fails when the population is under the floor", () => {
    assert.throws(
      () => assertPopulationFloor(596, 601, "records passed their source check"),
      /only 596 records passed their source check, under a floor of 601/,
    );
  });

  it("allows a floor of one, which says the population is not empty rather than how large it is", () => {
    assert.strictEqual(floorClearsHeadroom(1, 1), true);
    assert.strictEqual(floorClearsHeadroom(2, 2), false);
  });

  it("keeps a vacuity guard far below its population", () => {
    assert.strictEqual(floorClearsHeadroom(10, 1572), true);
    assert.strictEqual(floorClearsHeadroom(300, 552), true);
    assert.strictEqual(floorClearsHeadroom(500, 552), false);
    assert.strictEqual(floorClearsHeadroom(1500, 1572), false);
  });
});

describe("a sweep read against the population it covers states coverage, not headroom", () => {
  it("passes where the sweep reaches every member of the population it was read against", () => {
    assertCoversPopulation(2528, vendorsInTheCatalogue(), "paths served for the sweep");
    assertCoversPopulation(77, categoriesInTheCatalogue(), "categories publishing a denominator in an answer");
  });

  it("passes where the sweep covers the population exactly, which a floor would refuse for headroom", () => {
    const measured = categoriesInTheCatalogue().size;
    assert.strictEqual(floorClearsHeadroom(measured, measured), false);
    assertCoversPopulation(measured, categoriesInTheCatalogue(), "categories publishing a denominator in an answer");
  });

  it("fails where the sweep misses a member, naming both sides", () => {
    const measured = vendorsInTheCatalogue().size;
    assert.throws(
      () => assertCoversPopulation(measured - 1, vendorsInTheCatalogue(), "paths served for the sweep"),
      new RegExp(`${measured - 1} paths served for the sweep, against ${measured} vendors the catalogue holds`),
    );
  });

  it("shrinks with the data it reads rather than going red when a curation empties a category", () => {
    const catalogue = vendorsInTheCatalogue();
    const categories = categoriesInTheCatalogue();
    assert.ok(catalogue.size > categories.size, "the catalogue holds more vendors than categories");
    assert.notStrictEqual(catalogue.read, categories.read);
  });

  it("refuses a population handed over as a number rather than read from the data", () => {
    const asCalled = (population: string) => `${COVERAGE}(checked, ${population}, "a subject");`;
    assert.deepStrictEqual(passedPopulationsIn(`${SHARE}(checked, 1573, 0.05, "a subject");`).map(p => p.argument), ["1573"]);
    assert.deepStrictEqual(passedPopulationsIn(`${SHARE}(checked, recordsInTheCatalogue(), 0.05, "a subject");`), []);
    assert.deepStrictEqual(passedPopulationsIn(asCalled("60")).map(p => p.argument), ["60"]);
    assert.deepStrictEqual(
      passedPopulationsIn(asCalled('{ size: 60, read: "made up" }')).map(p => p.argument),
      ['{ size: 60, read: "made up" }'],
    );
    assert.deepStrictEqual(passedPopulationsIn(asCalled("liveCategories(60)")).map(p => p.argument), ["liveCategories(60)"]);
    assert.deepStrictEqual(passedPopulationsIn(asCalled("() => 60")).map(p => p.argument), ["() => 60"]);
    assert.deepStrictEqual(passedPopulationsIn(asCalled("categoriesInTheCatalogue()")), []);
  });

  it("holds every file in the suite to it", () => {
    const passed: string[] = [];
    for (const file of readdirSync(TEST_DIR).filter(name => name.endsWith(".ts"))) {
      for (const site of passedPopulationsIn(readFileSync(path.join(TEST_DIR, file), "utf-8"))) {
        passed.push(`${file}:${site.line} ${site.argument}`);
      }
    }
    assert.deepStrictEqual(
      passed,
      [],
      "a population has to be read by a no-argument reader in population-floor.ts, because a caller that computes the number has put the literal back one indirection later",
    );
  });
});

describe("a filtered subset states a share of the population it filtered, not a count", () => {
  const asRead = (size: number) => () => ({ size, read: "records the catalogue holds" });
  const wholeCatalogue = asRead(1573);
  const curatedCatalogue = asRead(1547);
  const halfTheCatalogue = asRead(900);
  const aSliverOfIt = asRead(160);
  const noCatalogueAtAll = asRead(0);

  it("passes where the subset is a comfortable share of what it was filtered from", () => {
    assertSharesPopulation(137, wholeCatalogue(), 0.05, "records restating their host");
  });

  it("holds where the population shrinks and the subset shrinks with it", () => {
    const measured: [number, () => { size: number; read: string }][] = [
      [137, wholeCatalogue],
      [132, curatedCatalogue],
      [80, halfTheCatalogue],
      [14, aSliverOfIt],
    ];
    for (const [subset, population] of measured) {
      assertSharesPopulation(subset, population(), 0.05, "records restating their host");
    }
  });

  it("fails where the filter collapses while the population stands still", () => {
    assert.throws(
      () => assertSharesPopulation(40, wholeCatalogue(), 0.05, "records restating their host"),
      /40 records restating their host, which is 2.5% of the 1573 records the catalogue holds it was filtered from, under a floor of 5.0%/,
    );
  });

  it("refuses a share set close enough to what it measured to be a tripwire on the filter", () => {
    assert.strictEqual(shareClearsHeadroom(0.05, 137, 1573), true);
    assert.strictEqual(shareClearsHeadroom(0.08, 137, 1573), false);
    assert.throws(
      () => assertSharesPopulation(137, wholeCatalogue(), 0.08, "records restating their host"),
      /a share of 8.0% leaves under 25% headroom over the 8.7% it measured/,
    );
  });

  it("says nothing rather than passing vacuously when the population it filtered is empty", () => {
    assert.throws(
      () => assertSharesPopulation(0, noCatalogueAtAll(), 0.05, "records restating their host"),
      /there are no records the catalogue holds, so no share of them says anything/,
    );
  });

  it("reads a share the way a reader would", () => {
    assert.strictEqual(asShare(0.05), "5.0%");
    assert.strictEqual(asShare(137 / 1573), "8.7%");
  });

  it("reads its own populations off the catalogue, both of them non-empty", () => {
    assert.ok(recordsInTheCatalogue().size > categoriesInTheCatalogue().size);
    assert.notStrictEqual(recordsInTheCatalogue().read, categoriesInTheCatalogue().read);
  });
});

describe("no test in the suite floors a live population on a bare literal", () => {
  it("reads the shape it is written to find", () => {
    assert.deepStrictEqual(
      bareFloorsIn(asWritten("routes.length", ">", 2000)).map(f => f.literal),
      [2000],
    );
    assert.deepStrictEqual(
      bareFloorsIn(asWritten("verdicts.size", ">=", 1500)).map(f => f.literal),
      [1500],
    );
    assert.deepStrictEqual(
      bareFloorsIn(`${asWritten("spans", ">", 150)}\n  ${asWritten("subjects.size", ">", 100)}`).map(f => f.line),
      [1, 2],
    );
  });

  it("reads a floor over a counter the test raised itself, not only over a collection", () => {
    assert.deepStrictEqual(bareFloorsIn(asWritten("compared", ">", 700)).map(f => f.literal), [700]);
    assert.deepStrictEqual(bareFloorsIn(asWritten("body.total", ">=", 200)).map(f => f.literal), [200]);
  });

  it("leaves a guard below the threshold and a ceiling above it alone", () => {
    assert.deepStrictEqual(bareFloorsIn(asWritten("answered.length", ">", 10)), []);
    assert.deepStrictEqual(bareFloorsIn(asWritten("advisory.length", "<=", 3000)), []);
    assert.deepStrictEqual(bareFloorsIn(asWritten("keys.length", "<", 302)), []);
  });

  it("leaves a floor alone where the same assertion bounds it above", () => {
    assert.deepStrictEqual(bareFloorsIn('assert.ok(wc >= 200 && wc <= 400, "the message it carries");'), []);
  });

  it("reads a floor whose message and condition both hold a comma", () => {
    assert.deepStrictEqual(
      bareFloorsIn(`assert.ok(routes.length > ${2000}, "read some, of many");`).map(f => f.literal),
      [2000],
    );
    assert.deepStrictEqual(
      bareFloorsIn(`assert.ok(rows.filter((r) => r.n > ${2}).length > ${400}, "a message");`).map(f => f.literal),
      [400],
    );
  });

  it("holds every file in the suite to it", () => {
    const bare: string[] = [];
    for (const file of readdirSync(TEST_DIR).filter(name => name.endsWith(".ts"))) {
      for (const floor of bareFloorsIn(readFileSync(path.join(TEST_DIR, file), "utf-8"))) {
        bare.push(`${file}:${floor.line} ${floor.text}`);
      }
    }
    assert.deepStrictEqual(
      bare,
      [],
      `a floor of ${REGISTERED_FROM} or more over a collection has to go through assertPopulationFloor, which measures its headroom against the population as it stands on the day it runs`,
    );
  });
});
