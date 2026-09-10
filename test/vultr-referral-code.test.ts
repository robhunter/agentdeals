import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, vendorsInTheCatalogue } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_CODES_PATH = path.join(__dirname, "..", "data", "platform_codes.json");

const { getBestReferralCode, getPlatformCodeForVendor, getAllPlatformCodes, listAllReferralCodes } = await import("../dist/platform-codes.js");
const { ourReferralLinkFor, platformCodeAsVendorReferral, referralTypeOfPlatformCode } = await import("../dist/referral-surfaces.js");
const { loadOffers } = await import("../dist/data.js");

const VENDOR = "Vultr DNS";
const SLUG = "vultr-dns";
const PUBLISHED_CODE = "9920277-9J";
const PUBLISHED_URL = "https://www.vultr.com/?ref=9920277-9J";
const READER_BENEFIT = "$300 in credit";
const FALLBACK_CODE = "9920276";
const CONDITIONS = [
  "A valid credit card or PayPal must be linked to claim the credit",
  "Unused credit expires 30 days after signup",
  "Vultr states this promotion is available for a limited time",
];

const store = JSON.parse(fs.readFileSync(PLATFORM_CODES_PATH, "utf-8"));
const rowsFor = (vendor: string) => store.platform_codes.filter((c: any) => c.vendor === vendor);

