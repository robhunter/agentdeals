import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COPY_HOLDS_ANOTHER_PLAN,
  COPY_STATES_NO_TERMS,
  FREE_PLAN_EXCERPT,
  FREE_PLAN_EXCERPT_HOLD,
  MAX_FREE_PLAN_EXCERPT_LENGTH,
  TIER_WITH_NO_FREE_PLAN,
  assignmentsOfTheExcerpt,
  excerptHoldsNamingNoRecordInForce,
  excerptTheFreePlan,
  excerptsDisagreeingWithTheirCitation,
  holdOnTheExcerpt,
  parseExcerptAnswer,
  verbatimExcerpt,
  writeFreePlanExcerpt,
} from "../scripts/free-plan-excerpt.js";
import { EXCERPT_NAMES_NO_ALLOWANCE_LIMIT_OR_PRICE } from "../dist/free-plan-excerpt-rules.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITER = path.join("scripts", "free-plan-excerpt.js");

const RENDER_PAGE =
  "Hobby Pro Scale Enterprise For individuals building personal projects and prototypes. $ 0 /mo + compute For teams deploying production-grade apps and agents. $ 25 /mo + compute Deploy for free Start with Pro Connect your repo, and go Deploy up to 25 services\n5 GB of bandwidth included Single-service previews Global regions & CDN Custom domains";
const RENDER_EXCERPT = "Deploy up to 25 services 5 GB of bandwidth included Single-service previews";
const READ = { pageText: RENDER_PAGE, url: "https://render.com/pricing", readOn: "2026-09-16", terms: ["Deploy up to 25 services", "5 GB of bandwidth included"] };

describe("an excerpt is the page's own words or nothing", () => {
  it("keeps a copy that is on the page once runs of whitespace are collapsed on both sides", () => {
    assert.deepStrictEqual(verbatimExcerpt("Deploy up to 25 services\n  5 GB of bandwidth included  Single-service previews", RENDER_PAGE), {
      found: true,
      excerpt: RENDER_EXCERPT,
    });
  });

  it("refuses a paraphrase of a real excerpt", () => {
    const paraphrase = verbatimExcerpt("Deploy up to 25 services with 5 GB bandwidth included", RENDER_PAGE);
    assert.strictEqual(paraphrase.excerpt, null);
    assert.strictEqual(paraphrase.found, true);
    assert.strictEqual(paraphrase.why, "the copy is not on the page as the page words it");
  });

  it("refuses a copy that changes only a figure or its case", () => {
    assert.strictEqual(verbatimExcerpt("Deploy up to 50 services", RENDER_PAGE).excerpt, null);
    assert.strictEqual(verbatimExcerpt("deploy up to 25 services", RENDER_PAGE).excerpt, null);
  });

  it("keeps a copy that writes out an entity the page text still carries, or a curly mark for a straight one, and stores the page's own characters", () => {
    const curlyApostrophe = String.fromCharCode(0x2019);
    const enDash = String.fromCharCode(0x2013);
    const kept: [string, string, string][] = [
      ["Hobby Access for a team of one (that&#x27;s you!) Enough build credits", "Access for a team of one (that's you!)", "Access for a team of one (that's you!)"],
      ["[*] 65&#43; always-free services with an Azure account", "65+ always-free services", "65+ always-free services"],
      ["the public API, and Grok Build&#x27;s free tier does not include it. Pro", `Grok Build${curlyApostrophe}s free tier does not include it.`, "Grok Build's free tier does not include it."],
      ["Starter &ndash; free forever, 3 monitors", "Starter - free forever, 3 monitors", `Starter ${enDash} free forever, 3 monitors`],
    ];
    for (const [page, copy, stored] of kept) {
      assert.deepStrictEqual(verbatimExcerpt(copy, page), { found: true, excerpt: stored }, copy);
    }
  });

  it("still refuses a copy whose words differ once entities and marks read alike", () => {
    const page = "the public API, and Grok Build&#x27;s free tier does not include it. Pro";
    for (const copy of ["Grok Build's free tier does not include them.", "Grok Build's free plan does not include it.", "Grok Builds free tier does not include it."]) {
      assert.strictEqual(verbatimExcerpt(copy, page).excerpt, null, copy);
    }
  });

  it(`refuses a copy longer than ${MAX_FREE_PLAN_EXCERPT_LENGTH} characters, even one the page carries`, () => {
    const page = `Free plan: ${"x".repeat(MAX_FREE_PLAN_EXCERPT_LENGTH)}`;
    const verdict = verbatimExcerpt(page, page);
    assert.strictEqual(verdict.excerpt, null);
    assert.match(verdict.why ?? "", /over the 400 an excerpt may hold/);
  });

  it("reads an empty copy as a page that states no free plan", () => {
    assert.deepStrictEqual(verbatimExcerpt("   ", RENDER_PAGE), { found: false, excerpt: null });
    assert.deepStrictEqual(verbatimExcerpt(undefined, RENDER_PAGE), { found: false, excerpt: null });
  });
});

