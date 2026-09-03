import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DealChange } from "../src/types.ts";
import {
  EVENT_CANCELLED,
  RESOLUTION_STATES,
  fieldsAssertingAResolution,
  isNoLongerInForce,
  prosePutsAResolutionIn,
  resolutionTag,
  resolvingRecord,
  summaryWithResolution,
  theEventNeverHappened,
  withResolutionInSummary,
} from "../dist/change-resolution.js";
import {
  classifyStability,
  demotionForChange,
  demotionInForce,
  isSevereChange,
  loadDealChanges,
  vendorRiskAssessment,
} from "../dist/data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const stored: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")
).changes;

const change = (over: Partial<DealChange> = {}): DealChange => ({
  vendor: "Example",
  change_type: "restriction",
  date: "2026-04-20",
  summary: "The vendor paused new signups.",
  previous_state: "Open to new signups",
  current_state: "Paused",
  impact: "high",
  source_url: "https://example.com/changelog",
  category: "Cloud Hosting",
  alternatives: [],
  ...over,
});

const reversed = (over: Partial<DealChange> = {}) =>
  change({
    resolution: { state: "reversed", date: "2026-09-02", detail: "Reversed: signups are open again." },
    ...over,
  });

describe("a record can say its change is no longer in force", () => {
  it("carries the resolution wherever the summary is read", () => {
    assert.strictEqual(
      summaryWithResolution(reversed()),
      "No longer in force (2026-09-02). The vendor paused new signups. Reversed: signups are open again."
    );
  });

  it("states the resolution before the claim, and the explanation after it", () => {
    const served = summaryWithResolution(reversed());
    const tag = resolutionTag(reversed().resolution!);
    assert.ok(served.startsWith(tag), "the derived tag leads");
    assert.ok(
      served.indexOf("paused new signups") < served.indexOf("signups are open again"),
      "the detail stays behind the claim it explains"
    );
  });

  it("marks a record whose resolution carries no written detail", () => {
    const bare = change({ resolution: { state: "retracted", date: "2026-09-02" } });
    assert.strictEqual(
      summaryWithResolution(bare),
      "Retracted — this record was our error (2026-09-02). The vendor paused new signups."
    );
  });

  it("derives a different tag for a change the vendor ended than for one we withdrew", () => {
    assert.notStrictEqual(
      resolutionTag({ state: "reversed", date: "2026-09-02" }),
      resolutionTag({ state: "retracted", date: "2026-09-02" })
    );
    for (const state of RESOLUTION_STATES) {
      assert.match(resolutionTag({ state, date: "2026-09-02" }), /2026-09-02/, `${state} names its date`);
    }
  });

  it("leaves a record with no resolution exactly as stored", () => {
    const plain = change();
    assert.strictEqual(summaryWithResolution(plain), plain.summary);
    assert.strictEqual(withResolutionInSummary(plain), plain);
  });

  it("does not state the resolution twice when the summary already carries it", () => {
    const once = withResolutionInSummary(reversed());
    assert.strictEqual(withResolutionInSummary(once).summary, once.summary);
    const bare = withResolutionInSummary(change({ resolution: { state: "retracted", date: "2026-09-02" } }));
    assert.strictEqual(withResolutionInSummary(bare).summary, bare.summary);
  });

  it("separates a change the vendor ended from a record we withdrew", () => {
    assert.strictEqual(theEventNeverHappened(reversed()), false);
    assert.strictEqual(
      theEventNeverHappened(change({ resolution: { state: "retracted", date: "2026-09-02", detail: "Retracted." } })),
      true
    );
    assert.strictEqual(isNoLongerInForce(change()), false);
  });
});

