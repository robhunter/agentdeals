import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTier, TIME_LIMITED_TIER_RULES } from "../dist/ranking.js";
import { loadOffers } from "../dist/data.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import { buildComparisonMap } from "../dist/comparison-pairs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const GREY = "#8b949e";
const READS_AS_AN_ONGOING_FREE_TIER = new Set(["active", "at risk", "stale"]);
const RUNS_OUT_LABELS = new Set(TIME_LIMITED_TIER_RULES.map(rule => rule.badgeLabel));
const WITHHELD_OR_ENDED = /^unrated\b|^free tier removed$|^deprecated$|^retired$/;

interface Listing { vendor: string; slug: string; tier: string; description: string }

const primaryListings: Listing[] = (() => {
  const offers = loadOffers();
  const listings: Listing[] = [];
  for (const [slug, vendor] of vendorSlugMap) {
    const primary = offers.find(o => o.vendor === vendor);
    if (primary) listings.push({ vendor, slug, tier: primary.tier, description: primary.description });
  }
  return listings;
})();

const runsOut = (listing: Listing): boolean => classifyTier(listing.tier).class === "time_limited";

function labelTheRulesGive(tier: string): string {
  return TIME_LIMITED_TIER_RULES.find(rule => rule.pattern.test(tier))!.badgeLabel;
}

let proc: ChildProcess | null = null;
let port = 0;

async function get(route: string): Promise<string> {
  const res = await fetch(`http://localhost:${port}${route}`);
  assert.strictEqual(res.status, 200, `${route} returned ${res.status}`);
  return res.text();
}

async function eachIn<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

interface BadgeRead { label: string; dated: boolean; colour: string }

function readBadge(svg: string): BadgeRead {
  const title = svg.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
  const right = title.split(": ").slice(1).join(": ");
  const [label, date] = right.split(" · ");
  const fills = [...svg.matchAll(/<rect x="[\d.]+" width="[\d.]+" height="\d+" fill="(#[0-9a-f]{6})"\/>/g)].map(m => m[1]);
  return { label: label.trim(), dated: /^[A-Z][a-z]{2} \d{4}$/.test((date ?? "").trim()), colour: fills[0] ?? "" };
}

function unescHtml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function verdictOf(html: string): string {
  const section = html.match(/class="verdict-section">([\s\S]*?)<\/div>/)?.[1] ?? "";
  return unescHtml(section.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? "").trim();
}

function jsonLd(html: string): Record<string, any>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
}

before(async () => {
  const started = await new Promise<{ child: ChildProcess; port: number }>((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
  proc = started.child;
  port = started.port;
});

after(() => { proc?.kill(); });

describe("a listing that runs out never reads as an ongoing free tier", () => {
  it("badges a credit, trial, preview or award by what it is, in grey, and never as active or at risk", async () => {
    const subjects = primaryListings.filter(runsOut);
    const wrong: string[] = [];
    let labelled = 0;
    await eachIn(subjects, async (listing) => {
      const badge = readBadge(await get(`/badge/${listing.slug}.svg`));
      if (READS_AS_AN_ONGOING_FREE_TIER.has(badge.label)) {
        wrong.push(`/badge/${listing.slug}.svg reads "${badge.label}" over the tier "${listing.tier}"`);
        return;
      }
      if (WITHHELD_OR_ENDED.test(badge.label)) return;
      labelled++;
      const expected = labelTheRulesGive(listing.tier);
      if (badge.label !== expected) wrong.push(`/badge/${listing.slug}.svg reads "${badge.label}", not "${expected}"`);
      if (!badge.dated) wrong.push(`/badge/${listing.slug}.svg carries no month after "${badge.label}"`);
      if (badge.colour !== GREY) wrong.push(`/badge/${listing.slug}.svg is coloured ${badge.colour}, not grey`);
    });
    assert.deepStrictEqual(wrong.slice(0, 20), [], wrong.slice(0, 20).join("\n"));
    assert.ok(labelled > 0, "no listing that runs out carries the label for what it is, so no badge here is checked");
  });

  it("gives no listing with an ongoing free tier one of those labels, even one that mentions credits", async () => {
    const controls = primaryListings.filter(listing => classifyTier(listing.tier).class === "free");
    const mislabelled: string[] = [];
    let creditWorded = 0;
    await eachIn(controls, async (listing) => {
      const { label } = readBadge(await get(`/badge/${listing.slug}.svg`));
      if (/credit/i.test(listing.description)) creditWorded++;
      if (RUNS_OUT_LABELS.has(label)) mislabelled.push(`/badge/${listing.slug}.svg reads "${label}" over the tier "${listing.tier}"`);
    });
    assert.deepStrictEqual(mislabelled, [], mislabelled.join("\n"));
    assert.ok(creditWorded > 0, "no listing with an ongoing free tier mentions credits, so the control is not exercised");
  });

  it("never says on a comparison that a listing which runs out offers a free tier, and publishes no free Offer for it", async () => {
    const runsOutByVendor = new Map(primaryListings.filter(runsOut).map(l => [l.vendor, l]));
    const pairs = [...buildComparisonMap().entries()]
      .filter(([, [a, b]]: [string, [string, string]]) => runsOutByVendor.has(a) || runsOutByVendor.has(b));
    const wrong: string[] = [];
    let slots = 0;
    let saysWhatItOffers = 0;
    await eachIn(pairs, async ([slug, [a, b]]: [string, [string, string]]) => {
      const html = await get(`/compare/${slug}`);
      const verdict = verdictOf(html);
      const faq = jsonLd(html).find(block => block["@type"] === "FAQPage")!.mainEntity[0].acceptedAnswer.text as string;
      const items = jsonLd(html).find(block => block["@type"] === "WebPage")!.mainEntity.itemListElement
        .map((element: { item: { name: string; offers?: unknown } }) => element.item);
      for (const [vendor, other] of [[a, b], [b, a]]) {
        const listing = runsOutByVendor.get(vendor);
        if (!listing) continue;
        slots++;
        for (const [where, text] of [["verdict", verdict], ["FAQ", faq]]) {
          if (text.includes(`${vendor} offers a free tier`)) wrong.push(`/compare/${slug} ${where} says ${vendor} offers a free tier`);
          if (text.includes(`Both ${vendor} and ${other} offer free tiers`) || text.includes(`Both ${other} and ${vendor} offer free tiers`)) {
            wrong.push(`/compare/${slug} ${where} says both offer free tiers`);
          }
          if (text.startsWith("Both offer free tiers")) wrong.push(`/compare/${slug} ${where} says both offer free tiers`);
        }
        if (items.find((item: { name: string; offers?: unknown }) => item.name === vendor)?.offers) {
          wrong.push(`/compare/${slug} prices ${vendor}'s "${listing.tier}" as a free Offer`);
        }
        const whatItOffers = `${classifyTier(listing.tier).note} ("${listing.tier}")`;
        if (verdict.includes(whatItOffers)) saysWhatItOffers++;
      }
    });
    assert.deepStrictEqual(wrong.slice(0, 20), [], wrong.slice(0, 20).join("\n"));
    assert.ok(slots > 0, "no comparison slot holds a listing that runs out, so no comparison here is checked");
    assert.ok(saysWhatItOffers > 0, "no comparison says what a listing that runs out offers, so the wording is unchecked");
  });
});