describe("writing the excerpt onto a record", () => {
  it("stores the excerpt with the page it came from and the day it was read", () => {
    const offer: Record<string, unknown> = { vendor: "Render" };
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, copied: RENDER_EXCERPT }), { outcome: "written" });
    assert.deepStrictEqual(offer[FREE_PLAN_EXCERPT], { text: RENDER_EXCERPT, url: "https://render.com/pricing", read_on: "2026-09-16" });
  });

  it("keeps a held excerpt the day's page still carries when the read finds no free-plan wording, dated that read", () => {
    const offer: Record<string, unknown> = { vendor: "Render", [FREE_PLAN_EXCERPT]: { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-08-28" } };
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, copied: "" }), { outcome: "none", held_excerpt: "kept" });
    assert.deepStrictEqual(offer[FREE_PLAN_EXCERPT], { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-09-16" });
  });

  it("removes a held excerpt the day's page no longer carries", () => {
    const offer: Record<string, unknown> = { vendor: "Render", [FREE_PLAN_EXCERPT]: { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-08-28" } };
    const pageText = RENDER_PAGE.replace("5 GB of bandwidth", "10 GB of bandwidth");
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, pageText, copied: "" }), { outcome: "none", held_excerpt: "removed" });
    assert.ok(!(FREE_PLAN_EXCERPT in offer));
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, pageText, copied: "" }), { outcome: "none" });
  });

  it("checks a held excerpt against the day's page even when the reader gave no answer it could parse", () => {
    const unparsed = parseExcerptAnswer("I could not find it.");
    assert.strictEqual(unparsed.copied, null);
    const offer: Record<string, unknown> = { vendor: "Render", [FREE_PLAN_EXCERPT]: { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-08-28" } };
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, copied: unparsed.copied }), { outcome: "unread", held_excerpt: "kept" });
    assert.deepStrictEqual(offer[FREE_PLAN_EXCERPT], { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-09-16" });
    const pageText = RENDER_PAGE.replace("Single-service previews", "Preview environments");
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, pageText, copied: unparsed.copied }), { outcome: "unread", held_excerpt: "removed" });
    assert.ok(!(FREE_PLAN_EXCERPT in offer));
  });

  it("reads the copy and the terms it states out of the reader's answer, fenced or not, and an empty copy as no free plan", () => {
    assert.deepStrictEqual(parseExcerptAnswer("```json\n{\"excerpt\":\"Deploy up to 25 services\",\"terms\":[\"up to 25 services\"],\"other_plans\":[\"Pro\"]}\n```"), { copied: "Deploy up to 25 services", terms: ["up to 25 services"], otherPlans: ["Pro"] });
    assert.deepStrictEqual(parseExcerptAnswer("Here it is: {\"excerpt\":\"\"}"), { copied: "", terms: [], otherPlans: [] });
    assert.deepStrictEqual(parseExcerptAnswer("{\"excerpt\":\"Deploy up to 25 services\",\"terms\":\"up to 25 services\",\"other_plans\":\"Pro\"}"), { copied: "Deploy up to 25 services", terms: [], otherPlans: [] });
  });

  it("keeps a held excerpt the day's page still carries when the new copy is refused, dated that read, and removes it once the page drops it", () => {
    const offer: Record<string, unknown> = { vendor: "Render", [FREE_PLAN_EXCERPT]: { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-08-28" } };
    const paraphrase = "Deploy up to 25 services with 5 GB bandwidth included";
    const refused = { outcome: "refused", why: "the copy is not on the page as the page words it" };
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, copied: paraphrase }), { ...refused, held_excerpt: "kept" });
    assert.deepStrictEqual(offer[FREE_PLAN_EXCERPT], { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-09-16" });
    const pageText = RENDER_PAGE.replace("Deploy up to 25 services", "Deploy up to 10 services");
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, pageText, readOn: "2026-10-05", copied: paraphrase }), { ...refused, held_excerpt: "removed" });
    assert.ok(!(FREE_PLAN_EXCERPT in offer));
  });

  it("replaces a held excerpt only with an excerpt the read writes", () => {
    const pageText = `${RENDER_PAGE} Hobby includes 750 free instance hours`;
    const offer: Record<string, unknown> = { vendor: "Render", [FREE_PLAN_EXCERPT]: { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-08-28" } };
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, pageText, copied: "Hobby includes 750 free instance hours", terms: ["750 free instance hours"] }), { outcome: "written" });
    assert.deepStrictEqual(offer[FREE_PLAN_EXCERPT], { text: "Hobby includes 750 free instance hours", url: READ.url, read_on: "2026-09-16" });
  });

  it("cites the page that carries a held excerpt on the day of the read", () => {
    const offer: Record<string, unknown> = { vendor: "Render", [FREE_PLAN_EXCERPT]: { text: RENDER_EXCERPT, url: "https://render.com/", read_on: "2026-08-28" } };
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, copied: "" }), { outcome: "none", held_excerpt: "kept" });
    assert.deepStrictEqual(offer[FREE_PLAN_EXCERPT], { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-09-16" });
  });
});

