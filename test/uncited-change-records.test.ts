import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  changeCitesASource,
  changeIsUncited,
  citedChanges,
  uncitedChanges,
} from "../dist/change-citation.js";
import { uncitedChangesAgainstBudget } from "../dist/change-reporting.js";
import {
  classifyStability,
  demotionForChange,
  demotionInForce,
  demotionWithheldForNoSource,
  demotionWithheldInForce,
  enrichOffers,
  loadDealChanges,
  loadOffers,
  vendorRiskAssessment,
} from "../dist/data.js";
import { vendorBadge, vendorVerdictSentence, statesRiskCause, type VendorVerdictInput } from "../dist/vendor-verdict.js";
import { qualityBudget } from "../dist/page-reviews.js";
import { toSlug } from "../dist/vendor-slug.js";
import { uncitedReport } from "../scripts/uncited-changes.js";
import type { DealChange } from "../dist/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

function withEntitiesDecoded(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const NOW = Date.parse("2026-09-05T00:00:00Z");

const record = (over: Partial<DealChange> = {}): DealChange => ({
  vendor: "Fixture Vendor",
  change_type: "free_tier_removed",
  date: "2026-08-01",
  summary: "Free tier removed",
  previous_state: "Free tier: 5 GB",
  current_state: "Paid only",
  impact: "high",
  source_url: "https://example.com/pricing",
  category: "Databases",
  alternatives: [],
  date_source: "vendor_page",
  ...over,
});

describe("a change record that cites no source", () => {
  it("is uncited whether the field is empty, whitespace or absent", () => {
    assert.strictEqual(changeCitesASource(record()), true);
    assert.strictEqual(changeIsUncited(record({ source_url: "" })), true);
    assert.strictEqual(changeIsUncited(record({ source_url: "   " })), true);
    assert.strictEqual(changeIsUncited({ ...record(), source_url: undefined as unknown as string }), true);
  });

  it("carries no demotion, where the same record with a source carries one", () => {
    assert.strictEqual(demotionForChange(record()), "risky");
    assert.strictEqual(demotionForChange(record({ source_url: "" })), null);
    assert.strictEqual(demotionInForce(record({ source_url: "" }), NOW), null);
    assert.strictEqual(demotionForChange(record({ change_type: "limits_reduced", source_url: "" })), null);
  });

  it("reports the demotion it would have carried, so the withholding can be explained", () => {
    assert.strictEqual(demotionWithheldForNoSource(record({ source_url: "" })), "risky");
    assert.strictEqual(demotionWithheldForNoSource(record({ change_type: "limits_reduced", source_url: "" })), "caution");
    assert.strictEqual(demotionWithheldForNoSource(record()), null);
    assert.strictEqual(demotionWithheldInForce(record({ source_url: "" }), NOW), "risky");
  });

  it("withholds a rating rather than reporting the vendor stable", () => {
    const assessment = vendorRiskAssessment([record({ source_url: "" })], NOW);
    assert.strictEqual(assessment.cause, null);
    assert.deepStrictEqual(assessment.rating_withheld, { reason: "no_source", records: 1 });
  });

  it("loses to a record that does cite a source, which still sets the rating", () => {
    const assessment = vendorRiskAssessment(
      [record({ source_url: "" }), record({ change_type: "limits_reduced", date: "2026-07-01" })],
      NOW,
    );
    assert.strictEqual(assessment.rating_withheld, null);
    assert.strictEqual(assessment.level, "caution");
    assert.strictEqual(assessment.cause?.change_type, "limits_reduced");
  });

  it("does not make the vendor volatile or put it on the watch list", () => {
    assert.strictEqual(classifyStability([record({ source_url: "" })], NOW), "stable");
    assert.strictEqual(classifyStability([record()], NOW), "volatile");
    assert.strictEqual(classifyStability([record({ change_type: "limits_reduced", source_url: "" })], NOW), "stable");
  });
});

describe("the verdict engine, given a withheld rating", () => {
  const input = (over: Partial<VendorVerdictInput> = {}): VendorVerdictInput => ({
    vendor: "Fixture Vendor",
    level: null,
    cause: null,
    changes: [record({ source_url: "" })],
    levelWithheld: null,
    unconfirmableSince: "",
    ratingWithheld: { reason: "no_source", records: 1 },
    ...over,
  });

  it("draws no badge, and says the missing source is why", () => {
    assert.deepStrictEqual(vendorBadge(input()), { kind: "none", because: { reason: "no_source" } });
  });

  it("states no risk cause", () => {
    assert.strictEqual(statesRiskCause(input()), false);
  });

  it("says the rating is withheld rather than that the vendor is stable", () => {
    const sentence = vendorVerdictSentence(input());
    assert.match(sentence, /cites no source/);
    assert.doesNotMatch(sentence, /\bstable\b/);
  });

  it("still rates a vendor whose cause does cite a source", () => {
    const rated = input({
      level: "risky",
      cause: { date: "2026-08-01", change_type: "free_tier_removed", summary: "Free tier removed" },
      ratingWithheld: null,
      changes: [record()],
    });
    assert.deepStrictEqual(vendorBadge(rated), { kind: "rating", word: "risky" });
    assert.strictEqual(statesRiskCause(rated), true);
  });
});

describe("the shipped catalogue", () => {
  const changes = loadDealChanges();
  const enriched = enrichOffers(loadOffers());

  const recordBehind = (vendor: string, cause: { date: string; change_type: string; summary: string }) =>
    changes.find(c =>
      c.vendor.toLowerCase() === vendor.toLowerCase()
      && c.date === cause.date
      && c.change_type === cause.change_type
      && c.summary === cause.summary);

  it("publishes no risk cause that cites no source", () => {
    const published = enriched
      .filter(o => o.risk_cause !== null)
      .map(o => ({ vendor: o.vendor, cause: o.risk_cause!, record: recordBehind(o.vendor, o.risk_cause!) }))
      .filter(({ record: r }) => r !== undefined && changeIsUncited(r))
      .map(({ vendor, cause }) => `${vendor}: ${cause.date} ${cause.change_type}`);
    assert.deepStrictEqual(published, [], "a vendor's published risk cause is a record citing no source");
  });

  it("publishes no risk level a record citing no source would have set", () => {
    const rated = enriched
      .filter(o => o.risk_level !== null && o.risk_level !== "stable")
      .filter((o) => {
        const vendorChanges = changes.filter(c => c.vendor.toLowerCase() === o.vendor.toLowerCase());
        return vendorChanges.filter(changeCitesASource).every(c => demotionInForce(c) === null);
      })
      .map(o => `${o.vendor}: ${o.risk_level}`);
    assert.deepStrictEqual(rated, [], "a non-stable level rests on no record that cites a source");
  });

  it("withholds the level, rather than reporting stable, wherever a rating is withheld", () => {
    const withheld = enriched.filter(o => o.rating_withheld !== null);
    assert.deepStrictEqual(
      withheld.filter(o => o.risk_level !== null).map(o => o.vendor),
      [],
      "a withheld rating still published a level",
    );
    assert.deepStrictEqual(
      withheld.filter(o => o.stability === "stable" || o.stability === "improving").map(o => o.vendor),
      [],
      "a withheld rating still published a favourable stability class",
    );
  });

  it("holds no more records citing no source than the budget allows", () => {
    const budget = qualityBudget("uncited_change_records");
    const measured = uncitedChangesAgainstBudget(changes).length;
    assert.ok(
      measured <= budget,
      `${measured} change records report a vendor's offer and cite no source, `
      + `over the budget of ${budget} in data/quality_budgets.json`,
    );
  });

  it("withholds a rating for exactly the vendors whose only demoting records cite no source", () => {
    const expected = [...new Set(
      loadOffers()
        .filter((offer) => {
          const vendorChanges = changes.filter(c => c.vendor.toLowerCase() === offer.vendor.toLowerCase());
          return vendorChanges.some(c => demotionWithheldInForce(c) !== null)
            && vendorChanges.every(c => demotionInForce(c) === null);
        })
        .map(o => o.vendor),
    )].sort();
    assert.ok(expected.length > 0, "no vendor in the catalogue rests a rating on a record citing no source");
    assert.deepStrictEqual(
      [...new Set(enriched.filter(o => o.rating_withheld !== null).map(o => o.vendor))].sort(),
      expected,
    );
  });

  it("counts the withheld records for the vendor whose rating is withheld", () => {
    for (const offer of enriched.filter(o => o.rating_withheld !== null)) {
      const vendorChanges = changes.filter(c => c.vendor.toLowerCase() === offer.vendor.toLowerCase());
      const expected = vendorChanges.filter(c => demotionWithheldInForce(c) !== null).length;
      assert.strictEqual(offer.rating_withheld!.records, expected, offer.vendor);
      assert.ok(expected > 0, `${offer.vendor} withholds a rating on no record`);
    }
  });

  it("is listed for triage by scripts/uncited-changes.js, one row per record", () => {
    const rows = uncitedReport(changes, loadOffers());
    assert.strictEqual(rows.length, uncitedChangesAgainstBudget(changes).length);
    for (const row of rows) {
      const source = changes.find(c => c.vendor === row.vendor && c.date === row.date && c.summary === row.summary);
      assert.ok(source && changeIsUncited(source), `${row.vendor} ${row.date} is not an uncited record`);
    }
  });
});

describe("the vendor page, for a vendor whose records cite no source", () => {
  let proc: ChildProcess | null = null;
  let port = 0;

  const changes = loadDealChanges();
  const offers = loadOffers();
  const withheldSubjects = enrichOffers(offers).filter(o => o.rating_withheld !== null);
  const markedSubjects = offers.filter(o =>
    changes.some(c => c.vendor.toLowerCase() === o.vendor.toLowerCase() && changeIsUncited(c)));

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

  const get = async (route: string) => {
    const res = await fetch(`http://localhost:${port}${route}`, {
      headers: { "user-agent": "agentdeals-internal/1.0 (uncited-change-records-test)" },
    });
    assert.strictEqual(res.status, 200, `${route} responded ${res.status}`);
    return res.text();
  };

  const jsonLdBlocks = (html: string): Record<string, unknown>[] =>
    [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(m => JSON.parse(m[1]) as Record<string, unknown>);

  it("draws no risk badge and states no cause, on every vendor whose rating is withheld", async () => {
    assert.ok(markedSubjects.length > 0, "the catalogue holds no record citing no source to render");
    for (const offer of withheldSubjects) {
      const html = await get(`/vendor/${toSlug(offer.vendor)}`);
      const h1 = html.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
      assert.strictEqual(
        h1.match(/<span class="risk-badge"[^>]*>([a-z]+)<\/span>/)?.[1] ?? null,
        null,
        `${offer.vendor} draws a risk badge on a withheld rating`,
      );
      assert.doesNotMatch(html, /class="risk-cause-line"/, `${offer.vendor} states a risk cause`);
      assert.match(html, /class="rating-withheld-line"/, `${offer.vendor} does not say why it is unrated`);
    }
  });

  it("marks every record citing no source in the history it renders", async () => {
    for (const offer of markedSubjects) {
      const html = await get(`/vendor/${toSlug(offer.vendor)}`);
      const uncitedHere = changes.filter(c =>
        c.vendor.toLowerCase() === offer.vendor.toLowerCase() && changeIsUncited(c));
      for (const c of uncitedHere) {
        assert.ok(withEntitiesDecoded(html).includes(c.summary), `${offer.vendor} does not render ${c.date}`);
      }
      const marked = [...html.matchAll(/class="change-item[^"]*"/g)].filter(m => m[0].includes("change-unsourced"));
      assert.strictEqual(marked.length, uncitedHere.length, `${offer.vendor} marks the wrong number of records`);
      assert.match(html, /class="unsourced-note"/, `${offer.vendor} renders no note saying the record sets no rating`);
    }
  });

  it("stamps no removal or at-risk badge on a vendor whose rating is withheld", async () => {
    for (const offer of withheldSubjects) {
      const svg = await get(`/badge/${toSlug(offer.vendor)}.svg`);
      assert.doesNotMatch(svg, /free tier removed|at risk|deprecated/, `${offer.vendor}'s badge asserts a verdict`);
      assert.match(svg, /unrated/, `${offer.vendor}'s badge does not say the rating is withheld`);
    }
  });

  it("publishes no schema.org Event for a record citing no source", async () => {
    for (const offer of markedSubjects) {
      const html = await get(`/vendor/${toSlug(offer.vendor)}`);
      const events = jsonLdBlocks(html)
        .flatMap(block => (Array.isArray(block.about) ? block.about : []))
        .filter((e): e is { description?: string } => typeof e === "object" && e !== null);
      const vendorChanges = changes.filter(c => c.vendor.toLowerCase() === offer.vendor.toLowerCase());
      const publishedSummaries = new Set(events.map(e => e.description));
      for (const c of vendorChanges.filter(changeIsUncited)) {
        assert.ok(
          !publishedSummaries.has(c.summary),
          `${offer.vendor} publishes an Event for ${c.date}, which cites no source`,
        );
      }
      const citedHere = citedChanges(vendorChanges);
      assert.ok(
        events.length <= Math.min(citedHere.length, 10),
        `${offer.vendor} publishes ${events.length} Events against ${citedHere.length} records citing a source`,
      );
    }
  });
});
