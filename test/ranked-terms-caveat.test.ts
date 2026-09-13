import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_CHECK_OUTCOMES } from "../dist/source-check.js";
import { TERMS_WITHHELD_LABELS } from "../dist/vendor-verdict.js";
import { ATTEMPT_THAT_DID_NOT_READ } from "../dist/read-date.js";

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
    for (const route of rankedPaths) {
      const body = pageOf.get(route)!;
      if (!body.includes("durability-withheld-because")) continue;
      const cells = [...body.matchAll(/class="durability-withheld-because"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => m[1]);
      assert.ok(cells.length > 0, `${route} marks a withheld class and names no reason`);
      for (const cell of cells) {
        assert.ok(
          Object.values(TERMS_WITHHELD_LABELS).some((label) => cell.includes(label)),
          `${route} names no recorded reason in "${cell}"`,
        );
        assert.match(cell, /\d{4}-\d{2}-\d{2}/, `${route} names a reason with no date: "${cell}"`);
      }
    }
  });

  it("shows the read that did not answer beside the date it last confirmed", () => {
    const route = rankedPaths.find((p) => p.startsWith("/best/"))!;
    const body = pageOf.get(route)!;
    assert.ok(
      body.includes(ATTEMPT_THAT_DID_NOT_READ(ATTEMPTED_ON)),
      `the Read / verified column hides the ${ATTEMPTED_ON} attempt that did not read the page`,
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
