import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toSlug } from "../dist/vendor-slug.js";
import { unconfirmedChangeNotice, ratingWithheldSentence } from "../dist/change-citation.js";
import { AN_UNCONFIRMED_CHANGE_SETS_NO_LABEL, ARCHIVE_CHECK_OUTCOMES } from "../dist/change-confirmation.js";
import { WITHHOLDING_BADGE_LABELS } from "../dist/vendor-verdict.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY_MS = 86_400_000;
const daysFromToday = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

const UNCONFIRMED = "Unconfirmed Change Fixture Hosting";
const CONFIRMED = "Confirmed Change Fixture Hosting";
const NARROWED = "Unconfirmed Narrowing Fixture Store";
const NARROWED_CATEGORY = "Unconfirmed Narrowing Fixture Storage";
const CONFIRMED_ON = daysFromToday(-5);
const RECORDED_ON = daysFromToday(-20);

function listingFor(vendor: string) {
  return {
    vendor,
    category: "Cloud Hosting",
    description: "Pay-as-you-go plans only; the free plan of 1 GB and 100 hours a month ended.",
    tier: "Free",
    url: `https://${toSlug(vendor)}.example/pricing`,
    tags: [],
    verifiedDate: CONFIRMED_ON,
    source_check: { checked: CONFIRMED_ON, outcome: "ok", detail: `the page names ${vendor} and states the terms we publish` },
  };
}

function removalRecordFor(vendor: string, outcome: string) {
  return {
    vendor,
    change_type: "free_tier_removed",
    date: RECORDED_ON,
    summary: "The free plan of 1 GB and 100 hours a month is no longer offered.",
    previous_state: "Free plan: 1 GB and 100 hours a month.",
    current_state: "Pay-as-you-go plans only.",
    impact: "high",
    source_url: `https://${toSlug(vendor)}.example/pricing`,
    category: "Cloud Hosting",
    alternatives: [],
    recorded_date: RECORDED_ON,
    date_source: "discovered",
    archive_check: { checked: CONFIRMED_ON, outcome },
  };
}

function narrowedListing() {
  return { ...listingFor(NARROWED), category: NARROWED_CATEGORY, description: "Free plan: 1 GB and 100 hours a month." };
}

function unconfirmedNarrowingRecord() {
  return {
    ...removalRecordFor(NARROWED, "no_usable_capture"),
    change_type: "limits_reduced",
    summary: "The free plan's storage fell from 2 GB to 1 GB.",
    previous_state: "Free plan: 2 GB and 100 hours a month.",
    current_state: "Free plan: 1 GB and 100 hours a month.",
    impact: "medium",
    category: NARROWED_CATEGORY,
  };
}

function startServer(env: NodeJS.ProcessEnv): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 120000);
    child.stderr!.on("data", (data: Buffer) => {
      const found = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(found[1]!, 10) }); }
    });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

