import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";
import {
  auditStack,
  changesRatingTheListedTier,
  checkVendorRisk,
  enrichOffers,
  findVendor,
  levelWithheldStatement,
  loadDealChanges,
  loadOffers,
  publishedRisk,
  vendorRiskAssessment,
} from "../dist/data.js";
import { cannotVouchForLevel } from "../dist/source-check.js";
import { getStackRecommendation } from "../dist/stacks.js";
import { gradeForStack, isRated, RATED_LEVELS } from "../dist/stack-grade.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const RECORDS_FLOOR = 1000;
const NAMES_FLOOR = 1000;
const WITHHELD_FLOOR = 400;
const CANDIDATE_SLOTS_FLOOR = 500;

function changesFor(vendor: string) {
  return loadDealChanges().filter(c => c.vendor.toLowerCase() === vendor.toLowerCase());
}

describe("one function decides a published risk level", () => {
  it("withholds the level for a gated offer, an uncited record and an unread source page", () => {
    const offers = loadOffers();
    const changes = loadDealChanges();
    const withheld = { gate: 0, rating_withheld: 0, source: 0 };
    for (const offer of offers) {
      const risk = publishedRisk(offer, changes.filter(c => c.vendor.toLowerCase() === offer.vendor.toLowerCase()));
      if (risk.risk_level !== null) continue;
      if (risk.gate) withheld.gate++;
      else if (risk.rating_withheld) withheld.rating_withheld++;
      else withheld.source++;
    }
    for (const [rule, count] of Object.entries(withheld)) {
      assert.ok(count > 0, `no record in the catalogue has its level withheld by ${rule}, so that rule is untested here`);
    }
  });

  it("a level is published only when no rule withholds it", () => {
    const offers = loadOffers();
    const changes = loadDealChanges();
    let rated = 0;
    for (const offer of offers) {
      const risk = publishedRisk(offer, changes.filter(c => c.vendor.toLowerCase() === offer.vendor.toLowerCase()));
      if (risk.risk_level === null) continue;
      rated++;
      assert.strictEqual(risk.gate, null, `${offer.vendor} publishes ${risk.risk_level} on a gated offer`);
      assert.strictEqual(risk.rating_withheld, null, `${offer.vendor} publishes ${risk.risk_level} from records that cite no source`);
      assert.ok(RATED_LEVELS.includes(risk.risk_level), `${offer.vendor} publishes ${risk.risk_level}`);
    }
    assertPopulationFloor(rated, RECORDS_FLOOR / 2, "records carry a published level");
  });

  it("withholds a favourable level against an unread source page, and publishes an adverse one", () => {
    const offers = loadOffers();
    const changes = loadDealChanges();
    let adverse = 0;
    for (const offer of offers) {
      const vendorChanges = changes.filter(c => c.vendor.toLowerCase() === offer.vendor.toLowerCase());
      const risk = publishedRisk(offer, vendorChanges);
      if (risk.gate || risk.rating_withheld) continue;
      if (!cannotVouchForLevel(offer, risk.link_unreachable)) continue;
      const recorded = vendorRiskAssessment(changesRatingTheListedTier(offer, vendorChanges)).level;
      if (recorded === "stable") {
        assert.strictEqual(risk.risk_level, null, `${offer.vendor} publishes stable over a page we could not read`);
        continue;
      }
      adverse++;
      assert.strictEqual(
        risk.risk_level,
        recorded,
        `${offer.vendor}: a page we could not read withheld the ${recorded} its own records earned`,
      );
    }
    assert.ok(adverse > 0, "no record carries an adverse level beside a source we cannot vouch for, so that half of the rule is untested here");
  });

  it("every withheld level states the rule that withheld it", () => {
    const offers = loadOffers();
    const changes = loadDealChanges();
    let withheld = 0;
    for (const offer of offers) {
      const risk = publishedRisk(offer, changes.filter(c => c.vendor.toLowerCase() === offer.vendor.toLowerCase()));
      if (risk.risk_level !== null) {
        assert.strictEqual(levelWithheldStatement(offer.vendor, risk), null, `${offer.vendor} carries a level and a reason it was withheld`);
        continue;
      }
      withheld++;
      const statement = levelWithheldStatement(offer.vendor, risk);
      assert.ok(statement && statement.length > 0, `${offer.vendor} has no level and nothing says why`);
    }
    assertPopulationFloor(withheld, WITHHELD_FLOOR, "records have their level withheld");
  });
});

