import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertSharesPopulation, recordsInTheCatalogue } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { lastReadDate, verificationDatesCell, LAST_READ_LABEL, VERIFICATION_DATES_HEADING } =
  await import("../dist/read-date.js");

interface CatalogueOffer {
  vendor: string;
  category: string;
  url: string;
  tier: string;
  verifiedDate: string;
}

const offers: CatalogueOffer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

const slugOf = (vendor: string) => vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const widestGap = offers
  .map((o) => ({ offer: o, read: lastReadDate(o), gap: daysBetween(o.verifiedDate, lastReadDate(o)) }))
  .sort((a, b) => b.gap - a.gap)[0]!;

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

describe("every record publishes the day we last read its page", () => {
  before(async () => { proc = await startServer(); });
  after(() => { proc?.kill(); });

  it("names a read date on every record the catalogue API returns", async () => {
    const { status, body } = await get("/api/offers?limit=5000");
    assert.equal(status, 200);
    const returned = JSON.parse(body).offers as Array<{ vendor: string; verifiedDate: string; last_read_date?: string; days_since_read?: number }>;
    const dated = returned.filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.last_read_date ?? ""));
    assertCoversPopulation(dated.length, recordsInTheCatalogue(), "records the API answers with a day we read the page");
    for (const o of returned) {
      assert.ok(
        (o.last_read_date ?? "") >= o.verifiedDate,
        `${o.vendor} publishes a read date of ${o.last_read_date} against a verification of ${o.verifiedDate}`,
      );
      assert.equal(typeof o.days_since_read, "number", `${o.vendor} publishes no age for its read date`);
    }
  });

  it("answers with a read date later than the verification on the records a read has moved", async () => {
    const { body } = await get("/api/offers?limit=5000");
    const returned = JSON.parse(body).offers as Array<{ verifiedDate: string; last_read_date?: string }>;
    const moved = returned.filter((o) => (o.last_read_date ?? "") > o.verifiedDate);
    assertSharesPopulation(moved.length, recordsInTheCatalogue(), 0.25, "records the API answers with a read later than the verification");
  });

  it("publishes both dates, each labelled, on the record with the widest gap", async () => {
    assert.ok(widestGap.gap > 0, "no record reads later than it verifies, so this control proves nothing");
    const { status, body } = await get(`/vendor/${slugOf(widestGap.offer.vendor)}`);
    assert.equal(status, 200, `/vendor/${slugOf(widestGap.offer.vendor)} must exist for this test to mean anything`);
    assert.ok(body.includes(LAST_READ_LABEL), `the page for ${widestGap.offer.vendor} does not label a read date`);
    assert.ok(body.includes(widestGap.read), `the page for ${widestGap.offer.vendor} does not publish ${widestGap.read}`);
    assert.ok(body.includes(widestGap.offer.verifiedDate), `the page for ${widestGap.offer.vendor} dropped its verification date`);
    assert.ok(
      body.includes(`last confirmed on ${widestGap.offer.verifiedDate}`),
      `the page for ${widestGap.offer.vendor} publishes two dates without saying which is which`,
    );
  });

  it("dates its last update no earlier than its last read", async () => {
    const { body } = await get(`/vendor/${slugOf(widestGap.offer.vendor)}`);
    const claimed = body.match(/Last updated (\d{4}-\d{2}-\d{2})\./);
    assert.ok(claimed, "the page states no last-updated date");
    assert.ok(
      claimed[1]! >= widestGap.read,
      `the page says it was last updated ${claimed[1]} and that we read the page on ${widestGap.read}`,
    );
  });

  it("labels the read date on a record read and verified on the same day", async () => {
    const together = offers.find((o) => lastReadDate(o) === o.verifiedDate && !/\//.test(o.vendor));
    assert.ok(together, "no record reads and verifies on the same day, so this control proves nothing");
    const { status, body } = await get(`/vendor/${slugOf(together.vendor)}`);
    assert.equal(status, 200);
    assert.ok(body.includes(LAST_READ_LABEL), `the page for ${together.vendor} hides the read date because it matches the verification`);
    assert.ok(
      body.includes("and the day we last confirmed"),
      `the page for ${together.vendor} does not say the one date it publishes is both`,
    );
  });

  it("heads every category table with both dates and fills every row", async () => {
    const categories = [...new Set(offers.map((o) => o.category))];
    const unheaded: string[] = [];
    let published = 0;
    for (const category of categories) {
      const { status, body } = await get(`/category/${slugOf(category)}`);
      assert.equal(status, 200, `/category/${slugOf(category)} must exist for this test to mean anything`);
      if (!body.includes(VERIFICATION_DATES_HEADING)) unheaded.push(category);
      for (const o of offers.filter((x) => x.category === category)) {
        if (body.includes(`>${verificationDatesCell(o)}</td>`)) published++;
      }
    }
    assert.deepEqual(unheaded, [], "category tables still head their date column with one date");
    assertCoversPopulation(published, recordsInTheCatalogue(), "rows publishing a day we read the page");
  });
});