function decoded(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("a vendor whose only label-setting change no archived copy could confirm", () => {
  let tmp = "";
  let server: { proc: ChildProcess; port: number } | undefined;
  const get = async (route: string) => fetch(`http://localhost:${server!.port}${route}`);

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "unconfirmed-change-pages-"));
    const index = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    index.offers.push(listingFor(UNCONFIRMED), listingFor(CONFIRMED), narrowedListing());
    const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
    changes.changes.push(
      removalRecordFor(UNCONFIRMED, "no_usable_capture"),
      removalRecordFor(CONFIRMED, "vendor_changed"),
      unconfirmedNarrowingRecord(),
    );
    writeFileSync(path.join(tmp, "index.json"), JSON.stringify(index));
    writeFileSync(path.join(tmp, "deal_changes.json"), JSON.stringify(changes));
    server = await startServer({
      AGENTDEALS_INDEX_PATH: path.join(tmp, "index.json"),
      AGENTDEALS_CHANGES_PATH: path.join(tmp, "deal_changes.json"),
    });
  });

  after(() => {
    server?.proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("publishes no risk level and names the unconfirmed reason in the API", async () => {
    const body = await (await get(`/api/offers?q=${encodeURIComponent("Change Fixture Hosting")}`)).json();
    const byVendor = new Map(body.offers.map((o: { vendor: string }) => [o.vendor, o]));
    const unconfirmed = byVendor.get(UNCONFIRMED) as { risk_level: string | null; rating_withheld: unknown };
    const confirmed = byVendor.get(CONFIRMED) as { risk_level: string | null; rating_withheld: unknown };
    assert.ok(unconfirmed && confirmed, `both fixture listings are served: ${[...byVendor.keys()].join(", ")}`);
    assert.strictEqual(unconfirmed.risk_level, null);
    assert.deepStrictEqual(unconfirmed.rating_withheld, { reason: "unconfirmed", records: 1 });
    assert.strictEqual(confirmed.risk_level, "risky");
    assert.strictEqual(confirmed.rating_withheld, null);
  });

  it("labels the vendor's badge unrated for an unconfirmed change", async () => {
    const badge = await (await get(`/badge/${toSlug(UNCONFIRMED)}.svg`)).text();
    assert.ok(badge.includes(`>${WITHHOLDING_BADGE_LABELS.unconfirmed}<`), badge.slice(0, 400));
  });

  it("says on the vendor page why there is no rating, and marks the record right after its summary", async () => {
    const page = decoded(await (await get(`/vendor/${toSlug(UNCONFIRMED)}`)).text());
    assert.ok(
      page.includes(`No rating: ${ratingWithheldSentence(UNCONFIRMED, { unsourced: 0, unconfirmed: 1 })}`),
      "the page says why it publishes no rating",
    );
    assert.ok(
      page.includes(`The free plan of 1 GB and 100 hours a month is no longer offered. ${unconfirmedChangeNotice(UNCONFIRMED)}`),
      "the history marks the record as unconfirmed right after its summary",
    );
  });

  it("leaves a confirmed record's vendor page and badge rated and unmarked", async () => {
    const page = decoded(await (await get(`/vendor/${toSlug(CONFIRMED)}`)).text());
    assert.ok(!page.includes(unconfirmedChangeNotice(CONFIRMED)));
    assert.ok(!page.includes("No rating:"));
    const badge = await (await get(`/badge/${toSlug(CONFIRMED)}.svg`)).text();
    assert.ok(!badge.includes(WITHHOLDING_BADGE_LABELS.unconfirmed));
  });

  it("states the rule on /criteria and the reason in the API schema", async () => {
    assert.ok(decoded(await (await get("/criteria")).text()).includes(AN_UNCONFIRMED_CHANGE_SETS_NO_LABEL));
    const schema = await (await get("/openapi.json")).text();
    assert.ok(schema.includes('"enum":["no_source","unconfirmed"]'), "the schema lists both withholding reasons");
    const vendorRisk = JSON.parse(schema).paths["/api/vendor-risk/{vendor}"].get.responses["200"].content["application/json"].schema;
    assert.match(
      vendorRisk.properties.risk_level.description,
      /rating_withheld is non-null \(#1352, #1952\): the only records that would rate this vendor cite no source or are changes no archived copy of its page has confirmed\./,
    );
  });

  it("withholds a stack candidate's favourable class for an unconfirmed narrowing and says so", async () => {
    const body = await (await get(`/api/stack?use_case=fixture&requirements=${encodeURIComponent(NARROWED_CATEGORY)}`)).json();
    const candidate = body.stack.flatMap((role: { candidates: unknown[] }) => role.candidates)
      .find((c: { vendor: string }) => c.vendor === NARROWED) as Record<string, unknown> | undefined;
    assert.ok(candidate, JSON.stringify(body).slice(0, 400));
    assert.deepStrictEqual(candidate.stability_withheld, { reason: "unconfirmed", records: 1 });
    assert.strictEqual(candidate.stability, null);
    assert.strictEqual(candidate.stability_withheld_because, "unconfirmed");
  });

  it("documents the archive check that /api/changes serves on a record", async () => {
    const served = await (await get(`/api/changes?vendor=${encodeURIComponent(UNCONFIRMED)}&since=2020-01-01`)).json();
    const marked = served.changes.find((c: { vendor: string }) => c.vendor === UNCONFIRMED);
    assert.strictEqual(marked?.archive_check?.outcome, "no_usable_capture", JSON.stringify(served).slice(0, 400));

    const schema = JSON.parse(await (await get("/openapi.json")).text());
    const published = schema.components.schemas.PublishedDealChange.allOf[1].properties;
    assert.deepStrictEqual(published.archive_check.properties.outcome.enum, ARCHIVE_CHECK_OUTCOMES);
    assert.match(published.archive_check.description, /Only the outcome no_usable_capture changes how the record counts/);

    const stackCandidate = schema.paths["/api/stack"].get.responses["200"].content["application/json"].schema
      .properties.stack.items.properties.candidates.items.properties;
    assert.deepStrictEqual(stackCandidate.stability_withheld.properties.reason.enum, ["no_source", "unconfirmed"]);
    assert.match(stackCandidate.stability_withheld.description, /\(unconfirmed, #1952\), so a favourable stability class is withheld rather than published\. Where both kinds stand, reason is unconfirmed; records counts both\./);
    assert.match(stackCandidate.stability.description, /a narrowing that cites no source or that no archived copy of the vendor's page has confirmed, or a gated listing\./);
  });
});
