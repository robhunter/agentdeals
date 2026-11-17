import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { visibleText } from "./change-vendor-index-observer.ts";
import { isoWeekOf } from "../dist/change-dates.js";
import { shutdownDateOf } from "../dist/forecast-shutdowns.js";
import { changeAnchor } from "../dist/change-anchor.js";
import type { DealChange } from "../src/types.ts";
import { eventResolutionFields, EVENT_CANCELLED, isCancelledAnnouncement, printsBeforeAndAfter, publishedImpactOf, standingOf, summaryWithResolution, theEventNeverHappened } from "../dist/change-resolution.js";
import { isOurOwnBookkeeping } from "../dist/data.js";
import { narrowingSentence } from "../dist/vendor-verdict.js";
import { trackedChanges } from "../dist/change-census.js";
import { feedEntryTitle, feedEntryCategory } from "../dist/change-feed.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stored: DealChange[] = JSON.parse(readFileSync(path.join(ROOT, "data/deal_changes.json"), "utf8")).changes;
const cancelledRecords = stored.filter(c => c.resolution?.state === "cancelled");
const record = stored.find(c => c.vendor === "Conductor" && c.date === "2026-11-20")!;
const detail = "Conductor called off its Conductor Cloud shutdown on November 13.";

function serverAt(day: string): Promise<{ child: ChildProcess; origin: string }> {
  const serve = pathToFileURL(path.join(ROOT, "dist/serve.js")).href;
  const code = `const RealDate = Date; const instant = RealDate.parse(${JSON.stringify(day + "T12:00:00Z")}); globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [instant])); } static now() { return instant; } }; await import(${JSON.stringify(serve)});`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_REFERRAL_HEALTH: "off" }, stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error(errors || "Server startup timeout")); }, 20000);
    child.stderr!.on("data", chunk => {
      errors += chunk.toString();
      const match = errors.match(/running on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve({ child, origin: `http://localhost:${match[1]}` }); }
    });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("exit", code => { clearTimeout(timeout); if (code) reject(new Error(errors)); });
  });
}

describe("a vendor cancellation preserves the announcement without asserting its outcome", () => {
  it("records the vendor's earlier cancellation and its source", () => {
    assert.ok(record);
    assert.equal(record.resolution?.state, "cancelled");
    assert.equal(record.resolution.date, "2026-11-13");
    assert.equal(record.resolution.detail, detail);
    assert.equal(record.resolution.source_url, "https://www.conductor.build/changelog");
    assert.equal(record.date, "2026-11-20");
  });

  it("keeps the cancellation distinct from our own errors", () => {
    assert.equal(isCancelledAnnouncement(record), true);
    assert.equal(theEventNeverHappened(record), false);
    assert.equal(isOurOwnBookkeeping(record), false);
    assert.equal(standingOf(record), "cancelled");
    assert.equal(publishedImpactOf(record), "none");
    assert.deepEqual(trackedChanges([record]), []);
    const retracted = { ...record, resolution: { state: "retracted" as const, date: "2026-11-21" } };
    assert.equal(theEventNeverHappened(retracted), true);
    assert.equal(isOurOwnBookkeeping(retracted), true);
    assert.match(summaryWithResolution(retracted), /this record was our error/);
  });

  it("replaces the claim, before-and-after states and event outcome", () => {
    assert.equal(summaryWithResolution(record), detail);
    assert.equal(printsBeforeAndAfter(record), false);
    assert.deepEqual(eventResolutionFields(record), { eventStatus: EVENT_CANCELLED });
    assert.equal(feedEntryTitle(record), `Conductor: ${detail}`);
    assert.equal(feedEntryCategory(record).term, "cancelled");
  });

  it("leads the vendor verdict with the cancellation before and after the former date", () => {
    for (const day of ["2026-11-17", "2026-11-20", "2026-11-21"]) {
      assert.equal(narrowingSentence([record], null, false, day), detail, day);
    }
  });

  it("retains an independent standing announcement in a mixed history", () => {
    const standing = { ...record, date: "2026-11-25", change_type: "restriction", listing_effect: undefined, what_ends: undefined, resolution: null };
    const verdict = narrowingSentence([record, standing], null, false, "2026-11-17");
    assert.ok(verdict.startsWith(detail));
    assert.match(verdict, /2026-11-25/);
    assert.deepEqual(trackedChanges([record, standing]), [standing]);
  });
});

