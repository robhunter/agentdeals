import { describe, it } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPopulationFloor,
  bareFloorsIn,
  floorClearsHeadroom,
  REGISTERED_FROM,
} from "./population-floor.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

const asWritten = (expression: string, comparison: string, literal: number) =>
  `assert.ok(${expression} ${comparison} ${literal}, "the message it carries");`;

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
