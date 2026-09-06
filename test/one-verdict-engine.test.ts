import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANGE_DIRECTION,
  CHANGE_IS_AN_EVENT,
  CHANGE_IS_A_CONDITION,
  RISK_DEMOTION,
  SEVERE_TYPES_WITHOUT_FLAT_DEMOTION,
  VERDICT_WINDOW_DAYS,
  VOLATILE_TYPES,
  changeTypesThatCanDemote,
  demotionInForce,
  loadDealChanges,
  loadOffers,
  vendorRiskAssessment,
  verdictHasLapsed,
} from "../dist/data.js";
import { isNoLongerInForce } from "../dist/change-resolution.js";
import { PRODUCT_DEPRECATED, deprecationEndsTheListedProduct } from "../dist/product-deprecation.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import { ENDED_BADGE_LABEL } from "../dist/retirement.js";
import type { DealChange } from "../src/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-15T00:00:00Z");

function record(overrides: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "V",
    change_type: "pricing_restructured",
    date: "2026-06-01",
    summary: "s",
    previous_state: "",
    current_state: "",
    impact: "medium",
    source_url: "https://example.test/pricing",
    category: "c",
    alternatives: [],
    ...overrides,
  } as DealChange;
}

const isoDaysBefore = (days: number) => new Date(NOW - days * DAY).toISOString().slice(0, 10);

const withdrawn = (change: DealChange): DealChange => ({
  ...change,
  resolution: { state: "retracted", date: isoDaysBefore(1), source_url: "https://example.test/withdrawal" },
});

function pointsDownAndStillHolds(change: DealChange, nowMs: number = Date.now()): boolean {
  if (CHANGE_DIRECTION[change.change_type] !== "negative") return false;
  if (isNoLongerInForce(change)) return false;
  if (verdictHasLapsed(change, nowMs)) return false;
  return !(change.change_type === PRODUCT_DEPRECATED && !deprecationEndsTheListedProduct(change));
}

describe("#1206 one risk scale, and every change type sits on one side of it", () => {
  it("classifies every change type the risk scale can act on as an event or a condition", () => {
    const unclassified: string[] = [];
    const both: string[] = [];
    for (const changeType of changeTypesThatCanDemote()) {
      const isEvent = CHANGE_IS_AN_EVENT.has(changeType);
      const isCondition = CHANGE_IS_A_CONDITION.has(changeType);
      if (!isEvent && !isCondition) unclassified.push(changeType);
      if (isEvent && isCondition) both.push(changeType);
    }
    assert.deepStrictEqual(unclassified, [], "these demote a vendor and nothing says whether the verdict expires");
    assert.deepStrictEqual(both, [], "these are classified as both an event and a condition");
  });

  it("keeps the types that skip the expiry check off the expiring side", () => {
    const wrong = [...VOLATILE_TYPES].filter(t => CHANGE_IS_AN_EVENT.has(t as DealChange["change_type"]));
    assert.deepStrictEqual(wrong, [], "these expire, and the volatility scale reads them without the expiry check");
  });

  it("acts on every change type it calls negative, apart from the one it judges per record", () => {
    const ignored = Object.entries(CHANGE_DIRECTION)
      .filter(([type, direction]) => direction === "negative" && RISK_DEMOTION[type as DealChange["change_type"]] === null)
      .map(([type]) => type);
    assert.deepStrictEqual(
      ignored,
      Object.keys(SEVERE_TYPES_WITHOUT_FLAT_DEMOTION),
      "these point down and the risk scale does not act on them",
    );
  });

  it("publishes no stable verdict over a record it calls negative and still holds in force", () => {
    const held = new Map<string, DealChange[]>();
    for (const c of loadDealChanges()) {
      const key = c.vendor.toLowerCase();
      if (!held.has(key)) held.set(key, []);
      held.get(key)!.push(c);
    }
    const wrong: string[] = [];
    let checked = 0;
    for (const vendor of new Set(loadOffers().map(o => o.vendor))) {
      const changes = held.get(vendor.toLowerCase()) ?? [];
      const inForce = changes.filter(c => pointsDownAndStillHolds(c));
      if (inForce.length === 0) continue;
      checked++;
      const assessment = vendorRiskAssessment(changes);
      if (assessment.level === "stable" && !assessment.rating_withheld) {
        wrong.push(`${vendor} holds ${inForce.map(c => c.change_type).join(", ")} and reads stable`);
      }
    }
    assert.ok(checked > 0, "no vendor holds a record that points down, so this asserts nothing");
    assert.deepStrictEqual(wrong.slice(0, 20), [], `stable verdicts over a record that points down:\n${wrong.slice(0, 20).join("\n")}`);
  });

  it("checks a vendor whose one adverse record stands, and exempts the same one withdrawn", () => {
    const standing = record({ change_type: "free_tier_removed", date: isoDaysBefore(30) });

    assert.strictEqual(pointsDownAndStillHolds(standing, NOW), true, "the invariant no longer checks a standing removal");
    assert.notStrictEqual(vendorRiskAssessment([standing], NOW).level, "stable");

    assert.strictEqual(pointsDownAndStillHolds(withdrawn(standing), NOW), false, "the invariant still checks a withdrawn removal");
    assert.strictEqual(vendorRiskAssessment([withdrawn(standing)], NOW).level, "stable");
  });
});

