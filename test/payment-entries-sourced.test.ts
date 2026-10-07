import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { sourceStatesTheCost } = await import("../dist/payment-protocols.js");

type Offer = import("../src/types.ts").Offer;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

type Entry = Record<string, unknown> & { protocol: string };

function entriesOf(offers: readonly Offer[]): Array<{ named: string; entry: Entry }> {
  return offers.flatMap(offer =>
    ((offer.payment_protocols ?? []) as unknown as Entry[]).map(entry => ({ named: `${offer.vendor} (${entry.protocol})`, entry })),
  );
}

function isWebAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const { protocol, hostname } = new URL(value);
    return (protocol === "https:" || protocol === "http:") && hostname.includes(".");
  } catch {
    return false;
  }
}

function entriesWithoutASourcePage(offers: readonly Offer[]): string[] {
  return entriesOf(offers).filter(({ entry }) => !isWebAddress(entry.source_url)).map(({ named }) => named);
}

function entriesWithoutTheVendorsWords(offers: readonly Offer[]): string[] {
  return entriesOf(offers)
    .filter(({ entry }) => typeof entry.source_quote !== "string" || entry.source_quote.trim() === "")
    .map(({ named }) => named);
}

const TODAY = new Date().toISOString().slice(0, 10);

function isAPastOrPresentDay(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value <= TODAY;
}

function entriesWithoutTheDayTheyWereRead(offers: readonly Offer[]): string[] {
  return entriesOf(offers).filter(({ entry }) => !isAPastOrPresentDay(entry.read_on)).map(({ named }) => named);
}

function costsTheVendorsWordsDoNotState(offers: readonly Offer[]): string[] {
  return entriesOf(offers)
    .filter(({ entry }) => entry.example_cost !== undefined && !sourceStatesTheCost(entry))
    .map(({ named, entry }) => `${named}: ${JSON.stringify(entry.example_cost)}`);
}

const SOURCED = {
  protocol: "x402",
  example_cost: "$0.02 per call",
  source_url: "https://zqsourced.example/docs/x402",
  source_quote: "Each call costs $0.02 per call over x402.",
  read_on: "2026-09-28",
};

function listing(vendor: string, ...entries: Array<Record<string, unknown>>): Offer {
  return {
    vendor,
    category: "Dev Utilities",
    description: "A synthetic API.",
    tier: "Free",
    url: `https://${vendor.toLowerCase()}.example/pricing`,
    tags: ["api"],
    verifiedDate: "2026-09-28",
    payment_protocols: entries as unknown as Offer["payment_protocols"],
  };
}

const DEFECTIVE: Offer[] = [
  listing("Zqsourced", SOURCED),
  listing("Zqnourl", { ...SOURCED, source_url: undefined }),
  listing("Zqrelative", { ...SOURCED, source_url: "/docs/x402" }),
  listing("Zqnoquote", { ...SOURCED, source_quote: undefined }),
  listing("Zqblankquote", { ...SOURCED, source_quote: "   " }),
  listing("Zqunstated", { ...SOURCED, example_cost: "$0.01-0.05/call" }),
  listing("Zqcostless", { ...SOURCED, example_cost: undefined }),
  listing("Zqundated", { ...SOURCED, read_on: undefined }),
  listing("Zqmalformed", { ...SOURCED, read_on: "2026-9-28" }),
  listing("Zqimpossible", { ...SOURCED, read_on: "2026-02-30" }),
  listing("Zqfuture", { ...SOURCED, read_on: "2999-01-01" }),
];

describe("the checks below find what they look for", () => {
  it("names an entry with no source page, or one that is not a web address", () => {
    assert.deepStrictEqual(entriesWithoutASourcePage(DEFECTIVE), ["Zqnourl (x402)", "Zqrelative (x402)"]);
  });

  it("names an entry with no quote, or a blank one", () => {
    assert.deepStrictEqual(entriesWithoutTheVendorsWords(DEFECTIVE), ["Zqnoquote (x402)", "Zqblankquote (x402)"]);
  });

  it("names an entry with no day it was read, a malformed or impossible one, or one still to come", () => {
    assert.deepStrictEqual(entriesWithoutTheDayTheyWereRead(DEFECTIVE), ["Zqundated (x402)", "Zqmalformed (x402)", "Zqimpossible (x402)", "Zqfuture (x402)"]);
  });

  it("names a cost the quote does not state, and passes an entry with no cost", () => {
    assert.deepStrictEqual(costsTheVendorsWordsDoNotState(DEFECTIVE), [
      "Zqnoquote (x402): \"$0.02 per call\"",
      "Zqblankquote (x402): \"$0.02 per call\"",
      "Zqunstated (x402): \"$0.01-0.05/call\"",
    ]);
  });
});

describe("every payment entry in the catalogue says where the vendor documents it", () => {
  it("gives each entry the page it was read from", () => {
    assert.deepStrictEqual(entriesWithoutASourcePage(SHIPPED), []);
  });

  it("gives each entry the vendor's own words", () => {
    assert.deepStrictEqual(entriesWithoutTheVendorsWords(SHIPPED), []);
  });

  it("gives each entry the day it was read", () => {
    assert.deepStrictEqual(entriesWithoutTheDayTheyWereRead(SHIPPED), []);
  });

  it("gives a cost only where those words state it", () => {
    assert.deepStrictEqual(costsTheVendorsWordsDoNotState(SHIPPED), []);
  });
});
