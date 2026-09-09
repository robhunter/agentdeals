import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enrichOffers, gateForOffer, getCategories, loadDealChanges, loadOffers } from "../dist/data.js";
import { toSlug } from "../dist/slug.js";
import { SUBTYPE_TAXONOMIES } from "../dist/product-role.js";
import {
  buildProductFunctions,
  functionKey,
  functionMembers,
  splitByFunction,
  type ProductFunction,
} from "../dist/product-function.js";
import { rankOffers, rotateListing, tieBreakSeed } from "../dist/ranking.js";
import { verificationLedger } from "../dist/verification-state.js";
import type { Offer } from "../dist/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers = loadOffers();
const categories = getCategories();
const functions = buildProductFunctions(categories.map(c => c.name));
const serveSource = fs.readFileSync(path.join(REPO, "src", "serve.ts"), "utf8");
const MIN_VENDORS = Number(/const BEST_OF_MIN_VENDORS = (\d+);/.exec(serveSource)?.[1]);
const MIN_PICKS = Number(/const BEST_OF_MIN_PICKS = (\d+);/.exec(serveSource)?.[1]);
const TODAY = new Date().toISOString().slice(0, 10);

function rankedFor(fn: ProductFunction, date: string) {
  return rankOffers(enrichOffers(functionMembers(offers, fn)), {
    queryKey: `best-of:${fn.categories[0] ?? fn.subtypes[0]}`,
    changes: loadDealChanges(),
    date,
    verificationLedger: verificationLedger(),
  });
}

const reaching = functions.filter(fn => functionMembers(offers, fn).filter(o => !o.eligibility).length >= MIN_VENDORS);
const published = reaching.filter(fn => rankedFor(fn, TODAY).qualified.length >= MIN_PICKS);
const withheld = reaching.filter(fn => !published.includes(fn));

function reachesAPage(offer: Offer): boolean {
  return gateForOffer(offer) === null;
}

function startServer(env: NodeJS.ProcessEnv = {}): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

let server: ChildProcess;
let port = 0;

before(async () => { ({ child: server, port } = await startServer()); });
after(() => { server?.kill(); });

async function page(pathname: string, atPort = port): Promise<{ status: number; html: string }> {
  const res = await fetch(`http://localhost:${atPort}${pathname}`, { redirect: "error" });
  return { status: res.status, html: await res.text() };
}

const unescapeForTest = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function vendorsListed(html: string): string[] {
  return [...html.matchAll(/class="best-pick-name">([^<]*)</g)].map(m => unescapeForTest(m[1]));
}

function groupBlocks(html: string): { subtype: string; body: string }[] {
  const blocks: { subtype: string; body: string }[] = [];
  const headings = [...html.matchAll(/<h2 class="function-group-heading" id="function-([a-z0-9-]+)">/g)];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index!;
    const end = i + 1 < headings.length ? headings[i + 1].index! : html.indexOf("<h2>Demoted", start);
    blocks.push({ subtype: headings[i][1], body: html.slice(start, end) });
  }
  return blocks;
}

const escapeForTest = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

