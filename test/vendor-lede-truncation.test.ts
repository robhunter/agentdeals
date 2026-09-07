import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { openingOfTerms, punctuatedOpeningOfTerms, termsWereClipped, unclosedBrackets } =
  await import("../dist/terms-opening.js");
const { readingBehindTheChange, supersedingChange } = await import("../dist/superseded-description.js");
const { toSlug } = await import("../dist/slug.js");

interface Offer { vendor: string; description: string }

const { offers } = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")) as { offers: Offer[] };
const { changes: dealChanges } = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8")) as
  { changes: { vendor: string }[] };

const changesByVendorName = new Map<string, { vendor: string }[]>();
for (const change of dealChanges) {
  const key = (change.vendor ?? "").toLowerCase();
  if (!changesByVendorName.has(key)) changesByVendorName.set(key, []);
  changesByVendorName.get(key)!.push(change);
}

const recordsBySlug = new Map<string, Offer[]>();
for (const offer of offers) {
  const slug = toSlug(offer.vendor);
  if (!recordsBySlug.has(slug)) recordsBySlug.set(slug, []);
  recordsBySlug.get(slug)!.push(offer);
}

const readingsBySlug = new Map<string, string[]>();
for (const offer of offers) {
  const superseding = supersedingChange(offer, changesByVendorName.get(offer.vendor.toLowerCase()) ?? []);
  if (!superseding) continue;
  const reading = readingBehindTheChange(superseding);
  if (!reading) continue;
  const slug = toSlug(offer.vendor);
  if (!readingsBySlug.has(slug)) readingsBySlug.set(slug, []);
  readingsBySlug.get(slug)!.push(reading.terms.trim());
}

let server: ChildProcess;
let base = "";

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        base = `http://localhost:${match[1]}`;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const SWEPT_PAGES_VACUITY_GUARD = 200;
const WITHHOLDING_PHRASE = "terms are superseded and withheld";
const INCLUDES_PHRASE = " free tier includes ";
const READING_PHRASE = " reads: ";
const CLIP_MARKER = "…";

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function metaDescriptionOf(html: string): string | null {
  const match = html.match(/<meta name="description" content="([^"]*)"/);
  return match ? decodeEntities(match[1]) : null;
}

function sharedPrefixLength(published: string, stored: string): number {
  let i = 0;
  while (i < published.length && i < stored.length && published[i] === stored[i]) i++;
  return i;
}

interface Quotation {
  route: string;
  stored: string;
  opening: string;
  marked: boolean;
  continues: string;
}

function quotationAgainst(route: string, published: string, candidates: readonly string[]): Quotation | null {
  const excerpted = published.startsWith(CLIP_MARKER);
  const body = excerpted ? published.slice(CLIP_MARKER.length) : published;
  let best: Quotation | null = null;
  for (const stored of candidates) {
    const from = excerpted ? stored.indexOf(body.slice(0, 24)) : 0;
    const rest = from < 0 ? "" : stored.slice(from);
    const shared = sharedPrefixLength(body, rest);
    const quotation: Quotation = {
      route,
      stored,
      opening: body.slice(0, shared),
      marked: body.slice(shared).startsWith(CLIP_MARKER),
      continues: rest.slice(shared),
    };
    if (best === null || quotation.opening.length > best.opening.length) best = quotation;
  }
  return best;
}

interface Swept {
  route: string;
  slug: string;
  description: string;
  branch: "superseded" | "has_free" | "other";
  quoted: string | null;
}

const swept: Swept[] = [];
const unreachable: string[] = [];

