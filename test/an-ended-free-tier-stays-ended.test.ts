import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import type { DealChange } from "../dist/types.js";
import type { VendorVerdictInput } from "../dist/vendor-verdict.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { freeTierClaim } = await import("../dist/vendor-verdict.js");
const { endingTheListingConfirms, vendorVerdictContextFrom } = await import("../dist/vendor-verdict-input.js");
const { loadOffers, loadDealChanges, riskCauseOf, vendorRiskAssessment } = await import("../dist/data.js");
const { toSlug } = await import("../dist/vendor-slug.js");
const { utcDate } = await import("../dist/ranking.js");

const TWO_YEARS_AGO = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const ONE_YEAR_AGO = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function record(over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Fixture Vendor",
    change_type: "free_tier_removed",
    date: TWO_YEARS_AGO,
    date_source: "vendor_page",
    summary: "The free plan was withdrawn.",
    previous_state: "Free plan",
    current_state: "14-day trial",
    impact: "high",
    source_url: "https://fixture.example/pricing",
    ...over,
  } as DealChange;
}

function inputFor(changes: DealChange[], tier: string): VendorVerdictInput {
  const assessment = vendorRiskAssessment(changes);
  return {
    vendor: "Fixture Vendor",
    tier,
    level: assessment.level,
    historyLevel: assessment.level,
    cause: riskCauseOf(assessment.cause),
    endingTheListingConfirms: endingTheListingConfirms({ tier }, changes),
    changes,
    levelWithheld: null,
    unconfirmableSince: "",
    termsConfirmedOn: utcDate(),
    lastReadOn: utcDate(),
  };
}

describe("a free tier our record says ended stays ended after its first year", () => {
  it("rates a removal older than a year as caution, which is why the claim cannot rest on the level", () => {
    assert.strictEqual(vendorRiskAssessment([record()]).level, "caution");
  });

  it("states the free tier ended when the listing records no free tier either", () => {
    const claim = freeTierClaim(inputFor([record()], "Trial"));
    assert.strictEqual(claim.states, "ended");
    assert.strictEqual(claim.states === "ended" && claim.how === "removed" ? claim.cause.date : null, TWO_YEARS_AGO);
  });

  it("keeps the rating where the listing still records a free tier, as when a vendor ended one product's free plan and we list another that is free", () => {
    const claim = freeTierClaim(inputFor([record()], "Free (open-source library; managed cloud is paid-only)"));
    assert.deepStrictEqual(claim, { states: "offered", level: "caution" });
  });

  it("does not state an ending a later free tier reversed", () => {
    const restored = record({ change_type: "new_free_tier", date: ONE_YEAR_AGO, current_state: "Free plan again" });
    assert.strictEqual(endingTheListingConfirms({ tier: "Trial" }, [record(), restored]), null);
  });

  it("does not state an ending we retracted", () => {
    const retracted = record({ resolution: { state: "retracted", date: utcDate(), detail: "Not a removal." } } as Partial<DealChange>);
    assert.strictEqual(endingTheListingConfirms({ tier: "Trial" }, [retracted]), null);
  });

  it("does not state an ending from a record that cites no source", () => {
    assert.strictEqual(endingTheListingConfirms({ tier: "Trial" }, [record({ source_url: "" })]), null);
  });

  it("names the record that ended the free tier as the cause, not a later narrowing that set the level", () => {
    const narrowing = record({ change_type: "limits_reduced", date: THIRTY_DAYS_AGO, summary: "The trial got shorter." });
    const input = inputFor([record(), narrowing], "Trial");
    assert.strictEqual(input.cause?.change_type, "limits_reduced", "the narrowing does not set the level, so this proves nothing");
    const claim = freeTierClaim(input);
    assert.strictEqual(claim.states === "ended" && claim.how === "removed" ? claim.cause.change_type : null, "free_tier_removed");
  });
});

describe("no badge sells a free tier that our record and our listing both say has ended", () => {
  let proc: ChildProcess | null = null;
  let port = 0;

  before(async () => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    proc = child;
    port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(parseInt(m[1], 10)); }
      });
    });
  });

  after(() => { proc?.kill(); });

  it("labels each such vendor's badge as ended or unrated, never as a free tier on offer", async () => {
    const offers = loadOffers();
    const changes = loadDealChanges();
    const vendors = [...new Set(offers.map((o: { vendor: string }) => o.vendor))] as string[];
    const population = vendors.filter((vendor) => {
      const vendorChanges = changes.filter((c: DealChange) => c.vendor.toLowerCase() === vendor.toLowerCase());
      const listing = offers.find((o: { vendor: string }) => o.vendor === vendor)!;
      return endingTheListingConfirms(listing, vendorChanges) !== null;
    });
    assertPopulationFloor(population.length, 1, "vendors whose record and listing both say the free tier ended");

    const sellingOne: string[] = [];
    for (const vendor of population) {
      const svg = await (await fetch(`http://localhost:${port}/badge/${toSlug(vendor)}.svg`)).text();
      const label = (svg.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").split(": ").slice(1).join(": ").split(" · ")[0].trim();
      if (["active", "at risk", "stale"].includes(label)) sellingOne.push(`${vendor}: ${label}`);
    }
    assert.deepStrictEqual(sellingOne, [], "a badge says the free tier is on offer where our record and our listing say it ended");
  });

  it("builds the same ending into the verdict every surface reads", () => {
    const offers = loadOffers();
    const changes = loadDealChanges();
    const vendor = offers.find((o: { vendor: string; tier: string }) => {
      const vendorChanges = changes.filter((c: DealChange) => c.vendor.toLowerCase() === o.vendor.toLowerCase());
      return endingTheListingConfirms(o, vendorChanges) !== null;
    })!;
    const vendorChanges = changes.filter((c: DealChange) => c.vendor.toLowerCase() === vendor.vendor.toLowerCase());
    const context = vendorVerdictContextFrom({
      vendor: vendor.vendor,
      vendorOffers: offers.filter((o: { vendor: string }) => o.vendor === vendor.vendor),
      vendorChanges,
      refusedReads: [],
      servedOn: utcDate(),
    });
    assert.deepStrictEqual(context!.input.endingTheListingConfirms, endingTheListingConfirms(vendor, vendorChanges));
  });
});