describe("a page named after a product function draws on both encodings of it", () => {
  it("the thresholds this sweep uses are the ones the site publishes with", () => {
    assert.ok(Number.isInteger(MIN_VENDORS) && MIN_VENDORS > 0, "src/serve.ts must state a record minimum these sweeps can read");
    assert.ok(Number.isInteger(MIN_PICKS) && MIN_PICKS > 1, "src/serve.ts must state a pick minimum above one");
    assert.ok(published.length > categories.length - 20, `only ${published.length} functions clear both thresholds`);
  });

  it("lists Sentry on the error tracking page, quoting the page the label was read from", async () => {
    const sentry = offers.find(o => o.vendor === "Sentry");
    assert.ok(sentry, "the catalogue holds no Sentry record, so this test asserts nothing");
    assert.notStrictEqual(sentry!.category, "Error Tracking", "Sentry is filed under Error Tracking, so nothing here is under test");
    const label = sentry!.product_subtypes?.labels.find(l => l.subtype === "error_tracking");
    assert.ok(label, "Sentry carries no error_tracking label, so nothing here is under test");

    const { status, html } = await page("/best/free-error-tracking");
    assert.strictEqual(status, 200);
    assert.ok(vendorsListed(html).includes("Sentry"), "/best/free-error-tracking does not list Sentry");
    assert.ok(html.includes(escapeForTest(label!.source_quote)), "Sentry is listed without the words we read the label from");
    assert.ok(html.includes(`href="${label!.source_url}"`), "Sentry is listed without a link to the page the label was read from");
    assert.ok(html.includes(escapeForTest(sentry!.product_subtypes!.reviewed)), "Sentry is listed without the date the label was read");
    assert.match(html, /on this page because we labelled it/, "the page does not say why a record filed elsewhere is present");
    assert.ok(html.includes(`href="/category/${toSlug(sentry!.category)}"`), "the page does not name the category Sentry is filed under");
  });

  it("no function page leaves out a record we labelled with its function", async () => {
    const missing: string[] = [];
    for (const fn of published) {
      if (fn.subtypes.length === 0) continue;
      const { html } = await page(`/best/free-${fn.slug}`);
      const listed = new Set(vendorsListed(html));
      for (const offer of offers) {
        if (!(offer.product_subtypes?.labels ?? []).some(l => fn.subtypes.includes(l.subtype))) continue;
        if (!reachesAPage(offer)) continue;
        if (!listed.has(offer.vendor)) missing.push(`${offer.vendor} (${offer.category}) is labelled for /best/free-${fn.slug} and is not on it`);
      }
    }
    assert.deepStrictEqual(missing, []);
  });

  it("keeps every record its category already reached on the page", async () => {
    const dropped: string[] = [];
    for (const fn of published) {
      if (fn.categories.length === 0) continue;
      const { html } = await page(`/best/free-${fn.slug}`);
      const listed = new Set(vendorsListed(html));
      for (const offer of offers) {
        if (!fn.categories.includes(offer.category)) continue;
        if (!reachesAPage(offer)) continue;
        if (!listed.has(offer.vendor)) dropped.push(`${offer.vendor} is filed under ${offer.category} and is absent from /best/free-${fn.slug}`);
      }
    }
    assert.deepStrictEqual(dropped, []);
  });

  it("carries no record that neither encoding admits", async () => {
    const strangers: string[] = [];
    for (const fn of published) {
      const { html } = await page(`/best/free-${fn.slug}`);
      const admitted = new Set(functionMembers(offers, fn).map(o => o.vendor));
      for (const vendor of new Set(vendorsListed(html))) {
        if (!admitted.has(vendor)) strangers.push(`${vendor} is on /best/free-${fn.slug} and neither its category nor a label puts it there`);
      }
    }
    assert.deepStrictEqual(strangers, []);
  });
});

describe("two names are the same function only when they name the same thing", () => {
  it("merges a category and a subtype that differ only by a plural", () => {
    const errorTracking = functions.find(f => f.slug === "error-tracking");
    assert.ok(errorTracking, "no function is named error-tracking");
    assert.deepStrictEqual(errorTracking!.categories, ["Error Tracking"]);
    assert.deepStrictEqual(errorTracking!.subtypes, ["error_tracking"]);

    const statusPages = functions.find(f => f.slug === "status-pages");
    assert.ok(statusPages, "no function is named status-pages");
    assert.deepStrictEqual(statusPages!.categories, ["Status Pages"]);
    assert.deepStrictEqual(statusPages!.subtypes, ["status_page"]);
  });

  it("refuses the three substring overlaps that are not the same function", () => {
    const notMerged: [string, string][] = [
      ["container_app", "Container Registry"],
      ["host_metrics", "Cloud Hosting"],
      ["document", "Documentation"],
    ];
    for (const [subtype, category] of notMerged) {
      assert.notStrictEqual(functionKey(toSlug(subtype)), functionKey(toSlug(category)), `${subtype} and ${category} resolve to one function`);
      const fn = functions.find(f => f.subtypes.includes(subtype));
      assert.ok(fn, `${subtype} names no function`);
      assert.ok(!fn!.categories.includes(category), `${subtype} was folded into ${category}`);
    }
  });

  it("gives every function slug one owner", () => {
    const seen = new Map<string, ProductFunction>();
    for (const fn of functions) {
      assert.ok(!seen.has(fn.slug), `two functions publish /best/free-${fn.slug}`);
      seen.set(fn.slug, fn);
    }
  });

  it("never folds two published categories onto one URL", () => {
    for (const fn of functions) {
      assert.ok(fn.categories.length <= 1, `/best/free-${fn.slug} would serve both ${fn.categories.join(" and ")}`);
    }
    const withPages = published.filter(fn => fn.categories.length === 1).map(fn => fn.categories[0]);
    assert.strictEqual(new Set(withPages).size, withPages.length, "a category lost its own best-of URL");
  });
});

