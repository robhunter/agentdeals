import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_CHECK_OUTCOMES } from "../dist/source-check.js";
import { NOTHING_CONTRADICTS_OUR_TERMS_FOR } from "../dist/data.js";
import { TERMS_WITHHELD_LABELS } from "../dist/vendor-verdict.js";
import { ATTEMPT_THAT_DID_NOT_READ, VERIFICATION_DATES_HEADING } from "../dist/read-date.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const DAY_MS = 86_400_000;
const dayOffset = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

const CONFIRMED_ON = dayOffset(-10);
const CHECKED_ON = dayOffset(-2);
const ATTEMPTED_ON = dayOffset(-1);

const NOT_OK_OUTCOMES = SOURCE_CHECK_OUTCOMES.filter((outcome: string) => outcome !== "ok");

interface FixtureOffer {
  vendor: string;
  category: string;
  description: string;
  tier: string;
  url: string;
  tags: string[];
  verifiedDate: string;
  product_subtypes: unknown;
  source_check: { checked: string; outcome: string; detail: string };
}

function offerFor(outcome: string, index: number): FixtureOffer {
  const vendor = `Cavecorp${index}`;
  const host = `cavecorp${index}.example`;
  return {
    vendor,
    category: "Databases",
    description: `Managed Postgres with 10 GB storage, 5 projects and 100K rows`,
    tier: "Free",
    url: `https://${host}/pricing`,
    tags: ["databases"],
    verifiedDate: CONFIRMED_ON,
    product_subtypes: {
      taxonomy: "Databases",
      labels: [{ subtype: "relational", source_url: `https://${host}/pricing`, source_quote: "managed Postgres" }],
      reviewed: CONFIRMED_ON,
    },
    source_check: { checked: CHECKED_ON, outcome, detail: `recorded as ${outcome}` },
  };
}

const OFFERS: FixtureOffer[] = NOT_OK_OUTCOMES.map((outcome: string, i: number) => offerFor(outcome, i + 1));
const CLEAN_READS: FixtureOffer[] = [0, 1].map((i) => ({
  ...offerFor("ok", 90 + i),
  vendor: `Cleancorp${i + 1}`,
  url: `https://cleancorp${i + 1}.example/pricing`,
  product_subtypes: {
    taxonomy: "Databases",
    labels: [{ subtype: "relational", source_url: `https://cleancorp${i + 1}.example/pricing`, source_quote: "managed Postgres" }],
    reviewed: CONFIRMED_ON,
  },
}));

const CORPUS = [...OFFERS, ...CLEAN_READS];
const CORPUS_ALL_READ = CORPUS.map((o) => ({ ...o, source_check: { ...o.source_check, outcome: "ok" } }));

const vendorOf = (offer: FixtureOffer) => offer.vendor;
const slugOf = (vendor: string) => vendor.toLowerCase();

interface Served {
  child: ChildProcess;
  port: number;
}

