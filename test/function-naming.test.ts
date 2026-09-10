import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enrichOffers, gateForOffer, getCategories, loadDealChanges, loadOffers } from "../dist/data.js";
import {
  SUBTYPE_TAXONOMIES,
  CROSS_TAXONOMY_RULINGS,
  crossTaxonomyCandidates,
  crossTaxonomyRulingFor,
  canonicalEntryFor,
  governingDefinition,
  type SubtypeTaxonomyEntry,
} from "../dist/product-role.js";
import {
  buildProductFunctions,
  functionMembers,
  functionDefinitions,
  functionMeaningSentence,
  type ProductFunction,
} from "../dist/product-function.js";
import { rankOffers } from "../dist/ranking.js";
import { verificationLedger } from "../dist/verification-state.js";
import { assertSharesPopulation, categoriesInTheCatalogue } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers = loadOffers();
const categories = getCategories();
const functions = buildProductFunctions(categories.map(c => c.name));
const serveSource = fs.readFileSync(path.join(REPO, "src", "serve.ts"), "utf8");
const MIN_VENDORS = Number(/const BEST_OF_MIN_VENDORS = (\d+);/.exec(serveSource)?.[1]);
const MIN_PICKS = Number(/const BEST_OF_MIN_PICKS = (\d+);/.exec(serveSource)?.[1]);
const TODAY = new Date().toISOString().slice(0, 10);

function picksFor(fn: ProductFunction, date = TODAY): number {
  return rankOffers(enrichOffers(functionMembers(offers, fn)), {
    queryKey: `best-of:${fn.categories[0] ?? fn.subtypes[0]}`,
    changes: loadDealChanges(),
    date,
    verificationLedger: verificationLedger(),
  }).qualified.length;
}

const reaching = functions.filter(fn => functionMembers(offers, fn).filter(o => !o.eligibility).length >= MIN_VENDORS);
const published = reaching.filter(fn => picksFor(fn) >= MIN_PICKS);

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

async function page(pathname: string): Promise<{ status: number; html: string }> {
  const res = await fetch(`http://localhost:${port}${pathname}`, { redirect: "error" });
  return { status: res.status, html: await res.text() };
}

const unescapeForTest = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function vendorsListed(html: string): string[] {
  return [...html.matchAll(/class="best-pick-name">([^<]*)</g)].map(m => unescapeForTest(m[1]));
}

function refName(ref: { taxonomy: string; subtype: string }): string {
  return `${ref.taxonomy}/${ref.subtype}`;
}