describe("every function with enough vendors to compare has a page", () => {
  it("publishes one for every subtype whose list would hold more than one pick, and no others", async () => {
    const bySubtype = new Map<string, Offer[]>();
    for (const offer of offers) {
      for (const label of offer.product_subtypes?.labels ?? []) {
        const held = bySubtype.get(label.subtype);
        if (held) held.push(offer);
        else bySubtype.set(label.subtype, [offer]);
      }
    }
    const owed = [...bySubtype.entries()].filter(([, list]) => list.filter(o => !o.eligibility).length >= MIN_VENDORS);
    assert.ok(owed.length >= 20, `only ${owed.length} subtypes clear the record threshold, so this sweep is not measuring the backlog`);
    let served = 0;
    let withheldHere = 0;
    for (const [subtype] of owed) {
      const fn = functions.find(f => f.subtypes.includes(subtype));
      assert.ok(fn, `${subtype} names no function`);
      const picks = rankedFor(fn!, TODAY).qualified.length;
      const { status } = await page(`/best/free-${fn!.slug}`);
      if (picks >= MIN_PICKS) {
        served++;
        assert.strictEqual(status, 200, `/best/free-${fn!.slug} answers ${status} for a subtype with ${picks} picks`);
      } else {
        withheldHere++;
        assert.notStrictEqual(status, 200, `/best/free-${fn!.slug} answers 200 while publishing ${picks} pick`);
      }
    }
    assert.ok(served >= 15, `only ${served} subtype pages are served, so this sweep is not measuring the namespace`);
    assert.ok(withheldHere >= 1, "no subtype falls under the pick threshold, so the negative half of this sweep is vacuous");
  });

  it("puts every one of them in the sitemap and on the index, and no withheld page in either", async () => {
    const map = await page("/sitemap-pages.xml");
    const index = await page("/best");
    for (const fn of published) {
      assert.ok(map.html.includes(`/best/${`free-${fn.slug}`}<`), `/best/free-${fn.slug} is in no sitemap`);
      assert.ok(index.html.includes(`href="/best/free-${fn.slug}"`), `/best/free-${fn.slug} is unreachable from /best`);
    }
    for (const fn of withheld) {
      assert.ok(!map.html.includes(`/best/${`free-${fn.slug}`}<`), `/best/free-${fn.slug} is withheld and still in the sitemap`);
      assert.ok(!index.html.includes(`href="/best/free-${fn.slug}"`), `/best/free-${fn.slug} is withheld and still linked from /best`);
    }
  });

  it("states, for every record a label put there, the URL and the date it was read from", async () => {
    for (const fn of published.filter(f => f.categories.length === 0)) {
      const { html } = await page(`/best/free-${fn.slug}`);
      const blocks = [...html.matchAll(/<div class="best-pick">[\s\S]*?<\/div>\s*<\/div>/g)].map(m => m[0]);
      assert.ok(blocks.length > 0, `/best/free-${fn.slug} renders no cards`);
      for (const block of blocks) {
        const vendor = /class="best-pick-name">([^<]*)</.exec(block)?.[1];
        const offer = offers.find(o => o.vendor === vendor);
        if (!offer) continue;
        const label = (offer.product_subtypes?.labels ?? []).find(l => fn.subtypes.includes(l.subtype));
        if (!label) continue;
        assert.ok(block.includes(`href="${label.source_url}"`), `${vendor} on /best/free-${fn.slug} cites no source URL for its label`);
        assert.ok(block.includes(escapeForTest(offer.product_subtypes!.reviewed)), `${vendor} on /best/free-${fn.slug} states no date for its label`);
        assert.ok(block.includes(escapeForTest(label.source_quote)), `${vendor} on /best/free-${fn.slug} states no words read from the page`);
      }
    }
  });
});