describe("the resolution survives the render sites that cut the summary short", () => {
  const serveSource = readFileSync(path.join(REPO, "src", "serve.ts"), "utf-8");
  const cuts = [
    ...serveSource.matchAll(/summary[^\n]{0,60}?\.(?:substring|slice)\(0,\s*(\d+)\)/g),
  ].map((m) => Number(m[1]));
  const resolvedRecords = stored.filter(isNoLongerInForce);

  it("is measuring render sites that exist", () => {
    assert.ok(cuts.length >= 20, `render sites truncating a summary: ${cuts.length}`);
    assert.ok(resolvedRecords.length >= 3, `resolved records: ${resolvedRecords.length}`);
  });

  it("states the resolution inside the narrowest cut any render site makes", () => {
    const narrowest = Math.min(...cuts);
    for (const record of resolvedRecords) {
      const shown = summaryWithResolution(record).slice(0, narrowest);
      assert.ok(
        shown.includes(resolutionTag(record.resolution!)),
        `${record.vendor} ${record.date} cut at ${narrowest}: ${shown}`
      );
    }
  });

  it("leaves room for the claim itself after the tag", () => {
    const narrowest = Math.min(...cuts);
    for (const record of resolvedRecords) {
      const tag = resolutionTag(record.resolution!);
      assert.ok(
        narrowest - tag.length >= 60,
        `${record.vendor} ${record.date} leaves ${narrowest - tag.length} characters of claim`
      );
    }
  });

  it("reaches records a trailing sentence cannot", () => {
    const widest = Math.max(...cuts);
    const narrowest = Math.min(...cuts);
    const beyondAnAppend = resolvedRecords.filter((c) => {
      const detail = c.resolution!.detail;
      return detail ? !`${c.summary} ${detail}`.slice(0, widest).includes(detail) : false;
    });
    assert.ok(
      beyondAnAppend.length > 0,
      `resolved records whose detail cannot reach the widest cut: ${beyondAnAppend.length}`
    );
    for (const record of beyondAnAppend) {
      assert.ok(
        summaryWithResolution(record).slice(0, narrowest).includes(resolutionTag(record.resolution!)),
        `${record.vendor} ${record.date} is marked where its own detail could not reach`
      );
    }
  });
});

describe("a change no longer in force does not rate the vendor", () => {
  it("stops demoting on the type that would otherwise demote", () => {
    assert.strictEqual(demotionForChange(change()), "caution");
    assert.strictEqual(demotionForChange(reversed()), null);
    assert.strictEqual(demotionInForce(reversed(), Date.parse("2026-04-21T00:00:00Z")), null);
  });

  it("stops counting as severe when the vendor gave the free tier back", () => {
    const removal = change({ change_type: "free_tier_removed" });
    assert.strictEqual(isSevereChange(removal), true);
    assert.strictEqual(isSevereChange({ ...removal, resolution: reversed().resolution }), false);
  });

  it("cannot be the vendor's risk cause", () => {
    const nowMs = Date.parse("2026-05-01T00:00:00Z");
    assert.strictEqual(vendorRiskAssessment([change()], nowMs).level, "caution");
    const resolved = vendorRiskAssessment([reversed()], nowMs);
    assert.strictEqual(resolved.level, "stable");
    assert.strictEqual(resolved.cause, null);
  });

  it("names the still-standing record when a vendor has one of each", () => {
    const nowMs = Date.parse("2026-05-01T00:00:00Z");
    const standing = change({ date: "2026-04-01", summary: "Limits cut on the free plan." });
    const assessment = vendorRiskAssessment([reversed(), standing], nowMs);
    assert.strictEqual(assessment.level, "caution");
    assert.strictEqual(assessment.cause?.date, "2026-04-01");
  });

  it("leaves a vendor stable when its only adverse record has been reversed", () => {
    const nowMs = Date.parse("2026-05-01T00:00:00Z");
    assert.strictEqual(classifyStability([change()], nowMs), "watch");
    assert.strictEqual(classifyStability([reversed()], nowMs), "stable");
  });

  it("does not read a reversed record as the vendor improving", () => {
    const nowMs = Date.parse("2026-05-01T00:00:00Z");
    assert.strictEqual(classifyStability([reversed({ change_type: "new_free_tier" })], nowMs), "stable");
  });
});