describe("an excerpt states at least one of the plan's terms", () => {
  const FORMSUBMIT_PAGE = "Setup is easy and free. Design a form for your site, and be sure to name all the fields. Then, just point the action to us and confirm your email address! NO REGISTRATION REQUIRED";
  const BITRISE_PAGE = "Hobby Build and distribute your passion project without the extra cost. Free Forever Get started Access for a team of one (that's you!) Enough build credits for you to build your small project a few times per month Support";
  const NORTHFLANK_PAGE = "Deploy anything, anywhere. Get started for free Book a demo";
  const FIREBASE_PAGE = "No-cost (Spark plan) Generous no-cost usage limits No payment method needed Get started";
  const write = (plan: { vendor: string; tier: string }, pageText: string, copied: string, terms: unknown) => {
    const record: Record<string, unknown> = { ...plan };
    const result = writeFreePlanExcerpt(record, { copied, terms, pageText, url: "https://vendor.example/pricing", readOn: "2026-10-01" });
    return { result, stored: (record[FREE_PLAN_EXCERPT] as { text: string } | undefined)?.text ?? null };
  };

  it("keeps a copy whose terms state a price, an allowance or a limit, with or without a figure", () => {
    assert.deepStrictEqual(write({ vendor: "Render", tier: "Hobby" }, RENDER_PAGE, RENDER_EXCERPT, ["Deploy up to 25 services"]).result, { outcome: "written" });
    assert.deepStrictEqual(write({ vendor: "Bitrise", tier: "Hobby" }, BITRISE_PAGE, "Free Forever Get started Access for a team of one (that's you!) Enough build credits for you to build your small project a few times per month", ["Free Forever", "a few times per month"]).result, { outcome: "written" });
    assert.deepStrictEqual(write({ vendor: "Firebase", tier: "Spark" }, FIREBASE_PAGE, FIREBASE_PAGE, ["No payment method needed"]).result, { outcome: "written" });
  });

  it("refuses a copy whose only terms say how to sign up, as needing no registration does", () => {
    assert.deepStrictEqual(write({ vendor: "Formsubmit.co", tier: "Free" }, FORMSUBMIT_PAGE, FORMSUBMIT_PAGE, ["NO REGISTRATION REQUIRED"]), { result: { outcome: "refused", why: EXCERPT_NAMES_NO_ALLOWANCE_LIMIT_OR_PRICE }, stored: null });
  });

  it("refuses a copy that only says the product is free or invites the reader to start, whatever the reader names as its terms", () => {
    for (const [copy, terms] of [
      ["Get started for free", ["Get started for free"]],
      ["Get started for free", ["for free"]],
      ["Deploy anything, anywhere. Get started for free", ["Get started for free"]],
    ] as [string, string[]][]) {
      assert.deepStrictEqual(write({ vendor: "Northflank", tier: "Free" }, NORTHFLANK_PAGE, copy, terms), { result: { outcome: "refused", why: COPY_STATES_NO_TERMS }, stored: null }, `${copy} / ${terms}`);
    }
  });

  it("does not count the vendor's or the plan's own name as a term", () => {
    assert.deepStrictEqual(write({ vendor: "Firebase", tier: "Spark" }, FIREBASE_PAGE, "No-cost (Spark plan)", ["No-cost (Spark plan)"]).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
    assert.deepStrictEqual(write({ vendor: "Northflank", tier: "Free" }, "Northflank Free Get started", "Northflank Free", ["Northflank Free"]).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
  });

  it("counts a term only when it holds a figure, or a word that states a limit, a duration or who can get the plan", () => {
    const NVIDIA_PAGE = "Free inference with leading models moonshotai kimi-k3 deepseek-ai deepseek-v4-pro-0813 More Models";
    assert.deepStrictEqual(write({ vendor: "NVIDIA NIM", tier: "Free" }, NVIDIA_PAGE, NVIDIA_PAGE, ["Free inference"]).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
    const GCE_PAGE = "Learn more about Google Cloud free VM program for e2-micro VM instance.";
    assert.deepStrictEqual(write({ vendor: "Google Compute Engine", tier: "Always Free" }, GCE_PAGE, GCE_PAGE, ["free VM program for e2-micro VM instance"]).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
    assert.deepStrictEqual(write({ vendor: "1Password", tier: "Free" }, "1Password Free Sign up", "1Password Free", ["1Password Free"]).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
    assert.deepStrictEqual(write({ vendor: "Render", tier: "Hobby" }, RENDER_PAGE, "Hobby Pro Scale", ["Hobby"]).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
    assert.deepStrictEqual(write({ vendor: "Mistral AI", tier: "Free" }, "Free Limited messages and web searches.", "Free Limited messages and web searches.", ["Limited messages"]).result, { outcome: "written" });
  });

  it("counts no word for who uses the plan or what it holds, such as teams, users, seats, projects or accounts, unless a figure or another term word stands beside it", () => {
    for (const word of ["team", "teams", "user", "users", "member", "members", "seat", "seats", "project", "projects", "collaborator", "collaborators", "account", "accounts", "hobby"]) {
      const copy = `Made for the ${word} that matters`;
      assert.deepStrictEqual(write({ vendor: "Acme", tier: "Free" }, copy, copy, [`the ${word} that matters`]).result, { outcome: "refused", why: COPY_STATES_NO_TERMS }, word);
    }
    const PASSION_PROJECT = "Build and distribute your passion project without the extra cost.";
    assert.deepStrictEqual(write({ vendor: "Bitrise", tier: "Hobby" }, BITRISE_PAGE, PASSION_PROJECT, [PASSION_PROJECT]).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
    const AIRTABLE_PAGE = "Our Free plan is available to teams for no charge";
    assert.deepStrictEqual(write({ vendor: "Airtable", tier: "Free" }, AIRTABLE_PAGE, AIRTABLE_PAGE, ["no charge", "teams"]).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
    assert.deepStrictEqual(write({ vendor: "Acme", tier: "Free" }, "Create a free account", "Create a free account", ["Create a free account"]).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
    for (const term of ["Up to 3 projects", "Unlimited team members", "5 seats", "50,000 monthly active users"]) {
      assert.deepStrictEqual(write({ vendor: "Acme", tier: "Free" }, term, term, [term]).result, { outcome: "written" }, term);
    }
  });

  it("refuses a copy when the reader names no term, or no term the copy holds", () => {
    assert.deepStrictEqual(write({ vendor: "Render", tier: "Hobby" }, RENDER_PAGE, RENDER_EXCERPT, []).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
    assert.deepStrictEqual(write({ vendor: "Render", tier: "Hobby" }, RENDER_PAGE, RENDER_EXCERPT, undefined).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
    assert.deepStrictEqual(write({ vendor: "Render", tier: "Hobby" }, RENDER_PAGE, RENDER_EXCERPT, ["Deploy up to 50 services", "100 GB of bandwidth"]).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
  });

  it("keeps a held excerpt the day's page still carries when the new copy states no terms, dated that read", () => {
    const record: Record<string, unknown> = { vendor: "Render", tier: "Hobby", [FREE_PLAN_EXCERPT]: { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-08-28" } };
    assert.deepStrictEqual(writeFreePlanExcerpt(record, { ...READ, copied: "Deploy for free", terms: ["Deploy for free"] }), { outcome: "refused", why: COPY_STATES_NO_TERMS, held_excerpt: "kept" });
    assert.deepStrictEqual(record[FREE_PLAN_EXCERPT], { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-09-16" });
  });
});

describe("an excerpt stays inside the listed plan's own words", () => {
  const NEON_PAGE = "Free $0 Build and learn free with no time limits 100 projects 0.5 GB of storage per project Functions Launch Usage-based Typical spend: $ 15 /mo";
  const POSTHOG_PAGE = "Feature Startups Y Combinator Eligibility <2 years old, <$5M raised Must be in YC Credit $50,000 for 12 months $50k per year, whilst eligible";
  const write = (plan: { vendor: string; tier: string }, pageText: string, copied: string, terms: string[], otherPlans: unknown) => {
    const record: Record<string, unknown> = { ...plan };
    return writeFreePlanExcerpt(record, { copied, terms, otherPlans, pageText, url: "https://vendor.example/pricing", readOn: "2026-10-01" });
  };

  it("refuses a copy that holds the words of another plan the reader names, as the page names it", () => {
    assert.deepStrictEqual(write({ vendor: "Neon", tier: "Free" }, NEON_PAGE, NEON_PAGE, ["100 projects"], ["Launch"]), { outcome: "refused", why: `${COPY_HOLDS_ANOTHER_PLAN}: Launch` });
    assert.deepStrictEqual(write({ vendor: "PostHog", tier: "YC Deal" }, POSTHOG_PAGE, POSTHOG_PAGE, ["$50k per year, whilst eligible"], ["Startups"]), { outcome: "refused", why: `${COPY_HOLDS_ANOTHER_PLAN}: Startups` });
  });

  it("applies to the answer the rotation's reader gives", async () => {
    const offer = { vendor: "Neon", category: "Databases", tier: "Free", url: "https://neon.example/pricing" };
    const record: Record<string, unknown> = { ...offer };
    const result = await excerptTheFreePlan(record, { offer, pageText: NEON_PAGE, read: async () => ({ copied: NEON_PAGE, terms: ["100 projects"], otherPlans: ["Launch"] }), readOn: "2026-10-01" });
    assert.deepStrictEqual([result.outcome, FREE_PLAN_EXCERPT in record], ["refused", false]);
  });

  it("keeps a copy whose other named plans it does not hold, or that names only the listed plan itself", () => {
    const ownWords = "Free $0 Build and learn free with no time limits 100 projects 0.5 GB of storage per project Functions";
    assert.deepStrictEqual(write({ vendor: "Neon", tier: "Free" }, NEON_PAGE, ownWords, ["100 projects"], ["Launch", "Free", "Scale"]), { outcome: "written" });
    assert.deepStrictEqual(write({ vendor: "Neon", tier: "Free" }, NEON_PAGE, ownWords, ["100 projects"], ["Fun"]), { outcome: "written" });
    assert.deepStrictEqual(write({ vendor: "Neon", tier: "Free" }, NEON_PAGE, ownWords, ["100 projects"], undefined), { outcome: "written" });
  });
});

describe("only a tier that may be a free plan is quoted", () => {
  const PAGE = "Acme pricing. Free tier: 10 GB per month for $0. Pro: $20 per month.";
  const excerpt = async (tier: string, held?: unknown) => {
    const offer = { vendor: "Acme", category: "Storage", tier, url: "https://acme.example/pricing" };
    const record: Record<string, unknown> = { ...offer, ...(held ? { [FREE_PLAN_EXCERPT]: held } : {}) };
    const asked: string[] = [];
    const result = await excerptTheFreePlan(record, {
      offer,
      pageText: PAGE,
      read: async () => {
        asked.push(tier);
        return { copied: "Free tier: 10 GB per month for $0.", terms: ["10 GB per month"] };
      },
      readOn: "2026-10-01",
    });
    return { result, asked, record };
  };

  it("never asks the reader about a paid, usage-billed, closed or ended tier, and removes an excerpt such a tier still holds", async () => {
    for (const tier of ["Paid", "Pay-as-you-go", "Legacy Free", "Freemium", "Retired"]) {
      const fresh = await excerpt(tier);
      assert.deepStrictEqual([fresh.asked, fresh.result.outcome, fresh.result.why, FREE_PLAN_EXCERPT in fresh.record], [[], "not_a_free_plan", TIER_WITH_NO_FREE_PLAN, false], tier);
      const holding = await excerpt(tier, { text: "Free tier: 10 GB", url: "https://acme.example/pricing", read_on: "2026-09-01" });
      assert.deepStrictEqual([holding.asked, holding.result.outcome, FREE_PLAN_EXCERPT in holding.record], [[], "removed", false], tier);
    }
  });

  it("asks about a free, trial, credit or programme tier, and writes what the reader copied", async () => {
    for (const tier of ["Free", "Hobby", "Free Trial", "Free Credits", "Startup Program"]) {
      const { result, asked, record } = await excerpt(tier);
      assert.deepStrictEqual([asked, result.outcome, (record[FREE_PLAN_EXCERPT] as { text: string }).text], [[tier], "written", "Free tier: 10 GB per month for $0."], tier);
    }
  });
});

describe("a hold on the listing keeps the reader from being asked and the excerpt from being kept", () => {
  const PAGE = "Acme pricing. Free tier: 60 requests a minute for $0.";
  const HOLD = { record_date: "2026-06-18", change_type: "restriction", reason: "The page still states the quota this record says ended." };
  const excerpt = async (tier: string, held?: unknown) => {
    const offer = { vendor: "Acme", category: "AI Coding", tier, url: "https://acme.example/pricing" };
    const record: Record<string, unknown> = { ...offer, [FREE_PLAN_EXCERPT_HOLD]: HOLD, ...(held ? { [FREE_PLAN_EXCERPT]: held } : {}) };
    const asked: string[] = [];
    const result = await excerptTheFreePlan(record, {
      offer,
      pageText: PAGE,
      read: async () => {
        asked.push(tier);
        return { copied: "Free tier: 60 requests a minute for $0.", terms: ["60 requests a minute"] };
      },
      readOn: "2026-10-01",
    });
    return { result, asked, record };
  };

  it("never asks the reader about a held listing, whatever its tier, and names the record that holds it", async () => {
    for (const tier of ["Free", "Paid"]) {
      const { result, asked, record } = await excerpt(tier);
      assert.deepStrictEqual([asked, result.outcome, result.why, FREE_PLAN_EXCERPT in record], [[], "on_hold", holdOnTheExcerpt(HOLD), false], tier);
    }
    assert.ok(holdOnTheExcerpt(HOLD).includes("restriction record of 2026-06-18"), holdOnTheExcerpt(HOLD));
  });

  it("removes an excerpt the held listing still carries, and leaves the hold in place", async () => {
    const { result, asked, record } = await excerpt("Free", { text: "Free tier: 60 requests a minute", url: "https://acme.example/pricing", read_on: "2026-09-01" });
    assert.deepStrictEqual([asked, result.outcome, FREE_PLAN_EXCERPT in record, record[FREE_PLAN_EXCERPT_HOLD]], [[], "removed", false, HOLD]);
  });
});

describe("every hold the catalogue carries names a record in force", () => {
  const RECORD = { vendor: "Acme", change_type: "restriction", date: "2026-06-18" };
  const held = (hold: Record<string, unknown>) => ({
    vendor: "Acme",
    tier: "Free",
    url: "https://acme.example/pricing",
    [FREE_PLAN_EXCERPT_HOLD]: { record_date: "2026-06-18", change_type: "restriction", reason: "The page still states the quota this record says ended.", ...hold },
  });

  it("names a record of the listing's own vendor that is in force, and gives a reason", () => {
    const offers = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
    const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
    assert.deepStrictEqual(excerptHoldsNamingNoRecordInForce(offers, changes), []);
  });

  it("refuses a hold that names no such record, names one no longer in force, or gives no reason", () => {
    assert.deepStrictEqual(excerptHoldsNamingNoRecordInForce([held({})], [RECORD]), []);
    assert.deepStrictEqual(excerptHoldsNamingNoRecordInForce([held({ record_date: "2026-06-19" })], [RECORD]), ["Acme (Free): the hold names no restriction record of 2026-06-19"]);
    assert.deepStrictEqual(excerptHoldsNamingNoRecordInForce([held({ change_type: "limits_reduced" })], [RECORD]), ["Acme (Free): the hold names no limits_reduced record of 2026-06-18"]);
    assert.deepStrictEqual(excerptHoldsNamingNoRecordInForce([held({})], [{ ...RECORD, vendor: "Another Co" }]), ["Acme (Free): the hold names no restriction record of 2026-06-18"]);
    for (const state of ["retracted", "reversed"]) {
      assert.deepStrictEqual(
        excerptHoldsNamingNoRecordInForce([held({})], [{ ...RECORD, resolution: { state, date: "2026-07-01", detail: "withdrawn" } }]),
        ["Acme (Free): the restriction record of 2026-06-18 that the hold names is no longer in force"],
        state,
      );
    }
    assert.deepStrictEqual(excerptHoldsNamingNoRecordInForce([held({ reason: "  " })], [RECORD]), ["Acme (Free): the hold gives no reason"]);
  });
});

describe("only the excerpt writer sets the field", () => {
  it("finds an assignment however the field is named, and not a read or a deletion", () => {
    const source = [
      "offer.free_plan_excerpt = { text };",
      "const record = { ...offer, free_plan_excerpt: kept };",
      "offer[FREE_PLAN_EXCERPT] = excerpt;",
      "delete offer.free_plan_excerpt;",
      "if (offer.free_plan_excerpt?.text === text) count++;",
      "if (offer.free_plan_excerpt == null) skip();",
    ].join("\n");
    assert.deepStrictEqual(assignmentsOfTheExcerpt(source), [1, 2, 3]);
  });

  it("is the only script that assigns it", () => {
    const scripts = (readdirSync(path.join(REPO, "scripts"), { recursive: true }) as string[])
      .filter(file => /\.(?:c|m)?[jt]s$/.test(file))
      .map(file => path.join("scripts", file));
    assert.ok(scripts.includes(WRITER), `${WRITER} is not among the scripts read`);
    const elsewhere = scripts
      .filter(file => file !== WRITER)
      .flatMap(file => assignmentsOfTheExcerpt(readFileSync(path.join(REPO, file), "utf-8")).map(line => `${file}:${line}`));
    assert.deepStrictEqual(elsewhere, []);
    assert.ok(assignmentsOfTheExcerpt(readFileSync(path.join(REPO, WRITER), "utf-8")).length > 0, "the scan finds no assignment in the writer itself");
  });
});

describe("every excerpt the catalogue holds agrees with the record that cites it", () => {
  const record = { vendor: "Render", tier: "Hobby", url: "https://render.com/pricing", source_check: { checked: "2026-09-16" } };
  const excerpt = (over: Record<string, unknown>) => ({ ...record, [FREE_PLAN_EXCERPT]: { text: RENDER_EXCERPT, url: record.url, read_on: "2026-09-16", ...over } });

  it("names the URL each record cites today, and a read no later than the record's last check", () => {
    const offers = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
    assert.deepStrictEqual(excerptsDisagreeingWithTheirCitation(offers), []);
  });

  it("refuses an excerpt left from a URL the record no longer cites, or read after the record's last check", () => {
    assert.deepStrictEqual(excerptsDisagreeingWithTheirCitation([excerpt({})]), []);
    assert.deepStrictEqual(excerptsDisagreeingWithTheirCitation([excerpt({ url: "https://render.com" })]), [
      "Render (Hobby): the excerpt was read from https://render.com, and the record cites https://render.com/pricing",
    ]);
    assert.deepStrictEqual(excerptsDisagreeingWithTheirCitation([excerpt({ read_on: "2026-09-17" })]), [
      "Render (Hobby): the excerpt was read on 2026-09-17, and the record's last check is 2026-09-16",
    ]);
  });

  it("refuses an excerpt with no text, or longer than the writer allows", () => {
    assert.deepStrictEqual(excerptsDisagreeingWithTheirCitation([excerpt({ text: "  " })]), ["Render (Hobby): the excerpt holds no text"]);
    assert.deepStrictEqual(excerptsDisagreeingWithTheirCitation([excerpt({ text: "x".repeat(MAX_FREE_PLAN_EXCERPT_LENGTH + 1) })]), [
      `Render (Hobby): the excerpt runs to ${MAX_FREE_PLAN_EXCERPT_LENGTH + 1} characters`,
    ]);
  });
});

describe("the rotation keeps the excerpt of a page it read", async () => {
  const { runAiMode } = await import("../scripts/reverify-rolling.js");
  const NOW = new Date("2026-09-16T06:30:00Z");
  const acme = { vendor: "Acme", url: "https://acme.example/pricing", description: "Free tier: 10 GB", category: "Storage", tier: "Free", verifiedDate: "2026-08-01" };
  const ACME_PAGE = "Acme pricing. Free tier: 10 GB per month for $0. Pro: $20 per month.";
  const run = async (options: Record<string, unknown>, dryRun = false, held?: unknown) => {
    const data = { offers: [{ ...acme, ...(held ? { [FREE_PLAN_EXCERPT]: held } : {}) }] };
    const asked: string[] = [];
    const result = await runAiMode([{ index: 0, offer: acme }], data, dryRun, NOW, {
      fetchFn: async () => ({ ok: true, text: ACME_PAGE, truncated: false }),
      verifyFn: async () => ({ status: "confirmed" }),
      confirmFn: async () => ({ describes_change: true }),
      excerptFn: async (offer: { vendor: string }) => {
        asked.push(offer.vendor);
        return { copied: "Free tier: 10 GB per month for $0.", terms: ["10 GB per month"] };
      },
      rateLimitMs: 0,
      ...options,
    });
    return { record: data.offers[0] as Record<string, unknown>, result, asked };
  };

  it("stores the words a read it accepted copied, dated the day of the read", async () => {
    const { record, result, asked } = await run({});
    assert.deepStrictEqual(asked, ["Acme"]);
    assert.deepStrictEqual(record[FREE_PLAN_EXCERPT], { text: "Free tier: 10 GB per month for $0.", url: acme.url, read_on: "2026-09-16" });
    assert.strictEqual(result.excerpts.written, 1);
  });

  it("asks for no excerpt from a page the source check refused, or one it could not fetch, and leaves the held one", async () => {
    const held = { text: "Free tier: 10 GB", url: acme.url, read_on: "2026-08-01" };
    const elsewhere = await run({ fetchFn: async () => ({ ok: true, text: "An about page naming nobody and pricing nothing.", truncated: false }) }, false, held);
    assert.deepStrictEqual([elsewhere.asked, elsewhere.record[FREE_PLAN_EXCERPT]], [[], held]);
    const unreachable = await run({ fetchFn: async () => ({ ok: false, error: "HTTP 503" }) }, false, held);
    assert.deepStrictEqual([unreachable.asked, unreachable.record[FREE_PLAN_EXCERPT]], [[], held]);
  });

  it("asks nothing for a listing whose tier is not a free plan, counts it, and removes the excerpt it held", async () => {
    const paid = { ...acme, tier: "Paid" };
    const data = { offers: [{ ...paid, [FREE_PLAN_EXCERPT]: { text: "Free tier: 10 GB", url: acme.url, read_on: "2026-08-01" } }] };
    const asked: string[] = [];
    const result = await runAiMode([{ index: 0, offer: paid }], data, false, NOW, {
      fetchFn: async () => ({ ok: true, text: ACME_PAGE, truncated: false }),
      verifyFn: async () => ({ status: "confirmed" }),
      confirmFn: async () => ({ describes_change: true }),
      excerptFn: async (offer: { vendor: string }) => {
        asked.push(offer.vendor);
        return { copied: "Free tier: 10 GB per month for $0.", terms: ["10 GB per month"] };
      },
      rateLimitMs: 0,
    });
    assert.deepStrictEqual(asked, []);
    assert.ok(!(FREE_PLAN_EXCERPT in data.offers[0]));
    assert.strictEqual(result.excerpts.removed, 1);
    const unheld = await runAiMode([{ index: 0, offer: paid }], { offers: [{ ...paid }] }, false, NOW, {
      fetchFn: async () => ({ ok: true, text: ACME_PAGE, truncated: false }),
      verifyFn: async () => ({ status: "confirmed" }),
      confirmFn: async () => ({ describes_change: true }),
      excerptFn: async () => ({ copied: "Free tier: 10 GB per month for $0.", terms: ["10 GB per month"] }),
      rateLimitMs: 0,
    });
    assert.strictEqual(unheld.excerpts.not_a_free_plan, 1);
  });

  it("asks nothing for a listing under a hold, counts it, and keeps the hold", async () => {
    const hold = { record_date: "2026-06-18", change_type: "restriction", reason: "The page still states the quota this record says ended." };
    const data = { offers: [{ ...acme, [FREE_PLAN_EXCERPT_HOLD]: hold }] };
    const asked: string[] = [];
    const result = await runAiMode([{ index: 0, offer: acme }], data, false, NOW, {
      fetchFn: async () => ({ ok: true, text: ACME_PAGE, truncated: false }),
      verifyFn: async () => ({ status: "confirmed" }),
      confirmFn: async () => ({ describes_change: true }),
      excerptFn: async (offer: { vendor: string }) => {
        asked.push(offer.vendor);
        return { copied: "Free tier: 10 GB per month for $0.", terms: ["10 GB per month"] };
      },
      rateLimitMs: 0,
    });
    assert.deepStrictEqual([asked, result.excerpts.on_hold, (data.offers[0] as Record<string, unknown>)[FREE_PLAN_EXCERPT_HOLD], FREE_PLAN_EXCERPT in data.offers[0]], [[], 1, hold, false]);
  });

  it("keeps a held excerpt the day's page still carries when the reader writes none, dated the read, counts it, and changes nothing on a dry run", async () => {
    const empty = { excerptFn: async () => ({ copied: "", terms: [] }) };
    const onThePage = () => ({ text: "Free tier: 10 GB per month for $0.", url: acme.url, read_on: "2026-08-01" });
    const kept = await run(empty, false, onThePage());
    assert.deepStrictEqual(kept.record[FREE_PLAN_EXCERPT], { ...onThePage(), read_on: "2026-09-16" });
    assert.deepStrictEqual([kept.result.excerpts.none, kept.result.excerpts.kept, kept.result.excerpts.removed], [1, 1, 0]);
    const dropped = await run(empty, false, { ...onThePage(), text: "Free tier: 20 GB per month for $0." });
    assert.ok(!(FREE_PLAN_EXCERPT in dropped.record));
    assert.deepStrictEqual([dropped.result.excerpts.none, dropped.result.excerpts.kept, dropped.result.excerpts.removed], [1, 0, 1]);
    const dry = await run(empty, true, onThePage());
    assert.deepStrictEqual([dry.record[FREE_PLAN_EXCERPT], dry.result.excerpts.kept], [onThePage(), 1]);
  });

  it("counts a refused copy and an unanswered read with their reasons, and writes nothing on a dry run", async () => {
    const paraphrased = await run({ excerptFn: async () => ({ copied: "Ten gigabytes free" }) });
    assert.deepStrictEqual(paraphrased.result.excerpts.refused, [{ vendor: "Acme", url: acme.url, why: "the copy is not on the page as the page words it" }]);
    assert.ok(!(FREE_PLAN_EXCERPT in paraphrased.record));
    const failing = await run({ excerptFn: async () => { throw new Error("HTTP 429"); } });
    assert.deepStrictEqual(failing.result.excerpts.unread, [{ vendor: "Acme", url: acme.url, why: "HTTP 429" }]);
    const dry = await run({}, true);
    assert.strictEqual(dry.result.excerpts.written, 1);
    assert.ok(!(FREE_PLAN_EXCERPT in dry.record));
  });
});