describe("a page whose members span several functions separates them", () => {
  it("stops asserting that a whole mixed category is one set of alternatives", async () => {
    const { html } = await page("/best/free-monitoring");
    const tieNote = /<div class="tie-note">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    assert.ok(tieNote.length > 0, "/best/free-monitoring states no scope at all");
    assert.ok(
      !/none is distinguishable from the others under any signal we record/.test(tieNote),
      "/best/free-monitoring still asserts its whole membership is indistinguishable",
    );
    assert.match(tieNote, /not all alternatives to one another/);
  });

  it("puts each record under every function it is labelled with, and under nothing else", async () => {
    let split = 0;
    for (const fn of published) {
      const { html } = await page(`/best/free-${fn.slug}`);
      const date = /<dt>date<\/dt><dd>([^<]+)<\/dd>/.exec(html)![1];
      const qualified = rankedFor(fn, date).qualified.map(e => e.offer);
      const groups = splitByFunction(qualified, fn);
      const blocks = groupBlocks(html);
      if (!groups) {
        assert.strictEqual(blocks.length, 0, `/best/free-${fn.slug} splits by function and should not`);
        continue;
      }
      split++;
      assert.strictEqual(blocks.length, groups.length, `/best/free-${fn.slug} spans ${groups.length} functions and renders ${blocks.length} sections`);
      for (const block of blocks) {
        const subtype = SUBTYPE_TAXONOMIES[fn.categories[0]]?.find(t => toSlug(t.subtype) === block.subtype)?.subtype;
        if (!subtype) continue;
        const carrying = new Set(qualified.filter(o => (o.product_subtypes?.labels ?? []).some(l => l.subtype === subtype)).map(o => o.vendor));
        assert.deepStrictEqual(
          [...new Set(vendorsListed(block.body))].sort(),
          [...carrying].sort(),
          `the ${subtype} section of /best/free-${fn.slug} is not the set of records carrying that label`,
        );
      }
    }
    assert.ok(split >= 4, `only ${split} pages span more than one labelled function, so this sweep is not measuring the split`);
  });

  it("makes the equivalence claim inside a group rather than over the page", async () => {
    const { html } = await page("/best/free-monitoring");
    for (const block of groupBlocks(html)) {
      const scope = /<p class="function-group-scope">([\s\S]*?)<\/p>/.exec(block.body)?.[1] ?? "";
      const cards = vendorsListed(block.body).length;
      if (cards > 1 && /labelled <code>/.test(scope)) {
        assert.match(scope, /None is distinguishable from the others in this group/, `the ${block.subtype} group makes no scoped equivalence claim`);
      }
      if (cards === 1) {
        assert.ok(!/None is distinguishable/.test(scope), `the ${block.subtype} group claims an equivalence over one offer`);
      }
    }
  });

  it("lists a record that carries no label rather than dropping it", async () => {
    let checked = 0;
    for (const fn of published) {
      const unlabelled = functionMembers(offers, fn).filter(o => (o.product_subtypes?.labels ?? []).length === 0 && reachesAPage(o));
      if (unlabelled.length === 0) continue;
      const { html } = await page(`/best/free-${fn.slug}`);
      const listed = new Set(vendorsListed(html));
      for (const offer of unlabelled) {
        checked++;
        assert.ok(listed.has(offer.vendor), `${offer.vendor} carries no label and is absent from /best/free-${fn.slug}`);
      }
    }
    assert.ok(checked > 50, `only ${checked} unlabelled records were reachable, so this sweep is not measuring the guarantee`);
  });
});

