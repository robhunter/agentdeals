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
const { endingTheListingConfirms } = await import("../dist/vendor-verdict-input.js");
const { freeTierEndingRecord, loadDealChanges, loadOffers, riskCauseOf, vendorRiskAssessment } = await import("../dist/data.js");
const { isNoLongerInForce } = await import("../dist/change-resolution.js");
const { toSlug } = await import("../dist/vendor-slug.js");
const { utcDate } = await import("../dist/ranking.js");

const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function record(over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Fixture Vendor",
    change_type: "open_source_killed",
    date: THIRTY_DAYS_AGO,
    date_source: "vendor_page",
    summary: "The open-source edition is no longer maintained; development continues in a commercial edition.",
    previous_state: "Open-source edition",
    current_state: "Commercial edition with a free single-node plan",
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

describe("a move away from open source lowers the rating without ending the free tier", () => {
  it("rates the listing risky and states its free tier as offered", () => {
    assert.deepStrictEqual(freeTierClaim(inputFor([record()], "Free")), { states: "offered", level: "risky" });
  });

  it("still states the free tier ended on a removal of the same age", () => {
    assert.strictEqual(freeTierClaim(inputFor([record({ change_type: "free_tier_removed" })], "Free")).states, "ended");
  });

  it("is not the record that ends a free tier, even on a listing that holds none", () => {
    assert.strictEqual(freeTierEndingRecord([record()]), null);
    assert.strictEqual(endingTheListingConfirms({ tier: "Trial" }, [record()]), null);
    assert.notStrictEqual(endingTheListingConfirms({ tier: "Trial" }, [record({ change_type: "free_tier_removed" })]), null);
  });
});

function vendorsWhoseOnlyEndingTypeRecordIsAMoveAwayFromOpenSource(): string[] {
  const inForce = (loadDealChanges() as DealChange[]).filter(c => !isNoLongerInForce(c));
  const listed = new Set((loadOffers() as Array<{ vendor: string }>).map(o => o.vendor));
  return [...listed].filter(vendor => {
    const held = inForce.filter(c => c.vendor.toLowerCase() === vendor.toLowerCase());
    return held.some(c => c.change_type === "open_source_killed") && !held.some(c => c.change_type === "free_tier_removed");
  });
}

function textOf(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

describe("pages rate a vendor that moved away from open source without saying its free tier ended", () => {
  let proc: ChildProcess | null = null;
  let port = 0;
  const get = async (route: string) => (await fetch(`http://localhost:${port}${route}`)).text();

  before(async () => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
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

  it("gives each such vendor a page and a badge that state no ending", async () => {
    const population = vendorsWhoseOnlyEndingTypeRecordIsAMoveAwayFromOpenSource();
    assertPopulationFloor(population.length, 1, "listed vendors whose only ending-type record in force is a move away from open source");
    const statingAnEnding: string[] = [];
    for (const vendor of population) {
      const page = await get(`/vendor/${toSlug(vendor)}`);
      for (const ending of ["Its free tier has ended", "There is no free tier left to rate", "How it ended:", ">free tier removed<"]) {
        if (page.includes(ending)) statingAnEnding.push(`/vendor/${toSlug(vendor)}: ${ending}`);
      }
      const svg = await get(`/badge/${toSlug(vendor)}.svg`);
      const label = (svg.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").split(": ").slice(1).join(": ").split(" · ")[0].trim();
      if (/removed|ended|shut/i.test(label)) statingAnEnding.push(`/badge/${toSlug(vendor)}.svg: ${label}`);
      const level = vendorRiskAssessment((loadDealChanges() as DealChange[]).filter(c => c.vendor.toLowerCase() === vendor.toLowerCase())).level;
      if (level !== "stable" && label === "active") statingAnEnding.push(`/badge/${toSlug(vendor)}.svg: active on a ${level} rating`);
    }
    assert.deepStrictEqual(statingAnEnding, []);
  });

  it("states MinIO's AIStor Free terms in the storage comparison's row and card, with no ending badge", async () => {
    const html = await get("/storage-comparison-2026");
    const row = html.match(/<td class="provider-col">MinIO\b[\s\S]*?<\/tr>/)?.[0] ?? "";
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(m => textOf(m[1]!));
    assert.strictEqual(cells.length, 8, "the MinIO row did not render as eight cells");
    assert.strictEqual(cells[1], "Self-hosted, single node");
    assert.strictEqual(cells[6], "&#10003;");
    assert.doesNotMatch(row, /removed-badge|line-through/);
    const card = html.match(/<h3>MinIO\b([\s\S]*?)<\/h3>\s*<div class="diff-desc">([\s\S]*?)<\/div>/);
    assert.ok(card, "the MinIO card did not render");
    assert.doesNotMatch(card[1]!, /removed-badge/);
    assert.ok(
      textOf(card[2]!).startsWith("Cost: Free single-node AIStor, under a commercial licence. The original AGPLv3 edition is no longer maintained, with no bug fixes or security patches. The most widely deployed S3-compatible object storage."),
      textOf(card[2]!),
    );
  });

  it("leaves MinIO off the open-source card of vendors that cannot remove a free tier", async () => {
    const html = await get("/state-of-free-tiers");
    const card = html.match(/Open Source Safety Net<\/h3>[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? "";
    assert.match(card, /href="\/vendor\/gitea"/, "the open-source card did not render");
    assert.doesNotMatch(card, /\/vendor\/minio"/);
  });
});
