import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

process.env.AGENTDEALS_REFUSALS_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "refusals-licence-free-removal-")),
  "change_refusals.json"
);

const {
  alsoFreeByPlan,
  citesALicenceBearingSource,
  freeGrounds,
  isFreeByLicence,
  gateCandidates,
  statesTheLicenceIsUntouched,
  vendorsFreeByLicence,
  FREE_GROUNDS,
  FREE_GROUNDS_FIELD,
  FREE_GROUND_LICENCE,
  FREE_GROUND_PLAN,
  FREE_TIER_REMOVED,
  GATE_REASONS,
  REJECT_REMOVAL_DOES_NOT_REACH_THE_LICENCE,
} = await import("../scripts/change-gate.js");

const { enrichOffers, loadOffers } = await import("../dist/data.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataFile = (name: string) =>
  JSON.parse(readFileSync(path.join(__dirname, "..", "data", name), "utf-8"));

const OFFERS = dataFile("index.json").offers as Array<Record<string, any>>;
const CHANGES = dataFile("deal_changes.json").changes as Array<Record<string, any>>;

const REMOVALS = CHANGES.filter(c => c.change_type === FREE_TIER_REMOVED);
const READ_FROM_A_HOSTED_PRICING_PAGE = ["Plausible Analytics", "Circum Icons", "Rybbit"];

const offerFor = (vendor: string) =>
  OFFERS.find(o => o.vendor.toLowerCase() === vendor.toLowerCase()) ?? null;

const removalFor = (vendor: string, date?: string) =>
  REMOVALS.filter(c => c.vendor.toLowerCase() === vendor.toLowerCase() && (!date || c.date === date));

const gate = (candidates: Array<Record<string, any>>, offers = OFFERS) =>
  gateCandidates(candidates, { offers });

const refusalReasons = async (candidates: Array<Record<string, any>>) => {
  const { rejected } = await gate(candidates);
  return rejected.map((r: { reason: string }) => r.reason);
};

describe("a licence grants the free use and a pricing page cannot withdraw it (#1658)", () => {
  describe("the grounds an offer is free on are stored beside the offer", () => {
    it("records only grounds the gate knows how to read", () => {
      const unknown = OFFERS.filter(o => FREE_GROUNDS_FIELD in o)
        .filter(o => {
          const stored = o[FREE_GROUNDS_FIELD];
          return !Array.isArray(stored) || stored.some((g: string) => !FREE_GROUNDS.includes(g));
        })
        .map(o => `${o.vendor}: ${JSON.stringify(o[FREE_GROUNDS_FIELD])}`);
      assert.deepStrictEqual(unknown, [], `offers storing a ground outside ${FREE_GROUNDS.join(" and ")}:\n${unknown.join("\n")}`);
    });

    it("names the licence as the ground for every offer whose free thing the licence grants", () => {
      for (const vendor of ["Plausible Analytics", "Circum Icons", "Rybbit", "DBOS", "n8n", "Kong", "MinIO"]) {
        assert.ok(isFreeByLicence(offerFor(vendor)), `${vendor} is free because its licence grants the use`);
      }
    });

    it("holds the two grounds apart, so a hosted plan can end while the licence stands", () => {
      assert.deepStrictEqual(freeGrounds(offerFor("Rybbit")), [FREE_GROUND_LICENCE, FREE_GROUND_PLAN]);
      assert.ok(alsoFreeByPlan(offerFor("Rybbit")));
      assert.ok(!alsoFreeByPlan(offerFor("Kong")));
    });

    it("is not read from the tier string, which names open source for offers the licence does not make free", () => {
      for (const vendor of ["JetBrains", "1Password", "Sentry", "BrowserStack", "Sauce Labs", "Semaphore CI", "VirusTotal", "Clarifai"]) {
        const held = OFFERS.filter(o => o.vendor === vendor);
        assert.ok(held.length > 0, `${vendor} is in the catalogue`);
        assert.ok(
          held.some(o => /oss|open.?source|community/i.test(o.tier)),
          `${vendor} holds an offer whose tier names open source`
        );
        for (const offer of held) {
          assert.ok(!isFreeByLicence(offer), `${vendor} is free on a plan or an eligibility rule, not on a licence`);
        }
      }
    });

    it("reads a candidate onto its offer by the name the record carries, whatever its case", () => {
      const vendors = vendorsFreeByLicence(OFFERS);
      assert.ok(vendors.has("plausible analytics"));
      assert.ok(!vendors.has("jetbrains"));
      assert.strictEqual(vendorsFreeByLicence().size, 0);
      assert.strictEqual(freeGrounds({ vendor: "Slack" }).length, 0);
      assert.strictEqual(isFreeByLicence(undefined), false);
    });
  });

  describe("the gate refuses a removal whose evidence cannot reach the licence", () => {
    it("refuses every record read off a hosted-pricing surface for an offer the licence makes free", async () => {
      for (const vendor of READ_FROM_A_HOSTED_PRICING_PAGE) {
        const [record] = removalFor(vendor, "2026-08-28");
        assert.ok(record, `${vendor} holds the 2026-08-28 record`);
        assert.deepStrictEqual(await refusalReasons([record]), [REJECT_REMOVAL_DOES_NOT_REACH_THE_LICENCE]);
      }
    });

    it("states what a record would have to carry instead", async () => {
      const [record] = removalFor("Plausible Analytics", "2026-08-28");
      const { rejected } = await gate([record]);
      assert.match(rejected[0].detail, /licence grants the use/);
      assert.match(rejected[0].detail, /repository, its licence file or a self-hosting document/);
    });

    it("counts its refusals, so the population it holds back can be reported", () => {
      assert.ok(GATE_REASONS.includes(REJECT_REMOVAL_DOES_NOT_REACH_THE_LICENCE));
    });

    it("refuses these three and no other record in the change log", async () => {
      const refused: string[] = [];
      for (const record of REMOVALS) {
        const { rejected } = await gate([record]);
        if (rejected.some((r: { reason: string }) => r.reason === REJECT_REMOVAL_DOES_NOT_REACH_THE_LICENCE)) {
          refused.push(record.vendor);
        }
      }
      assertPopulationFloor(REMOVALS.length, 60, "free-tier removal records read through the gate");
      assert.deepStrictEqual(refused.sort(), [...READ_FROM_A_HOSTED_PRICING_PAGE].sort());
    });
  });

  describe("records the licence question does not touch are left alone", () => {
    it("keeps a removal a person wrote against the vendor's own announcement", async () => {
      for (const vendor of ["LocalStack", "SwaggerHub", "Elmah.io", "DBOS", "Storj"]) {
        const records = removalFor(vendor);
        assert.ok(records.length > 0, `${vendor} holds a free-tier removal`);
        assert.deepStrictEqual(await refusalReasons(records), []);
      }
    });

    it("keeps a removal on an offer whose free thing is a hosted plan", async () => {
      const onAHostedPlan = REMOVALS.filter(c => {
        const offer = offerFor(c.vendor);
        return offer !== null && !isFreeByLicence(offer);
      });
      assert.ok(
        onAHostedPlan.length > 0,
        "no removal sits on an offer the licence does not make free, so this case has no subject to read",
      );
      const reached: string[] = [];
      for (const record of onAHostedPlan) {
        const reasons = await refusalReasons([record]);
        if (reasons.includes(REJECT_REMOVAL_DOES_NOT_REACH_THE_LICENCE)) {
          reached.push(`${record.vendor} ${record.date}`);
        }
      }
      assert.deepStrictEqual(reached, [], "the licence gate refused a record whose offer no licence makes free");
    });

    it("keeps a read that says which hosted plan ended and leaves the licence standing", async () => {
      const [record] = removalFor("n8n", "2026-09-03");
      assert.ok(record, "n8n holds the 2026-09-03 record");
      assert.strictEqual(record.date_source, "discovered");
      assert.ok(isFreeByLicence(offerFor("n8n")));
      assert.ok(statesTheLicenceIsUntouched(record.summary));
      assert.deepStrictEqual(await refusalReasons([record]), []);
    });

    it("keeps a read that cites a source carrying the licence", async () => {
      const [refused] = removalFor("Rybbit", "2026-08-28");
      const cited = { ...refused, source_url: "https://github.com/rybbit-io/rybbit/blob/master/LICENSE" };
      assert.deepStrictEqual(await refusalReasons([cited]), []);
    });
  });

  describe("what counts as a source that carries a licence", () => {
    it("accepts a repository and a page about the licence or about self-hosting", () => {
      for (const url of [
        "https://github.com/plausible/analytics",
        "https://gitlab.com/gitlab-org/gitlab",
        "https://codeberg.org/forgejo/forgejo",
        "https://plausible.io/docs/self-hosting",
        "https://www.elastic.co/licensing/elastic-license",
        "https://n8n.io/oss",
      ]) {
        assert.ok(citesALicenceBearingSource(url), `${url} carries a licence`);
      }
    });

    it("refuses a hosted-pricing surface and a homepage", () => {
      for (const url of [
        "https://plausible.io/",
        "https://rybbit.com/",
        "https://circumicons.com",
        "https://www.dbos.dev/pricing",
        "not a url",
        "",
      ]) {
        assert.ok(!citesALicenceBearingSource(url), `${url} states what the vendor sells, not what the licence permits`);
      }
    });
  });

  describe("the three records are withdrawn and the grade follows", () => {
    it("carries a retraction citing the repository the licence lives in", () => {
      for (const vendor of READ_FROM_A_HOSTED_PRICING_PAGE) {
        const [record] = removalFor(vendor, "2026-08-28");
        assert.strictEqual(record.resolution?.state, "retracted", `${vendor}'s record is withdrawn`);
        assert.ok(
          citesALicenceBearingSource(record.resolution?.source_url),
          `${vendor}'s retraction cites a source that carries the licence`
        );
        assert.match(record.resolution.detail, /licence|licen[cs]e/i);
      }
    });

    it("no longer rates an offer risky on a record we have withdrawn", () => {
      const enriched = enrichOffers(loadOffers());
      const gradeFor = (vendor: string) =>
        enriched.find((o: { vendor: string }) => o.vendor.toLowerCase() === vendor.toLowerCase())?.risk_level ?? null;
      for (const vendor of READ_FROM_A_HOSTED_PRICING_PAGE) {
        assert.notStrictEqual(gradeFor(vendor), "risky", `${vendor} is not rated risky on a withdrawn record`);
      }
      assert.strictEqual(gradeFor("LocalStack"), "risky");
    });
  });

  describe("the grounds decide what the pipeline may record and are not published as a term", () => {
    it("is absent from every offer the server serves and present in the store", () => {
      const served = loadOffers().filter((o: Record<string, any>) => FREE_GROUNDS_FIELD in o);
      assert.deepStrictEqual(served, []);
      const stored = new Set(OFFERS.filter(o => FREE_GROUNDS_FIELD in o).map(o => o.vendor));
      for (const vendor of [...READ_FROM_A_HOSTED_PRICING_PAGE, "DBOS", "n8n", "Kong"]) {
        assert.ok(stored.has(vendor), `${vendor} carries its grounds where the gate reads them`);
      }
    });

    it("is absent from the enriched offer every page and route renders", () => {
      const leaked = enrichOffers(loadOffers())
        .filter((o: Record<string, any>) => FREE_GROUNDS_FIELD in o)
        .map((o: { vendor: string }) => o.vendor);
      assert.deepStrictEqual(leaked, []);
    });
  });
});
