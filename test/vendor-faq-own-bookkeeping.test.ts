import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { assertPopulationFloor } from "./population-floor.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { changesTheVendorMade, freeTierLongevityStart, loadDealChanges, loadOffers, NEGATIVE_CHANGE_TYPES } = await import("../dist/data.js");
const { isOurOwnBookkeeping, ourOwnRecordsSentence } = await import("../dist/vendor-verdict.js");
const { vendorSlugMap } = await import("../dist/vendor-slug.js");

type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const DAY_MS = 24 * 60 * 60 * 1000;

const OUR_OWN_RECORD_QUOTED_AS_LATEST =
  /Most recently: (?:Retracted|Data correction)|The most recent was [^:]{0,60}: (?:Retracted|Data correction)/;

const storedLog = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
const stored: DealChange[] = storedLog.changes;

function retracted<T extends DealChange>(change: T): T {
  return { ...change, resolution: { state: "retracted", date: change.date } };
}

function retypedAsACorrection<T extends DealChange>(change: T): T {
  return { ...change, change_type: "record_corrected" };
}

const OUR_OWN_BOOKKEEPING: Array<[string, (change: DealChange) => DealChange]> = [
  ["retracted", retracted],
  ["retyped as a correction", retypedAsACorrection],
];

function storedByVendor(): Map<string, DealChange[]> {
  const byVendor = new Map<string, DealChange[]>();
  for (const change of stored) byVendor.set(change.vendor, [...(byVendor.get(change.vendor) ?? []), change]);
  return byVendor;
}

const slugForVendor = new Map<string, string>([...vendorSlugMap].map(([slug, vendor]) => [vendor, slug]));

function readableText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

function structuredAnswers(html: string): string[] {
  const answers: string[] = [];
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      continue;
    }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      if ((node as { "@type"?: string })["@type"] !== "FAQPage") continue;
      for (const entry of (node as { mainEntity: Array<{ acceptedAnswer: { text: string } }> }).mainEntity) {
        answers.push(entry.acceptedAnswer.text);
      }
    }
  }
  return answers;
}

function countOnVendorPage(html: string, vendor: string): number | null {
  const m = readableText(html).match(new RegExp(`${vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} has had (\\d+) recorded pricing change`));
  return m ? Number(m[1]) : null;
}

function countOnAlternativesPage(html: string, vendor: string): number | null {
  const m = readableText(html).match(new RegExp(`${vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} has (\\d+) recorded pricing change`));
  return m ? Number(m[1]) : null;
}

function startServer(env: Record<string, string> = {}): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    proc.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc, base: `http://localhost:${m[1]}` });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function fetchText(base: string, route: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}${route}`);
  return { status: res.status, body: await res.text() };
}

describe("our own retractions and corrections stay out of a vendor's change count and longevity, for every record on file (#1925)", () => {
  it("leaves a record out of the changes the vendor made once it is retracted or retyped as a correction", () => {
    let checked = 0;
    for (const [, records] of storedByVendor()) {
      const made = changesTheVendorMade(records).length;
      records.forEach((record, i) => {
        for (const [how, mark] of OUR_OWN_BOOKKEEPING) {
          const marked = records.map((r, j) => (j === i ? mark(r) : r));
          const after = changesTheVendorMade(marked);
          assert.ok(!after.includes(marked[i]), `${record.vendor} ${record.date} still counts once ${how}`);
          assert.strictEqual(after.length, made - (isOurOwnBookkeeping(record) ? 0 : 1), `${record.vendor} ${record.date} ${how}`);
          checked += 1;
        }
      });
    }
    assertPopulationFloor(checked, 1, "records marked as our own bookkeeping");
  });

  it("dates free-tier longevity as though a retracted or corrected record had never been written", () => {
    const beforeAnyRecord = new Date(0);
    let moved = 0;
    for (const [, records] of storedByVendor()) {
      records.forEach((record, i) => {
        const without = records.filter((_, j) => j !== i);
        const expected = freeTierLongevityStart(without, beforeAnyRecord).getTime();
        const asWritten = freeTierLongevityStart(records, beforeAnyRecord).getTime();
        for (const [how, mark] of OUR_OWN_BOOKKEEPING) {
          const marked = records.map((r, j) => (j === i ? mark(r) : r));
          assert.strictEqual(
            freeTierLongevityStart(marked, beforeAnyRecord).getTime(),
            expected,
            `${record.vendor} ${record.date} ${how} still dates the free tier's longevity`,
          );
        }
        if (asWritten !== expected) moved += 1;
      });
    }
    assertPopulationFloor(moved, 1, "records that date a vendor's longevity as written");
  });
});