let serverProc: ChildProcess | null = null;
let port = 0;

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 15000);
    proc.stderr!.on("data", (data: Buffer) => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ proc, port: parseInt(match[1], 10) });
      }
    });
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function sitemapPaths(): Promise<string[]> {
  const indexRes = await fetch(`http://localhost:${port}/sitemap.xml`);
  assert.strictEqual(indexRes.status, 200);
  const children = [...(await indexRes.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.ok(children.length >= 4, `sitemap index listed ${children.length} sitemaps`);

  const paths = new Set<string>(["/"]);
  for (const child of children) {
    const childPath = new URL(child, "http://localhost").pathname;
    const res = await fetch(`http://localhost:${port}${childPath}`);
    assert.strictEqual(res.status, 200, `${childPath} answered ${res.status}`);
    for (const m of (await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      paths.add(new URL(m[1], "http://localhost").pathname);
    }
  }
  return [...paths];
}

function readableText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ");
}

const CREDIT_AFTER_VULTR = /Vultr[^$]{0,200}?\$([\d,]+(?:\.\d+)?)\s*(?:in\s+)?(?:free\s+)?credits?\b/gi;

describe("the record carries the terms the reader is held to and the terms we are paid under", () => {
  it("publishes one Vultr code and keeps the second stored but inactive", () => {
    const rows = rowsFor(VENDOR);
    assert.strictEqual(rows.length, 2, "both Vultr codes belong on the record");

    const published = rows.filter((c: any) => c.active);
    assert.strictEqual(published.length, 1, "exactly one Vultr code may be published");
    assert.strictEqual(published[0].code, PUBLISHED_CODE);
    assert.strictEqual(published[0].referee_benefit, READER_BENEFIT);

    const fallback = rows.find((c: any) => c.code === FALLBACK_CODE);
    assert.ok(fallback, `${FALLBACK_CODE} must stay on the record as the documented fallback`);
    assert.strictEqual(fallback.active, false);
    assert.strictEqual(fallback.referee_benefit, "", "the fallback pays the reader nothing, and the record should say so");
  });

  it("never offers a code that gives the reader nothing", () => {
    for (const code of getAllPlatformCodes()) {
      assert.ok(
        code.referee_benefit.trim().length > 0,
        `${code.vendor} ${code.code} is published with no reader benefit — a code that pays only us must not be active`
      );
    }
  });

  it("states each reader-facing condition where the reader is asked to act", () => {
    const published = rowsFor(VENDOR).find((c: any) => c.active);
    assert.deepStrictEqual(published.restrictions, CONDITIONS);
  });

  it("keeps the qualification we are paid under off the list the reader is asked to meet", () => {
    const published = rowsFor(VENDOR).find((c: any) => c.active);
    assert.deepStrictEqual(published.payout_qualification, { active_days: 30, min_payments_usd: 100 });
    for (const restriction of published.restrictions) {
      assert.ok(
        !/verified sale|paid \$100|min_payments/i.test(restriction),
        `a condition on our payout is not something the reader must do: ${restriction}`
      );
    }
  });

  it("says in the conditions themselves that the offer is time-limited", () => {
    for (const code of getAllPlatformCodes()) {
      if (!code.limited_time) continue;
      assert.ok(
        code.restrictions.some((r: string) => /limited time/i.test(r)),
        `${code.vendor} is recorded as limited_time and the reader is told nothing about it`
      );
    }
  });

  it("dates the reading the terms came from", () => {
    const published = rowsFor(VENDOR).find((c: any) => c.active);
    assert.match(published.terms_verified, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(published.added_at, "2026-08-29");
  });

  it("reads a code that pays both sides as dual-sided", () => {
    assert.strictEqual(referralTypeOfPlatformCode(getPlatformCodeForVendor(VENDOR)!), "dual-sided");
    assert.strictEqual(
      referralTypeOfPlatformCode({ referee_benefit: "", referrer_compensation: "commission" } as any),
      "referrer-only"
    );
    assert.strictEqual(
      referralTypeOfPlatformCode({ referee_benefit: "$5 in credit", referrer_compensation: "none" } as any),
      "referee-only"
    );
  });
});

describe("the code resolves for the vendor whose page it renders on", () => {
  it("is keyed to the name the offer index holds", () => {
    const offer = loadOffers().find((o: any) => o.vendor === VENDOR);
    assert.ok(offer, "the offer index must still hold the record this code renders on");

    const resolved = getPlatformCodeForVendor(VENDOR);
    assert.strictEqual(resolved!.code, PUBLISHED_CODE);
    assert.strictEqual(getPlatformCodeForVendor("Vultr"), null, "a bare vendor name resolves to no page and must not resolve to a code");

    const link = ourReferralLinkFor(VENDOR, offer);
    assert.strictEqual(link!.url, PUBLISHED_URL);
    assert.deepStrictEqual(link!.restrictions, CONDITIONS);
  });

  it("reaches the tool that answers for one vendor", () => {
    const answer = platformCodeAsVendorReferral(VENDOR);
    assert.strictEqual(answer!.referral.code, PUBLISHED_CODE);
    assert.strictEqual(answer!.referral.url, PUBLISHED_URL);
    assert.strictEqual(answer!.referral.referee_value, READER_BENEFIT);
    assert.deepStrictEqual(answer!.referral.restrictions, CONDITIONS);
    assert.strictEqual(platformCodeAsVendorReferral("Hetzner DNS"), null);
  });

  it("carries the conditions into the listing an agent prefetches", () => {
    const best = getBestReferralCode(VENDOR);
    assert.strictEqual(best!.code, PUBLISHED_CODE);
    assert.deepStrictEqual(best!.restrictions, CONDITIONS);

    const listed = listAllReferralCodes().find((c: any) => c.vendor === VENDOR);
    assert.strictEqual(listed!.referee_benefit, READER_BENEFIT);
    assert.deepStrictEqual(listed!.restrictions, CONDITIONS);
    assert.ok(
      !listAllReferralCodes().some((c: any) => c.code === FALLBACK_CODE),
      "the fallback pays the reader nothing and must not be listed"
    );
  });

  it("leaves the code we already published resolving as before", () => {
    const railway = getBestReferralCode("Railway");
    assert.strictEqual(railway!.code, "7RZL9q");
    assert.strictEqual(railway!.referee_benefit, "$20 in credits");
  });
});

describe("every surface that offers the code also states its conditions", () => {
  let vendorPage = "";
  let referralPrograms = "";
  let disclosure = "";
  let byVendor: any = null;
  let referralEndpoint: any = null;

  before(async () => {
    const started = await startServer();
    serverProc = started.proc;
    port = started.port;
    vendorPage = await (await fetch(`http://localhost:${port}/vendor/${SLUG}`)).text();
    referralPrograms = await (await fetch(`http://localhost:${port}/referral-programs`)).text();
    disclosure = await (await fetch(`http://localhost:${port}/disclosure`)).text();
    byVendor = await (await fetch(`http://localhost:${port}/api/referral-codes/${encodeURIComponent(VENDOR)}`)).json();
    referralEndpoint = await (await fetch(`http://localhost:${port}/api/referral/${encodeURIComponent(VENDOR)}`)).json();
  });

  after(() => { serverProc?.kill(); });

  it("offers the reward and its conditions on the vendor page, conditions first", () => {
    assert.ok(vendorPage.includes(`Sign up via our referral link and get ${READER_BENEFIT}`));
    for (const condition of CONDITIONS) {
      assert.ok(vendorPage.includes(condition), `/vendor/${SLUG} should state: ${condition}`);
    }
    const conditionAt = vendorPage.indexOf(CONDITIONS[0]);
    const buttonAt = vendorPage.indexOf(`${PUBLISHED_URL}" rel="noopener sponsored"`);
    assert.ok(conditionAt > -1 && buttonAt > -1, "the page must carry both the conditions and the button");
    assert.ok(conditionAt < buttonAt, "the conditions must come before the button, not after it");
  });

  it("agrees with itself about what each side of the deal gets", () => {
    const text = readableText(vendorPage);
    assert.ok(text.includes("You Earn $100 cash per verified paid signup"), text.slice(text.indexOf("You Earn"), text.indexOf("You Earn") + 120));
    assert.ok(text.includes(`They Get ${READER_BENEFIT}`), "the documented program block must not contradict the button above it");
  });

  it("states them on the listing page that links straight out to the code", () => {
    const rowAt = referralPrograms.indexOf(`/vendor/${SLUG}" class="vendor-link"`);
    assert.ok(rowAt > -1, "/referral-programs should list the vendor");
    const row = referralPrograms.slice(rowAt, referralPrograms.indexOf("</tr>", rowAt));
    assert.ok(row.includes(PUBLISHED_URL), "the row links straight out to the code");
    for (const condition of CONDITIONS) {
      assert.ok(row.includes(condition), `the row that links out should state: ${condition}`);
    }
  });

  it("repeats them where we list who pays us", () => {
    for (const condition of CONDITIONS) {
      assert.ok(disclosure.includes(condition), `/disclosure should state: ${condition}`);
    }
  });

  it("hands them to an agent asking for the code", () => {
    assert.strictEqual(byVendor.code, PUBLISHED_CODE);
    assert.strictEqual(byVendor.referee_benefit, READER_BENEFIT);
    assert.deepStrictEqual(byVendor.restrictions, CONDITIONS);

    assert.strictEqual(referralEndpoint.referral_code, PUBLISHED_CODE);
    assert.strictEqual(referralEndpoint.referee_value, READER_BENEFIT);
    assert.strictEqual(referralEndpoint.type, "dual-sided");
    assert.deepStrictEqual(referralEndpoint.restrictions, CONDITIONS);
  });

  it("inlines the code on the offer an agent reads without asking twice", async () => {
    const listing = await (await fetch(`http://localhost:${port}/api/offers?category=${encodeURIComponent("DNS & Domain Management")}&limit=100`)).json();
    const vultr = listing.offers.find((o: any) => o.vendor === VENDOR);
    assert.ok(vultr, "the category listing should hold the vendor");
    assert.strictEqual(vultr.referral_code.code, PUBLISHED_CODE);
    assert.deepStrictEqual(vultr.referral_code.restrictions, CONDITIONS);

    const details = await (await fetch(`http://localhost:${port}/api/details/${encodeURIComponent(VENDOR)}`)).json();
    assert.strictEqual(details.offer.referral_code.code, PUBLISHED_CODE);
    assert.deepStrictEqual(details.offer.referral_code.restrictions, CONDITIONS);
  });

  it("publishes no Vultr credit figure that contradicts the record", async () => {
    const paths = await sitemapPaths();
    assertCoversPopulation(paths.length, vendorsInTheCatalogue(), "routes in the sitemap the sweep read");

    const offenders: string[] = [];
    let readerCreditMentions = 0;
    for (const p of paths) {
      const res = await fetch(`http://localhost:${port}${p}`);
      assert.strictEqual(res.status, 200, `${p} answered ${res.status}`);
      const text = readableText(await res.text());
      for (const match of text.matchAll(CREDIT_AFTER_VULTR)) {
        readerCreditMentions++;
        if (match[1] !== "300") {
          offenders.push(`${p}: ${match[0].trim().slice(0, 120)}`);
        }
      }
    }
    assert.ok(readerCreditMentions > 0, "the sweep found no Vultr credit figure at all, so it proves nothing");
    assert.deepStrictEqual(offenders, [], `every Vultr credit figure must be the ${READER_BENEFIT} on the record\n\n${offenders.join("\n")}`);
  });

  it("publishes the fallback code nowhere at all", async () => {
    const paths = await sitemapPaths();
    const offenders: string[] = [];
    for (const p of paths) {
      const html = await (await fetch(`http://localhost:${port}${p}`)).text();
      if (html.includes(FALLBACK_CODE)) offenders.push(p);
    }
    assert.deepStrictEqual(offenders, [], `${FALLBACK_CODE} pays the reader nothing and must not be published`);

    const listing = await (await fetch(`http://localhost:${port}/api/referral-codes`)).json();
    assert.ok(!JSON.stringify(listing).includes(FALLBACK_CODE), "the code listing must not carry the fallback either");
  });
});
