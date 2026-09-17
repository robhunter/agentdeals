import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const { CANNOT_CONFIRM_THESE_TERMS, whyWeCannotConfirmTheseTerms } = await import("../dist/vendor-verdict.js");
const { vendorVerdictContextFrom, reasonWeCannotConfirmTheTerms } = await import("../dist/vendor-verdict-input.js");
const { loadOffers, changesByVendor, refusalsForVendor } = await import("../dist/data.js");
const { vendorSlugMap } = await import("../dist/vendor-slug.js");
const { ENDED_TIERS } = await import("../dist/retirement.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const EVERY_NTH_VENDOR_PAGE = 3;

const RESTATEMENTS_A_PAGE_MAY_MAKE = 12;
const RESTATEMENTS_THE_TYPICAL_PAGE_MAKES = 7;

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 120000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function unescapeServed(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"')
    .replace(/&rsquo;/g, "'").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&hellip;/g, "…")
    .replace(/&darr;/g, "↓").replace(/&rarr;/g, "→").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function textOf(html: string): string {
  return unescapeServed(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function visibleTextOf(html: string): string {
  return textOf(
    html
      .replace(/<head[\s\S]*?<\/head>/g, " ")
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " "),
  );
}

function sectionOf(html: string, pattern: RegExp): string | null {
  const found = html.match(pattern);
  return found ? textOf(found[1]) : null;
}

const quickVerdictOf = (html: string): string | null =>
  sectionOf(html, /<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/);

const termsBlockOf = (html: string): string | null =>
  sectionOf(html, /<h2>Free Tier Details<\/h2>\s*<p class="(?:desc-text|terms-superseded-text)"[^>]*>([\s\S]*?)<\/p>/);

const tierOf = (html: string): string | null =>
  sectionOf(html, /<div class="detail-label">Tier<\/div>\s*<div class="detail-value"[^>]*>([\s\S]*?)<\/div>/);

function nodeDescriptionOf(html: string): string | null {
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed: unknown;
    try { parsed = JSON.parse(block[1]); } catch { continue; }
    let found: string | null = null;
    const visit = (node: unknown): void => {
      if (found !== null || !node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const record = node as Record<string, unknown>;
      if (record["@type"] === "SoftwareApplication" && typeof record.description === "string") {
        found = record.description;
        return;
      }
      Object.values(record).forEach(visit);
    };
    visit(parsed);
    if (found !== null) return found;
  }
  return null;
}

function closed(terms: string): string {
  return /[.!?…]$/.test(terms.trim()) ? terms.trim() : `${terms.trim()}.`;
}

function reasonTheNodeAdds(description: string, displayed: string): string | null {
  const opening = closed(displayed);
  const stated = description.trim();
  if (stated === opening || stated === displayed.trim()) return "";
  return stated.startsWith(`${opening} `) ? stated.slice(opening.length + 1) : null;
}

function occurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let seen = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) { seen++; at = haystack.indexOf(needle, at + needle.length); }
  return seen;
}

interface Withholding { clause: string; sentence: string }

function reasonsByVendorSlug(): Map<string, Withholding> {
  const changes = changesByVendor();
  const servedOn = new Date().toISOString().slice(0, 10);
  const offersByVendor = new Map<string, any[]>();
  for (const offer of loadOffers()) {
    const held = offersByVendor.get(offer.vendor);
    if (held) held.push(offer);
    else offersByVendor.set(offer.vendor, [offer]);
  }
  const found = new Map<string, Withholding>();
  for (const [slug, vendor] of vendorSlugMap) {
    const vendorOffers = offersByVendor.get(vendor);
    if (!vendorOffers) continue;
    const context = vendorVerdictContextFrom({
      vendor,
      vendorOffers,
      vendorChanges: changes.get(vendor.toLowerCase()) ?? [],
      refusedReads: refusalsForVendor(vendor),
      servedOn,
    });
    if (!context) continue;
    const unconfirmed = reasonWeCannotConfirmTheTerms(context.primary, whyWeCannotConfirmTheseTerms(context.input));
    if (unconfirmed) found.set(slug, { clause: unconfirmed.clause, sentence: unconfirmed.sentence });
  }
  return found;
}

