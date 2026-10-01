import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FREE_PLAN_EXCERPT,
  MAX_FREE_PLAN_EXCERPT_LENGTH,
  assignmentsOfTheExcerpt,
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
const READ = { pageText: RENDER_PAGE, url: "https://render.com/pricing", readOn: "2026-09-16" };

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

  it("reads the copy out of the reader's answer, fenced or not, and an empty copy as no free plan", () => {
    assert.deepStrictEqual(parseExcerptAnswer("```json\n{\"excerpt\":\"Deploy up to 25 services\"}\n```"), { copied: "Deploy up to 25 services" });
    assert.deepStrictEqual(parseExcerptAnswer("Here it is: {\"excerpt\":\"\"}"), { copied: "" });
  });

  it("leaves a held excerpt under its own read date when the new copy is refused", () => {
    const held = { text: RENDER_EXCERPT, url: READ.url, read_on: "2026-08-28" };
    const offer: Record<string, unknown> = { vendor: "Render", [FREE_PLAN_EXCERPT]: held };
    const result = writeFreePlanExcerpt(offer, { ...READ, readOn: "2026-09-16", copied: "Deploy up to 25 services with 5 GB bandwidth included" });
    assert.strictEqual(result.outcome, "refused");
    assert.deepStrictEqual(offer[FREE_PLAN_EXCERPT], held);
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
        return { copied: "Free tier: 10 GB per month for $0." };
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
