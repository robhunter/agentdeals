import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  riskEntries,
  scorecard,
  gradesLastSet,
  gradesFirstSet,
  gradesSetOn,
  gradingDatesClause,
  trackedSinceGrading,
  negativesSinceGrading,
  neverTracked,
  whyNotEvidence,
  freeTierStanding,
  splitByFreeTierStanding,
  changeLogNamesFor,
  FREE_TIER_NEGATIVE_TYPES,
  GRADE_FACTORS_WITHOUT_PRICING_HISTORY,
  INDEX_SWEEP_STATE,
} = await import("../dist/risk-scorecard.js");
const { CHANGE_DIRECTION } = await import("../dist/change-direction.js");
const { changeEntryDateLabel } = await import("../dist/change-dates.js");
const { loadOffers, loadDealChanges } = await import("../dist/data.js");

const offers = loadOffers();
const dealChanges = loadDealChanges();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GRADED_COUNT = 37;
const BANDS = ["low", "medium", "high", "dead"] as const;

let serverProc: ChildProcess | null = null;
let port = 0;
let riskHtml = "";

function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "..", "dist", "serve.js");
    const proc = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("Server startup timeout")); }, 20000);
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

function sectionBetween(html: string, openId: string, closeId: string): string {
  const from = html.indexOf(`id="${openId}"`);
  const to = html.indexOf(`id="${closeId}"`);
  assert.ok(from >= 0, `the page has no section anchored ${openId}`);
  assert.ok(to > from, `the page has no section anchored ${closeId} after ${openId}`);
  return html.slice(from, to);
}

before(async () => {
  const started = await startServer();
  serverProc = started.proc;
  port = started.port;
  const res = await fetch(`http://localhost:${port}/free-tier-risk`);
  assert.strictEqual(res.status, 200);
  riskHtml = await res.text();
});

after(() => {
  if (serverProc) serverProc.kill();
});

describe("every risk grade carries the date it was set", () => {
  it("dates all of them", () => {
    assert.strictEqual(riskEntries.length, GRADED_COUNT);
    for (const entry of riskEntries) {
      assert.ok(ISO_DATE.test(entry.graded), `${entry.vendor} carries no grading date`);
    }
  });

  it("reports the newest grading date as the date the grades were last set", () => {
    const dates = gradesSetOn(riskEntries);
    assert.deepStrictEqual(dates, [...dates].sort());
    assert.strictEqual(gradesLastSet(riskEntries), dates[dates.length - 1]);
  });

  it("renders the grading date beside the grade for every vendor", () => {
    for (const entry of riskEntries) {
      assert.ok(
        riskHtml.includes(`graded ${entry.graded}`),
        `the page renders no grading date for ${entry.vendor}`,
      );
    }
  });

  it("states the dates the grades were set in the page byline and the meta description", () => {
    const clause = gradingDatesClause(riskEntries);
    assert.ok(clause.includes(gradesFirstSet(riskEntries)), "the byline clause hides the date the grades were first set");
    assert.ok(clause.includes(gradesLastSet(riskEntries)), "the byline clause hides the date a grade was last revised");
    assert.ok(riskHtml.includes(clause), `the byline does not date the grades: ${clause}`);
    const meta = riskHtml.match(/<meta name="description" content="([^"]*)"/);
    assert.ok(meta, "the page publishes no meta description");
    assert.ok(meta![1].includes(clause), `the meta description does not date the grades: ${meta![1]}`);
  });
});

