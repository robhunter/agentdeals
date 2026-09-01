import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  curatedAlternativeNames,
  resolveCuratedAlternatives,
  curatedAlternativesFor,
  addCuratedToPool,
  unmatchedCuratedNames,
} from "../dist/curated-alternatives.js";
import { partitionAlternativesAcross } from "../dist/product-role.js";
import type { DealChange, Offer } from "../src/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const changes: DealChange[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;

function offerFixture(vendor: string, category: string, extra: Partial<Offer> = {}): Offer {
  return {
    vendor,
    category,
    description: `${vendor} description`,
    tier: "Free",
    url: `https://example.com/${vendor.toLowerCase()}`,
    tags: [],
    verifiedDate: "2026-08-01",
    ...extra,
  };
}

function changeFixture(vendor: string, alternatives: string[]): DealChange {
  return {
    vendor,
    change_type: "limits_reduced",
    date: "2026-01-01",
    summary: `${vendor} reduced its limits`,
    previous_state: "before",
    current_state: "after",
    impact: "medium",
    source_url: "https://example.com/pricing",
    category: "Databases",
    alternatives,
  };
}

function slugOf(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function categoriesOf(vendor: string): Set<string> {
  return new Set(offers.filter(o => o.vendor === vendor).map(o => o.category));
}

function categoryPoolFor(vendor: string): Offer[] {
  const cats = categoriesOf(vendor);
  const seen = new Set<string>();
  const pool: Offer[] = [];
  for (const o of offers) {
    if (!cats.has(o.category) || o.vendor === vendor || seen.has(o.vendor)) continue;
    seen.add(o.vendor);
    pool.push(o);
  }
  return pool;
}

describe("curated alternative names", () => {
  it("reads every alternative named by the vendor's own change records", () => {
    const records = [changeFixture("Xata", ["Neon", "Supabase"]), changeFixture("Xata", ["CockroachDB"])];
    assert.deepStrictEqual(curatedAlternativeNames("Xata", records), ["Neon", "Supabase", "CockroachDB"]);
  });

  it("matches a vendor whose change records differ in case", () => {
    const records = [changeFixture("xata", ["Neon"])];
    assert.deepStrictEqual(curatedAlternativeNames("Xata", records), ["Neon"]);
  });

  it("reads nothing from another vendor's records", () => {
    const records = [changeFixture("Xata", ["Neon"])];
    assert.deepStrictEqual(curatedAlternativeNames("Neon", records), []);
  });

  it("keeps one entry for a name repeated across records", () => {
    const records = [changeFixture("Xata", ["Neon"]), changeFixture("Xata", ["Neon"])];
    assert.deepStrictEqual(curatedAlternativeNames("Xata", records), ["Neon"]);
  });

  it("never names the vendor as its own alternative", () => {
    const records = [changeFixture("Xata", ["Xata", "Neon"])];
    assert.deepStrictEqual(curatedAlternativeNames("Xata", records), ["Neon"]);
  });
});

describe("resolving curated names against the catalogue", () => {
  const catalogue = [
    offerFixture("Neon", "Databases"),
    offerFixture("Bruno", "API Development"),
  ];

  it("matches a name in another category", () => {
    const resolved = resolveCuratedAlternatives("Postman", [changeFixture("Postman", ["Bruno"])], catalogue);
    assert.deepStrictEqual(resolved.matched.map(o => o.vendor), ["Bruno"]);
    assert.deepStrictEqual(resolved.unmatched, []);
  });

  it("requires an exact vendor name and does not match a prefix", () => {
    const resolved = resolveCuratedAlternatives("Dub.co", [changeFixture("Dub.co", ["Bit", "neon", "Neon Serverless"])], catalogue);
    assert.deepStrictEqual(resolved.matched, []);
    assert.deepStrictEqual(resolved.unmatched, ["Bit", "neon", "Neon Serverless"]);
  });

  it("reports a name we do not carry as unmatched", () => {
    const resolved = resolveCuratedAlternatives("Dub.co", [changeFixture("Dub.co", ["Bitly", "Short.io"])], catalogue);
    assert.deepStrictEqual(resolved.matched, []);
    assert.deepStrictEqual(resolved.unmatched, ["Bitly", "Short.io"]);
  });

  it("does not match a catalogue entry whose name merely begins with the curated name", () => {
    const longerNames = [
      offerFixture("Bitly Enterprise", "Dev Utilities"),
      offerFixture("Neon Serverless Postgres", "Databases"),
    ];
    const resolved = resolveCuratedAlternatives("Dub.co", [changeFixture("Dub.co", ["Bitly", "Neon"])], longerNames);
    assert.deepStrictEqual(resolved.matched, []);
    assert.deepStrictEqual(resolved.unmatched, ["Bitly", "Neon"]);
  });

  it("does not match a catalogue entry whose name merely contains the curated name", () => {
    const embedded = [offerFixture("Cloudflare R2 Storage", "Storage")];
    const resolved = resolveCuratedAlternatives("Firebase", [changeFixture("Firebase", ["R2"])], embedded);
    assert.deepStrictEqual(resolved.matched, []);
    assert.deepStrictEqual(resolved.unmatched, ["R2"]);
  });
});

describe("the curated set a vendor page renders", () => {
  const EMULATOR_ROLE = {
    deployment_model: "local_dev_only" as const,
    is_addon: false,
    source_url: "https://example.com/docs",
    source_quote: "runs on your machine",
    reviewed: "2026-08-01",
  };

  it("removes a curated name a membership gate would remove", () => {
    const catalogue = [
      offerFixture("Emulator", "Databases", { product_role: EMULATOR_ROLE }),
      offerFixture("Turso", "Databases"),
    ];
    const subject = offerFixture("Neon", "Databases");
    const curated = curatedAlternativesFor(
      "Neon",
      [changeFixture("Neon", ["Emulator", "Turso"])],
      catalogue,
      [subject],
    );
    assert.deepStrictEqual(curated.kept.map(o => o.vendor), ["Turso"]);
    assert.deepStrictEqual(curated.removed.map(r => [r.offer.vendor, r.gate]), [["Emulator", "local_dev_only"]]);
  });

  it("keeps a curated name whose gate the subject carries too", () => {
    const catalogue = [offerFixture("Emulator", "Databases", { product_role: EMULATOR_ROLE })];
    const subject = offerFixture("LocalStack", "Databases", { product_role: EMULATOR_ROLE });
    const curated = curatedAlternativesFor(
      "LocalStack",
      [changeFixture("LocalStack", ["Emulator"])],
      catalogue,
      [subject],
    );
    assert.deepStrictEqual(curated.kept.map(o => o.vendor), ["Emulator"]);
    assert.deepStrictEqual(curated.removed, []);
  });

  it("reports the names it could not match alongside the ones it kept", () => {
    const catalogue = [offerFixture("Turso", "Databases")];
    const subject = offerFixture("Neon", "Databases");
    const curated = curatedAlternativesFor(
      "Neon",
      [changeFixture("Neon", ["Turso", "PlanetScale"])],
      catalogue,
      [subject],
    );
    assert.deepStrictEqual(curated.kept.map(o => o.vendor), ["Turso"]);
    assert.deepStrictEqual(curated.unmatched, ["PlanetScale"]);
  });
});

describe("widening the pool with curated names", () => {
  it("adds a curated offer the category pool does not hold", () => {
    const pool = [offerFixture("Katalon", "Testing")];
    const widened = addCuratedToPool(pool, [offerFixture("Bruno", "API Development")]);
    assert.deepStrictEqual(widened.map(o => o.vendor), ["Katalon", "Bruno"]);
  });

  it("does not duplicate a curated offer the category pool already holds", () => {
    const pool = [offerFixture("Neon", "Databases")];
    const widened = addCuratedToPool(pool, [offerFixture("Neon", "Databases")]);
    assert.deepStrictEqual(widened.map(o => o.vendor), ["Neon"]);
  });

  it("keeps every member the category pool produced", () => {
    const pool = [offerFixture("A", "Databases"), offerFixture("B", "Databases")];
    const widened = addCuratedToPool(pool, [offerFixture("C", "Storage")]);
    for (const original of pool) {
      assert.ok(widened.some(o => o.vendor === original.vendor), `${original.vendor} left the pool`);
    }
  });

  it("returns a pool at least as large as the one it was given, for every vendor we carry", () => {
    for (const vendor of new Set(offers.map(o => o.vendor))) {
      const pool = categoryPoolFor(vendor);
      const curated = resolveCuratedAlternatives(vendor, changes, offers);
      const widened = addCuratedToPool(pool, curated.matched);
      assert.ok(widened.length >= pool.length, `${vendor} lost members`);
      for (const original of pool) {
        assert.ok(widened.some(o => o.vendor === original.vendor), `${vendor} lost ${original.vendor}`);
      }
    }
  });

  it("leaves the membership gate to decide what the widened pool keeps", () => {
    const localOnly = offerFixture("Emulator", "Databases", {
      product_role: {
        deployment_model: "local_dev_only",
        is_addon: false,
        source_url: "https://example.com/docs",
        source_quote: "runs on your machine",
        reviewed: "2026-08-01",
      },
    });
    const subject = offerFixture("Hosted DB", "Databases");
    const widened = addCuratedToPool([], [localOnly]);
    const partitioned = partitionAlternativesAcross(widened, [subject]);
    assert.deepStrictEqual(partitioned.kept, []);
    assert.deepStrictEqual(partitioned.removed.map(r => r.gate), ["local_dev_only"]);
  });
});

describe("the queue of curated names we do not carry", () => {
  it("records which vendors named each name", () => {
    const records = [changeFixture("Firebase", ["AWS S3"]), changeFixture("Uploadthing", ["AWS S3"])];
    const queue = unmatchedCuratedNames(records, [offerFixture("Neon", "Databases")]);
    assert.deepStrictEqual(queue, [{ name: "AWS S3", named_by: ["Firebase", "Uploadthing"] }]);
  });

  it("omits a name the catalogue carries", () => {
    const records = [changeFixture("Xata", ["Neon", "PlanetScale"])];
    const queue = unmatchedCuratedNames(records, [offerFixture("Neon", "Databases")]);
    assert.deepStrictEqual(queue.map(e => e.name), ["PlanetScale"]);
  });

  it("matches the file committed alongside the catalogue", () => {
    const committed = JSON.parse(
      readFileSync(path.join(REPO, "data", "curated_alternatives_unmatched.json"), "utf-8"),
    ) as { unmatched: Array<{ name: string; named_by: string[] }> };
    assert.deepStrictEqual(committed.unmatched, unmatchedCuratedNames(changes, offers));
  });

  it("holds no name that also appears in the catalogue", () => {
    const committed = JSON.parse(
      readFileSync(path.join(REPO, "data", "curated_alternatives_unmatched.json"), "utf-8"),
    ) as { unmatched: Array<{ name: string }> };
    const indexed = new Set(offers.map(o => o.vendor));
    for (const entry of committed.unmatched) {
      assert.ok(!indexed.has(entry.name), `${entry.name} is in the catalogue`);
    }
  });

  it("names no curated alternative outside the subject's category that a membership gate would remove", () => {
    for (const subject of new Set(changes.map(c => c.vendor))) {
      const subjectCategories = categoriesOf(subject);
      if (subjectCategories.size === 0) continue;
      const curated = resolveCuratedAlternatives(subject, changes, offers);
      for (const candidate of curated.matched) {
        if (subjectCategories.has(candidate.category)) continue;
        const removed = partitionAlternativesAcross([candidate], offers.filter(o => o.vendor === subject)).removed;
        assert.deepStrictEqual(
          removed,
          [],
          `${candidate.vendor} is gated for ${subject} and sits in ${candidate.category}, which the exclusion sentence on /vendor/${slugOf(subject)} names as ${[...subjectCategories].join(", ")}`,
        );
      }
    }
  });

  it("holds every curated name the catalogue does not carry", () => {
    const indexed = new Set(offers.map(o => o.vendor));
    const queued = new Set(unmatchedCuratedNames(changes, offers).map(e => e.name));
    for (const change of changes) {
      for (const name of change.alternatives ?? []) {
        if (!indexed.has(name)) assert.ok(queued.has(name), `${name} is missing from the queue`);
      }
    }
  });
});

let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, body: await res.text() };
};

