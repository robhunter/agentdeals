import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  restatementsTheIndexNeverTook,
  restatementsWrittenAgain,
} from "../scripts/restate-superseded-terms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => JSON.parse(readFileSync(path.join(__dirname, "..", "data", file), "utf-8"));

const ledger = read("restated_terms.json").restatements as any[];
const offers = read("index.json").offers as any[];

const named = (entries: any[]) => entries.map(entry => `${entry.vendor} ${entry.restated_on}`);

const restated = offers.find(offer => offer.restated_from);
const itsEntry = ledger.find(
  entry => entry.vendor === restated?.vendor && entry.url === restated?.url && entry.restated_on === restated?.restated_from.restated_on,
);

describe("the restatement ledger records only the restatements the index took", () => {
  it("holds at least one restatement the index publishes, so the census has a subject", () => {
    assert.ok(restated && itsEntry, "no record in the index carries a restatement the ledger holds");
  });

  it("names, for every record, the restatement the index publishes as its newest standing entry", () => {
    assert.deepStrictEqual(named(restatementsTheIndexNeverTook(ledger, offers)), []);
  });

  it("holds each reading's restatement of a record once", () => {
    assert.deepStrictEqual(named(restatementsWrittenAgain(ledger)), []);
  });

  it("finds an entry the index never took", () => {
    const untaken = { ...itsEntry, restated_on: "2099-01-01", description: `${itsEntry.description} (held back)` };
    assert.deepStrictEqual(named(restatementsTheIndexNeverTook([...ledger, untaken], offers)), [`${restated.vendor} 2099-01-01`]);
  });

  it("finds the same reading's restatement written a second time, on a day the index did not take it", () => {
    const again = { ...itsEntry, restated_on: "2099-01-01" };
    assert.deepStrictEqual(named(restatementsWrittenAgain([...ledger, again])), [`${restated.vendor} 2099-01-01`]);
    assert.deepStrictEqual(named(restatementsTheIndexNeverTook([...ledger, again], offers)), [`${restated.vendor} 2099-01-01`]);
  });

  it("finds a record whose terms are not the ones its newest restatement wrote", () => {
    const edited = offers.map(offer => (offer === restated ? { ...offer, description: `${offer.description} (edited)` } : offer));
    assert.deepStrictEqual(named(restatementsTheIndexNeverTook(ledger, edited)), [`${itsEntry.vendor} ${itsEntry.restated_on}`]);
  });

  it("does not count an entry that has been reverted", () => {
    const reverted = { ...itsEntry, restated_on: "2099-01-01", description: "reverted", reverted_on: "2099-01-02" };
    assert.deepStrictEqual(named(restatementsTheIndexNeverTook([...ledger, reverted], offers)), []);
    assert.deepStrictEqual(named(restatementsWrittenAgain([...ledger, { ...itsEntry, reverted_on: "2099-01-02" }])), []);
  });
});
