import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISCONTINUATION_DATE_UNRESOLVED,
  deprecationEndsTheListedProduct,
  discontinuationDate,
  discontinuationDateStatedInText,
} from "../dist/product-deprecation.js";
import { discontinuedGateFor, gateFor, rankOffers } from "../dist/ranking.js";
import { gateClauseList } from "../dist/gate-disclosure.js";
import { changesForVendor, loadDealChanges, loadOffers } from "../dist/data.js";
import { toSlug } from "../dist/slug.js";
import type { DealChange, Offer } from "../dist/types.js";

const TODAY = "2026-09-20";

function record(over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Vendor A",
    date: "2026-08-01",
    date_source: "vendor_page",
    change_type: "product_deprecated",
    summary: "",
    previous_state: "",
    current_state: "",
    impact: "high",
    source_url: "",
    category: "Databases",
    alternatives: [],
    ...over,
  } as DealChange;
}

function offer(over: Partial<Offer> = {}): Offer {
  return {
    vendor: "Vendor A",
    category: "Databases",
    tier: "Free",
    description: "1 GB storage",
    url: "https://example.com/pricing",
    verifiedDate: TODAY,
    ...over,
  } as Offer;
}

const catalogue = loadOffers();
const changeLog = loadDealChanges();

function offersFor(vendor: string): Offer[] {
  return catalogue.filter((o) => o.vendor.toLowerCase() === vendor.toLowerCase());
}

interface PastDeprecation {
  change: DealChange;
  statedInText: string;
}

function deprecationsNamingAPastDayInTheirOwnText(today: string): PastDeprecation[] {
  const found: PastDeprecation[] = [];
  for (const change of changeLog) {
    const statedInText = discontinuationDateStatedInText(change);
    if (!statedInText || statedInText > today) continue;
    found.push({ change, statedInText });
  }
  return found;
}

describe("a deprecation record states the day the product stops", () => {
  it("prefers the day the record states to the day its prose names", () => {
    const stated = record({
      vendor: "Acme",
      summary: "Acme is shutting down on December 31, 2027.",
      discontinued_date: "2026-06-30",
    });
    assert.strictEqual(discontinuationDateStatedInText(stated), "2027-12-31");
    assert.strictEqual(discontinuationDate(stated), "2026-06-30");
  });

  it("reads an unresolved field as a record that names no day, whatever its prose says", () => {
    const unresolved = record({
      vendor: "Acme",
      summary: "Acme is shutting down on August 10, 2026.",
      discontinued_date: DISCONTINUATION_DATE_UNRESOLVED,
    });
    assert.strictEqual(discontinuationDateStatedInText(unresolved), "2026-08-10");
    assert.strictEqual(discontinuationDate(unresolved), null);
  });

  it("falls back to the prose for a record carrying no field at all", () => {
    const noField = record({ vendor: "Acme", summary: "Acme is shutting down on August 10, 2026." });
    assert.strictEqual(discontinuationDate(noField), "2026-08-10");
  });

  it("ignores a field that is not a day", () => {
    const malformed = record({
      vendor: "Acme",
      summary: "Acme is shutting down on August 10, 2026.",
      discontinued_date: "August 2026",
    });
    assert.strictEqual(discontinuationDate(malformed), "2026-08-10");
  });

  it("states no day for a record that ends a product other than the one we list", () => {
    const other = record({ vendor: "AWS", summary: "AWS Proton end of support on October 7, 2026.", discontinued_date: "2026-10-07" });
    assert.ok(!deprecationEndsTheListedProduct(other));
    assert.strictEqual(discontinuationDate(other), null);
  });
});

describe("a product whose stated day has passed is gated rather than demerited", () => {
  const ended = record({ vendor: "Acme", summary: "Acme is shutting down.", discontinued_date: "2026-08-10" });

  it("gates the offer from the day the record names", () => {
    assert.strictEqual(gateFor(offer({ vendor: "Acme" }), "2026-08-09", [ended]), null);
    assert.strictEqual(gateFor(offer({ vendor: "Acme" }), "2026-08-10", [ended])?.code, "product_discontinued");
    assert.strictEqual(gateFor(offer({ vendor: "Acme" }), TODAY, [ended])?.code, "product_discontinued");
  });

  it("names the day in the reason it publishes", () => {
    assert.strictEqual(
      discontinuedGateFor({ vendor: "Acme" }, [ended], TODAY)?.reason,
      "Acme was discontinued on 2026-08-10, so it is not a current option.",
    );
  });

  it("leaves an offer with no such record alone", () => {
    assert.strictEqual(gateFor(offer({ vendor: "Acme" }), TODAY, []), null);
  });

  it("lets the tier the offer states answer first when both end it", () => {
    assert.strictEqual(gateFor(offer({ vendor: "Acme", tier: "Retired" }), TODAY, [ended])?.code, "offer_retired");
  });

  it("takes the offer off the ranked list and onto the gated tail", () => {
    const candidates = [offer({ vendor: "Acme" }), offer({ vendor: "Beta", url: "https://beta.example/pricing" })];
    const ranked = rankOffers(candidates, { queryKey: "t", changes: [ended], date: TODAY });
    assert.deepStrictEqual(ranked.ranked.map((e) => e.offer.vendor), ["Beta"]);
    assert.deepStrictEqual(ranked.excluded.map((e) => e.offer.vendor), ["Acme"]);
    assert.strictEqual(ranked.excluded[0].gate.code, "product_discontinued");
  });

  it("publishes a clause for the code so a gated list can say why", () => {
    assert.strictEqual(gateClauseList(["product_discontinued"]), "1 has been discontinued");
    assert.strictEqual(gateClauseList(["product_discontinued", "product_discontinued"]), "2 have been discontinued");
  });
});

