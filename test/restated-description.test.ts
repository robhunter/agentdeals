import { describe, it } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { readRestatements } from "../scripts/restate-superseded-terms.js";

const { RESTATEMENT_JOIN, clauseSayingWhatTheProductIs, restatedDescription, statesTerms } =
  await import("../dist/restated-description.js");
const {
  READING_SAYS_WHAT_WE_ALREADY_STORE,
  restatementRulings,
  restatementKeepsWhatTheProductIs,
  ruleOnRestating,
  withheldTermsMeasure,
} = await import("../dist/restatement.js");
const { changesByVendor } = await import("../dist/superseded-census.js");
const { loadDealChanges, loadOffers } = await import("../dist/data.js");
const { utcDate } = await import("../dist/ranking.js");

type Offer = import("../src/types.ts").Offer;

const SENTENCES_A_HUMAN_WROTE: { vendor: string; stored: string; reading: string; clause: string }[] = [
  {
    vendor: "Supabase",
    stored:
      "Open source Firebase alternative — 500 MB Postgres database, 50K monthly active users, 1 GB file storage",
    reading:
      "The free tier includes unlimited API requests, 50,000 monthly active users, 500 MB database size.",
    clause: "Open source Firebase alternative",
  },
  {
    vendor: "Retool",
    stored: "Internal tools builder — free for up to 5 users, unlimited apps. Drag-and-drop UI",
    reading: "The Free tier costs $0/mo and includes unlimited web & mobile apps, up to 5 users.",
    clause: "Internal tools builder",
  },
  {
    vendor: "Socket.dev",
    stored:
      "Supply chain security for open source dependencies. Free and unlimited for all OSS repos. Private repos: 1,000 scans/month",
    reading: "Free: $0 per month, per developer. Unlimited developers & repos. 1,000 scans per month.",
    clause: "Supply chain security for open source dependencies",
  },
  {
    vendor: "Mintlify",
    stored:
      "Developer documentation platform — custom domain, web editor, API playground, custom components. For individuals",
    reading: "The Starter plan is $0/month and includes 5 editor seats, a web editor, and API playground.",
    clause: "Developer documentation platform",
  },
  {
    vendor: "Tinybird",
    stored: "Real-time analytics data platform — 10 GB storage, 10 QPS max, 0.25 vCPUs compute",
    reading: "Free tier includes 1k requests per day, 10GB included storage, 0.25 vCPUs.",
    clause: "Real-time analytics data platform",
  },
  {
    vendor: "GitHub Copilot",
    stored:
      "AI coding assistant by GitHub/Microsoft. Works in VS Code/JetBrains/GitHub.com. Copilot Free: 2,000 completions/month",
    reading: "Free: $0 USD per user / month. Includes 2,000 completions per month.",
    clause: "AI coding assistant by GitHub/Microsoft",
  },
];

const OPENINGS_THAT_STATE_TERMS = [
  "300 credits/month (deploys at 15 credits each, bandwidth at 20 credits/GB)",
  "Free CI/CD for public repos (unlimited minutes). Private repos: 2,000 min/mo",
  "Free plan: $0/month with one-time $5 credit (30-day trial), 1 vCPU",
  "Free tier with 10K metric series, 50 GB logs, 50 GB traces, 14-day retention",
  "Hobby plan with 100 GB/month Fast Data Transfer, 1M function invocations",
];

describe("restating the terms and keeping the sentence a human wrote", () => {
  it("keeps the opening clause and puts the reading where the terms were", () => {
    for (const { vendor, stored, reading, clause } of SENTENCES_A_HUMAN_WROTE) {
      assert.equal(clauseSayingWhatTheProductIs(stored), clause, vendor);
      assert.equal(restatedDescription(stored, reading), `${clause}${RESTATEMENT_JOIN}${reading}`, vendor);
    }
  });

  it("takes the reading whole where the stored description opens on the terms themselves", () => {
    for (const stored of OPENINGS_THAT_STATE_TERMS) {
      assert.equal(clauseSayingWhatTheProductIs(stored), null, stored);
      assert.equal(restatedDescription(stored, "The free plan now includes 1 GB."), "The free plan now includes 1 GB.");
    }
  });

  it("reads a whole description that names no terms as the sentence to keep", () => {
    const stored = "Get the highest resolution favicon for any website from our simple API.";
    assert.equal(clauseSayingWhatTheProductIs(stored), stored);
  });

  it("does not end a clause on the full stop inside an initialism", () => {
    const stored =
      "Manage, debug, fan-out and proxy webhooks to public or internal (i.e. localhost) destinations — 150 requests/month";
    assert.equal(
      clauseSayingWhatTheProductIs(stored),
      "Manage, debug, fan-out and proxy webhooks to public or internal (i.e. localhost) destinations",
    );
  });

  it("does not say twice what the reading already says", () => {
    const stored = "Open-source scheduling — unlimited event types, 1 user";
    const reading = "Open-source scheduling for individuals. Free forever: 1 user, unlimited event types.";
    assert.equal(restatedDescription(stored, reading), reading);
  });

  it("counts a figure and a word about the terms as terms, and a product name carrying a digit as neither", () => {
    assert.ok(statesTerms("100 GB of transfer"));
    assert.ok(statesTerms("~30 free models"));
    assert.ok(statesTerms("Integration infrastructure for 600+ APIs"));
    assert.ok(statesTerms("Free for individuals"));
    assert.equal(statesTerms("S3-compatible object storage by Backblaze"), false);
    assert.equal(statesTerms("OAuth2 and SAML identity provider"), false);
  });
});