function restatements(visible: string, withholding: Withholding): number {
  const clause = withholding.clause;
  const opened = `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
  const lowered = `${clause.charAt(0).toLowerCase()}${clause.slice(1)}`;
  return occurrences(visible, opened) + occurrences(visible, lowered) + occurrences(visible, withholding.sentence);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[middle - 1] + sorted[middle]) / 2;
}

interface VendorPage {
  route: string;
  slug: string;
  tier: string | null;
  verdict: string;
  visible: string;
  reason: string | null;
  citesARead: boolean;
  restated: number | null;
}

describe("a vendor page states the reason it cannot confirm the terms in its own verdict, and states it once", () => {
  let server: { proc: ChildProcess; port: number } | null = null;
  const pages: VendorPage[] = [];
  const unreadable: string[] = [];

  before(async () => {
    const withheld = reasonsByVendorSlug();
    server = await startServer();
    const base = `http://localhost:${server.port}`;
    const sitemap = await (await fetch(`${base}/sitemap-vendors.xml`)).text();
    const routes = [...sitemap.matchAll(/<loc>([^<]*\/vendor\/[^<]*)<\/loc>/g)]
      .map(([, url]) => new URL(url).pathname)
      .filter((_, index) => index % EVERY_NTH_VENDOR_PAGE === 0);

    let next = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (next < routes.length) {
        const route = routes[next++];
        const response = await fetch(base + route);
        if (!response.ok) continue;
        const html = await response.text();
        const description = nodeDescriptionOf(html);
        const displayed = termsBlockOf(html);
        const verdict = quickVerdictOf(html);
        if (description === null || displayed === null || verdict === null) { unreadable.push(route); continue; }
        const slug = route.replace("/vendor/", "");
        const withholding = withheld.get(slug) ?? null;
        const visible = visibleTextOf(html);
        pages.push({
          route,
          slug,
          tier: tierOf(html),
          verdict,
          visible,
          reason: reasonTheNodeAdds(description, displayed),
          citesARead: /class="free-tier-source-line"/.test(html),
          restated: withholding ? restatements(visible, withholding) : null,
        });
      }
    }));
  });

  after(() => { server?.proc.kill(); });

  it("reads enough vendor pages for the sweeps below to mean something", () => {
    assertPopulationFloor(pages.length, 300, "vendor pages read with a node, a terms block and a verdict");
    assert.deepStrictEqual(unreadable.slice(0, 15), [], "vendor pages served no node, no terms block or no verdict");
  });

  it("says in the verdict a reader sees that it cannot confirm the terms, wherever the node says so", () => {
    const stated = pages.filter(p => p.reason !== null && p.reason.includes(CANNOT_CONFIRM_THESE_TERMS));
    assertPopulationFloor(stated.length, 200, "vendor pages whose node states a reason we cannot confirm the terms");
    assert.deepStrictEqual(
      stated.filter(p => !p.verdict.includes(CANNOT_CONFIRM_THESE_TERMS))
        .map(p => `${p.route}: ${p.verdict.slice(-120)}`).slice(0, 15),
      [],
    );
  });

  it("cites no read of the vendor's page beside terms that read does not confirm", () => {
    assertPopulationFloor(
      pages.filter(p => p.citesARead).length,
      150,
      "vendor pages cite the read behind the terms they display",
    );
    assert.deepStrictEqual(
      pages.filter(p => p.citesARead && p.reason !== null && p.reason !== "")
        .map(p => `${p.route}: ${p.reason!.slice(0, 90)}`).slice(0, 15),
      [],
    );
  });

  it("states that reason a bounded number of times on any one page", () => {
    const restated = pages.filter(p => p.restated !== null).map(p => p.restated as number);
    assertPopulationFloor(restated.length, 200, "vendor pages hold terms we cannot confirm");
    const over = pages
      .filter(p => (p.restated ?? 0) > RESTATEMENTS_A_PAGE_MAY_MAKE)
      .map(p => `${p.route}: ${p.restated}`);
    assert.deepStrictEqual(over.slice(0, 15), []);
    assert.ok(
      median(restated) <= RESTATEMENTS_THE_TYPICAL_PAGE_MAKES,
      `the page in the middle of this population states the reason ${median(restated)} times,`
        + ` over a ceiling of ${RESTATEMENTS_THE_TYPICAL_PAGE_MAKES}`,
    );
  });

  it("leaves a record whose tier names its own ending to say so without a caveat or a citation", () => {
    const ended = pages.filter(p => ENDED_TIERS.some((tier: string) => tier.toLowerCase() === (p.tier ?? "").toLowerCase()));
    assertPopulationFloor(ended.length, 4, "vendor pages whose tier names the offer as ended");
    assert.deepStrictEqual(
      ended.filter(p => p.reason !== "" || p.citesARead).map(p => `${p.route}: ${p.reason ?? "no node built from the block"}`),
      [],
    );
  });
});

describe("only a tier that is the ending itself withholds the reason we cannot confirm the terms", () => {
  const reason = {
    because: { reason: "states_no_terms" as const },
    clause: "the page we cite for this offer states no amount, tier or rate we can read",
    sentence: "The page we cite for this offer states no amount, tier or rate we can read.",
    theReadFoundAFreePlan: false,
    on: "2026-09-02",
  };

  for (const tier of ENDED_TIERS as readonly string[]) {
    it(`states none where the tier is ${tier}`, () => {
      assert.strictEqual(reasonWeCannotConfirmTheTerms({ tier }, reason), null);
    });
  }

  it("states one where the tier only mentions an ending beside a live plan", () => {
    assert.strictEqual(reasonWeCannotConfirmTheTerms({ tier: "Free (Deprecated)" }, reason), reason);
    assert.strictEqual(reasonWeCannotConfirmTheTerms({ tier: "Free (sunset 2026)" }, reason), reason);
  });

  it("states none where we hold no reason at all", () => {
    assert.strictEqual(reasonWeCannotConfirmTheTerms({ tier: "Free" }, null), null);
  });
});