describe("nothing we hold ranks as a free tier past the day its own record ends it", () => {
  const past = deprecationsNamingAPastDayInTheirOwnText(TODAY);

  it("reads a non-empty set of records naming a day that has passed", () => {
    assert.ok(past.length > 0, "no deprecation record we hold names a discontinuation day in the past");
  });

  it("gates every offer held by a vendor whose record names a day that has passed", () => {
    const ranking = past.flatMap(({ change, statedInText }) =>
      offersFor(change.vendor)
        .filter((held) => gateFor(held, TODAY, changesForVendor(held.vendor)) === null)
        .map((held) => `${held.vendor} [${held.tier}] ranks on ${TODAY}, ${statedInText} after its own record ends it`),
    );
    assert.deepStrictEqual(ranking, []);
  });

  it("checks that against a non-empty set of offers", () => {
    const checked = past.flatMap(({ change }) => offersFor(change.vendor));
    assert.ok(checked.length > 0, "no offer we hold belongs to a vendor whose record names a past discontinuation day");
  });
});

describe("a record that ends another product, or names a day still ahead, keeps its listing", () => {
  const ENDS_ANOTHER_PRODUCT = ["Firebase", "Google Gemini API", "Google Tenor API", "MiniMax"];

  for (const vendor of ENDS_ANOTHER_PRODUCT) {
    it(`leaves ${vendor} where the fix found it`, () => {
      const deprecations = changesForVendor(vendor).filter((c) => c.change_type === "product_deprecated");
      assert.ok(deprecations.length > 0, `${vendor} holds no deprecation record to act as a control`);
      assert.ok(
        deprecations.every((c) => !deprecationEndsTheListedProduct(c)),
        `${vendor}'s deprecation now reads as ending the product we list`,
      );
      for (const held of offersFor(vendor)) {
        assert.notStrictEqual(
          gateFor(held, TODAY, changesForVendor(vendor))?.code,
          "product_discontinued",
          `${vendor} [${held.tier}] is gated by a record that ends another product`,
        );
      }
    });
  }

  it("holds a vendor whose free plan outlives the announcement until the day it names", () => {
    const outliving = changeLog.filter(
      (c) => discontinuationDate(c) !== null && (discontinuationDate(c) as string) > TODAY,
    );
    assert.ok(outliving.length > 0, "no deprecation we hold names a day still ahead of us");
    for (const change of outliving) {
      const day = discontinuationDate(change) as string;
      const dayBefore = new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
      for (const held of offersFor(change.vendor)) {
        assert.notStrictEqual(
          gateFor(held, dayBefore, changesForVendor(held.vendor))?.code,
          "product_discontinued",
          `${held.vendor} is discontinued on ${dayBefore}, a day before the ${day} its record names`,
        );
        assert.strictEqual(
          gateFor(held, day, changesForVendor(held.vendor))?.code,
          "product_discontinued",
          `${held.vendor} still ranks on ${day}, the day its own record ends it`,
        );
      }
    }
  });
});

describe("the vendor page for a discontinued product no longer answers that it is free", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const REPO = path.join(__dirname, "..");
  const discontinued = deprecationsNamingAPastDayInTheirOwnText(TODAY)
    .flatMap(({ change }) => offersFor(change.vendor))
    .filter((held, at, all) => all.findIndex((o) => o.vendor === held.vendor) === at);

  let proc: ChildProcess | null = null;
  let port = 0;

  before(async () => {
    const started = await new Promise<{ child: ChildProcess; port: number }>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    proc = started.child;
    port = started.port;
  });

  after(() => { proc?.kill(); });

  const get = async (at: string) => {
    const res = await fetch(`http://localhost:${port}${at}`);
    return { status: res.status, text: await res.text() };
  };

  const headingOf = (html: string): string => {
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
    return (h1?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
  };

  const faqAnswers = (html: string): string[] => {
    const answers: string[] = [];
    for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      if (!block[1].includes("FAQPage")) continue;
      for (const entry of JSON.parse(block[1]).mainEntity ?? []) answers.push(entry.acceptedAnswer.text);
    }
    return answers;
  };

  it("reads a non-empty set of vendor pages", () => {
    assert.ok(discontinued.length > 0, "no vendor page belongs to a product a record has already ended");
  });

  for (const held of discontinued) {
    const at = `/vendor/${toSlug(held.vendor)}`;

    it(`keeps ${at} answering, and answers what happened`, async () => {
      const page = await get(at);
      assert.strictEqual(page.status, 200);
      const day = discontinuationDate(
        changesForVendor(held.vendor).find((c) => discontinuationDate(c) !== null) as DealChange,
      );
      assert.ok(page.text.includes(`was discontinued on ${day}`), `${at} does not say when ${held.vendor} stopped`);
    });

    it(`does not headline ${at} as a free tier`, async () => {
      const heading = headingOf((await get(at)).text);
      assert.ok(!/free tier/i.test(heading), `${at} still heads the page "${heading}"`);
    });

    it(`does not answer that ${held.vendor} offers a free tier`, async () => {
      const affirmative = faqAnswers((await get(at)).text)
        .filter((answer) => answer.startsWith(`Yes, ${held.vendor} offers a free tier`));
      assert.deepStrictEqual(affirmative, []);
    });
  }
});