describe("no record publishes a retraction the structured field does not hold", () => {
  it("finds a resolution asserted in prose", () => {
    assert.strictEqual(prosePutsAResolutionIn("Reversed: signups reopened."), true);
    assert.strictEqual(prosePutsAResolutionIn("Retracted 2026-09-02: no such plan."), true);
    assert.strictEqual(prosePutsAResolutionIn("The pause is no longer in force."), true);
    assert.strictEqual(prosePutsAResolutionIn("The vendor paused new signups."), false);
  });

  it("would fail on a record that states its retraction in free text alone", () => {
    const proseOnly = change({ summary: "The vendor paused new signups. Reversed: signups are open again." });
    assert.deepStrictEqual(fieldsAssertingAResolution(proseOnly), ["summary"]);
    assert.strictEqual(isNoLongerInForce(proseOnly), false);
  });

  it("does not count the resolution's own detail as free text", () => {
    assert.deepStrictEqual(fieldsAssertingAResolution(withResolutionInSummary(reversed())), []);
  });

  it("does not count the derived tag as free text either", () => {
    const bare = withResolutionInSummary(change({ resolution: { state: "retracted", date: "2026-09-02" } }));
    assert.ok(prosePutsAResolutionIn(bare.summary), "the tag reads as a resolution");
    assert.deepStrictEqual(fieldsAssertingAResolution(bare), []);
    assert.deepStrictEqual(fieldsAssertingAResolution({ ...bare, resolution: null }), ["summary"]);
  });

  it("holds across every stored change record", () => {
    const proseOnly = stored
      .filter((c) => !isNoLongerInForce(c) && fieldsAssertingAResolution(c).length > 0)
      .map((c) => `${c.vendor} ${c.date} ${fieldsAssertingAResolution(c).join("+")}`);
    assert.deepStrictEqual(proseOnly, []);
  });

  it("holds across every record as it is served", () => {
    const served = loadDealChanges();
    const proseOnly = served
      .filter((c) => !isNoLongerInForce(c) && fieldsAssertingAResolution(c).length > 0)
      .map((c) => `${c.vendor} ${c.date}`);
    assert.deepStrictEqual(proseOnly, []);
  });

  it("is not vacuous — the log holds records that have been resolved", () => {
    const resolved = stored.filter(isNoLongerInForce);
    assert.ok(resolved.length >= 3, `resolved records: ${resolved.length}`);
    for (const record of resolved) {
      assert.ok(RESOLUTION_STATES.includes(record.resolution!.state), `${record.vendor} ${record.date}`);
      assert.match(record.resolution!.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok((record.resolution!.detail ?? "").trim().length > 0 || record.resolution!.source_url, `${record.vendor} ${record.date}`);
      assert.ok(record.resolution!.date >= record.date, `${record.vendor} resolved after it happened`);
    }
  });

  it("names a record we hold when it names one at all", () => {
    const named = stored.filter((c) => c.resolution?.resolved_by);
    assert.ok(named.length >= 2, `records naming a resolving record: ${named.length}`);
    for (const record of named) {
      const resolver = resolvingRecord(record, stored);
      assert.ok(resolver, `${record.vendor} ${record.date} names a record in the log`);
      assert.strictEqual(resolver!.vendor, record.vendor);
      assert.ok(resolver!.date >= record.date, `${record.vendor} is resolved by a later record`);
    }
  });

  it("is not also typed into a page, where no resolution can follow it", () => {
    const serveSource = readFileSync(path.join(REPO, "src", "serve.ts"), "utf-8");
    const opening = (c: DealChange) => c.summary.slice(0, 40);
    const typedIn = (records: DealChange[]) =>
      records.filter((c) => opening(c).length >= 30 && serveSource.includes(opening(c)));

    assert.deepStrictEqual(
      typedIn(stored.filter(isNoLongerInForce)).map((c) => `${c.vendor} ${c.date}`),
      []
    );
    assert.ok(
      typedIn(stored.filter((c) => !isNoLongerInForce(c))).length > 0,
      "change text does reach page copy, so the check above has something to find"
    );
  });

  it("serves the resolution alongside the claim it withdraws", () => {
    for (const record of loadDealChanges().filter(isNoLongerInForce)) {
      const detail = record.resolution!.detail;
      if (!detail) continue;
      assert.ok(
        record.summary.includes(detail),
        `${record.vendor} ${record.date} serves its resolution`
      );
    }
  });
});

describe("the Netlify seat charge our own log already recorded as lifted", () => {
  const march = stored.find((c) => c.vendor === "Netlify" && c.date === "2026-03-01")!;

  it("is resolved by the April record naming the same seat charge", () => {
    assert.strictEqual(march.resolution?.state, "reversed");
    const resolver = resolvingRecord(march, stored)!;
    assert.strictEqual(resolver.date, "2026-04-14");
    assert.ok(resolver.summary.includes("unlimited team seats"));
  });

  it("no longer rates Netlify", () => {
    const netlify = loadDealChanges().filter((c) => c.vendor === "Netlify");
    const cause = vendorRiskAssessment(netlify).cause;
    assert.notStrictEqual(cause?.date, "2026-03-01");
  });
});

describe("the reversed GitHub Copilot signup pause", () => {
  const pause = stored.find((c) => c.vendor === "GitHub Copilot" && c.date === "2026-04-20")!;
  const trials = stored.find((c) => c.vendor === "GitHub Copilot" && c.date === "2026-04-10")!;

  it("is recorded as reversed rather than deleted", () => {
    assert.strictEqual(pause.resolution?.state, "reversed");
    assert.strictEqual(trials.resolution?.state, "reversed");
    assert.ok(pause.summary.includes("paused new signups"), "the event it recorded is still history");
  });

  it("is no longer what GitHub Copilot is rated on", () => {
    const copilot = loadDealChanges().filter((c) => c.vendor === "GitHub Copilot");
    const cause = vendorRiskAssessment(copilot).cause;
    assert.notStrictEqual(cause?.date, "2026-04-20");
    assert.notStrictEqual(cause?.date, "2026-04-10");
  });
});

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

async function vendorEvents(get: (p: string) => Promise<string>, page: string): Promise<any[]> {
  const body = await get(page);
  const blocks = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const events: any[] = [];
  for (const [, raw] of blocks) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const value of Object.values(parsed ?? {})) {
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        if (entry && typeof entry === "object" && (entry as any)["@type"] === "Event") events.push(entry);
      }
    }
  }
  assert.ok(events.length > 0, `${page} publishes at least one Event`);
  return events;
}

