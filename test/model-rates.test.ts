import { describe, it } from "node:test";
import assert from "node:assert";
import {
  readModelRates,
  cheapestRate,
  dearestRate,
  spanOfRates,
  formatRate,
  formatRateSpan,
  monthlyTokenCost,
  formatDollars,
  amountValue,
  publishableRates,
  soleMatch,
} from "../dist/model-rates.js";

describe("reading model rates out of a record description", () => {
  it("reads a colon-introduced pair and keeps the model name", () => {
    const rates = readModelRates("Claude API access with usage-based pricing. Sonnet 5: $2/$10 per MTok.");
    assert.deepEqual(rates, [{ model: "Sonnet 5", input: "$2", output: "$10" }]);
  });

  it("reads several pairs from one sentence run and keeps each name", () => {
    const rates = readModelRates(
      "Fable 5.1: $10/$50 per MTok (input/output). Opus 5: $5/$25 per MTok. Haiku 4.5: $1/$5 per MTok.",
    );
    assert.deepEqual(rates.map(r => r.model), ["Fable 5.1", "Opus 5", "Haiku 4.5"]);
    assert.deepEqual(rates.map(r => `${r.input}/${r.output}`), ["$10/$50", "$5/$25", "$1/$5"]);
  });

  it("does not read a version dot as the end of a sentence", () => {
    const rates = readModelRates("Per-model paid pricing: Gemini 2.5 Pro $1.25/$10 (≤200K, doubles above).");
    assert.deepEqual(rates, [{ model: "Gemini 2.5 Pro", input: "$1.25", output: "$10" }]);
  });

  it("does not swallow a trailing comma or full stop into the amount", () => {
    const rates = readModelRates("Gemini 3.0 Flash Preview $0.50/$3, Gemini 2.5 Flash $0.30/$2.50.");
    assert.deepEqual(rates.map(r => r.output), ["$3", "$2.50"]);
  });

  it("reads a rate split across input and output clauses", () => {
    const rates = readModelRates("DeepSeek V3.2 (deepseek-chat): $0.28/M input, $0.42/M output (1M context).");
    assert.deepEqual(rates, [{ model: "DeepSeek V3.2", input: "$0.28", output: "$0.42" }]);
  });

  it("takes the model name from after the rate when the sentence puts it there", () => {
    const rates = readModelRates("Paid API rates start at $0.5/M input and $1.5/M output tokens for Mistral Large.");
    assert.deepEqual(rates, [{ model: "Mistral Large", input: "$0.5", output: "$1.5" }]);
  });

  it("keeps a version number in a name that follows the rate", () => {
    const rates = readModelRates("Starting at $0.20/M input tokens, $0.50/M output tokens for Grok 4.1 Fast.");
    assert.equal(rates[0].model, "Grok 4.1 Fast");
  });

  it("reads an input rate with no stated output rate rather than inventing one", () => {
    const rates = readModelRates("Paid tiers use token-based pricing: GPT-4o from $2.50/1M input tokens.");
    assert.deepEqual(rates, [{ model: "GPT-4o", input: "$2.50", output: null }]);
  });

  it("reads no rate out of a description that states none", () => {
    assert.deepEqual(readModelRates("Free tier: 30 RPM, 100K-500K tokens/day depending on model."), []);
    assert.deepEqual(readModelRates(""), []);
    assert.deepEqual(readModelRates(undefined), []);
  });

  it("does not report a price of the plan itself as a model rate", () => {
    assert.deepEqual(readModelRates("Pro plan ($20/seat/mo) with 100 GB/month transfer."), []);
  });

  it("does not claim a name it cannot find", () => {
    const rates = readModelRates("Token pricing is $1/$4 per MTok.");
    assert.equal(rates.length, 1);
    assert.equal(rates[0].model, null);
  });
});

describe("choosing and formatting a rate to publish", () => {
  const lineup = readModelRates("Fable 5.1: $10/$50 per MTok. Opus 5: $5/$25 per MTok. Haiku 4.5: $1/$5 per MTok.");

  it("orders by the input rate, not by the order the record states them in", () => {
    assert.equal(cheapestRate(lineup)?.model, "Haiku 4.5");
    assert.equal(dearestRate(lineup)?.model, "Fable 5.1");
  });

  it("spans from cheapest to dearest", () => {
    assert.deepEqual(spanOfRates(lineup).map(r => r.model), ["Haiku 4.5", "Fable 5.1"]);
  });

  it("collapses a span whose ends carry the same figures", () => {
    const twins = readModelRates("DeepSeek V3.2: $0.28/M input, $0.42/M output. DeepSeek V3.2 Thinking: $0.28/M input, $0.42/M output.");
    assert.equal(twins.length, 2);
    assert.deepEqual(spanOfRates(twins).map(r => r.model), ["DeepSeek V3.2"]);
  });

  it("has nothing to span when the record carries no rate", () => {
    assert.deepEqual(spanOfRates([]), []);
    assert.equal(formatRateSpan([]), null);
    assert.equal(cheapestRate([]), null);
  });

  it("marks a rate that states only an input price", () => {
    assert.equal(formatRate({ model: "GPT-4o", input: "$2.50", output: null }), "$2.50 (GPT-4o, input only)");
  });

  it("names the model beside the figures", () => {
    assert.equal(formatRateSpan(lineup), "$1/$5 (Haiku 4.5) – $10/$50 (Fable 5.1)");
  });
});

describe("pricing a month of traffic at a recorded rate", () => {
  it("bills input and output separately", () => {
    assert.equal(monthlyTokenCost({ model: "Sonnet 5", input: "$2", output: "$10" }, 100, 100), 1200);
  });

  it("declines to price a rate with no output figure", () => {
    assert.equal(monthlyTokenCost({ model: "GPT-4o", input: "$2.50", output: null }, 100, 100), null);
  });

  it("reads an amount written with thousands separators", () => {
    assert.equal(amountValue("$1,250.50"), 1250.5);
  });

  it("writes a whole-dollar figure with separators", () => {
    assert.equal(formatDollars(6000), "$6,000");
    assert.equal(formatDollars(69.6), "$70");
  });
});

describe("deciding which of a record's rates may be published", () => {
  const priced = { tier: "Pay-as-you-go", description: "Sonnet 5: $2/$10 per MTok." };

  it("publishes the rates of an offer that is still on sale", () => {
    assert.deepEqual(publishableRates(priced), [{ model: "Sonnet 5", input: "$2", output: "$10" }]);
  });

  it("publishes no rate for an offer the record says has ended", () => {
    assert.deepEqual(publishableRates({ ...priced, tier: "Retired" }), []);
    assert.deepEqual(publishableRates({ ...priced, tier: "Discontinued" }), []);
  });

  it("publishes no rate when there is no record", () => {
    assert.deepEqual(publishableRates(null), []);
  });
});

describe("resolving a slug to one record", () => {
  const arize = [{ vendor: "Arize AI" }, { vendor: "Arize Ax" }, { vendor: "Groq" }];

  it("returns the record when exactly one vendor takes the slug", () => {
    assert.deepEqual(soleMatch(arize, "groq"), { vendor: "Groq" });
  });

  it("returns nothing when two vendors take the same slug", () => {
    assert.equal(soleMatch([{ vendor: "Arize AI" }, { vendor: "Arize.ai" }], "arize-ai"), null);
  });

  it("returns nothing when no vendor takes the slug", () => {
    assert.equal(soleMatch(arize, "cerebras"), null);
  });
});