interface ComposedEntry {
  vendor: string;
  stored: string;
  description: string;
  terms: string;
}

describe("every entry the rotation restates, whether it has restated it yet or not", () => {
  const offers = loadOffers() as Offer[];
  const byVendor = changesByVendor(loadDealChanges());
  const rulings = restatementRulings(
    offers,
    (offer: Offer) => byVendor.get(offer.vendor.toLowerCase()) ?? [],
    utcDate(),
  );
  const restatable = rulings.filter((ruling: any) => !ruling.refusal);

  const composed: ComposedEntry[] = [
    ...restatable.map((ruling: any) => ({
      vendor: ruling.offer.vendor,
      stored: ruling.offer.description,
      description: ruling.description,
      terms: ruling.reading.terms,
    })),
    ...readRestatements().map((entry: any) => ({
      vendor: entry.vendor,
      stored: entry.previous_description,
      description: entry.description,
      terms: entry.reading_terms,
    })),
  ];

  const keepsWhatTheProductIs = (entry: ComposedEntry) => entry.description !== entry.terms;

  it("reads every entry it has already restated as well as every entry it may, so the write cannot empty this block", () => {
    assertPopulationFloor(composed.length, 90, "entries the rotation has restated or may restate");
    assert.deepStrictEqual(
      composed.filter((entry) => typeof entry.terms !== "string" || entry.terms === "")
        .map((entry) => entry.vendor).slice(0, 15),
      [],
      "entries recorded without the reading their terms came from",
    );
  });

  it("keeps a sentence a human wrote on some entries and takes the reading whole on the rest", () => {
    const keeping = composed.filter(keepsWhatTheProductIs);
    const whole = composed.filter((entry) => entry.description === entry.terms);
    assert.equal(keeping.length + whole.length, composed.length);
    assertPopulationFloor(keeping.length, 60, "entries keeping the sentence a human wrote");
    assert.equal(
      withheldTermsMeasure(rulings).restatements_keeping_the_stored_sentence_saying_what_the_product_is,
      restatable.filter(restatementKeepsWhatTheProductIs).length,
    );
  });

  it("publishes the whole of the reading whichever way it composes the entry", () => {
    for (const entry of composed) {
      assert.ok(
        entry.description.endsWith(entry.terms),
        `${entry.vendor} drops part of the reading it restates from`,
      );
    }
  });

  it("opens every kept sentence on the stored description and states no terms in it", () => {
    for (const entry of composed.filter(keepsWhatTheProductIs)) {
      const kept = entry.description.length - entry.terms.length - RESTATEMENT_JOIN.length;
      const clause = entry.description.slice(0, kept);
      assert.ok(entry.stored.startsWith(clause), entry.vendor);
      assert.equal(statesTerms(clause), false, `${entry.vendor} keeps a clause stating terms`);
    }
  });

  it("refuses an entry the reading would restate word for word as it already stands", () => {
    const stored = "Vector database — the free tier holds 1 GB.";
    const offer = {
      vendor: "Example",
      tier: "Free",
      url: "https://example.com/pricing",
      description: stored,
    };
    const change = {
      vendor: "Example",
      change_type: "limits_reduced",
      date: "2026-09-07",
      recorded_date: "2026-09-07",
      date_source: "vendor_page",
      summary: "The free tier moved.",
      previous_state: stored,
      current_state: "the free tier holds 1 GB.",
      source_url: "https://example.com/pricing",
    };
    assert.equal(ruleOnRestating(offer, change, "2026-09-17")?.refusal, READING_SAYS_WHAT_WE_ALREADY_STORE);
  });
});