describe("one function carries one name, whichever parent declared it", () => {
  it("resolves the two labels for similarity search to a single function", () => {
    const carrying = functions.filter(fn => fn.subtypes.includes("vector") || fn.subtypes.includes("vector_store"));
    assert.strictEqual(carrying.length, 1, `${carrying.length} functions carry a similarity-search label`);
    assert.deepStrictEqual([...carrying[0].subtypes].sort(), ["vector", "vector_store"]);
    assert.deepStrictEqual([...carrying[0].taxonomies].sort(), ["AI / ML", "Databases"]);
    assert.strictEqual(carrying[0].slug, "vector");
  });

  it("lists the records both parents filed on the page named after that function", async () => {
    const fn = functions.find(f => f.slug === "vector")!;
    const { status, html } = await page("/best/free-vector");
    assert.strictEqual(status, 200);
    const listed = new Set(vendorsListed(html));

    const bothParents = offers.filter(o => (o.product_subtypes?.labels ?? []).some(l => l.subtype === "vector" || l.subtype === "vector_store"));
    assert.ok(bothParents.some(o => o.category === "AI / ML"), "no record carries the label under the AI / ML parent");
    assert.ok(bothParents.some(o => o.category === "Databases"), "no record carries the label under the Databases parent");

    for (const vendor of ["Pinecone", "Qdrant", "Weaviate", "Chroma"]) {
      const offer = offers.find(o => o.vendor === vendor);
      assert.ok(offer, `the catalogue holds no ${vendor} record, so this test asserts nothing`);
      assert.strictEqual(gateForOffer(offer!), null, `${vendor} is gated, so its absence would not be about naming`);
      assert.ok(listed.has(vendor), `${vendor} carries a similarity-search label and is absent from /best/free-vector`);
    }

    const absent = bothParents.filter(o => !listed.has(o.vendor));
    for (const offer of absent) {
      assert.notStrictEqual(gateForOffer(offer), null, `${offer.vendor} is ungated and absent from /best/free-vector`);
    }
    assert.ok(
      absent.some(o => (o.product_subtypes?.labels ?? []).some(l => l.subtype === "vector")),
      "every record the free-tier gate withholds here carries the AI / ML label, so the gate and the merge are not separable",
    );
    assert.deepStrictEqual(functionMembers(offers, fn).length, bothParents.length);
  });

  it("rules on every pair the taxonomies flag across parents, and flags every pair it rules on", () => {
    const candidates = crossTaxonomyCandidates();
    assert.ok(candidates.length >= 3, `only ${candidates.length} cross-parent candidates, so this sweep is not reading the taxonomy`);
    const unruled = candidates.filter(c => crossTaxonomyRulingFor(c.a, c.b) === null);
    assert.deepStrictEqual(unruled.map(c => `${refName(c.a)} <> ${refName(c.b)}`), []);

    for (const ruling of CROSS_TAXONOMY_RULINGS) {
      const flagged = candidates.some(c => crossTaxonomyRulingFor(c.a, c.b) === ruling);
      assert.ok(flagged, `${refName(ruling.a)} <> ${refName(ruling.b)} is ruled on and the taxonomies no longer bring it up`);
      assert.ok(ruling.reason.length > 0, `${refName(ruling.a)} <> ${refName(ruling.b)} states no reason`);
      if (ruling.same) assert.ok(ruling.canonical, `${refName(ruling.a)} <> ${refName(ruling.b)} is one function and names no governing entry`);
    }
    assert.ok(CROSS_TAXONOMY_RULINGS.some(r => r.same), "no pair is ruled one function, so the register proves nothing");
    assert.ok(CROSS_TAXONOMY_RULINGS.some(r => !r.same), "no pair is ruled two functions, so the register never refuses a merge");
  });

  it("goes red on a label duplicated under another parent that nobody has ruled on", () => {
    const seeded: Record<string, SubtypeTaxonomyEntry[]> = {
      ...SUBTYPE_TAXONOMIES,
      Monitoring: [
        ...SUBTYPE_TAXONOMIES.Monitoring,
        { subtype: "uptime_probe", definition: SUBTYPE_TAXONOMIES["Cloud Hosting"][0].definition },
      ],
    };
    const candidates = crossTaxonomyCandidates(seeded);
    const seededPair = candidates.find(c => c.a.subtype === "uptime_probe" || c.b.subtype === "uptime_probe");
    assert.ok(seededPair, "a definition copied verbatim under another parent is not flagged as a candidate");
    assert.strictEqual(crossTaxonomyRulingFor(seededPair!.a, seededPair!.b), null);
    const unruled = candidates.filter(c => crossTaxonomyRulingFor(c.a, c.b) === null);
    assert.strictEqual(unruled.length, 1, "the seed is the only unruled pair, so the completeness check is what went red");
  });

  it("gives a merged function one governing definition rather than one per parent", () => {
    const fn = functions.find(f => f.slug === "vector")!;
    assert.strictEqual(functionDefinitions(fn).length, 1, "the merged function publishes more than one definition of itself");
    assert.strictEqual(functionDefinitions(fn)[0], governingDefinition("AI / ML", "vector_store"));
    assert.strictEqual(canonicalEntryFor({ taxonomy: "AI / ML", subtype: "vector_store" }).subtype, "vector");
  });

  it("keeps the substring overlaps that are not one function apart", () => {
    const ruling = crossTaxonomyRulingFor({ taxonomy: "Databases", subtype: "document" }, { taxonomy: "AI / ML", subtype: "document_extraction" });
    assert.ok(ruling, "the document pair is not ruled on");
    assert.strictEqual(ruling!.same, false);
    const documents = functions.find(f => f.subtypes.includes("document"))!;
    assert.ok(!documents.subtypes.includes("document_extraction"), "document extraction was folded into the document database function");
  });
});

