import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { withoutFinalStop } = await import("../dist/terms-opening.js");

type Offer = import("../src/types.ts").Offer;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);
const slugOf = (vendor: string) => vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function listing(vendor: string, description: string): Offer {
  return {
    vendor,
    category: "Databases",
    description,
    tier: "Free",
    url: `https://${slugOf(vendor)}.example/pricing`,
    tags: ["database"],
    verifiedDate: TODAY,
    source_check: { checked: TODAY, outcome: "ok", detail: `the page names ${vendor} as "${slugOf(vendor)}"` },
  } as Offer;
}

const ENDS_A_SENTENCE = listing("Sentence Ending Opening Co", "Free for up to 10 users forever.");
const ENDS_AN_ABBREVIATION = listing("Abbreviation Ending Opening Co", "Free databases, storage, backups, etc.");
const RECOMMENDATION = (offer: Offer, opening: string) =>
  `${offer.vendor}'s free tier can be suitable for small production workloads and side projects. We rate it stable and it offers ${opening}, so it's a reasonable starting point. Monitor your usage against the limits and have an upgrade plan ready.`;

function startServer(indexPath: string): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_INDEX_PATH: indexPath },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server startup timeout"));
    }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) {
        clearTimeout(timer);
        resolve({ proc: child, base: `http://localhost:${found[1]}` });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function productionAnswer(base: string, offer: Offer): Promise<string> {
  const html = await (await fetch(`${base}/vendor/${slugOf(offer.vendor)}`)).text();
  for (const [, block] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const parsed = JSON.parse(block!);
    if (parsed["@type"] !== "FAQPage") continue;
    const item = parsed.mainEntity.find((q: { name: string }) => q.name === `Is ${offer.vendor}'s free tier good for production?`);
    if (item) return item.acceptedAnswer.text;
  }
  return "";
}

describe("an opening run on into a longer sentence", () => {
  it("drops the full stop, question mark or exclamation mark that ends it", () => {
    assert.strictEqual(withoutFinalStop("Free for up to 10 users forever."), "Free for up to 10 users forever");
    assert.strictEqual(withoutFinalStop("Free forever!"), "Free forever");
    assert.strictEqual(withoutFinalStop("Need more?"), "Need more");
    assert.strictEqual(withoutFinalStop("  3 databases.  "), "3 databases");
  });

  it("keeps the full stop of an abbreviation, which the comma follows", () => {
    for (const opening of ["Free databases, storage, backups, etc.", "Run by Example Inc.", "Owned by Example Ltd.", "Sold by Example Co.", "Any region, e.g.", "One plan, i.e."]) {
      assert.strictEqual(withoutFinalStop(opening), opening);
    }
  });

  it("leaves an opening that ends some other way as it is", () => {
    for (const opening of ["300 emails/day, unlimited contacts…", "Free basic endpoints (Like, Follow, List, etc.)", "1 GB of storage", "Search \"Free\""]) {
      assert.strictEqual(withoutFinalStop(opening), opening);
    }
    assert.strictEqual(withoutFinalStop("Two sentences. The second ends here."), "Two sentences. The second ends here");
  });
});

describe("the vendor page's production answer runs the listing's opening into the recommendation", () => {
  let server: { proc: ChildProcess; base: string };
  const scratch = mkdtempSync(path.join(tmpdir(), "production-answer-opening-"));

  before(async () => {
    const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    catalogue.offers.push(ENDS_A_SENTENCE, ENDS_AN_ABBREVIATION);
    const indexPath = path.join(scratch, "index.json");
    writeFileSync(indexPath, JSON.stringify(catalogue));
    server = await startServer(indexPath);
  });

  after(() => {
    server?.proc.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("without the full stop that ended the listing's sentence", async () => {
    assert.strictEqual(await productionAnswer(server.base, ENDS_A_SENTENCE), RECOMMENDATION(ENDS_A_SENTENCE, "Free for up to 10 users forever"));
  });

  it("keeping the full stop of an abbreviation the listing ends with", async () => {
    assert.strictEqual(await productionAnswer(server.base, ENDS_AN_ABBREVIATION), RECOMMENDATION(ENDS_AN_ABBREVIATION, "Free databases, storage, backups, etc."));
  });
});