function startServer(env: Record<string, string>): Promise<Served> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function pathsOf(port: number): Promise<string[]> {
  const locsOf = (xml: string) =>
    [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  const index = locsOf(await (await fetch(`http://localhost:${port}/sitemap.xml`)).text());
  const paths: string[] = [];
  for (const child of index) {
    if (!child.startsWith("/sitemap")) { paths.push(child); continue; }
    paths.push(...locsOf(await (await fetch(`http://localhost:${port}${child}`)).text()));
  }
  return paths;
}

function vendorsNamedInOrder(body: string): string[] {
  const seen: string[] = [];
  for (const m of body.matchAll(/href="\/vendor\/([a-z0-9-]+)"/g)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

function demeritsInOrder(body: string): string[] {
  return [...body.matchAll(/<span class="demerit-code">([\s\S]*?)<\/span>/g)].map((m) => m[1].trim());
}

interface ApplicationNode {
  name: string;
  description: string;
}

function unescapeServed(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function collectApplications(node: unknown, found: ApplicationNode[]): ApplicationNode[] {
  if (Array.isArray(node)) {
    for (const item of node) collectApplications(item, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;
  const record = node as Record<string, unknown>;
  if (record["@type"] === "SoftwareApplication" && typeof record.description === "string" && typeof record.name === "string") {
    found.push({ name: record.name, description: record.description });
  }
  for (const value of Object.values(record)) collectApplications(value, found);
  return found;
}

function applicationsIn(body: string): ApplicationNode[] {
  const blocks = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return blocks.flatMap((block) => collectApplications(JSON.parse(block), []));
}

function caveatSentencesIn(body: string): string[] {
  return [...body.matchAll(/class="listing-terms-unconfirmed"[^>]*>([\s\S]*?)<\/span>/g)]
    .map((m) => unescapeServed(m[1].replace(/<[^>]*>/g, "").trim()))
    .filter((sentence) => sentence.length > 0);
}

function metaDescriptionOf(body: string): string {
  const m = body.match(/<meta name="description" content="([^"]*)">/);
  return m ? unescapeServed(m[1]) : "";
}

function applicationsFor(body: string, vendor: string): ApplicationNode[] {
  return applicationsIn(body).filter((node) => node.name === vendor);
}

let fixtureDir = "";
let unconfirmed: Served | null = null;
let allRead: Served | null = null;
const pageOf = new Map<string, string>();
const controlPageOf = new Map<string, string>();
let rankedPaths: string[] = [];

before(async () => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "ranked-terms-caveat-"));
  const indexPath = path.join(fixtureDir, "index.json");
  const controlIndexPath = path.join(fixtureDir, "index-all-read.json");
  const statePath = path.join(fixtureDir, "verification_state.json");
  writeFileSync(indexPath, JSON.stringify({ offers: CORPUS }, null, 2));
  writeFileSync(controlIndexPath, JSON.stringify({ offers: CORPUS_ALL_READ }, null, 2));
  writeFileSync(statePath, JSON.stringify({
    records: CORPUS.map((o) => ({
      vendor: o.vendor,
      url: o.url,
      last_attempt_at: ATTEMPTED_ON,
      last_outcome: o.source_check.outcome === "ok" ? "confirmed" : "fetch_failed",
      last_error: null,
      failure_category: null,
      consecutive_failures: o.source_check.outcome === "ok" ? 0 : 1,
      last_success: CONFIRMED_ON,
      last_read_at: o.source_check.outcome === "ok" ? ATTEMPTED_ON : null,
      quarantined_since: null,
    })),
  }, null, 2));

  unconfirmed = await startServer({
    AGENTDEALS_INDEX_PATH: indexPath,
    AGENTDEALS_VERIFICATION_STATE_PATH: statePath,
  });
  allRead = await startServer({
    AGENTDEALS_INDEX_PATH: controlIndexPath,
    AGENTDEALS_VERIFICATION_STATE_PATH: statePath,
  });

  const paths = await pathsOf(unconfirmed.port);
  rankedPaths = paths.filter((p) => p.startsWith("/best/") || p.startsWith("/category/"));
  for (const route of rankedPaths) {
    pageOf.set(route, await (await fetch(`http://localhost:${unconfirmed.port}${route}`)).text());
    controlPageOf.set(route, await (await fetch(`http://localhost:${allRead.port}${route}`)).text());
  }
});

after(() => {
  unconfirmed?.child.kill();
  allRead?.child.kill();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe("a ranked page that publishes terms we could not confirm", () => {
  it("publishes a best-of page and a category page, so the assertions below are about real pages", () => {
    assert.ok(rankedPaths.some((p) => p.startsWith("/best/")), `no best-of page published: ${rankedPaths.join(", ")}`);
    assert.ok(rankedPaths.some((p) => p.startsWith("/category/")), `no category page published: ${rankedPaths.join(", ")}`);
  });

  it("names every offer whose read did not confirm the terms", () => {
    for (const offer of OFFERS) {
      const naming = rankedPaths.filter((route) => vendorsNamedInOrder(pageOf.get(route)!).includes(slugOf(vendorOf(offer))));
      assert.ok(naming.length > 0, `${offer.vendor} (${offer.source_check.outcome}) is on no ranked page`);
    }
  });

  it("carries the reason on every ranked page that names the offer", () => {
    for (const offer of OFFERS) {
      for (const route of rankedPaths) {
        const body = pageOf.get(route)!;
        if (!vendorsNamedInOrder(body).includes(slugOf(vendorOf(offer)))) continue;
        assert.match(
          body,
          /listing-terms-unconfirmed|durability-withheld-because/,
          `${route} names ${offer.vendor} over a ${offer.source_check.outcome} read and carries no caveat`,
        );
      }
    }
  });

  it("dates the caveat with the day of the read that did not confirm", () => {
    const bestOf = rankedPaths.filter((p) => p.startsWith("/best/"));
    let reasoned = 0;
    for (const route of bestOf) {
      const body = pageOf.get(route)!;
      const cells = [...body.matchAll(/class="durability-withheld-because"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => m[1]);
      assert.ok(cells.length > 0, `${route} withholds a durability class and names no reason for any row`);
      reasoned += cells.length;
      for (const cell of cells) {
        assert.ok(
          Object.values(TERMS_WITHHELD_LABELS).some((label) => cell.includes(label)),
          `${route} names no recorded reason in "${cell}"`,
        );
        assert.match(cell, /\d{4}-\d{2}-\d{2}/, `${route} names a reason with no date: "${cell}"`);
      }
    }
    assert.ok(
      reasoned >= NOT_OK_OUTCOMES.length,
      `${reasoned} rows name a reason across ${bestOf.length} best-of pages, fewer than the ${NOT_OK_OUTCOMES.length} outcomes in the corpus`,
    );
  });

  it("shows the read that did not answer beside the date it last confirmed", () => {
    const route = rankedPaths.find((p) => p.startsWith("/best/"))!;
    const body = pageOf.get(route)!;
    assert.ok(
      body.includes(ATTEMPT_THAT_DID_NOT_READ(ATTEMPTED_ON)),
      `the ${VERIFICATION_DATES_HEADING} column hides the ${ATTEMPTED_ON} attempt that did not read the page`,
    );
    assert.ok(body.includes(CONFIRMED_ON), "the column drops the date the terms were last confirmed");
  });

  it("says nothing of the kind for an offer whose read confirmed the terms", () => {
    for (const clean of CLEAN_READS) {
      for (const route of rankedPaths) {
        const rows = [...pageOf.get(route)!.matchAll(/<tr>((?:(?!<tr>)[\s\S])*?)<\/tr>/g)]
          .map((m) => m[1])
          .filter((row) => row.includes(`/vendor/${slugOf(clean.vendor)}"`));
        assert.ok(rows.length <= 1, `${route} carries ${rows.length} rows for ${clean.vendor}`);
        for (const row of rows) {
          assert.doesNotMatch(row, /listing-terms-unconfirmed|durability-withheld-because/,
            `${route} caveats ${clean.vendor}, whose read confirmed the terms`);
        }
      }
    }
  });
});

describe("the same corpus with every read confirming the terms", () => {
  it("ranks the same offers in the same order on every ranked page", () => {
    for (const route of rankedPaths) {
      assert.deepEqual(
        vendorsNamedInOrder(pageOf.get(route)!),
        vendorsNamedInOrder(controlPageOf.get(route)!),
        `${route} ranks differently when the reads confirm`,
      );
    }
  });

  it("publishes the same set of ranked pages", async () => {
    const control = (await pathsOf(allRead!.port)).filter((p) => p.startsWith("/best/") || p.startsWith("/category/"));
    assert.deepEqual(rankedPaths.slice().sort(), control.slice().sort());
  });

  it("charges the same demerits, so a read we could not complete costs the vendor nothing", () => {
    for (const route of rankedPaths) {
      assert.deepEqual(
        demeritsInOrder(pageOf.get(route)!),
        demeritsInOrder(controlPageOf.get(route)!),
        `${route} demotes an offer for a read failure of ours`,
      );
    }
  });

  it("carries no caveat anywhere", () => {
    for (const route of rankedPaths) {
      assert.doesNotMatch(
        controlPageOf.get(route)!,
        /listing-terms-unconfirmed|durability-withheld-because/,
        `${route} caveats an offer whose read confirmed the terms`,
      );
    }
  });
});

describe("the structured data beside those cards", () => {
  it("publishes a node for every offer whose read did not confirm the terms", () => {
    for (const offer of OFFERS) {
      const nodes = rankedPaths.flatMap((route) => applicationsFor(pageOf.get(route)!, offer.vendor));
      assert.ok(nodes.length > 0, `${offer.vendor} (${offer.source_check.outcome}) has no structured node on any ranked page`);
    }
  });

  it("closes every node that states terms we cannot confirm with the sentence the card prints", () => {
    let closed = 0;
    for (const route of rankedPaths) {
      const body = pageOf.get(route)!;
      const spoken = caveatSentencesIn(body);
      for (const offer of OFFERS) {
        for (const node of applicationsFor(body, offer.vendor)) {
          assert.ok(
            node.description.startsWith(`${offer.description}.`),
            `${route} publishes a description for ${offer.vendor} that does not open with the terms: "${node.description}"`,
          );
          const tail = node.description.slice(`${offer.description}.`.length).trim();
          assert.ok(
            spoken.includes(tail),
            `${route} closes ${offer.vendor}'s description with a sentence the page never prints: "${tail}"`,
          );
          closed++;
        }
      }
    }
    assert.ok(closed >= NOT_OK_OUTCOMES.length, `only ${closed} structured descriptions were checked`);
  });

  it("leaves the description alone when the read confirmed the terms", () => {
    for (const route of rankedPaths) {
      for (const clean of CLEAN_READS) {
        for (const node of applicationsFor(pageOf.get(route)!, clean.vendor)) {
          assert.strictEqual(
            node.description,
            clean.description,
            `${route} caveats ${clean.vendor} in structured data over a read that confirmed the terms`,
          );
        }
      }
    }
  });

  it("does not carry the caveat in prose and withhold it from the node on the same page", () => {
    for (const route of rankedPaths) {
      const body = pageOf.get(route)!;
      const spoken = caveatSentencesIn(body);
      if (spoken.length === 0) continue;
      const silent = OFFERS
        .flatMap((offer) => applicationsFor(body, offer.vendor).map((node) => ({ offer, node })))
        .filter(({ node }) => !spoken.some((sentence) => node.description.endsWith(sentence)))
        .map(({ offer }) => offer.vendor);
      assert.deepStrictEqual(silent, [], `${route} says it in prose and not in the structured data for: ${silent.join(", ")}`);
    }
  });

  it("says on every page how many of the offers it lists we could not confirm", () => {
    for (const route of rankedPaths) {
      const body = pageOf.get(route)!;
      const named = new Set(vendorsNamedInOrder(body));
      const owing = OFFERS.filter((offer) => named.has(slugOf(offer.vendor))).length;
      const meta = metaDescriptionOf(body);
      if (owing === 0) {
        assert.doesNotMatch(meta, /could not confirm today's terms/, `${route} discloses a count it does not owe: "${meta}"`);
        continue;
      }
      const stated = meta.match(/We could not confirm today's terms for (\d+) of them/);
      assert.ok(stated, `${route} lists ${owing} offers we cannot confirm and its description says so nowhere: "${meta}"`);
      assert.strictEqual(Number(stated![1]), owing, `${route} states ${stated![1]} unconfirmed offers against ${owing} named on the page`);
    }
  });

  it("names no vendor as uncontradicted while the same page caveats it", () => {
    const naming = new RegExp(`${NOTHING_CONTRADICTS_OUR_TERMS_FOR} ([^.]*)\\.`);
    let read = 0;
    for (const route of rankedPaths) {
      const body = pageOf.get(route)!;
      const named = new Set(vendorsNamedInOrder(body));
      const meta = metaDescriptionOf(body);
      const uncontradicted = meta.match(naming);
      if (!uncontradicted) continue;
      read++;
      const asUncontradicted = uncontradicted[1].replace(/ and more$/, "").split(", ").map((v) => v.trim());
      const withheld = asUncontradicted.filter((vendor) => OFFERS.some((offer) => offer.vendor === vendor && named.has(slugOf(vendor))));
      assert.deepStrictEqual(withheld, [], `${route} says nothing contradicts ${withheld.join(", ")} and caveats the same offer below`);
    }
    assert.ok(read > 0, `none of the ${rankedPaths.length} ranked pages names a vendor list for this assertion to read`);
  });
});

describe("the same corpus with every read confirming the terms, in the structured data", () => {
  it("publishes the stored terms and nothing after them", () => {
    for (const route of rankedPaths) {
      for (const node of applicationsIn(controlPageOf.get(route)!)) {
        assert.ok(
          [...OFFERS, ...CLEAN_READS].some((offer) => offer.description === node.description),
          `${route} publishes a structured description that is not the stored terms: "${node.description}"`,
        );
      }
    }
  });

  it("states no unconfirmed count in its description", () => {
    for (const route of rankedPaths) {
      assert.doesNotMatch(
        metaDescriptionOf(controlPageOf.get(route)!),
        /could not confirm today's terms/,
        `${route} discloses an unconfirmed count over a corpus whose reads all confirmed`,
      );
    }
  });
});
