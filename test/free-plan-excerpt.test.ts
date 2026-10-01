import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COPY_STATES_NO_TERMS,
  FREE_PLAN_EXCERPT,
  MAX_FREE_PLAN_EXCERPT_LENGTH,
  TIER_WITH_NO_FREE_PLAN,
  assignmentsOfTheExcerpt,
  excerptTheFreePlan,
  excerptsDisagreeingWithTheirCitation,
  parseExcerptAnswer,
  verbatimExcerpt,
  writeFreePlanExcerpt,
} from "../scripts/free-plan-excerpt.js";

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

  it("removes a held excerpt when a read finds no free-plan wording", () => {
    const offer: Record<string, unknown> = { vendor: "Render", [FREE_PLAN_EXCERPT]: { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-08-28" } };
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, copied: "" }), { outcome: "removed" });
    assert.ok(!(FREE_PLAN_EXCERPT in offer));
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, copied: "" }), { outcome: "none" });
  });

  it("leaves a held excerpt untouched when the reader gave no answer it could parse", () => {
    const held = { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-08-28" };
    const offer: Record<string, unknown> = { vendor: "Render", [FREE_PLAN_EXCERPT]: held };
    const unparsed = parseExcerptAnswer("I could not find it.");
    assert.strictEqual(unparsed.copied, null);
    assert.deepStrictEqual(writeFreePlanExcerpt(offer, { ...READ, copied: unparsed.copied }), { outcome: "unread" });
    assert.deepStrictEqual(offer[FREE_PLAN_EXCERPT], held);
  });

  it("reads the copy and the terms it states out of the reader's answer, fenced or not, and an empty copy as no free plan", () => {
    assert.deepStrictEqual(parseExcerptAnswer("```json\n{\"excerpt\":\"Deploy up to 25 services\",\"terms\":[\"up to 25 services\"]}\n```"), { copied: "Deploy up to 25 services", terms: ["up to 25 services"] });
    assert.deepStrictEqual(parseExcerptAnswer("Here it is: {\"excerpt\":\"\"}"), { copied: "", terms: [] });
    assert.deepStrictEqual(parseExcerptAnswer("{\"excerpt\":\"Deploy up to 25 services\",\"terms\":\"up to 25 services\"}"), { copied: "Deploy up to 25 services", terms: [] });
  });

  it("leaves a held excerpt under its own read date when the new copy is refused", () => {
    const held = { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-08-28" };
    const offer: Record<string, unknown> = { vendor: "Render", [FREE_PLAN_EXCERPT]: held };
    const result = writeFreePlanExcerpt(offer, { ...READ, readOn: "2026-09-16", copied: "Deploy up to 25 services with 5 GB bandwidth included" });
    assert.strictEqual(result.outcome, "refused");
    assert.deepStrictEqual(offer[FREE_PLAN_EXCERPT], held);
  });
});

describe("an excerpt states at least one of the plan's terms", () => {
  const FORMSUBMIT_PAGE = "Setup is easy and free. Design a form for your site, and be sure to name all the fields. Then, just point the action to us and confirm your email address! NO REGISTRATION REQUIRED";
  const BITRISE_PAGE = "Hobby Build and distribute your passion project without the extra cost. Free Forever Get started Access for a team of one (that's you!) Enough build credits";
  const NORTHFLANK_PAGE = "Deploy anything, anywhere. Get started for free Book a demo";
  const FIREBASE_PAGE = "No-cost (Spark plan) Generous no-cost usage limits No payment method needed Get started";
  const write = (plan: { vendor: string; tier: string }, pageText: string, copied: string, terms: unknown) => {
    const record: Record<string, unknown> = { ...plan };
    const result = writeFreePlanExcerpt(record, { copied, terms, pageText, url: "https://vendor.example/pricing", readOn: "2026-10-01" });
    return { result, stored: (record[FREE_PLAN_EXCERPT] as { text: string } | undefined)?.text ?? null };
  };

  it("keeps a copy whose terms state a price, an allowance, a limit or who can get the plan, with or without a figure", () => {
    assert.deepStrictEqual(write({ vendor: "Render", tier: "Hobby" }, RENDER_PAGE, RENDER_EXCERPT, ["Deploy up to 25 services"]).result, { outcome: "written" });
    assert.deepStrictEqual(write({ vendor: "Formsubmit.co", tier: "Free" }, FORMSUBMIT_PAGE, FORMSUBMIT_PAGE, ["NO REGISTRATION REQUIRED"]).result, { outcome: "written" });
    assert.deepStrictEqual(write({ vendor: "Bitrise", tier: "Hobby" }, BITRISE_PAGE, "Free Forever Get started Access for a team of one (that's you!)", ["Access for a team of one"]).result, { outcome: "written" });
    assert.deepStrictEqual(write({ vendor: "Firebase", tier: "Spark" }, FIREBASE_PAGE, FIREBASE_PAGE, ["No payment method needed"]).result, { outcome: "written" });
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

  it("refuses a copy when the reader names no term, or no term the copy holds", () => {
    assert.deepStrictEqual(write({ vendor: "Render", tier: "Hobby" }, RENDER_PAGE, RENDER_EXCERPT, []).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
    assert.deepStrictEqual(write({ vendor: "Render", tier: "Hobby" }, RENDER_PAGE, RENDER_EXCERPT, undefined).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
    assert.deepStrictEqual(write({ vendor: "Render", tier: "Hobby" }, RENDER_PAGE, RENDER_EXCERPT, ["Deploy up to 50 services", "100 GB of bandwidth"]).result, { outcome: "refused", why: COPY_STATES_NO_TERMS });
  });

  it("leaves a held excerpt under its own read date when the new copy states no terms", () => {
    const held = { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-08-28" };
    const record: Record<string, unknown> = { vendor: "Render", tier: "Hobby", [FREE_PLAN_EXCERPT]: held };
    assert.deepStrictEqual(writeFreePlanExcerpt(record, { ...READ, copied: "Deploy for free", terms: ["Deploy for free"] }), { outcome: "refused", why: COPY_STATES_NO_TERMS });
    assert.deepStrictEqual(record[FREE_PLAN_EXCERPT], held);
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