describe("what a reader and an agent are told about a resolved change", () => {
  before(async () => { proc = await startServer(); });
  after(() => { proc?.kill(); });

  const get = async (p: string) => (await fetch(`http://localhost:${serverPort}${p}`)).text();
  const getJson = async (p: string) => (await fetch(`http://localhost:${serverPort}${p}`)).json() as any;

  it("renders the reversed pause as history on the vendor page", async () => {
    const body = await get("/vendor/github-copilot");
    const items = body.split('<div class="change-item').slice(1);
    const pause = items.find((i) => i.includes("#github-copilot-2026-04-20"));
    assert.ok(pause, "the vendor page renders the April 20 record");
    assert.ok(pause!.startsWith(" change-resolved"), "the reversed record is marked as no longer in force");
    assert.ok(pause!.includes("marked Retired"), "the reversal travels with the claim");
    const standing = items.find((i) => i.includes("#github-copilot-2026-08-28"));
    assert.ok(standing && !standing.startsWith(" change-resolved"), "a standing record is not marked");
  });

  it("does not lead the vendor page with a pause GitHub lifted", async () => {
    const body = await get("/vendor/github-copilot");
    const verdict = body.slice(0, body.indexOf("change-item"));
    assert.ok(!verdict.includes("paused for new signups"), "the risk verdict cites a standing record");
  });

  it("marks the reversed record on the change log", async () => {
    const body = await get("/pricing-changes");
    const entries = body.split('<div class="pc-entry').slice(1);
    const pause = entries.find((e) => e.includes("paused new signups for Copilot Pro"));
    assert.ok(pause, "/pricing-changes renders the April 20 record");
    assert.ok(pause!.startsWith(" pc-resolved") || pause!.slice(0, 60).includes("pc-resolved"));
  });

  it("gives an agent the resolution in risk_cause", async () => {
    const risk = await getJson("/api/vendor-risk/GitHub%20Copilot");
    assert.strictEqual(risk.vendor, "GitHub Copilot", "the endpoint resolved the vendor");
    assert.ok(risk.risk_cause, "GitHub Copilot is rated on a standing record");
    assert.strictEqual(risk.risk_cause.resolution, null, "a resolved change is never the cause");
    assert.ok("current_state" in risk.risk_cause, "risk_cause carries the record's current state");
    assert.notStrictEqual(risk.risk_cause.date, "2026-04-20");
    assert.notStrictEqual(risk.risk_cause.date, "2026-04-10");
  });

  it("carries the same shape on /api/offers", async () => {
    const offers = await getJson("/api/offers?category=AI%20Coding");
    const withCause = (offers.offers ?? offers).filter((o: any) => o.risk_cause);
    assert.ok(withCause.length > 0, "the category has a rated vendor");
    for (const offer of withCause) {
      assert.ok("current_state" in offer.risk_cause, `${offer.vendor} risk_cause carries current_state`);
      assert.strictEqual(offer.risk_cause.resolution, null, `${offer.vendor} is not rated on a resolved change`);
    }
  });

  it("serves the reversal wherever the change log is read", async () => {
    const changes = await getJson("/api/changes?since=2026-04-01");
    const pause = (changes.changes ?? changes).find(
      (c: any) => c.vendor === "GitHub Copilot" && c.date === "2026-04-20"
    );
    assert.ok(pause, "the API serves the April 20 record");
    assert.strictEqual(pause.resolution?.state, "reversed");
    assert.ok(pause.summary.includes("marked Retired"), "the summary cannot be read without the reversal");
  });

  it("marks the resolved record on the alternatives page, where no detail sentence carries it", async () => {
    const body = await get("/alternative-to/netlify");
    const items = body.split('<div class="change-item').slice(1);
    const lifted = items.find((i) => i.includes("charged as a full Pro seat"));
    assert.ok(lifted, "/alternative-to/netlify renders the March record");
    assert.ok(lifted!.startsWith(" change-resolved"), "the reversed record is marked");
    const standing = items.find((i) => i.includes("Restructured to credit-based pricing"));
    assert.ok(standing && !standing.startsWith(" change-resolved"), "a standing record is not marked");
    assert.ok(body.includes(".change-resolved{"), "the page carries the rule that dims it");
  });

  it("ends the structured event on the vendor page for a change the vendor reversed", async () => {
    const events = await vendorEvents(get, "/vendor/netlify");
    const march = events.find((e) => e.startDate === "2026-03-01");
    assert.ok(march, "the vendor page publishes the March record as an Event");
    assert.strictEqual(march.endDate, "2026-04-14", "the event ends on the date it stopped being in force");
    const standing = events.find((e) => e.startDate === "2026-04-17");
    assert.ok(standing && !("endDate" in standing), "a standing record has no end");
  });

  it("cancels the structured event for a record we withdrew", async () => {
    const events = await vendorEvents(get, "/vendor/cursor");
    const retracted = events.find((e) => e.eventStatus);
    assert.ok(retracted, "the retracted record is published with a status");
    assert.strictEqual(retracted.eventStatus, EVENT_CANCELLED);
    assert.strictEqual(retracted.startDate, "2026-04-13");
    assert.ok(!events.some((e) => e.startDate === "2026-04-07" && e.eventStatus), "a standing record has no status");
  });

  it("tells the stack checker which of its changes are no longer in force", async () => {
    const body = await get("/stack-check");
    assert.ok(body.includes('"resolved":true'), "a resolved record reaches the page's data");
    assert.ok(body.includes('"resolved":false'), "a standing record reaches it too");
    assert.ok(body.includes(".change-resolved{"), "the page carries the rule that dims it");
    assert.ok(body.includes("' change-resolved'"), "the renderer applies it");
  });

  it("gives the comparison tool the resolution it renders on", async () => {
    const compared = await getJson("/api/compare?a=Netlify&b=Vercel");
    const march = compared.vendor_a.deal_changes.find((c: any) => c.date === "2026-03-01");
    assert.ok(march, "/api/compare serves the March record");
    assert.strictEqual(march.resolution?.state, "reversed");
    const body = await get("/compare-tool");
    assert.ok(body.includes(".change-resolved{"), "the page carries the rule that dims it");
    assert.ok(body.includes("' change-resolved'"), "the renderer applies it");
  });
});
