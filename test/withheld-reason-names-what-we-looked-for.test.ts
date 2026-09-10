import { describe, it } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const {
  LEVEL_WITHHOLDING_OUTCOMES,
  NO_PRICE_SIGNAL_PHRASE,
  unconfirmedTermsClause,
  withheldLevelClause,
  withheldLevelSentence,
} = await import("../dist/source-check.js");
const { unconfirmedTermsMetaSentence } = await import("../dist/vendor-verdict.js");
const { classifySource } = await import("../scripts/vendor-naming.js");
const { priceSignals } = await import("../scripts/change-gate.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");
const INDEX_PATH = path.join(__dirname, "..", "data", "index.json");

const OVERCLAIM = /states no terms/;

const SENTENCES: Record<string, string> = {
  link_unreachable: "Acme's pricing page has not resolved for us.",
  does_not_name_vendor: "The page we cite for Acme does not name it.",
  does_not_name_product: "The page we cite for Acme names the platform it runs on and not Acme itself.",
  states_no_terms: "The page we cite for Acme states no amount, tier or rate we can read.",
  unreadable: "We could not read the page we cite for Acme.",
};

const CLAUSES: Record<string, string> = {
  link_unreachable: "its pricing page has not resolved for us",
  does_not_name_vendor: "the page we cite for this offer does not name it",
  does_not_name_product: "the page we cite for this offer names the platform it runs on and not the offer itself",
  states_no_terms: "the page we cite for this offer states no amount, tier or rate we can read",
  unreadable: "we could not read the page we cite for this offer",
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(path.join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [path.join(dir, entry.name)]
        : [],
  );
}

describe("what we tell a reader when we hold a rating back", () => {
  for (const [reason, sentence] of Object.entries(SENTENCES)) {
    it(`states the ${reason} sentence, so an edit to one cannot silently change another`, () => {
      assert.strictEqual(withheldLevelSentence(reason as never, "Acme"), sentence);
    });
  }

  for (const [reason, clause] of Object.entries(CLAUSES)) {
    it(`states the ${reason} clause, so an edit to one cannot silently change another`, () => {
      assert.strictEqual(withheldLevelClause(reason as never), clause);
    });
  }

  it("carries the same clause into what an agent is told about unconfirmed terms", () => {
    for (const outcome of LEVEL_WITHHOLDING_OUTCOMES) {
      assert.strictEqual(unconfirmedTermsClause(outcome), CLAUSES[outcome], outcome);
    }
  });
});

describe("the sentence names what the check looked for rather than claiming the page said nothing", () => {
  it("says what the check recorded in the field beside it, word for word", () => {
    const text = "MinIO. Purpose-built subscription tiers support no-cost development to mission-critical production.";
    const check = classifySource({ vendor: "MinIO", url: "https://min.io/pricing" }, { ok: true, text }, priceSignals(text));
    assert.strictEqual(check.outcome, "states_no_terms");
    assert.ok(check.detail.endsWith(NO_PRICE_SIGNAL_PHRASE), check.detail);
    assert.ok(withheldLevelSentence("states_no_terms", "MinIO").includes(NO_PRICE_SIGNAL_PHRASE));
    assert.ok(withheldLevelClause("states_no_terms").includes(NO_PRICE_SIGNAL_PHRASE));
  });

  it("says nothing about the page being silent, which is what it could not establish", () => {
    assert.doesNotMatch(withheldLevelSentence("states_no_terms", "Acme"), OVERCLAIM);
    assert.doesNotMatch(withheldLevelClause("states_no_terms"), OVERCLAIM);
    assert.doesNotMatch(unconfirmedTermsMetaSentence("states_no_terms"), OVERCLAIM);
  });

  it("keeps the sentence a meta description can carry", () => {
    assert.strictEqual(
      unconfirmedTermsMetaSentence("states_no_terms"),
      "Not verified — the page we cite for this offer states no amount, tier or rate we can read.",
    );
  });

  it("leaves the outcome for a page that named a plan saying something different", () => {
    assert.notStrictEqual(unconfirmedTermsClause("states_no_amount"), unconfirmedTermsClause("states_no_terms"));
    assert.match(unconfirmedTermsClause("states_no_amount"), /names a plan but states no amount/);
  });
});

describe("no surface keeps its own copy of the sentence this replaced", () => {
  const sources = filesUnder(SRC);

  it("reads the whole of src, so the scan is not looking at one file", () => {
    assertPopulationFloor(sources.length, 60, "TypeScript files under src the scan reads");
  });

  it("finds the phrase in none of them", () => {
    const carrying = sources.filter((file) => OVERCLAIM.test(readFileSync(file, "utf-8")));
    assert.deepStrictEqual(carrying.map((file) => path.relative(SRC, file)), []);
  });

  it("is read against a catalogue where the outcome it describes is not empty", () => {
    const offers = JSON.parse(readFileSync(INDEX_PATH, "utf-8")).offers as any[];
    const stating = offers.filter((offer) => offer.source_check?.outcome === "states_no_terms");
    assert.ok(stating.length > 0, "no record in the catalogue carries the outcome this sentence describes");
    assertPopulationFloor(offers.length, 1000, "offers in the catalogue this sentence is read against");
  });
});