const days = [...new Set(cancelledRecords.flatMap(c => [
  c.resolution!.date,
  ...[-1, 0, 1].map(offset => new Date(Date.parse(c.date + "T12:00:00Z") + offset * 86400000).toISOString().slice(0, 10)),
]))];

for (const day of days) {
  describe(`a cancelled announcement on ${day}`, () => {
    let server: Awaited<ReturnType<typeof serverAt>>;
    const get = async (route: string) => {
      const response = await fetch(server.origin + route, { redirect: "error" });
      assert.equal(response.status, 200, route);
      return response;
    };
    before(async () => { server = await serverAt(day); });
    after(async () => {
      if (!server?.child || server.child.exitCode !== null) return;
      await new Promise<void>(resolve => { server.child.once("exit", () => resolve()); server.child.kill(); });
    });

    for (const route of ["/shutdowns", "/deadlines", "/api/deadlines", "/api/deadlines?type=product_deprecated", "/this-week", "/api/digest/weekly", ...cancelledRecords.map(c => { const { year, week } = isoWeekOf(new Date(c.date + "T12:00:00Z")); return `/digest/${year}-w${String(week).padStart(2, "0")}`; })]) {
      it(`omits every cancelled record from ${route}`, async () => {
        assert.ok(cancelledRecords.length > 0);
        const response = await get(route);
        const body = await response.text();
        if (route.startsWith("/api/")) {
          const payload = JSON.parse(body);
          const entries = payload.deadlines ?? [...payload.top_changes, ...payload.discovered_changes];
          assert.ok(Array.isArray(entries));
          for (const cancelled of cancelledRecords) {
            assert.ok(!entries.some((entry: any) => entry.vendor === cancelled.vendor && entry.date === cancelled.date), `${cancelled.vendor} ${cancelled.date}`);
          }
        } else {
          const text = visibleText(body);
          for (const cancelled of cancelledRecords) {
            assert.ok(!body.includes(changeAnchor(cancelled)), `${cancelled.vendor} ${cancelled.date}`);
            assert.ok(!text.includes(visibleText(cancelled.summary)), `${cancelled.vendor} summary`);
            if (route === "/shutdowns" || route === "/deadlines") {
              const cards = body.split(route === "/shutdowns" ? /<div class="shutdown-card"/ : /<div class="dl-card /).slice(1);
              for (const card of cards) {
                const title = card.match(route === "/shutdowns" ? /<h3[^>]*>([\s\S]*?)<\/h3>/ : /class="dl-vendor"[^>]*>([\s\S]*?)<\/(?:a|span)>/)?.[1];
                const subject = route === "/shutdowns" ? cancelled.what_ends ?? cancelled.vendor : cancelled.vendor;
                const dates = [cancelled.date, shutdownDateOf(cancelled), ...(cancelled.shutdown_stages ?? []).map(stage => stage.date)];
                const cardText = visibleText(card);
                const hasDate = dates.some(date => card.includes(date) || cardText.includes(new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })));
                assert.ok(!(title && visibleText(title) === subject && hasDate), `${cancelled.vendor} dated card`);
              }
            }
          }
        }
      });
    }

    it("documents the cancellation and its lack of impact in the served API schema", async () => {
      const spec = await (await get("/api/openapi.json")).json() as any;
      const schemas = spec.components.schemas;
      assert.ok(schemas.ChangeResolution.description.endsWith("state is 'cancelled' when the vendor called off an announced change before its date; the change never took effect, and date is the day the vendor called it off."));
      const properties = schemas.PublishedDealChange.allOf[1].properties;
      assert.ok(properties.standing.description.endsWith("'cancelled' — the vendor announced the change and called it off before its date, so the record is true history of an announcement that never took effect."));
      assert.ok(properties.impact.description.endsWith("It is also 'none' whenever standing is 'cancelled', because the change never took effect."));
      assert.ok(schemas.ChangeResolution.properties.state.enum.includes("cancelled"));
      assert.ok(properties.standing.enum.includes("cancelled"));
      const deadlines = await (await get("/deadlines")).text();
      assert.ok(!visibleText(deadlines).includes("It is not removed because the shutdown was cancelled or because we stopped holding the record."));
    });

    it("keeps the deadline total equal to the entries served", async () => {
      const html = await (await get("/deadlines")).text();
      const api = await (await get("/api/deadlines")).json() as any;
      const total = Number(html.match(/<p class="page-intro">(\d+) upcoming deadlines/)?.[1]);
      assert.ok(total > 0);
      assert.equal(total, api.count);
      assert.equal(api.deadlines.length, api.count);
      assert.equal((html.match(/class="dl-card/g) ?? []).length, api.count);
    });

    for (const route of ["/pricing-changes", "/changes"]) {
      it(`retains every cancellation as history on ${route}`, async () => {
        const html = await (await get(route)).text();
        const entries = html.split(/<div class="(?:pc|chg)-entry/).slice(1);
        const index = html.match(/<section class="change-vendor-index"[^>]*>([\s\S]*?)<\/section>/)?.[1];
        assert.ok(index);
        const lines = [...index.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match => ({ html: match[1], text: visibleText(match[1]).replace(/\s+:/g, ":") }));
        for (const cancelled of cancelledRecords) {
          const statement = cancelled.resolution!.detail!;
          const indexLine = lines.find(line => line.text.startsWith(`${cancelled.vendor}: `) && line.text.includes(statement));
          assert.ok(indexLine);
          assert.ok(indexLine.html.includes(`href="${cancelled.resolution!.source_url}"`));
          assert.match(indexLine.html, /class="change-source"/);
          assert.match(indexLine.html, /rel="nofollow noopener"/);
          assert.ok(!lines.some(line => line.text.startsWith(`${cancelled.vendor}: `) && /: cancelled \d/.test(line.text)));
          const history = entries.find(entry => {
            const vendor = entry.match(/class="(?:pc|chg)-vendor"[^>]*>([\s\S]*?)<\/(?:a|span)>/)?.[1];
            return entry.slice(0, entry.indexOf(">") + 1).includes(`data-event-date="${cancelled.date}"`) && vendor !== undefined && visibleText(vendor) === cancelled.vendor;
          });
          assert.ok(history, `${route}: ${cancelled.vendor}`);
          assert.ok(visibleText(history).includes(statement));
          assert.doesNotMatch(history.slice(0, history.indexOf('</div>')), /(?:pc|chg)-upcoming/);
          assert.match(history, />cancelled<\/span>/);
          assert.ok(history.includes(cancelled.resolution!.date));
          assert.ok(!visibleText(history).includes(`effective ${cancelled.date}`));
          assert.doesNotMatch(history, /class="(?:pc|chg)-impact"/);
          assert.doesNotMatch(history, /this record was our error/);
        }
      });
    }

    it("publishes the cancellation and source through the change API", async () => {
      const api = await (await get(`/api/changes?since=${cancelledRecords.map(c => c.date).sort()[0]}&limit=10000`)).json() as any;
      for (const record of cancelledRecords) {
        const cancelled = api.changes.find((c: any) => c.vendor === record.vendor && c.date === record.date && c.change_type === record.change_type);
        assert.ok(cancelled);
        assert.equal(cancelled.summary, record.resolution!.detail);
        assert.equal(cancelled.standing, "cancelled");
        assert.equal(cancelled.impact, "none");
        assert.equal(cancelled.resolution.source_url, record.resolution!.source_url);
        assert.equal(cancelled.source_url, record.resolution!.source_url);
      }
    });
  });
}
