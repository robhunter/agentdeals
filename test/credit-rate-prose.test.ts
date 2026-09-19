import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const offers = JSON.parse(readFileSync(path.join(root, "data", "index.json"), "utf-8")).offers as
  Array<Record<string, any>>;
const serve = readFileSync(path.join(root, "src", "serve.ts"), "utf-8");

const netlify = offers.find(o => o.vendor === "Netlify" && o.category === "Cloud Hosting");

const rateFrom = (text: string, unit: RegExp) => {
  const match = text.match(unit);
  return match ? Number(match[1].replace(/,/g, "")) : null;
};

const metered = (unit: string) =>
  new RegExp(String.raw`(\d[\d,]*) credits?(?: limit)?\s*(?:\/|per )\s*${unit}`, "i");

const RECORDED = {
  allowance: rateFrom(netlify.description, metered("month")),
  bandwidth: rateFrom(netlify.description, metered("GB(?!-)")),
  compute: rateFrom(netlify.description, metered("GB-hour")),
  requests: rateFrom(netlify.description, metered("10[Kk]")),
  deploy: rateFrom(netlify.description, /(\d[\d,]*) credits each/),
};

const published = (pattern: RegExp) =>
  [...serve.matchAll(pattern)].map(m => ({ value: Number(m[1].replace(/,/g, "")), text: m[0] }));

const disagreeing = (pattern: RegExp, recorded: number | null) =>
  published(pattern)
    .filter(({ value }) => value !== recorded)
    .map(({ text }) => `${text} (the record holds ${recorded})`);

describe("prose that quotes a credit rate agrees with the record that holds it (#1332)", () => {
  it("reads every rate the vendor meters from the record rather than from a literal", () => {
    assert.deepStrictEqual(RECORDED, { allowance: 300, bandwidth: 20, compute: 10, requests: 2, deploy: 15 });
  });

  it("reads a rate the record states in the vendor's words as well as in ours", () => {
    const asWeStoreIt =
      "300 credits/month (deploys at 15 credits each, bandwidth at 20 credits/GB, compute at 10 credits/GB-hour, web requests at 2 credits/10K)";
    const asTheVendorWritesIt =
      "The Free plan offers 300 credit limit / month, including production deploys (15 credits each), " +
      "compute (10 credits per GB-hour), bandwidth (20 credits per GB), and web requests (2 credits per 10k requests).";
    for (const text of [asWeStoreIt, asTheVendorWritesIt]) {
      assert.equal(rateFrom(text, metered("month")), 300);
      assert.equal(rateFrom(text, metered("GB(?!-)")), 20);
      assert.equal(rateFrom(text, metered("GB-hour")), 10);
      assert.equal(rateFrom(text, metered("10[Kk]")), 2);
      assert.equal(rateFrom(text, /(\d[\d,]*) credits each/), 15);
    }
  });

  it("publishes no bandwidth rate the record does not hold", () => {
    const wrong = disagreeing(/(\d[\d,]*) credits?\/GB(?!-)/g, RECORDED.bandwidth);
    assert.deepStrictEqual(wrong, [], `bandwidth rates in src/serve.ts:\n${wrong.join("\n")}`);
  });

  it("publishes no compute rate the record does not hold", () => {
    const wrong = disagreeing(/(\d[\d,]*) credits?\/GB-hour/g, RECORDED.compute);
    assert.deepStrictEqual(wrong, [], `compute rates in src/serve.ts:\n${wrong.join("\n")}`);
  });

  it("publishes no request rate the record does not hold", () => {
    const wrong = disagreeing(/(\d[\d,]*) credits?\/10[Kk]/g, RECORDED.requests);
    assert.deepStrictEqual(wrong, [], `request rates in src/serve.ts:\n${wrong.join("\n")}`);
  });

  it("publishes no deploy rate the record does not hold", () => {
    const wrong = disagreeing(/(\d[\d,]*) credits each/g, RECORDED.deploy);
    assert.deepStrictEqual(wrong, [], `deploy rates in src/serve.ts:\n${wrong.join("\n")}`);
  });

  it("recomputes the bandwidth a month of credits buys whenever it states one", () => {
    const buys = RECORDED.allowance! / RECORDED.bandwidth!;
    const stated = [
      ...serve.matchAll(/[~≈] ?([\d.]+) GB \((?:at )?(?:\d+ credits\/GB|credit-based)\)/g),
      ...serve.matchAll(/roughly ([\d.]+) GB bandwidth/g),
    ].map(m => ({ value: Number(m[1]), text: m[0] }));
    assert.ok(stated.length >= 4, `only ${stated.length} derived bandwidth figures were found`);
    const wrong = stated
      .filter(({ value }) => value !== buys)
      .map(({ text }) => `${text} — ${RECORDED.allowance} credits at ${RECORDED.bandwidth}/GB buys ${buys} GB`);
    assert.deepStrictEqual(wrong, [], `derived bandwidth figures in src/serve.ts:\n${wrong.join("\n")}`);
  });

  it("states no per-seat charge the record says was withdrawn", () => {
    const standing = [...serve.matchAll(/[^.]*\b(?:per-committer|repo committer)[^.]*\./g)]
      .map(m => m[0].trim())
      .filter(sentence => !/Advanced Security/.test(sentence));
    assert.deepStrictEqual(standing, [], `sentences charging per committer:\n${standing.join("\n")}`);
  });
});