describe("grouping is not a ranking", () => {
  it("orders the groups by the published seed and nothing else", async () => {
    const { html } = await page("/best/free-monitoring");
    const date = /<dt>date<\/dt><dd>([^<]+)<\/dd>/.exec(html)?.[1];
    const queryKey = /<dt>query_key<\/dt><dd>([^<]+)<\/dd>/.exec(html)?.[1];
    assert.ok(date && queryKey, "/best/free-monitoring publishes no seed inputs");
    const fn = functions.find(f => f.slug === "monitoring")!;
    const groups = splitByFunction(rankedFor(fn, date!).qualified.map(e => e.offer), fn)!;
    const expected = rotateListing(groups.filter(g => g.subtype), queryKey!, date!)
      .map(g => toSlug(g.subtype!))
      .concat(groups.filter(g => !g.subtype).map(g => toSlug(g.residue!)));
    assert.deepStrictEqual(groupBlocks(html).map(b => b.subtype), expected);
    assert.ok(tieBreakSeed(date!, queryKey!, 0).length > 0);
  });

  it("keeps the demote-only policy and adds no top slot", async () => {
    for (const slug of ["free-monitoring", "free-uptime-check", "free-error-tracking"]) {
      const { html } = await page(`/best/${slug}`);
      assert.match(html, /Rankings start every offer at zero and can only demote/, `/best/${slug} drops the demote-only policy`);
      assert.match(html, /There is no top slot here to sell/, `/best/${slug} drops the no-top-slot statement`);
      assert.ok(!/\bbest pick\b|\bwinner\b|\bnumber one\b|\btop pick\b/i.test(html), `/best/${slug} crowns an entry`);
    }
  });

  it("moves no offer between the qualified and demoted bands", async () => {
    const { html } = await page("/best/free-monitoring");
    const demotedAt = html.indexOf("<h2>Demoted");
    const qualified = new Set(vendorsListed(html.slice(0, demotedAt)));
    const flat = await page("/best/free-status-pages");
    assert.ok(qualified.size > 0 && vendorsListed(flat.html).length > 0);
    const demoted = vendorsListed(html.slice(demotedAt));
    for (const vendor of demoted) {
      assert.ok(!qualified.has(vendor), `${vendor} is rendered both qualified and demoted on /best/free-monitoring`);
    }
  });
});

describe("membership is derived from the record, not written down per page", () => {
  const perturbed = path.join(os.tmpdir(), `catalogue-relabelled-${process.pid}.json`);
  let child: ChildProcess;
  let relabelledPort = 0;
  let movedIn: Offer | undefined;

  before(async () => {
    const rewritten = offers.map(o =>
      o.vendor === "Sentry" && o.product_subtypes
        ? { ...o, product_subtypes: { ...o.product_subtypes, labels: o.product_subtypes.labels.filter(l => l.subtype !== "error_tracking") } }
        : o,
    );
    movedIn = rewritten.find(o => o.category === "Databases" && (o.product_subtypes?.labels ?? []).length > 0 && !o.eligibility);
    assert.ok(movedIn, "no Databases record carries a label, so this test cannot move one");
    const withNewLabel = rewritten.map(o =>
      o === movedIn
        ? { ...o, product_subtypes: { ...o.product_subtypes!, labels: [...o.product_subtypes!.labels, { subtype: "error_tracking", source_url: o.url, source_quote: "moved for this test" }] } }
        : o,
    );
    fs.writeFileSync(perturbed, JSON.stringify({ offers: withNewLabel }));
    ({ child, port: relabelledPort } = await startServer({ AGENTDEALS_INDEX_PATH: perturbed }));
  });

  after(() => {
    child?.kill();
    fs.rmSync(perturbed, { force: true });
  });

  it("withdraws a record from the page when its label is removed", async () => {
    const { html } = await page("/best/free-error-tracking", relabelledPort);
    assert.ok(!vendorsListed(html).includes("Sentry"), "Sentry survives on /best/free-error-tracking with no error_tracking label");
  });

  it("publishes a record on the page when a label is added, whatever its category", async () => {
    const { html } = await page("/best/free-error-tracking", relabelledPort);
    assert.ok(vendorsListed(html).includes(movedIn!.vendor), `${movedIn!.vendor} carries an error_tracking label and is not on the page`);
    assert.ok(html.includes("moved for this test"), "the page does not quote the added label's source");
  });

  it("publishes a whole page for a label that reaches the threshold, and withdraws it when it does not", async () => {
    const live = await page("/best/free-uptime-check");
    assert.strictEqual(live.status, 200);
    const stripped = path.join(os.tmpdir(), `catalogue-unlabelled-${process.pid}.json`);
    fs.writeFileSync(stripped, JSON.stringify({
      offers: offers.map(o => o.product_subtypes ? { ...o, product_subtypes: { ...o.product_subtypes, labels: o.product_subtypes.labels.filter(l => l.subtype !== "uptime_check") } } : o),
    }));
    const { child: withoutLabel, port: strippedPort } = await startServer({ AGENTDEALS_INDEX_PATH: stripped });
    try {
      const gone = await page("/best/free-uptime-check", strippedPort).catch(() => ({ status: 0, html: "" }));
      assert.notStrictEqual(gone.status, 200, "/best/free-uptime-check still answers 200 with no record carrying the label");
    } finally {
      withoutLabel.kill();
      fs.rmSync(stripped, { force: true });
    }
  });
});
