import { describe, it } from "node:test";
import assert from "node:assert";
import { loadOffers } from "../dist/data.js";
import { clauseBefore, readPlacedModelRates } from "../dist/model-rates.js";

const TIER_DISCOUNT_OR_THEN = /\b(?:batch|flex|priority|cached|caching|long[- ]context|then)\b|\b(?:over|above)\s+\d[\d,.]*\s*K\b/i;
const THEN_DIRECTLY_BEFORE = /\bthen\s+$/i;
const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const FROM_A_DATE = new RegExp(String.raw`^\s*from\s+(?:\d{4}-\d{2}-\d{2}|${MONTH}\.?\s+\d{1,2}(?:,\s*\d{4})?)`, "i");

const GEMINI_PAID_TERMS_WITH_TIER_PAIRS =
  'Paid, per million tokens (input/output; output prices include thinking tokens): Gemini 4 Argon $2/$10 through 2026-11-30, then $4/$20 from 2026-12-01 (input and output both double; context caching $0.10, then $0.20, implicit caching only); Gemini 3.8 Flash $0.75/$3.75 until 2026-12-31, then $1.50 input and $7.50 output from 2027-01-01 (3.6 Flash: the same prices and dates); Gemini 3.5 Flash-Lite $0.30/$2.50; Gemini 3.1 Flash-Lite $0.25/$1.50; Gemini 3.1 Pro Preview $2/$12 (prompts up to 200K tokens). From December 1, 2026, Gemini 4 Argon costs $4 per million input tokens and $20 per million output tokens. The Batch API costs half the standard price; Gemini 3.8 Flash is $0.375/$1.875 per million tokens through 2026-12-31. Gemini 4 Argon on the Batch API is $1/$5 through 2026-11-30, then $2/$10 from 2026-12-01. Google also sells two tiers, Flex and Priority, both in Preview. A request picks one with the service_tier field ("flex" or "priority"); without it the request is Standard. Gemini 4 Argon on Flex is $1/$5 through 2026-11-30, then $2/$10 from 2026-12-01; on Priority it is $3.60/$18 through 2026-11-30, then $7.20/$36 from 2026-12-01.';

interface PairToRewrite {
  pair: string;
  reasons: string[];
  inWords: string;
}

function pairsToWriteInWords(description: string): PairToRewrite[] {
  const firstPairOfModel = new Map<string, string>();
  const rewrites: PairToRewrite[] = [];
  for (const rate of readPlacedModelRates(description)) {
    const pair = description.slice(rate.at, rate.end);
    const before = description.slice(0, rate.at);
    const reasons: string[] = [];
    const named = clauseBefore(before).match(TIER_DISCOUNT_OR_THEN);
    if (named) reasons.push(`its clause says "${named[0]}"`);
    else if (THEN_DIRECTLY_BEFORE.test(before)) reasons.push('it follows "then"');
    const dated = description.slice(rate.end).match(FROM_A_DATE);
    if (dated) reasons.push(`it is followed by "${dated[0].trim()}"`);
    if (rate.model) {
      const figures = `${rate.input}/${rate.output ?? ""}`;
      const first = firstPairOfModel.get(rate.model.toLowerCase());
      if (first === undefined) firstPairOfModel.set(rate.model.toLowerCase(), figures);
      else if (first !== figures) reasons.push(`it gives ${rate.model} a second price after ${first}`);
    }
    if (reasons.length) {
      const inWords = rate.output === null ? `${rate.input} per million input tokens` : `${rate.input} input and ${rate.output} output`;
      rewrites.push({ pair, reasons, inWords });
    }
  }
  return rewrites;
}

const pairsIn = (description: string) => pairsToWriteInWords(description).map((r) => r.pair);

function failuresIn(listings: { vendor: string; tier: string; description: string }[]): string[] {
  return listings.flatMap((listing) =>
    pairsToWriteInWords(listing.description).map(
      (r) => `${listing.vendor} (${listing.tier}): ${r.pair}: ${r.reasons.join("; ")}. Write that price in words, such as "${r.inWords}", or the rate reader takes it as a current standard rate.`,
    ),
  );
}