describe("every surface publishes the level /api/offers publishes", () => {
  it("the enriched catalogue row is the published risk of its own record", () => {
    const offers = loadOffers();
    const changes = loadDealChanges();
    const enriched = enrichOffers(offers);
    assert.strictEqual(enriched.length, offers.length);
    for (let at = 0; at < offers.length; at++) {
      const expected = publishedRisk(offers[at], changes.filter(c => c.vendor.toLowerCase() === offers[at].vendor.toLowerCase()));
      assert.strictEqual(
        enriched[at].risk_level,
        expected.risk_level,
        `${offers[at].vendor} (${offers[at].url}) reads ${enriched[at].risk_level} on /api/offers and ${expected.risk_level} from the one function`,
      );
    }
    assertPopulationFloor(offers.length, RECORDS_FLOOR, "records were compared");
  });

  it("/api/audit-stack answers for the record it resolved, exactly as /api/vendor-risk does", () => {
    const offers = loadOffers();
    const names = [...new Set(offers.map(o => o.vendor))];
    const audit = auditStack(names);
    let compared = 0;
    for (const name of names) {
      const svc = audit.services.find(s => s.vendor === name);
      assert.ok(svc, `${name} is missing from the audit`);
      assert.strictEqual(svc.status, "found", `${name} is in the index and the audit did not find it`);
      const match = findVendor(offers, name);
      assert.strictEqual(match.type, "exact", `${name} did not resolve to one record`);
      const expected = publishedRisk(match.offer, changesFor(match.offer.vendor));
      assert.strictEqual(svc.risk_level, expected.risk_level, `${name} audits as ${svc.risk_level} and the catalogue publishes ${expected.risk_level}`);
      const viaVendorRisk = checkVendorRisk(name);
      assert.ok(viaVendorRisk.result, `/api/vendor-risk did not answer for ${name}`);
      assert.strictEqual(svc.risk_level, viaVendorRisk.result.risk_level ?? null, `${name} disagrees between /api/audit-stack and /api/vendor-risk`);
      compared++;
    }
    assertPopulationFloor(compared, NAMES_FLOOR, "vendor names were compared across the two endpoints");
  });

  it("an audited service carries the withholding fields, and a withheld one says why", () => {
    const offers = loadOffers();
    const names = [...new Set(offers.map(o => o.vendor))];
    const audit = auditStack(names);
    let withheld = 0;
    for (const svc of audit.services) {
      if (svc.status !== "found") continue;
      for (const field of ["gate", "rating_withheld", "link_unreachable", "source_check"]) {
        assert.ok(field in svc, `${svc.vendor} carries no ${field} field`);
      }
      if (isRated(svc.risk_level)) {
        assert.strictEqual(svc.gate, null, `${svc.vendor} is gated and audits as ${svc.risk_level}`);
        continue;
      }
      withheld++;
      assert.strictEqual(svc.risk_level, null, `${svc.vendor} audits as ${svc.risk_level}, which is not a level we publish`);
      assert.ok(svc.level_withheld_because, `${svc.vendor} audits with no level and nothing says why`);
    }
    assertPopulationFloor(withheld, WITHHELD_FLOOR, "audited services have their level withheld");
  });

  it("an audited service we do not list carries the gate that says so", () => {
    const offers = loadOffers();
    const gatedNames = [...new Set(
      offers.filter(o => publishedRisk(o, changesFor(o.vendor)).gate).map(o => o.vendor),
    )];
    const audit = auditStack(gatedNames);
    let carried = 0;
    for (const name of gatedNames) {
      const match = findVendor(offers, name);
      if (match.type !== "exact" || !publishedRisk(match.offer, changesFor(match.offer.vendor)).gate) continue;
      const svc = audit.services.find(s => s.vendor === name);
      assert.ok(svc, `${name} is missing from the audit`);
      assert.ok(svc.gate, `${name} is an offer we do not list and the audit reports no gate`);
      carried++;
    }
    assertPopulationFloor(carried, 40, "gated vendors were audited");
  });

  it("counts a vendor we decline to rate as unrated rather than as a risk found", () => {
    const offers = loadOffers();
    const withheld = offers
      .filter(o => publishedRisk(o, changesFor(o.vendor)).risk_level === null)
      .map(o => o.vendor)
      .slice(0, 8);
    assert.ok(withheld.length > 0, "no record has its level withheld, so nothing here is exercised");
    assert.strictEqual(auditStack(withheld).risks_found, 0, "a stack of vendors we decline to rate reports risks");

    const adverse = offers
      .filter(o => ["caution", "risky"].includes(publishedRisk(o, changesFor(o.vendor)).risk_level as string))
      .map(o => o.vendor)
      .slice(0, 2);
    assert.strictEqual(adverse.length, 2, "the catalogue holds fewer than two vendors we publish an adverse level for");
    assert.strictEqual(auditStack(adverse).risks_found, 2, "a published adverse level is not counted as a risk found");
  });

  it("a recommended swap is a vendor we are willing to rate", () => {
    const offers = loadOffers();
    const names = [...new Set(offers.map(o => o.vendor))];
    const audit = auditStack(names);
    const targets = [...new Set(audit.services.filter(s => s.cheaper_alternative).map(s => s.cheaper_alternative!.vendor))];
    for (const target of targets) {
      const match = findVendor(offers, target);
      assert.strictEqual(match.type, "exact", `the swap target ${target} does not resolve to one record`);
      const risk = publishedRisk(match.offer, changesFor(match.offer.vendor));
      assert.strictEqual(risk.risk_level, "stable", `${target} is offered as a swap and the catalogue publishes ${risk.risk_level}`);
    }
    assert.ok(targets.length > 0, "no swap was offered anywhere in the catalogue");
  });

  it("a stack candidate publishes the level its own record does, on every day of the rotation", () => {
    const offers = loadOffers();
    let slots = 0;
    let withheld = 0;
    for (let day = 0; day < 14; day++) {
      const date = new Date(Date.UTC(2026, 0, 1) + day * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      for (const useCase of ["Next.js SaaS app", "AI startup", "mobile backend"]) {
        for (const role of getStackRecommendation(useCase, undefined, date).stack) {
          for (const candidate of role.candidates) {
            slots++;
            const record = offers.find(o => o.vendor === candidate.vendor && o.url === candidate.url);
            assert.ok(record, `${candidate.vendor} is a candidate and is not a record in the index`);
            const expected = publishedRisk(record, changesFor(record.vendor));
            assert.strictEqual(candidate.risk_level, expected.risk_level, `${candidate.vendor} is offered as ${candidate.risk_level} and the catalogue publishes ${expected.risk_level}`);
            if (candidate.risk_level !== null) continue;
            withheld++;
            assert.ok(candidate.level_withheld_because, `${candidate.vendor} is offered with no level and nothing says why`);
          }
        }
      }
    }
    assertPopulationFloor(slots, CANDIDATE_SLOTS_FLOOR, "candidate slots were compared");
    assert.ok(withheld > 0, "no candidate in the rotation has its level withheld, so the reason is untested here");
  });
});

describe("no surface derives a level of its own", () => {
  const DERIVES_A_LEVEL = /vendorRiskAssessment\s*\([^)]*\)\s*\.\s*level|assessment\s*\.\s*level|\bvendorRiskLevel\s*\(/;

  it("only the one function reads a level off a raw assessment", () => {
    const files = fs.readdirSync(path.join(REPO, "src")).filter(f => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(path.join(REPO, "src", file), "utf-8");
      source.split("\n").forEach((line, at) => {
        if (!DERIVES_A_LEVEL.test(line)) return;
        if (file === "data.ts" && line.includes("const assessment = vendorRiskAssessment")) return;
        if (file === "data.ts" && line.includes("assessment.level")) return;
        offenders.push(`src/${file}:${at + 1} ${line.trim()}`);
      });
    }
    assert.deepStrictEqual(offenders, [], "a surface reads a risk level without applying the rules that withhold one");
    assertPopulationFloor(files.length, 20, "source files were scanned");
  });

  it("the withholding rule is written once", () => {
    const source = fs.readFileSync(path.join(REPO, "src", "data.ts"), "utf-8");
    const occurrences = source.split("cannotVouchForLevel(").length - 1;
    assert.strictEqual(occurrences, 1, "cannotVouchForLevel is applied in more than one place in data.ts");
  });
});

describe("a stack grade counts a vendor we decline to rate as unrated", () => {
  const none = { stable: 0, caution: 0, risky: 0, withheld: 0, not_found: 0 };

  it("a stack of nothing we rate earns no letter", () => {
    const graded = gradeForStack({ ...none, withheld: 4 }, 4);
    assert.strictEqual(graded.label, "No grade");
    assert.ok(!/^[A-F]$/.test(graded.grade), `a stack we cannot rate was graded ${graded.grade}`);
  });

  it("an unrated vendor never earns the grade a stable one would", () => {
    const allStable = gradeForStack({ ...none, stable: 4 }, 4);
    const oneWithheld = gradeForStack({ ...none, stable: 3, withheld: 1 }, 4);
    assert.strictEqual(allStable.grade, "A");
    assert.strictEqual(oneWithheld.grade, "A");
    assert.notStrictEqual(oneWithheld.description, allStable.description, "a partial stack claims the same thing about itself as a whole one");
    assert.strictEqual(oneWithheld.denominator, "Grade based on 3 of 4 services.");
  });

  it("a withheld vendor does not dilute a risk it cannot vouch for", () => {
    const overFour = gradeForStack({ ...none, risky: 1, stable: 3 }, 4);
    const overTwo = gradeForStack({ ...none, risky: 1, stable: 1, withheld: 2 }, 4);
    assert.strictEqual(overFour.grade, "D");
    assert.strictEqual(overTwo.grade, "F", "one risky service in two rated ones was graded on a denominator of four");
  });

  it("every letter travels with the denominator it was computed over", () => {
    const shapes = [
      { stable: 4 }, { caution: 4 }, { risky: 4 }, { stable: 2, caution: 2 },
      { stable: 1, risky: 3 }, { stable: 3, withheld: 1 }, { risky: 1, stable: 1, withheld: 2 },
    ];
    for (const shape of shapes) {
      const counts = { ...none, ...shape };
      const entered = counts.stable + counts.caution + counts.risky + counts.withheld;
      const graded = gradeForStack(counts, entered);
      assert.ok(/^[A-F]$/.test(graded.grade), `${JSON.stringify(shape)} earned no letter`);
      assert.ok(graded.denominator.includes(`of ${entered} services`), `the ${graded.grade} for ${JSON.stringify(shape)} carries no denominator`);
    }
  });

  it("a service not in the index is not counted as rated", () => {
    const graded = gradeForStack({ ...none, stable: 1, not_found: 3 }, 4);
    assert.strictEqual(graded.denominator, "Grade based on 1 of 4 services.");
  });
});

describe("the stack check page ships the withholding", () => {
  let proc: ChildProcess | null = null;
  let port = 0;
  let page = "";

  before(async () => {
    proc = await new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
      child.stderr!.on("data", (data: Buffer) => {
        const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
    const res = await fetch(`http://localhost:${port}/stack-check`);
    assert.strictEqual(res.status, 200);
    page = await res.text();
  });

  after(() => { if (proc) proc.kill(); });

  it("the lookup it ships carries the level the catalogue publishes, and says why when there is none", () => {
    const match = page.match(/var VENDOR_LOOKUP = (\{.*?\});\n/s);
    assert.ok(match, "the page ships no vendor lookup");
    const lookup = JSON.parse(match[1]) as Record<string, { vendor: string; risk_level: string | null; level_withheld_because: string | null }>;
    const offers = loadOffers();
    let compared = 0;
    let withheld = 0;
    for (const entry of Object.values(lookup)) {
      const match = findVendor(offers, entry.vendor);
      if (match.type !== "exact") continue;
      compared++;
      if (entry.risk_level === null) {
        withheld++;
        assert.ok(entry.level_withheld_because, `${entry.vendor} ships with no level and nothing says why`);
        continue;
      }
      assert.ok(RATED_LEVELS.includes(entry.risk_level), `${entry.vendor} ships as ${entry.risk_level}`);
      const expected = publishedRisk(match.offer, changesFor(match.offer.vendor));
      assert.strictEqual(entry.risk_level, expected.risk_level, `${entry.vendor} ships as ${entry.risk_level} and the catalogue publishes ${expected.risk_level}`);
    }
    assertPopulationFloor(compared, NAMES_FLOOR, "lookup entries were compared against the catalogue");
    assert.ok(withheld > 0, "the lookup withholds no level, so the reason is untested here");
  });

  it("the client substitutes no level of its own", () => {
    for (const coercion of ["risk_level || 'stable'", "!== 'stable' && !rc"]) {
      assert.ok(!page.includes(coercion), `the page still coerces a missing level: ${coercion}`);
    }
  });

  it("the grade the page computes is the grade this module computes", () => {
    assert.ok(page.includes("function gradeForStack"), "the page carries its own copy of the grading rule");
    assert.ok(page.includes("gradeForStack(riskCounts, data.services.length)"), "the page does not call the shared rule");
    assert.ok(page.includes(">Unrated<"), "the risk summary has no unrated stat");
  });
});