describe("#1206 an event verdict expires, a condition verdict does not", () => {
  it("drops an event verdict once the record falls outside the window", () => {
    for (const changeType of CHANGE_IS_AN_EVENT) {
      if (RISK_DEMOTION[changeType] === null) continue;
      const inside = record({ change_type: changeType, date: isoDaysBefore(VERDICT_WINDOW_DAYS - 1) });
      const outside = record({ change_type: changeType, date: isoDaysBefore(VERDICT_WINDOW_DAYS + 1) });
      assert.strictEqual(verdictHasLapsed(inside, NOW), false, `${changeType} inside the window`);
      assert.strictEqual(verdictHasLapsed(outside, NOW), true, `${changeType} outside the window`);
      assert.strictEqual(vendorRiskAssessment([inside], NOW).level, RISK_DEMOTION[changeType], changeType);
      assert.strictEqual(vendorRiskAssessment([outside], NOW).level, "stable", changeType);
      assert.strictEqual(vendorRiskAssessment([outside], NOW).cause, null, changeType);
    }
  });

  it("holds a condition verdict however old the record is", () => {
    for (const changeType of CHANGE_IS_A_CONDITION) {
      const ancient = record({ change_type: changeType, date: isoDaysBefore(VERDICT_WINDOW_DAYS * 10) });
      assert.strictEqual(verdictHasLapsed(ancient, NOW), false, changeType);
      assert.strictEqual(demotionInForce(ancient, NOW), demotionInForce(record({ change_type: changeType }), NOW), changeType);
    }
  });

  it("keeps the newest record in force when an older one on the same vendor has expired", () => {
    const expired = record({ change_type: "pricing_restructured", date: isoDaysBefore(VERDICT_WINDOW_DAYS + 30) });
    const live = record({ change_type: "limits_reduced", date: isoDaysBefore(10) });
    const assessment = vendorRiskAssessment([expired, live], NOW);
    assert.strictEqual(assessment.level, "caution");
    assert.strictEqual(assessment.cause?.change_type, "limits_reduced");
  });
});