describe("price pairs in listing descriptions", () => {
  it("are each a model's current standard rate in every listing, so the rate reader can take them as one", () => {
    const listings = loadOffers();
    assert.ok(listings.some((listing) => readPlacedModelRates(listing.description).length > 0), "no listing holds a price pair, so the check reads nothing");
    assert.deepStrictEqual(failuresIn(listings), []);
  });

  it("are refused for each tier, discount and dated price in the Google Gemini API terms that gave them as pairs", () => {
    assert.deepStrictEqual(pairsIn(GEMINI_PAID_TERMS_WITH_TIER_PAIRS), ["$4/$20", "$0.375/$1.875", "$1/$5", "$2/$10", "$1/$5", "$2/$10", "$3.60/$18", "$7.20/$36"]);
  });

  it("are refused when the clause before them names a tier, a discount or a context size", () => {
    for (const clause of ["Model X on the Batch API is", "Model X on Flex is", "on Priority Model X is", "Model X cached input is", "Model X with context caching is", "Model X long-context prompts are", "Model X prompts over 200K tokens are", "Model X prompts above 128K are"]) {
      assert.deepStrictEqual(pairsIn(`Model X $2/$8. ${clause} $1/$4.`), ["$1/$4"], clause);
    }
  });

  it("are refused when they follow then, with or without a date after them", () => {
    assert.deepStrictEqual(pairsIn("Model X $2/$8 for the first year, then $4/$16."), ["$4/$16"]);
    assert.deepStrictEqual(pairsIn("Model X $2/$8 through 2026-11-30, then Model X $4/$16 after that."), ["$4/$16"]);
  });

  it("are refused when a start date follows them directly", () => {
    assert.deepStrictEqual(pairsIn("Model X $4/$16 from 2026-12-01."), ["$4/$16"]);
    assert.deepStrictEqual(pairsIn("Model X $4/$16 from December 1, 2026."), ["$4/$16"]);
    assert.deepStrictEqual(pairsIn("Model X $4/$16 from Dec 1."), ["$4/$16"]);
  });

  it("are refused when they give a model a second, different price, and the model's first price stands", () => {
    assert.deepStrictEqual(pairsIn("Model X $2/$8; Model Y $1/$2. The cheaper option: Model X is $1/$4."), ["$1/$4"]);
    assert.deepStrictEqual(pairsIn("Model X $2/$8; model x $1/$4."), ["$1/$4"]);
  });

  it("pass a current price with an end date, followed by the next price in words", () => {
    assert.deepStrictEqual(pairsIn("Gemini 4 Argon $2/$10 through 2026-11-30, then $4 input and $20 output from 2026-12-01"), []);
    assert.deepStrictEqual(pairsIn("Gemini 3.8 Flash $0.75/$3.75 until 2026-12-31, then $1.50 input and $7.50 output from 2027-01-01."), []);
  });

  it("pass a rate with its prompt-size condition after it, and a model's same price given twice", () => {
    assert.deepStrictEqual(pairsIn("Gemini 3.1 Pro Preview $2/$12 (prompts up to 200K tokens)"), []);
    assert.deepStrictEqual(pairsIn("Model X $2/$8. Model X $2/$8 on every plan."), []);
  });

  it("name the listing, the pair, why, and the price in words when they fail", () => {
    const listing = { vendor: "Example AI", tier: "Free", description: "Model X $2/$8. Model X on the Batch API is $1/$4 from 2026-12-01; Model X is $3/$9." };
    assert.deepStrictEqual(failuresIn([listing]), [
      'Example AI (Free): $1/$4: its clause says "Batch"; it is followed by "from 2026-12-01". Write that price in words, such as "$1 input and $4 output", or the rate reader takes it as a current standard rate.',
      'Example AI (Free): $3/$9: it gives Model X a second price after $2/$8. Write that price in words, such as "$3 input and $9 output", or the rate reader takes it as a current standard rate.',
    ]);
  });
});