async function sweepVendorPages(): Promise<void> {
  const xml = await (await fetch(`${base}/sitemap-vendors.xml`)).text();
  const routes = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < routes.length) {
      const route = routes[cursor++];
      const response = await fetch(base + route);
      if (response.status !== 200) { unreachable.push(route); continue; }
      const description = metaDescriptionOf(await response.text());
      if (description === null) { unreachable.push(route); continue; }
      const withheld = description.includes(WITHHOLDING_PHRASE);
      const includesAt = description.indexOf(INCLUDES_PHRASE);
      const readsAt = description.indexOf(READING_PHRASE);
      swept.push({
        route,
        slug: route.replace("/vendor/", ""),
        description,
        branch: withheld ? "superseded" : includesAt === -1 ? "other" : "has_free",
        quoted: withheld
          ? (readsAt === -1 ? null : description.slice(readsAt + READING_PHRASE.length))
          : includesAt === -1
          ? null
          : description.slice(includesAt + INCLUDES_PHRASE.length),
      });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

function statedTerms(): Quotation[] {
  const out: Quotation[] = [];
  for (const page of swept) {
    if (page.branch !== "has_free" || page.quoted === null) continue;
    const records = recordsBySlug.get(page.slug);
    if (!records) continue;
    const quotation = quotationAgainst(page.route, page.quoted, records.map(r => r.description.trim()));
    if (quotation) out.push(quotation);
  }
  return out;
}

function clippedStatedTerms(): Quotation[] {
  return statedTerms().filter(q => q.continues !== "");
}

describe("the vendor page lede", () => {
  before(async () => {
    server = await startServer();
    await sweepVendorPages();
  });

  after(() => {
    server?.kill();
  });

  it("answers on every vendor page, and states terms a record of that vendor begins with", () => {
    assert.deepStrictEqual(unreachable, [], "vendor pages that published no description");
    assert.ok(
      swept.length > SWEPT_PAGES_VACUITY_GUARD,
      `swept ${swept.length} vendor pages, too few to stand as a site-wide check`,
    );
    const quoted = statedTerms();
    assert.strictEqual(
      quoted.length,
      swept.filter(p => p.branch === "has_free").length,
      "free-tier ledes whose vendor has no record in the index",
    );
    const strangers = quoted.filter(q => q.opening.length < 8).map(q => `${q.route}: ${q.opening}`);
    assert.deepStrictEqual(strangers, [], "ledes sharing almost nothing with their own record");
  });

  it("never ends inside a word", () => {
    const midWord = clippedStatedTerms()
      .filter(q => /[A-Za-z0-9]$/.test(q.opening) && /^[A-Za-z0-9]/.test(q.continues))
      .map(q => `${q.route}: …${q.opening.slice(-40)} | record continues ${q.continues.slice(0, 20)}`);
    assert.deepStrictEqual(midWord, [], "ledes cut inside a word");
  });

  it("marks every lede that stops short of its record, so a clip cannot read as a finished claim", () => {
    const silent = clippedStatedTerms()
      .filter(q => !q.marked)
      .map(q => `${q.route}: …${q.opening.slice(-40)} | record continues ${q.continues.slice(0, 30)}`);
    assert.deepStrictEqual(silent, [], "ledes shorter than their record that do not say so");
  });

  it("never separates a number from its unit", () => {
    const severed = clippedStatedTerms()
      .filter(q => /\d$/.test(q.opening) && /^\s*[A-Za-z]/.test(q.continues))
      .map(q => `${q.route}: …${q.opening.slice(-40)} | record continues ${q.continues.slice(0, 20)}`);
    assert.deepStrictEqual(severed, [], "ledes that end on a figure whose unit follows in the record");
  });

  it("leaves no separator hanging in front of the marker", () => {
    const hanging = clippedStatedTerms()
      .filter(q => /[\s,;:—–-]$/.test(q.opening))
      .map(q => `${q.route}: …${q.opening.slice(-40)}`);
    assert.deepStrictEqual(hanging, [], "ledes whose clip marker follows a separator");
  });

  it("never opens a bracket it does not close", () => {
    const unbalanced = swept
      .filter(p => unclosedBrackets(p.description) > 0)
      .map(p => `${p.route}: ${p.description}`);
    assert.deepStrictEqual(unbalanced, [], "ledes with an unclosed bracket");
  });

  it("repeats a full stop only where its own record does", () => {
    const invented = swept
      .filter(p => p.description.includes(".."))
      .filter(p => ![
        ...(recordsBySlug.get(p.slug) ?? []).map(r => r.description),
        ...(readingsBySlug.get(p.slug) ?? []),
      ].some(stored => stored.includes("..")))
      .map(p => `${p.route}: ${p.description}`);
    assert.deepStrictEqual(invented, [], "ledes whose repeated full stop the render invented");
  });

  it("derives every branch of the description from the one truncation rule", () => {
    const source = readFileSync(path.join(REPO, "src", "serve.ts"), "utf8");
    const rawClips = [...source.matchAll(/publishableTerms\.slice\([^)]*\)/g)].map(m => m[0]);
    assert.deepStrictEqual(rawClips, [], "description branches that clip the stored terms without the shared rule");
    assert.ok(
      source.includes("punctuatedOpeningOfTerms(publishableTerms, 100)"),
      "the free-tier branch no longer takes its opening from the shared rule",
    );
    assert.ok(
      source.includes("openingOfTerms(publishableTerms, 120)"),
      "the verdict no longer takes its opening from the shared rule",
    );
  });

  it("leaves the superseded branch quoting the reading behind its record, verbatim and marked", () => {
    const withheld = swept.filter(p => p.branch === "superseded" && p.quoted !== null);
    assert.ok(withheld.length > 20, `only ${withheld.length} pages withhold superseded terms`);

    const notAPrefix: string[] = [];
    const silent: string[] = [];
    for (const page of withheld) {
      const readings = readingsBySlug.get(page.slug);
      if (!readings) continue;
      const quotation = quotationAgainst(page.route, page.quoted!, readings);
      if (!quotation || quotation.opening.length < 8) {
        notAPrefix.push(`${page.route}: ${page.quoted!.slice(0, 60)}`);
        continue;
      }
      if (quotation.continues !== "" && !quotation.marked) {
        silent.push(`${page.route}: …${quotation.opening.slice(-40)} | reading continues ${quotation.continues.slice(0, 30)}`);
      }
    }
    assert.deepStrictEqual(notAPrefix, [], "withheld pages quoting words the reading behind them does not contain");
    assert.deepStrictEqual(silent, [], "withheld pages quoting less than the reading without saying so");
  });
});