describe("#1206 the badge and the vendor page read the same scale", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;

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
    serverPort = started.port;
  });

  after(() => { if (proc) proc.kill(); });

  const UNRATED_BADGE_LABEL = "unrated \u2014 no source";
  const WITHHELD_BADGE_PREFIX = "unrated \u2014 ";

  const LEVEL_FOR_BADGE: Record<string, string> = {
    "deprecated": "risky",
    "free tier removed": "risky",
    "at risk": "caution",
    "stale": "stable",
    "active": "stable",
  };

  const badgeLabel = (svg: string): string | null => {
    const title = svg.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
    const right = title.split(": ").slice(1).join(": ");
    if (!right) return null;
    return right.split(" · ")[0].trim();
  };

  it("gives the badge the level the risk scale reached, for every vendor", async () => {
    const changes = loadDealChanges();
    const held = new Map<string, DealChange[]>();
    for (const c of changes) {
      const key = c.vendor.toLowerCase();
      if (!held.has(key)) held.set(key, []);
      held.get(key)!.push(c);
    }
    const slugs = [...vendorSlugMap.entries()];
    const disagreeing: string[] = [];
    let queue = 0;
    const worker = async () => {
      while (queue < slugs.length) {
        const [slug, vendor] = slugs[queue++];
        const res = await fetch(`http://localhost:${serverPort}/badge/${slug}.svg`);
        if (res.status !== 200) { disagreeing.push(`/badge/${slug}.svg returned ${res.status}`); continue; }
        const label = badgeLabel(await res.text());
        if (label === null) { disagreeing.push(`/badge/${slug}.svg carries no readable label`); continue; }
        if (label === "not found") continue;
        if (label === ENDED_BADGE_LABEL) continue;
        if (label === UNRATED_BADGE_LABEL) {
          if (vendorRiskAssessment(held.get(vendor.toLowerCase()) ?? []).rating_withheld === null) {
            disagreeing.push(`/badge/${slug}.svg withholds a rating the risk scale reached`);
          }
          continue;
        }
        if (label.startsWith(WITHHELD_BADGE_PREFIX)) continue;
        const level = LEVEL_FOR_BADGE[label];
        if (level === undefined) { disagreeing.push(`/badge/${slug}.svg reads "${label}"`); continue; }
        const expected = vendorRiskAssessment(held.get(vendor.toLowerCase()) ?? []).level;
        if (level !== expected) disagreeing.push(`/badge/${slug}.svg reads ${level}, the risk scale reads ${expected}`);
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    assert.deepStrictEqual(disagreeing.slice(0, 20), [], `badges disagreeing with the risk scale:\n${disagreeing.slice(0, 20).join("\n")}`);
  });

  it("calls a badge deprecated only where the record ends the product we list", async () => {
    const changes = loadDealChanges();
    const wrong: string[] = [];
    let checked = 0;
    for (const [slug, vendor] of vendorSlugMap) {
      const deprecations = changes.filter(c =>
        c.vendor.toLowerCase() === vendor.toLowerCase() && c.change_type === "product_deprecated");
      if (deprecations.length === 0) continue;
      if (deprecations.some(c => deprecationEndsTheListedProduct(c))) continue;
      checked++;
      const svg = await (await fetch(`http://localhost:${serverPort}/badge/${slug}.svg`)).text();
      if (badgeLabel(svg) === "deprecated") wrong.push(`/badge/${slug}.svg`);
    }
    assert.ok(checked > 0, "no vendor retired one of its other products, so this asserts nothing");
    assert.deepStrictEqual(wrong, [], "these badges call a vendor deprecated over a record that ends another product");
  });

  it("gives the vendor risk endpoint the level the risk scale reached", async () => {
    const changes = loadDealChanges();
    const vendors = [...new Set(loadOffers().map(o => o.vendor))];
    const demoted = vendors.filter(v =>
      vendorRiskAssessment(changes.filter(c => c.vendor.toLowerCase() === v.toLowerCase())).level !== "stable");
    const sample = [...demoted.slice(0, 15), ...vendors.filter(v => !demoted.includes(v)).slice(0, 15)];
    assert.ok(demoted.length > 0, "the index holds no vendor the risk scale demotes");
    const wrong: string[] = [];
    for (const vendor of sample) {
      const res = await fetch(`http://localhost:${serverPort}/api/vendor-risk/${encodeURIComponent(vendor)}`);
      if (res.status !== 200) continue;
      const body = await res.json() as { risk_level: string | null };
      if (body.risk_level === null) continue;
      const expected = vendorRiskAssessment(changes.filter(c => c.vendor.toLowerCase() === vendor.toLowerCase())).level;
      if (body.risk_level !== expected) wrong.push(`${vendor}: endpoint ${body.risk_level}, risk scale ${expected}`);
    }
    assert.deepStrictEqual(wrong, [], "the vendor risk endpoint disagrees with the risk scale");
  });

  it("names no change type in a stable verdict, so the sentence survives a change to the risk map", async () => {
    const changes = loadDealChanges();
    const stable = [...vendorSlugMap.entries()].filter(([, vendor]) =>
      vendorRiskAssessment(changes.filter(c => c.vendor.toLowerCase() === vendor.toLowerCase())).level === "stable");
    assert.ok(stable.length > 0, "no vendor reads stable, so this asserts nothing");
    const enumerating = /no free tier removal, limit reduction or pricing restructure/;
    const wrong: string[] = [];
    for (const [slug] of stable.slice(0, 40)) {
      const html = await (await fetch(`http://localhost:${serverPort}/vendor/${slug}`)).text();
      if (enumerating.test(html)) wrong.push(`/vendor/${slug}`);
    }
    assert.deepStrictEqual(wrong, [], "these pages list the change types a stable verdict rules out");
  });

  const RECENCY = /recently/i;
  const STATES_A_DATE = /\d{4}-\d{2}-\d{2}/;

  interface FaqItem { path: string; question: string; answer: string }

  const faqItemsIn = (pagePath: string, html: string): FaqItem[] => {
    const items: FaqItem[] = [];
    for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      let parsed: unknown;
      try { parsed = JSON.parse(block[1]); } catch { continue; }
      for (const entry of (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, any>>) {
        if (!entry || entry["@type"] !== "FAQPage" || !Array.isArray(entry.mainEntity)) continue;
        for (const q of entry.mainEntity) {
          const answer = q?.acceptedAnswer?.text;
          if (typeof q?.name === "string" && typeof answer === "string") {
            items.push({ path: pagePath, question: q.name, answer });
          }
        }
      }
    }
    return items;
  };

  const faqSample = async (): Promise<FaqItem[]> => {
    const changes = loadDealChanges();
    const withChanges = new Set(changes.map(c => c.vendor.toLowerCase()));
    const slugs = [...vendorSlugMap.entries()];
    const recorded = slugs.filter(([, v]) => withChanges.has(v.toLowerCase())).slice(0, 30);
    const silent = slugs.filter(([, v]) => !withChanges.has(v.toLowerCase())).slice(0, 30);
    const items: FaqItem[] = [];
    for (const [slug] of [...recorded, ...silent]) {
      for (const prefix of ["/vendor/", "/alternative-to/"]) {
        const res = await fetch(`http://localhost:${serverPort}${prefix}${slug}`);
        if (res.status !== 200) continue;
        items.push(...faqItemsIn(prefix + slug, await res.text()));
      }
    }
    return items;
  };

  it("asks no question about a vendor's pricing history that presumes it is recent", async () => {
    const items = await faqSample();
    const fromVendorPages = items.filter(i => i.path.startsWith("/vendor/"));
    const fromAlternativePages = items.filter(i => i.path.startsWith("/alternative-to/"));
    assert.ok(fromVendorPages.length > 0, "no vendor page published a structured FAQ, so this asserts nothing");
    assert.ok(fromAlternativePages.length > 0, "no alternatives page published a structured FAQ, so this asserts nothing");
    const presuming = items.filter(i => RECENCY.test(i.question)).map(i => `${i.path}: ${i.question}`);
    assert.deepStrictEqual([...new Set(presuming)].slice(0, 10), [],
      "a question carries no date, so it cannot say when the change it asks about happened");
  });

  it("dates every answer that calls a change recent", async () => {
    const undated = (await faqSample())
      .filter(i => RECENCY.test(i.answer) && !STATES_A_DATE.test(i.answer))
      .map(i => `${i.path}: ${i.answer.slice(0, 120)}`);
    assert.deepStrictEqual([...new Set(undated)].slice(0, 10), [],
      "these answers call a change recent without saying when it happened");
  });
});