describe("the vendor and alternatives FAQs as served (#1925)", () => {
  let baseline: { proc: ChildProcess; base: string };
  const marked = new Map<string, { proc: ChildProcess; base: string }>();
  let scratch = "";
  let counted: { vendor: string; slug: string; latest: DealChange; onVendorPage: number; onAlternativesPage: number } | null = null;
  let longevity: { vendor: string; slug: string; narrowing: DealChange; startsAfter: number; served: number } | null = null;

  before(async () => {
    baseline = await startServer();
    const offers = loadOffers();
    const byVendor = storedByVendor();

    for (const [vendor, records] of [...byVendor].sort(([a], [b]) => a.localeCompare(b))) {
      const slug = slugForVendor.get(vendor);
      if (!slug) continue;
      const made = changesTheVendorMade(records).sort((a: DealChange, b: DealChange) => b.date.localeCompare(a.date));
      if (made.length < 2 || made[0].date === made[1].date) continue;
      const vendorPage = await fetchText(baseline.base, `/vendor/${slug}`);
      const alternativesPage = await fetchText(baseline.base, `/alternative-to/${slug}`);
      if (vendorPage.status !== 200 || alternativesPage.status !== 200) continue;
      const onVendorPage = countOnVendorPage(vendorPage.body, vendor);
      const onAlternativesPage = countOnAlternativesPage(alternativesPage.body, vendor);
      if (onVendorPage === null || onAlternativesPage === null) continue;
      counted = { vendor, slug, latest: made[0], onVendorPage, onAlternativesPage };
      break;
    }

    for (const [vendor, records] of [...byVendor].sort(([a], [b]) => a.localeCompare(b))) {
      const slug = slugForVendor.get(vendor);
      const vendorOffers = offers.filter((o: { vendor: string }) => o.vendor === vendor);
      if (!slug || vendorOffers.length !== 1) continue;
      const verified = new Date(vendorOffers[0].verifiedDate).getTime();
      const narrowing = changesTheVendorMade(records)
        .filter((c: DealChange) => NEGATIVE_CHANGE_TYPES.has(c.change_type))
        .sort((a: DealChange, b: DealChange) => b.date.localeCompare(a.date));
      if (narrowing.length === 0 || new Date(narrowing[0].date).getTime() <= verified) continue;
      if (narrowing[1] && narrowing[1].date === narrowing[0].date) continue;
      const res = await fetch(`${baseline.base}/api/vendor-risk/${slug}`);
      if (res.status !== 200) continue;
      const served = (await res.json()).free_tier_longevity_days;
      if (typeof served !== "number") continue;
      const next = narrowing[1] ? new Date(narrowing[1].date).getTime() : Number.NEGATIVE_INFINITY;
      longevity = { vendor, slug, narrowing: narrowing[0], startsAfter: Math.max(next, verified), served };
      break;
    }

    scratch = mkdtempSync(path.join(tmpdir(), "own-bookkeeping-"));
    for (const [how, mark] of OUR_OWN_BOOKKEEPING) {
      const changes = stored.map((c) => (c === counted?.latest || c === longevity?.narrowing ? mark(c) : c));
      const file = path.join(scratch, `${how.replace(/\W+/g, "-")}.json`);
      writeFileSync(file, JSON.stringify({ ...storedLog, changes }));
      marked.set(how, await startServer({ AGENTDEALS_CHANGES_PATH: file }));
    }
  });

  after(() => {
    baseline?.proc.kill();
    for (const server of marked.values()) server.proc.kill();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("quotes no retraction or correction as the latest change, on the vendor and alternatives page of every vendor we hold one for", async () => {
    const vendors = [...storedByVendor()]
      .filter(([vendor, records]) => slugForVendor.has(vendor) && records.some(isOurOwnBookkeeping))
      .map(([vendor]) => vendor);
    assertPopulationFloor(vendors.length, 1, "vendors holding a record of our own bookkeeping");
    const quoted: string[] = [];
    let read = 0;
    for (const vendor of vendors) {
      for (const route of [`/vendor/${slugForVendor.get(vendor)}`, `/alternative-to/${slugForVendor.get(vendor)}`]) {
        const page = await fetchText(baseline.base, route);
        if (page.status !== 200) continue;
        read += 1;
        const surfaces = [readableText(page.body), ...structuredAnswers(page.body)];
        if (surfaces.some((text) => OUR_OWN_RECORD_QUOTED_AS_LATEST.test(text))) quoted.push(route);
      }
    }
    assert.deepStrictEqual(quoted, []);
    assertPopulationFloor(read, 1, "vendor and alternatives pages read for those vendors");
  });

  it("answers in the verdict's words, and counts no vendor change, where every record we hold is ours", async () => {
    const served = loadDealChanges();
    const allOurs = [...storedByVendor()]
      .filter(([vendor, records]) => slugForVendor.has(vendor) && records.every(isOurOwnBookkeeping))
      .map(([vendor]) => vendor);
    assertPopulationFloor(allOurs.length, 1, "vendors whose every record is our own bookkeeping");
    const wrong: string[] = [];
    for (const vendor of allOurs) {
      const page = await fetchText(baseline.base, `/vendor/${slugForVendor.get(vendor)}`);
      if (page.status !== 200) continue;
      const sentence = ourOwnRecordsSentence(served.filter((c: DealChange) => c.vendor === vendor));
      const answers = structuredAnswers(page.body);
      if (countOnVendorPage(page.body, vendor) !== null) wrong.push(`${vendor}: counts a vendor change`);
      if (!readableText(page.body).includes(sentence)) wrong.push(`${vendor}: the page does not say "${sentence}"`);
      if (!answers.some((a) => a.includes(sentence))) wrong.push(`${vendor}: the FAQ structured data does not say "${sentence}"`);
    }
    assert.deepStrictEqual(wrong, []);
  });

  for (const [how] of OUR_OWN_BOOKKEEPING) {
    it(`counts one change fewer on both FAQs once the vendor's latest change is ${how}`, async () => {
      assert.ok(counted, "no vendor has two dated changes of its own and both FAQs, so nothing here can move");
      const server = marked.get(how)!;
      const vendorPage = await fetchText(server.base, `/vendor/${counted.slug}`);
      const alternativesPage = await fetchText(server.base, `/alternative-to/${counted.slug}`);
      assert.strictEqual(countOnVendorPage(vendorPage.body, counted.vendor), counted.onVendorPage - 1);
      assert.strictEqual(countOnAlternativesPage(alternativesPage.body, counted.vendor), counted.onAlternativesPage - 1);
      const latestQuoted = readableText(vendorPage.body).split("Most recently:")[1]?.slice(0, 200) ?? "";
      assert.ok(
        !latestQuoted.includes(counted.latest.summary.slice(0, 40)),
        `${counted.vendor} still quotes the ${how} record as its latest change: ${latestQuoted}`,
      );
    });

    it(`dates free-tier longevity past a narrowing record once it is ${how}`, async () => {
      assert.ok(longevity, "no vendor's longevity is dated by a narrowing record, so nothing here can move");
      const res = await fetch(`${marked.get(how)!.base}/api/vendor-risk/${longevity.slug}`);
      const served = (await res.json()).free_tier_longevity_days;
      const expected = Math.max(0, Math.floor((Date.now() - longevity.startsAfter) / DAY_MS));
      assert.ok(served > longevity.served, `${longevity.vendor} still counts from ${longevity.narrowing.date}: ${served} days`);
      assert.ok(Math.abs(served - expected) <= 1, `${longevity.vendor} counts ${served} days where ${expected} were expected`);
    });
  }
});