describe("no surface claims the grades refresh on their own", () => {
  it("answers the update-cadence question with the date the grades were set", () => {
    const faq = riskHtml.match(/How often is the Free Tier Risk Index updated\?[^]*?(?=<\/div>|<h3)/);
    assert.ok(faq, "the page no longer answers how often the index is updated");
    assert.ok(
      faq![0].includes(gradingDatesClause(riskEntries)),
      "the update-cadence answer does not name the dates the grades were set",
    );
    assert.ok(
      !/We update risk scores whenever a new pricing change is tracked/.test(riskHtml),
      "the page still says the risk scores move with every tracked change",
    );
  });

  it("carries the same answer in the structured data a machine reads", () => {
    const blocks = [...riskHtml.matchAll(/<script type="application\/ld\+json">([^]*?)<\/script>/g)]
      .map(m => JSON.parse(m[1]));
    const faqBlock = blocks.find(b => b["@type"] === "FAQPage");
    assert.ok(faqBlock, "the page ships no FAQ structured data");
    const answers: string[] = faqBlock.mainEntity.map((q: any) => q.acceptedAnswer.text);
    const cadence = answers.find(a => a.includes("editorial"));
    assert.ok(cadence, "the structured data does not say the grades are editorial");
    assert.ok(cadence!.includes(gradingDatesClause(riskEntries)), "the structured data does not date the grades");
    const lowestRisk = answers.find(a => a.includes("lowest-risk picks"));
    assert.ok(lowestRisk, "the structured data no longer names the lowest-risk picks");
    const named = ["Cloudflare", "GitHub", "Grafana Cloud", "AWS Free Tier", "Google Cloud (Always Free)"];
    const namedGradedOn = gradesLastSet(riskEntries.filter(e => named.includes(e.vendor)));
    assert.ok(
      lowestRisk!.includes(`graded ${namedGradedOn}`),
      "the structured data names graded vendors without the date of their grade",
    );
  });
});

describe("the band that gives a forward instruction holds only free tiers that still exist", () => {
  it("keeps a vendor out of Plan Your Exit unless our catalogue holds a free tier for it", () => {
    const high = riskEntries.filter(e => e.risk === "high");
    const split = splitByFreeTierStanding(high, offers);
    assert.ok(split.alreadyGone.length > 0, "no high-grade vendor has lost its free tier, so the split proves nothing");
    const section = sectionBetween(riskHtml, "high", "dead");
    for (const entry of split.stillFree) {
      assert.ok(section.includes(`>${entry.vendor}</a>`), `${entry.vendor} still has a free tier and is not listed under Plan Your Exit`);
      assert.strictEqual(freeTierStanding(entry, offers), "still_listed");
    }
    for (const entry of split.alreadyGone) {
      assert.ok(
        !section.includes(`>${entry.vendor}</a>`),
        `${entry.vendor} has no free tier left and is listed under a heading telling readers to plan an exit from it`,
      );
    }
  });

  it("lists the vendors it moved under Already Changed instead, still under their own grade", () => {
    const high = riskEntries.filter(e => e.risk === "high");
    const split = splitByFreeTierStanding(high, offers);
    const section = sectionBetween(riskHtml, "dead", "scorecard");
    for (const entry of split.alreadyGone) {
      assert.ok(section.includes(`>${entry.vendor}</a>`), `${entry.vendor} was moved out of the forward band and lands nowhere`);
    }
    assert.ok(section.includes("High Risk"), "the moved vendors no longer show the grade they were given");
  });

  it("names why each moved vendor was moved", () => {
    const split = splitByFreeTierStanding(riskEntries.filter(e => e.risk === "high"), offers);
    for (const entry of split.alreadyGone) {
      const standing = freeTierStanding(entry, offers);
      assert.notStrictEqual(standing, "still_listed");
      assert.ok(riskHtml.includes(entry.vendor), `${entry.vendor} is not named on the page`);
    }
    assert.ok(riskHtml.includes("no catalogue record") || riskHtml.includes("no free tier in our catalogue"),
      "the page does not say on what basis a vendor left the forward band");
  });
});

describe("no entry is silent about its own window", () => {
  it("says what has been tracked for every vendor since it was graded", () => {
    for (const entry of riskEntries) {
      const tracked = trackedSinceGrading(entry, dealChanges);
      if (neverTracked(entry, dealChanges)) continue;
      if (tracked.length === 0) continue;
      for (const record of tracked) {
        assert.ok(
          riskHtml.includes(`${changeEntryDateLabel(record.change)}</span><div>${record.change.change_type}`),
          `${entry.vendor} does not publish the ${record.change.change_type} tracked on ${record.change.date}`,
        );
      }
    }
  });

  it("says so out loud when nothing has been tracked", () => {
    const quiet = riskEntries.filter(e => !neverTracked(e, dealChanges) && trackedSinceGrading(e, dealChanges).length === 0);
    assert.ok(quiet.length > 0, "every graded vendor has moved since grading, so the empty case proves nothing");
    assert.ok(riskHtml.includes("Nothing tracked since it was graded."), "an entry with nothing tracked says nothing at all");
  });

  it("marks a change it does not count, and says which rule kept it out", () => {
    const notCounted = riskEntries.flatMap(e => trackedSinceGrading(e, dealChanges)).filter(t => t.notEvidence !== null);
    assert.ok(notCounted.length > 0, "no tracked change was excluded, so the exclusions prove nothing");
    for (const reason of new Set(notCounted.map(t => t.notEvidence))) {
      assert.ok(riskHtml.includes(`not counted &mdash;`), "an excluded change is shown without saying it was excluded");
      assert.ok(reason !== null);
    }
  });
});