describe("the truncation rule", () => {
  it("returns the terms untouched when they fit", () => {
    assert.strictEqual(openingOfTerms("10 GB storage, zero egress", 60), "10 GB storage, zero egress");
    assert.strictEqual(punctuatedOpeningOfTerms("10 GB storage, zero egress", 60), "10 GB storage, zero egress.");
  });

  it("stops on a word and says that it stopped", () => {
    const terms = "Hobby plan with 100 GB/month Fast Data Transfer, 1M function invocations, 4 hrs Active CPU, 360 GB-hrs Provisioned Memory";
    const opening = openingOfTerms(terms, 100);
    assert.ok(termsWereClipped(opening), opening);
    assert.ok(terms.startsWith(opening.replace(/…$/, "")), opening);
    assert.ok(!/GB-h…$/.test(opening), `the opening severed a unit: ${opening}`);
  });

  it("marks a stop at a sentence boundary too, because a full stop reads as the whole claim", () => {
    const terms = "Edge compute with 100K requests/day, 10ms CPU time per invocation. KV: 1 GB storage, 100K reads/day.";
    const opening = openingOfTerms(terms, 70);
    assert.strictEqual(opening, "Edge compute with 100K requests/day, 10ms CPU time per invocation…");
    assert.ok(termsWereClipped(opening));
  });

  it("does not leave a figure, or the separator after it, without what followed", () => {
    const terms = "Team plan with 25 seats, 100 GB storage, 5000 build minutes and 12 concurrent jobs per account";
    for (let cap = 20; cap <= 90; cap++) {
      const bare = openingOfTerms(terms, cap).replace(/…\)*$/, "");
      assert.ok(!/\d$/.test(bare), `cap ${cap} ended on a figure: ${bare}…`);
      assert.ok(!/[\s,;:—–-]$/.test(bare), `cap ${cap} left a separator in front of the marker: ${bare}…`);
    }
  });

  it("leaves no separator in front of the marker anywhere in the catalogue", () => {
    const hanging: string[] = [];
    for (const offer of offers) {
      for (const cap of [90, 100, 120, 170]) {
        const bare = openingOfTerms(offer.description.trim(), cap).replace(/…\)*$/, "");
        if (/[\s,;:—–-]$/.test(bare)) hanging.push(`${offer.vendor} at ${cap}: …${bare.slice(-40)}`);
      }
    }
    assert.deepStrictEqual(hanging, [], "openings whose clip marker follows a separator");
  });

  it("closes a bracket the clip would have left open, without dropping the terms inside it", () => {
    const terms = "300 credits/month (deploys at 15 credits each, bandwidth at 20 credits/GB, compute at 10 credits/GB-hour, web requests at 2 credits/10K)";
    const opening = openingOfTerms(terms, 100);
    assert.strictEqual(unclosedBrackets(opening), 0, opening);
    assert.ok(termsWereClipped(opening), opening);
    assert.ok(opening.includes("deploys at 15 credits each"), `closing the bracket dropped the terms: ${opening}`);
  });

  it("adds no second full stop to terms that end with one", () => {
    assert.strictEqual(punctuatedOpeningOfTerms("Event gateway — 10K events/month.", 100), "Event gateway — 10K events/month.");
    const clipped = punctuatedOpeningOfTerms("Edge compute with 100K requests/day, 10ms CPU time per invocation. KV: 1 GB storage.", 70);
    assert.ok(!clipped.includes(".."), clipped);
  });

  it("is either the record word for word or an opening that says it is one", () => {
    for (const offer of offers) {
      const terms = offer.description.trim();
      for (const cap of [90, 100, 120, 170]) {
        const opening = openingOfTerms(terms, cap);
        if (opening === terms) continue;
        assert.ok(termsWereClipped(opening), `${offer.vendor} at ${cap}: ${opening}`);
        assert.ok(
          terms.startsWith(opening.replace(/…\)*$/, "")),
          `${offer.vendor} at ${cap} publishes words its record does not: ${opening}`,
        );
      }
    }
  });
});
