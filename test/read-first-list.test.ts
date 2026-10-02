import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { offerKey } from "../scripts/change-refusals.js";
import {
  FREE_PLAN_EXCERPT,
  FREE_PLAN_EXCERPT_HOLD,
  anExcerptMayBeWritten,
  excerptTheFreePlan,
} from "../scripts/free-plan-excerpt.js";
import {
  IN_QUARANTINE,
  MATCHES_NO_LISTING,
  TAKES_NO_QUOTE,
  placesOnTheReadFirstList,
  readReadFirstList,
} from "../scripts/read-first.js";
import { SOURCE_CHECK_OK } from "../scripts/vendor-naming.js";

const { pickOldestEntries, repickedNextRun, runAiMode, summaryLines } = await import("../scripts/reverify-rolling.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED_LIST = path.join(__dirname, "..", "data", "read_first.json");
const RUN = new Date("2026-10-03T06:00:00Z");

type Listing = { vendor: string; tier: string; url: string; [field: string]: unknown };

function listing(vendor: string, verifiedDate: string, extra: Record<string, unknown> = {}): Listing {
  return {
    vendor,
    tier: "Free",
    url: `https://${vendor.toLowerCase()}.example/pricing`,
    description: "Free plan includes 1,000 requests/mo",
    category: "API",
    verifiedDate,
    ...extra,
  };
}

function quoteFor(offer: Listing) {
  return { text: "Free plan includes 1,000 requests/mo", url: offer.url, read_on: "2026-09-01" };
}

function entry(offer: Listing) {
  return { vendor: offer.vendor, tier: offer.tier };
}

function draw(offers: Listing[], limit: number, listed: { vendor: string; tier: string }[], options: Record<string, unknown> = {}) {
  const { places } = placesOnTheReadFirstList(listed, offers);
  return pickOldestEntries(offers, limit, RUN, { readFirst: places, ...options });
}

function vendorsOf(drawn: { picked: { offer: Listing }[] }) {
  return drawn.picked.map((picked) => picked.offer.vendor);
}

const alder = listing("Alder", "2026-06-01");
const birch = listing("Birch", "2026-07-01", {
  source_check: { checked: "2026-07-01", outcome: SOURCE_CHECK_OK, detail: 'the page names Birch as "birch"' },
});
const fir = listing("Fir", "2026-08-15");
const elm = listing("Elm", "2026-09-01");
elm[FREE_PLAN_EXCERPT] = quoteFor(elm);
const dogwood = listing("Dogwood", "2026-09-25");
const cedar = listing("Cedar", "2026-09-30");
const CATALOGUE = [alder, birch, fir, elm, dogwood, cedar];
const LIST = [entry(dogwood), entry(cedar), entry(elm)];

describe("the read-first list", () => {
  it("is drawn before every older listing and before a check that kept only the name, in the list's order", () => {
    assert.deepStrictEqual(vendorsOf(draw(CATALOGUE, 2, LIST)), ["Dogwood", "Cedar"]);
    assert.deepStrictEqual(vendorsOf(draw(CATALOGUE, 2, [entry(cedar), entry(dogwood)])), ["Cedar", "Dogwood"]);
  });

  it("changes nothing when it is empty", () => {
    assert.deepStrictEqual(vendorsOf(draw(CATALOGUE, 6, [])), vendorsOf(pickOldestEntries(CATALOGUE, 6, RUN)));
    assert.deepStrictEqual(vendorsOf(draw(CATALOGUE, 6, [])), ["Birch", "Alder", "Fir", "Elm", "Dogwood", "Cedar"]);
  });

  it("leaves a listed listing that holds a quote in age order", () => {
    assert.deepStrictEqual(vendorsOf(draw(CATALOGUE, 6, LIST)), ["Dogwood", "Cedar", "Birch", "Alder", "Fir", "Elm"]);
  });

  it("keeps a held verdict's second reading ahead of it", () => {
    const awaitingCorroboration = new Set([offerKey(fir.vendor, fir.url)]);
    assert.deepStrictEqual(vendorsOf(draw(CATALOGUE, 1, LIST, { awaitingCorroboration })), ["Fir", "Dogwood"]);
  });

  it("keeps a listing named twice at its first place", () => {
    assert.deepStrictEqual(vendorsOf(draw(CATALOGUE, 2, [entry(dogwood), entry(cedar), entry(dogwood)])), ["Dogwood", "Cedar"]);
  });

  it("reports a name that matches no listing and ignores it", () => {
    const listed = [{ vendor: "Ghost", tier: "Free" }, ...LIST, { vendor: "Cedar", tier: "Pro" }];
    const { unmatched } = placesOnTheReadFirstList(listed, CATALOGUE);
    assert.deepStrictEqual(unmatched, [
      { vendor: "Ghost", tier: "Free", why: MATCHES_NO_LISTING },
      { vendor: "Cedar", tier: "Pro", why: MATCHES_NO_LISTING },
    ]);
    assert.deepStrictEqual(vendorsOf(draw(CATALOGUE, 6, listed)), vendorsOf(draw(CATALOGUE, 6, LIST)));
  });

  it("draws by age, and reports, a listed listing that takes no quote", () => {
    const licence = listing("Hazel", "2026-09-28", { tier: "Free OSS" });
    const paid = listing("Juniper", "2026-09-28", { tier: "Paid" });
    const held = listing("Larch", "2026-09-28", {
      [FREE_PLAN_EXCERPT_HOLD]: { record_date: "2026-06-18", change_type: "restriction", reason: "The page still states the quota this record says ended." },
    });
    const offers = [...CATALOGUE, licence, paid, held];
    const drawn = draw(offers, 3, [entry(licence), entry(paid), entry(held), entry(dogwood)]);
    assert.deepStrictEqual(vendorsOf(drawn), ["Dogwood", "Birch", "Alder"]);
    assert.deepStrictEqual(drawn.listedButNotDrawnFirst, [
      { vendor: "Hazel", tier: "Free OSS", why: TAKES_NO_QUOTE },
      { vendor: "Juniper", tier: "Paid", why: TAKES_NO_QUOTE },
      { vendor: "Larch", tier: "Free", why: TAKES_NO_QUOTE },
    ]);
  });

  it("leaves a listed listing in quarantine to its retry, and reports it", () => {
    const verificationState = new Map([
      [offerKey(dogwood.vendor, dogwood.url), { quarantined_since: "2026-09-20", last_attempt_at: "2026-09-30" }],
    ]);
    const drawn = draw(CATALOGUE, 2, LIST, { verificationState });
    assert.deepStrictEqual(vendorsOf(drawn), ["Cedar", "Birch"]);
    assert.deepStrictEqual(drawn.listedButNotDrawnFirst, [{ vendor: "Dogwood", tier: "Free", why: IN_QUARANTINE }]);
  });

  it("says in the run summary how many it drew and how many were waiting, and why any listed listing was not drawn first", () => {
    const drawn = draw(CATALOGUE, 1, LIST);
    assert.strictEqual(drawn.pickedFromTheReadFirstList, 1);
    assert.strictEqual(drawn.queuedOnTheReadFirstList, 2);
    const lines = summaryLines({ verified: 0 }, {
      checked: 1,
      ...drawn,
      notDrawnFirstFromTheReadFirstList: [{ vendor: "Ghost", tier: "Free", why: MATCHES_NO_LISTING }],
    });
    const at = lines.indexOf("Drawn first from the read-first list: 1 of 2");
    assert.ok(at > 0, lines.join("\n"));
    assert.deepStrictEqual(lines.slice(at + 1, at + 3), ["On the read-first list and not drawn first for a quote: 1", "  Ghost (Free): matches no listing"]);
    assert.ok(!summaryLines({ verified: 0 }, { checked: 1 }).some((line: string) => line.includes("read-first list")));
  });
});

describe("a listing drawn first for a quote", () => {
  const page = (offer: Listing) => `${offer.vendor} pricing. Free plan includes 1,000 requests/mo. Pro: $20 per month.`;

  async function readOnce(copied: string) {
    const scratch = mkdtempSync(path.join(tmpdir(), "read-first-"));
    const stores = {
      changesPath: path.join(scratch, "changes.json"),
      refusalsPath: path.join(scratch, "refusals.json"),
      corroborationPath: path.join(scratch, "corroboration.json"),
    };
    writeFileSync(stores.changesPath, JSON.stringify({ changes: [] }));
    try {
      const data = { offers: [{ ...alder }, { ...dogwood }] as Listing[] };
      const { places } = placesOnTheReadFirstList([entry(dogwood)], data.offers);
      const selection = { readFirst: places };
      const { picked } = pickOldestEntries(data.offers, 1, RUN, selection);
      await runAiMode(picked, data, false, RUN, {
        fetchFn: async (url: string) => ({ ok: true, text: page(data.offers.find((offer) => offer.url === url)!), truncated: false }),
        verifyFn: async () => ({ status: "confirmed" }),
        confirmFn: async () => ({ describes_change: true }),
        excerptFn: async () => ({ copied, terms: ["1,000 requests/mo"] }),
        rateLimitMs: 0,
        ...stores,
      });
      return { picked, data, repicked: repickedNextRun(picked, data.offers, 1, RUN, selection) };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("goes back to age order once the read stores a quote", async () => {
    const { picked, data, repicked } = await readOnce("Free plan includes 1,000 requests/mo.");
    assert.deepStrictEqual(picked.map((one: { offer: Listing }) => one.offer.vendor), ["Dogwood"]);
    assert.strictEqual((data.offers[1][FREE_PLAN_EXCERPT] as { text: string }).text, "Free plan includes 1,000 requests/mo.");
    assert.strictEqual(repicked, 0);
  });

  it("is drawn first again on the next run while it holds none", async () => {
    const { data, repicked } = await readOnce("");
    assert.ok(!(FREE_PLAN_EXCERPT in data.offers[1]));
    assert.strictEqual(repicked, 1);
  });
});

describe("whether a listing takes a quote", () => {
  const offers: [string, Listing][] = [
    ["a free tier", listing("Acme", "2026-09-01")],
    ["a Free OSS listing", listing("Acme", "2026-09-01", { tier: "Free OSS" })],
    ["a tier that is not a free plan", listing("Acme", "2026-09-01", { tier: "Paid" })],
    ["a listing under a hold", listing("Acme", "2026-09-01", {
      [FREE_PLAN_EXCERPT_HOLD]: { record_date: "2026-06-18", change_type: "restriction", reason: "The page still states the quota this record says ended." },
    })],
  ];

  for (const [subject, offer] of offers) {
    it(`agrees with whether a read asks for one, for ${subject}`, async () => {
      let asked = false;
      await excerptTheFreePlan({ ...offer }, {
        offer,
        pageText: "Acme pricing. Free plan includes 1,000 requests/mo.",
        read: async () => {
          asked = true;
          return { copied: "", terms: [] };
        },
        readOn: "2026-10-03",
      });
      assert.strictEqual(anExcerptMayBeWritten(offer), asked);
    });
  }
});

describe("reading the read-first list", () => {
  function written(text: string | null) {
    const scratch = mkdtempSync(path.join(tmpdir(), "read-first-list-"));
    const file = path.join(scratch, "read_first.json");
    if (text !== null) writeFileSync(file, text);
    try {
      return readReadFirstList(file);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("reads the listings in their order", () => {
    assert.deepStrictEqual(written(JSON.stringify({ listings: [{ vendor: "B", tier: "Free" }, { vendor: "A", tier: "Hobby" }] })), {
      listings: [{ vendor: "B", tier: "Free" }, { vendor: "A", tier: "Hobby" }],
      problem: null,
    });
  });

  it("is empty when there is no file", () => {
    assert.deepStrictEqual(written(null), { listings: [], problem: null });
  });

  it("is empty, with the problem named, when the file is not JSON or holds no listings array", () => {
    const broken = written("{ listings: ");
    assert.deepStrictEqual(broken.listings, []);
    assert.match(broken.problem ?? "", /is not JSON/);
    const shapeless = written(JSON.stringify({ listings: { vendor: "A" } }));
    assert.deepStrictEqual(shapeless.listings, []);
    assert.match(shapeless.problem ?? "", /holds no "listings" array/);
  });

  it("is committed as a listings array whose entries each name one vendor and tier once", () => {
    const { listings, problem } = readReadFirstList(COMMITTED_LIST);
    assert.strictEqual(problem, null);
    const raw = JSON.parse(readFileSync(COMMITTED_LIST, "utf-8"));
    assert.ok(Array.isArray(raw.listings));
    const malformed = listings.filter(
      (listed: unknown) =>
        typeof (listed as { vendor?: unknown })?.vendor !== "string" ||
        typeof (listed as { tier?: unknown })?.tier !== "string" ||
        !(listed as { vendor: string }).vendor.trim() ||
        !(listed as { tier: string }).tier.trim(),
    );
    assert.deepStrictEqual(malformed, []);
    const names = listings.map((listed: { vendor: string; tier: string }) => `${listed.vendor} (${listed.tier})`);
    assert.deepStrictEqual(names.filter((name: string, at: number) => names.indexOf(name) !== at), []);
  });
});