describe("a grade with no pricing history behind it says so", () => {
  it("names the vendors our change log has never held a record for", () => {
    const untracked = riskEntries.filter(e => neverTracked(e, dealChanges));
    assert.ok(untracked.length > 0, "every graded vendor has a tracked change, so the disclosure proves nothing");
    for (const entry of untracked) {
      assert.ok(
        riskHtml.includes(`No change has ever been tracked for ${entry.vendor}.`),
        `${entry.vendor} carries a grade with no record behind it and the page does not say so`,
      );
    }
    assert.ok(
      riskHtml.includes(GRADE_FACTORS_WITHOUT_PRICING_HISTORY),
      "the page does not name which factors supplied a grade that pricing history could not",
    );
  });

  it("does not attribute those grades to the change data in the methodology either", () => {
    const untracked = riskEntries.filter(e => neverTracked(e, dealChanges));
    const method = sectionBetween(riskHtml, "methodology", "low");
    for (const entry of untracked) {
      assert.ok(method.includes(entry.vendor), `the methodology claims change data behind ${entry.vendor}'s grade without exception`);
    }
  });
});

describe("the page publishes its own hit rate", () => {
  it("scores every band and keeps the quiet vendors in the denominator", () => {
    const section = sectionBetween(riskHtml, "scorecard", "scoring");
    for (const band of scorecard(riskEntries, dealChanges)) {
      const inBand = riskEntries.filter(e => e.risk === band.grade).length;
      assert.strictEqual(band.vendors, inBand, `the ${band.grade} band scored ${band.vendors} of ${inBand} graded vendors`);
      assert.ok(band.vendorsWithNothingTracked <= band.vendors);
      assert.ok(section.includes(`>${band.rate}%<`), `the ${band.grade} band publishes no rate`);
      assert.ok(section.includes(`>${band.vendors}<`), `the ${band.grade} band publishes no denominator`);
    }
    assert.ok(BANDS.every(b => section.includes(b === "dead" ? "Already Changed" : `${b[0].toUpperCase()}${b.slice(1)} Risk`)),
      "the scorecard does not cover every band");
  });

  it("counts a vendor only for a record in force that names a free tier negative", () => {
    for (const entry of riskEntries) {
      for (const negative of negativesSinceGrading(entry, dealChanges)) {
        assert.ok(FREE_TIER_NEGATIVE_TYPES.includes(negative.change_type), `${negative.change_type} counted against ${entry.vendor}`);
        assert.strictEqual(whyNotEvidence(negative), null);
        assert.ok(negative.date > entry.graded, `a change from before ${entry.vendor} was graded was counted against it`);
      }
    }
  });

  it("shows the same rate a reader recomputing it from the change log would get", () => {
    const section = sectionBetween(riskHtml, "scorecard", "scoring");
    for (const band of scorecard(riskEntries, dealChanges)) {
      const expected = band.vendors === 0 ? 0 : Math.round((band.vendorsWithANegative / band.vendors) * 100);
      assert.strictEqual(band.rate, expected);
      assert.ok(section.includes(`>${band.negativeRecords}<`), `the ${band.grade} band publishes no record count`);
    }
  });
});