describe("a function page's sentences do not constrain the wording of a definition", () => {
  const VERB_PHRASE = SUBTYPE_TAXONOMIES.Monitoring[0].definition;
  const NOUN_PHRASE = SUBTYPE_TAXONOMIES.Databases[0].definition;
  const ADDRESSED_TO_READER = SUBTYPE_TAXONOMIES["Cloud Hosting"][2].definition;

  function definitionStartsAClause(sentence: string, definition: string): boolean {
    const at = sentence.indexOf(definition);
    if (at < 0) return false;
    return /[:;—]$/.test(sentence.slice(0, at).trimEnd());
  }

  it("composes the same way for a verb phrase, a noun phrase and a phrase addressed to the reader", () => {
    for (const definition of [VERB_PHRASE, NOUN_PHRASE, ADDRESSED_TO_READER]) {
      const sentence = functionMeaningSentence([definition]);
      assert.ok(definitionStartsAClause(sentence, definition), `a definition is spliced mid-clause: ${sentence}`);
      assert.ok(sentence.endsWith("."), `the sentence does not end: ${sentence}`);
    }
  });

  it("rejects the shape that reads correctly only for a verb phrase", () => {
    assert.ok(definitionStartsAClause(`We list a product here when it ${VERB_PHRASE}.`, VERB_PHRASE) === false);
    assert.ok(definitionStartsAClause(`We list a product here when it ${NOUN_PHRASE}.`, NOUN_PHRASE) === false);
    assert.ok(definitionStartsAClause(functionMeaningSentence([NOUN_PHRASE]), NOUN_PHRASE));
  });

  it("places every definition it publishes at a clause boundary, in the description and the structured data", async () => {
    let checked = 0;
    for (const fn of published.filter(f => f.categories.length === 0)) {
      const { html } = await page(`/best/free-${fn.slug}`);
      const meta = unescapeForTest(/<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "");
      const jsonLd = JSON.parse(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema.org","@type":"ItemList".*?)<\/script>/.exec(html)?.[1] ?? "{}");
      const pageMeta = unescapeForTest(/<p class="page-meta">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "");
      for (const definition of functionDefinitions(fn)) {
        checked++;
        for (const [where, text] of [["meta description", meta], ["ItemList description", String(jsonLd.description ?? "")], ["page heading", pageMeta]] as const) {
          assert.ok(definitionStartsAClause(text, definition), `/best/free-${fn.slug} splices its definition mid-clause in the ${where}: ${text}`);
        }
      }
    }
    assert.ok(checked >= 15, `only ${checked} definitions were published, so this sweep is not measuring the namespace`);
  });

  it("counts offers in the number it uses for them", async () => {
    for (const fn of published) {
      const { html } = await page(`/best/free-${fn.slug}`);
      const meta = unescapeForTest(/<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "");
      const counted = [...meta.matchAll(/(\d+) (offers?)(?: (meets?|is|are))?/g)];
      assert.ok(counted.length >= 2, `/best/free-${fn.slug} counts nothing in its description: ${meta}`);
      for (const [, count, noun, verb] of counted) {
        const plural = Number(count) !== 1;
        assert.strictEqual(noun, plural ? "offers" : "offer", `/best/free-${fn.slug} writes "${count} ${noun}"`);
        if (!verb) continue;
        const agrees = plural ? ["meet", "are"] : ["meets", "is"];
        assert.ok(agrees.includes(verb), `/best/free-${fn.slug} writes "${count} ${noun} ${verb}"`);
      }
    }
  });
});

describe("a page's title names a class of product", () => {
  const generic = new Set(["best", "free", "tools", "and", "&"]);
  const contentTokens = (title: string) =>
    title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 0 && !generic.has(w));

  it("never titles a subtype page with the attribute alone", () => {
    const bare = published.filter(fn => fn.categories.length === 0 && contentTokens(fn.title).length < 2);
    assert.deepStrictEqual(bare.map(fn => `/best/free-${fn.slug} is titled "${fn.title}"`), []);
    assert.ok(published.some(fn => fn.categories.length === 0), "no subtype page is published, so this sweep asserts nothing");
  });

  it("takes a declared name from the noun its parent category supplies", () => {
    let declared = 0;
    for (const [taxonomy, entries] of Object.entries(SUBTYPE_TAXONOMIES)) {
      for (const entry of entries) {
        if (!entry.name) continue;
        declared++;
        const head = entry.name.split(" ").at(-1)!.toLowerCase();
        assert.ok(
          taxonomy.toLowerCase().split(/[^a-z]+/).includes(head),
          `${taxonomy}/${entry.subtype} is named "${entry.name}" and ${head} is not a noun its parent supplies`,
        );
        const fn = functions.find(f => f.subtypes.includes(entry.subtype) && f.categories.length === 0);
        if (fn) assert.strictEqual(fn.listNoun, entry.name, `/best/free-${fn.slug} does not publish the name declared for it`);
      }
    }
    assert.ok(declared >= 3, `only ${declared} names are declared, so this sweep is not reading the taxonomy`);
  });

  it("does not title a page with a word our own catalogue uses for a different kind of product", async () => {
    const fn = published.find(f => f.slug === "vector")!;
    const memberCategories = new Set(functionMembers(offers, fn).map(o => o.category));
    const otherSense = offers.filter(o => !memberCategories.has(o.category) && /\bvector\b/i.test(`${o.vendor} ${o.description ?? ""}`));
    assert.ok(otherSense.length >= 2, "the catalogue holds no other sense of the word, so this test asserts nothing");
    assert.ok(
      otherSense.some(o => /design/i.test(o.category)),
      "no design product uses the word, so the two senses this title has to separate are not both in the catalogue",
    );
    const { html } = await page("/best/free-vector");
    const heading = /<h1>([^<]*)<\/h1>/.exec(html)?.[1] ?? "";
    assert.ok(!/^Best Free Vector Tools?$/.test(heading), `/best/free-vector is titled "${heading}"`);
    const distinguishing = contentTokens(heading).filter(t => t !== "vector");
    assert.ok(distinguishing.length > 0, `/best/free-vector's title adds nothing to the bare attribute: ${heading}`);
    for (const other of otherSense) {
      const text = `${other.vendor} ${other.category} ${other.description ?? ""}`.toLowerCase();
      assert.ok(
        distinguishing.some(token => !text.includes(token)),
        `${other.vendor} would answer to "${heading}" as readily as the products on the page`,
      );
    }
  });

  it("publishes no two titles distinguishable only by a word that does not distinguish their contents", async () => {
    const index = await page("/best");
    assert.strictEqual(index.status, 200);
    const titles = published.map(fn => ({ slug: fn.slug, tokens: contentTokens(fn.title) }));
    const collisions: string[] = [];
    for (let i = 0; i < titles.length; i++) {
      for (let j = i + 1; j < titles.length; j++) {
        const a = titles[i];
        const b = titles[j];
        if (a.tokens.length !== b.tokens.length) continue;
        const differing = a.tokens.filter((t, k) => t !== b.tokens[k]);
        if (differing.length !== 1) continue;
        const k = a.tokens.findIndex((t, n) => t !== b.tokens[n]);
        if (a.tokens[k].startsWith(b.tokens[k]) || b.tokens[k].startsWith(a.tokens[k])) {
          collisions.push(`/best/free-${a.slug} and /best/free-${b.slug}`);
        }
      }
    }
    assert.deepStrictEqual(collisions, []);
  });

  it("leaves every category-named page titled after its category", async () => {
    const named = published.filter(fn => fn.categories.length > 0);
    assertSharesPopulation(named.length, categoriesInTheCatalogue(), 0.6, "categories publishing a page titled after them");
    for (const fn of named) {
      assert.strictEqual(fn.title, fn.categories[0]);
      assert.strictEqual(fn.listNoun, `${fn.categories[0]} Tools`);
      const { status, html } = await page(`/best/free-${fn.slug}`);
      assert.strictEqual(status, 200, `/best/free-${fn.slug} answers ${status}`);
      assert.ok(html.includes(`<h1>Best Free ${fn.categories[0].replace(/&/g, "&amp;")} Tools</h1>`), `/best/free-${fn.slug} lost its category title`);
    }
  });
});