const CURATED_HEADING = "Recommended Migration Targets";

function curatedSection(body: string): string | null {
  const start = body.indexOf(CURATED_HEADING);
  if (start === -1) return null;
  const end = body.indexOf("</div>\n  </div>", start);
  return body.slice(start, end === -1 ? body.length : end);
}

describe("curated alternatives on the published pages", () => {
  before(async () => { proc = await startServer(); });
  after(() => { if (proc) proc.kill(); });

  const POSTMAN_CURATED = ["Bruno", "Insomnia", "Hoppscotch", "Apidog", "Thunder Client"];

  it("names all five curated alternatives to Postman on the alternatives page", async () => {
    const res = await get("/alternative-to/postman");
    assert.strictEqual(res.status, 200);
    const section = curatedSection(res.body);
    assert.ok(section, "no curated section");
    for (const vendor of POSTMAN_CURATED) {
      assert.ok(section.includes(`>${vendor}<`), `${vendor} is not in the curated section`);
    }
  });

  it("names all five curated alternatives to Postman on the vendor page", async () => {
    const res = await get("/vendor/postman");
    assert.strictEqual(res.status, 200);
    const section = curatedSection(res.body);
    assert.ok(section, "no curated section");
    for (const vendor of POSTMAN_CURATED) {
      assert.ok(section.includes(`>${vendor}<`), `${vendor} is not in the curated section`);
    }
  });

  it("carries the curated alternatives into the full alternatives list", async () => {
    const res = await get("/alternative-to/postman");
    for (const vendor of POSTMAN_CURATED) {
      assert.ok(res.body.includes(`/vendor/${slugOf(vendor)}`), `${vendor} is not linked`);
    }
  });

  it("counts the categories the alternatives list actually spans", async () => {
    const res = await get("/alternative-to/postman");
    const sentence = res.body.match(/There are \d+ free alternatives to Postman tracked on AgentDeals across the ([^.]+) categor(?:y|ies)\./);
    assert.ok(sentence, "no count sentence");
    assert.ok(sentence[1].includes("API Development"), `categories read ${sentence[1]}`);
  });

  it("publishes the same wording for the curated block on both page types", async () => {
    const vendorPage = await get("/vendor/postman");
    const altPage = await get("/alternative-to/postman");
    const note = "These alternatives were identified from Postman&rsquo;s pricing changes as recommended replacements.";
    assert.ok(vendorPage.body.includes(note));
    assert.ok(altPage.body.includes(note));
  });

  it("shows no curated block for a vendor whose curated names we do not carry", async () => {
    for (const url of ["/alternative-to/dub-co", "/vendor/dub-co"]) {
      const res = await get(url);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(curatedSection(res.body), null, `${url} shows a curated block`);
      assert.ok(!res.body.includes("Bitly"), `${url} names Bitly`);
      assert.ok(!res.body.includes("Short.io"), `${url} names Short.io`);
    }
  });

  it("keeps every ungated category member on a page whose curated names are all in category", async () => {
    const { partitionAlternativesAcross } = await import("../dist/product-role.js");
    const res = await get("/alternative-to/xata");
    assert.strictEqual(res.status, 200);
    const count = res.body.match(/All Free Alternatives \((\d+)\)/);
    assert.ok(count, "no alternatives count");
    const xata = offers.filter(o => o.vendor === "Xata");
    const ungated = partitionAlternativesAcross(categoryPoolFor("Xata"), xata).kept.length;
    assert.ok(ungated > 0, "the ungated pool must not be empty for this test to mean anything");
    assert.strictEqual(Number(count[1]), ungated, `expected every ungated category member, saw ${count[1]} of ${ungated}`);
    for (const vendor of ["Neon", "Supabase", "CockroachDB"]) {
      assert.ok(res.body.includes(`>${vendor}<`), `${vendor} is not listed`);
    }
  });

  it("orders the curated block through the shared ranking module", async () => {
    const { createHash } = await import("node:crypto");
    const { rankForListing } = await import("../dist/ranking.js");
    const body = (await get("/vendor/postman")).body;
    const start = body.indexOf(CURATED_HEADING);
    const grid = body.slice(start, body.indexOf('<div class="audit-block">', start));
    const rendered = [...grid.matchAll(/<span class="alt-name">([^<]+)<\/span>/g)].map(m => m[1]);

    const kept = partitionAlternativesAcross(
      resolveCuratedAlternatives("Postman", changes, offers).matched,
      offers.filter(o => o.vendor === "Postman"),
    ).kept;
    const ranking = rankForListing(kept, { queryKey: "curated-alternatives:Postman", changes });
    assert.deepStrictEqual(rendered, ranking.entries.map(e => e.offer.vendor));

    const block = body.slice(start).match(/<div class="audit-block">[\s\S]*?<\/div>/)![0];
    const date = block.match(/<dt>date<\/dt><dd>([^<]+)</)![1];
    const queryKey = block.match(/<dt>query_key<\/dt><dd>([^<]+)</)![1].replace(/&amp;/g, "&");
    const seed = block.match(/<dt>seed<\/dt><dd>([^<]+)</)![1];
    assert.strictEqual(queryKey, "curated-alternatives:Postman");
    assert.strictEqual(createHash("sha256").update(`${date}|${queryKey}|p0`).digest("hex"), seed);
  });

  it("leaves the category heading on the vendor page describing the category list", async () => {
    const heading = "<h2>Alternatives in Databases</h2>";
    const res = await get("/vendor/firebase");
    assert.ok(res.body.includes(heading), "the subject must render a category list for the assertion to mean anything");
    const categoryList = res.body.slice(res.body.indexOf(heading));
    for (const vendor of ["Cloudflare R2", "Backblaze B2"]) {
      assert.ok(res.body.includes(`>${vendor}<`), `${vendor} must be curated onto the page for this to test anything`);
      assert.ok(!categoryList.includes(`>${vendor}<`), `${vendor} is inside the category list`);
    }
  });
});