describe("the grading rules the page states are the rules it applies", () => {
  it("does not count a record that has been reversed or retracted", () => {
    const reversed = dealChanges.filter((c: any) => c.resolution);
    assert.ok(reversed.length > 0, "no record carries a resolution, so the exclusion proves nothing");
    for (const change of reversed) assert.strictEqual(whyNotEvidence(change), "no_longer_in_force");
  });

  it("does not count the index sweep", () => {
    const swept = dealChanges.filter((c: any) => c.current_state === INDEX_SWEEP_STATE && !c.resolution);
    assert.ok(swept.length > 0, "no record came from an index sweep, so the exclusion proves nothing");
    for (const change of swept) assert.strictEqual(whyNotEvidence(change), "index_sweep");
  });

  it("does not count a deprecation of a different product the vendor sells", () => {
    const excluded = riskEntries
      .flatMap(e => trackedSinceGrading(e, dealChanges))
      .filter(t => t.notEvidence === "another_product");
    assert.ok(excluded.length > 0, "no deprecation named another product, so the exclusion proves nothing");
    for (const record of excluded) assert.strictEqual(record.change.change_type, "product_deprecated");
  });

  it("keeps its negative set inside the direction map the rest of the site reads", () => {
    for (const type of FREE_TIER_NEGATIVE_TYPES) {
      assert.strictEqual(CHANGE_DIRECTION[type], "negative", `${type} is not negative in the shared direction map`);
    }
  });

  it("looks up every graded vendor under a name the change log actually uses", () => {
    const known = new Set(dealChanges.map((c: any) => c.vendor));
    const unmatched = riskEntries.flatMap(e => changeLogNamesFor(e).filter((n: string) => !known.has(n)).map((n: string) => `${e.vendor} -> ${n}`));
    const orphaned = riskEntries.filter(e => neverTracked(e, dealChanges)).map(e => e.vendor);
    for (const miss of unmatched) {
      const vendor = miss.split(" -> ")[0];
      const entry = riskEntries.find(e => e.vendor === vendor)!;
      const stillMatches = changeLogNamesFor(entry).some((n: string) => known.has(n));
      assert.ok(
        stillMatches || orphaned.includes(vendor),
        `${miss} matches no vendor in the change log and is not published as an untracked grade`,
      );
    }
  });
});

describe("the count in the body and the count in the metadata agree", () => {
  it("publishes the graded population once", () => {
    const meta = riskHtml.match(/<meta name="description" content="([^"]*)"/)![1];
    assert.ok(meta.includes(`${riskEntries.length} developer tool free tiers`), `the meta description miscounts: ${meta}`);
    assert.ok(riskHtml.includes(`All ${riskEntries.length} vendors ranked by risk level`), "the scoring table miscounts");
    assert.ok(riskHtml.includes(`This index scores ${riskEntries.length} major developer tools`), "the summary miscounts");
    assert.ok(riskHtml.includes(`This risk index covers ${riskEntries.length} major developer tools`), "the closing line miscounts");
  });

  it("counts the same on the guide hub and the guide directory", async () => {
    for (const route of ["/alternatives", "/guides"]) {
      const res = await fetch(`http://localhost:${port}${route}`);
      if (res.status !== 200) continue;
      const html = await res.text();
      if (!html.includes("Free Tier Risk Index")) continue;
      assert.ok(!/risk (?:scores|analysis) for 38\b/.test(html), `${route} still counts 38 graded vendors`);
    }
  });
});

describe("no route on the site states a stale count or a cadence the grades do not keep", () => {
  it("sweeps every published route", async () => {
    const indexRes = await fetch(`http://localhost:${port}/sitemap.xml`);
    assert.strictEqual(indexRes.status, 200);
    const children = [...(await indexRes.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    const paths = new Set<string>(["/"]);
    for (const child of children) {
      const childRes = await fetch(child.replace(/^https?:\/\/[^/]+/, `http://localhost:${port}`));
      if (childRes.status !== 200) continue;
      for (const loc of (await childRes.text()).matchAll(/<loc>([^<]+)<\/loc>/g)) {
        paths.add(new URL(loc[1]).pathname);
      }
    }
    const ROUTE_FLOOR = 2000;
    assert.ok(paths.size >= ROUTE_FLOOR, `swept only ${paths.size} routes`);

    const offenders: string[] = [];
    for (const route of paths) {
      const res = await fetch(`http://localhost:${port}${route}`);
      if (res.status !== 200) continue;
      const html = await res.text();
      if (/risk (?:scores|analysis) for 38\b/.test(html)) offenders.push(`${route} counts 38 graded vendors`);
      if (/We update risk scores whenever a new pricing change is tracked/.test(html)) {
        offenders.push(`${route} says the risk scores move with every tracked change`);
      }
    }
    assert.deepStrictEqual(offenders, [], offenders.join("; "));
  });
});