describe("a page named after a class publishes more than one of them", () => {
  it("serves no page whose list holds a single pick", async () => {
    let checked = 0;
    for (const fn of published) {
      const { status, html } = await page(`/best/free-${fn.slug}`);
      assert.strictEqual(status, 200, `/best/free-${fn.slug} answers ${status}`);
      const demotedAt = html.indexOf("<h2>Demoted");
      const picks = vendorsListed(html.slice(0, demotedAt)).length;
      assert.ok(picks >= MIN_PICKS, `/best/free-${fn.slug} publishes ${picks} pick`);
      checked++;
    }
    assert.ok(checked >= 70, `only ${checked} pages were read, so this sweep is not measuring the namespace`);
  });

  it("withholds the URL from a function that reaches the record threshold and would publish one", async () => {
    const withheld = reaching.filter(fn => picksFor(fn) < MIN_PICKS);
    assert.ok(withheld.length > 0, "no function is withheld today, so this test asserts nothing");
    const map = await page("/sitemap-pages.xml");
    for (const fn of withheld) {
      const reachable = functionMembers(offers, fn).filter(o => !o.eligibility).length;
      assert.ok(reachable >= MIN_VENDORS, `${fn.slug} does not reach the record threshold, so it is not the case under test`);
      const { status } = await page(`/best/free-${fn.slug}`);
      assert.strictEqual(status, 404, `/best/free-${fn.slug} answers ${status} while publishing ${picksFor(fn)} pick`);
      assert.ok(!map.html.includes(`/best/free-${fn.slug}<`), `/best/free-${fn.slug} answers 404 and is in the sitemap`);
    }
  });

  it("states on the published method why a function with enough records can still have no page", async () => {
    const { status, html } = await page("/criteria");
    assert.strictEqual(status, 200);
    assert.match(html, /the threshold counts what the page shows rather than what it could reach/);
    assert.match(html, /whose list would publish fewer than 2 today/);
  });

  it("keeps the demoted band on the pages it still serves", async () => {
    const { html } = await page("/best/free-vector");
    assert.match(html, /Rankings start every offer at zero and can only demote/);
    assert.match(html, /There is no top slot here to sell/);
    assert.ok(!/\bbest pick\b|\bwinner\b|\bnumber one\b|\btop pick\b/i.test(html), "/best/free-vector crowns an entry");
  });
});
