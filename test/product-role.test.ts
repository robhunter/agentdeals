import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  membershipGatesFor,
  alternativeMembershipGate,
  roleMembershipGate,
  partitionAlternatives,
  partitionAlternativesAcross,
  partitionRoleCandidates,
  filterAlternatives,
  productRoleSentence,
  MEMBERSHIP_GATE_ORDER,
  MEMBERSHIP_GATE_RULES,
} from "../src/product-role.ts";
import { rankForListing, rankOffers } from "../src/ranking.ts";
import type { Offer, ProductRole, DeploymentModel } from "../src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const index = JSON.parse(readFileSync(join(REPO, "data", "index.json"), "utf8")) as { offers: Offer[] };

const DEPLOYMENT_MODELS: DeploymentModel[] = ["hosted", "self_hosted", "local_dev_only"];

function offer(vendor: string, role?: Partial<ProductRole>): Offer {
  return {
    vendor,
    category: "Databases",
    description: `${vendor} description`,
    tier: "Free",
    url: `https://${vendor.toLowerCase()}.example/pricing`,
    tags: [],
    verifiedDate: "2026-08-01",
    ...(role
      ? {
          product_role: {
            deployment_model: "hosted",
            is_addon: false,
            source_url: `https://${vendor.toLowerCase()}.example/docs`,
            source_quote: "quote",
            reviewed: "2026-08-25",
            ...role,
          } as ProductRole,
        }
      : {}),
  };
}

const hosted = offer("Hosted");
const emulator = offer("Emulator", { deployment_model: "local_dev_only" });
const otherEmulator = offer("OtherEmulator", { deployment_model: "local_dev_only" });
const addon = offer("Addon", { is_addon: true, augments: "a database you already run" });
const otherAddon = offer("OtherAddon", { is_addon: true });
const selfHosted = offer("SelfHosted", { deployment_model: "self_hosted" });
const unreviewed = offer("Unreviewed");

describe("#1032 which product properties gate membership", () => {
  it("an unclassified record carries no gate", () => {
    assert.deepStrictEqual([...membershipGatesFor(unreviewed)], []);
  });

  it("only local_dev_only gates on deployment model, and self-hosted never does", () => {
    assert.deepStrictEqual([...membershipGatesFor(emulator)], ["local_dev_only"]);
    assert.deepStrictEqual([...membershipGatesFor(selfHosted)], []);
    assert.deepStrictEqual([...membershipGatesFor(hosted)], []);
  });

  it("an add-on gates whatever it is deployed as", () => {
    assert.deepStrictEqual([...membershipGatesFor(addon)], ["addon"]);
    const selfHostedAddon = offer("Both", { deployment_model: "self_hosted", is_addon: true });
    assert.deepStrictEqual([...membershipGatesFor(selfHostedAddon)], ["addon"]);
  });

  it("a record can carry both gates", () => {
    const both = offer("Both", { deployment_model: "local_dev_only", is_addon: true });
    assert.deepStrictEqual([...membershipGatesFor(both)].sort(), ["addon", "local_dev_only"]);
  });

  it("every gate in the order table has published wording", () => {
    for (const gate of MEMBERSHIP_GATE_ORDER) {
      assert.ok(MEMBERSHIP_GATE_RULES[gate].label.length > 0, `${gate} needs a label`);
      assert.ok(MEMBERSHIP_GATE_RULES[gate].rule.length > 20, `${gate} needs a rule a reader can check`);
    }
    assert.deepStrictEqual(
      Object.keys(MEMBERSHIP_GATE_RULES).sort(),
      [...MEMBERSHIP_GATE_ORDER].sort(),
      "the published table and the applied order must name the same gates"
    );
  });
});

describe("#1032 a gate removes a candidate only where the subject cannot carry it too", () => {
  it("removes a local-only product from a hosted product's alternatives", () => {
    assert.equal(alternativeMembershipGate(emulator, hosted), "local_dev_only");
  });

  it("keeps a local-only product in another local-only product's alternatives", () => {
    assert.equal(alternativeMembershipGate(emulator, otherEmulator), null);
  });

  it("removes an add-on from the alternatives of the thing it augments", () => {
    assert.equal(alternativeMembershipGate(addon, hosted), "addon");
  });

  it("keeps an add-on in another add-on's alternatives", () => {
    assert.equal(alternativeMembershipGate(addon, otherAddon), null);
  });

  it("never removes a candidate that carries no gate", () => {
    for (const subject of [hosted, emulator, addon, selfHosted, unreviewed]) {
      assert.equal(alternativeMembershipGate(hosted, subject), null);
      assert.equal(alternativeMembershipGate(selfHosted, subject), null);
      assert.equal(alternativeMembershipGate(unreviewed, subject), null);
    }
  });

  it("a subject carrying one gate does not inherit the other", () => {
    assert.equal(alternativeMembershipGate(addon, emulator), "addon");
    assert.equal(alternativeMembershipGate(emulator, addon), "local_dev_only");
  });

  it("reports the removed candidates and the gate that removed each", () => {
    const { kept, removed } = partitionAlternatives([hosted, emulator, addon, selfHosted], hosted);
    assert.deepStrictEqual(kept.map((o) => o.vendor), ["Hosted", "SelfHosted"]);
    assert.deepStrictEqual(
      removed.map((r) => [r.offer.vendor, r.gate]),
      [["Emulator", "local_dev_only"], ["Addon", "addon"]]
    );
  });

  it("filterAlternatives keeps exactly what partitionAlternatives keeps", () => {
    const candidates = [hosted, emulator, addon, selfHosted, unreviewed];
    assert.deepStrictEqual(
      filterAlternatives(candidates, hosted).map((o) => o.vendor),
      partitionAlternatives(candidates, hosted).kept.map((o) => o.vendor)
    );
  });

  it("a vendor listed in several categories keeps a candidate any one of its records could keep", () => {
    const acrossOne = partitionAlternativesAcross([emulator], [hosted]);
    assert.deepStrictEqual(acrossOne.removed.map((r) => r.offer.vendor), ["Emulator"]);
    const acrossBoth = partitionAlternativesAcross([emulator], [hosted, otherEmulator]);
    assert.deepStrictEqual(acrossBoth.kept.map((o) => o.vendor), ["Emulator"]);
  });
});

describe("#1032 a role recommendation has no subject to compare against", () => {
  it("removes every gated candidate from a role, both gates", () => {
    const { kept, removed } = partitionRoleCandidates([hosted, emulator, addon, selfHosted, unreviewed]);
    assert.deepStrictEqual(kept.map((o) => o.vendor), ["Hosted", "SelfHosted", "Unreviewed"]);
    assert.deepStrictEqual(removed.map((r) => r.gate), ["local_dev_only", "addon"]);
  });

  it("names a gate for a gated record and nothing for an ungated one", () => {
    assert.equal(roleMembershipGate(emulator), "local_dev_only");
    assert.equal(roleMembershipGate(addon), "addon");
    assert.equal(roleMembershipGate(selfHosted), null);
    assert.equal(roleMembershipGate(unreviewed), null);
  });
});

describe("#1032 neither property can reach scoring or ordering", () => {
  const rankingSource = readFileSync(join(REPO, "src", "ranking.ts"), "utf8");

  it("the selection module does not mention either property", () => {
    for (const banned of [/product_role/, /deployment_model/, /is_addon/, /local_dev_only/]) {
      assert.ok(!banned.test(rankingSource), `the selection module must not read ${banned}`);
    }
  });

  it("flipping every classification leaves the order of a listing byte-identical", () => {
    const candidates = index.offers.filter((o) => o.category === "Databases");
    assert.ok(candidates.length > 10, "this test needs a category with enough records to order");

    const before = rankForListing(candidates, { queryKey: "order-check", changes: [], date: "2026-08-25" });
    const flipped = candidates.map((o) => ({
      ...o,
      product_role: {
        deployment_model: (o.product_role?.deployment_model === "local_dev_only" ? "hosted" : "local_dev_only") as DeploymentModel,
        is_addon: !o.product_role?.is_addon,
        source_url: "https://example.invalid/docs",
        source_quote: "flipped for this test",
        reviewed: "2026-08-25",
      },
    }));
    const after = rankForListing(flipped, { queryKey: "order-check", changes: [], date: "2026-08-25" });

    assert.deepStrictEqual(
      after.entries.map((e) => e.offer.vendor),
      before.entries.map((e) => e.offer.vendor),
      "the classification must not move a single position"
    );
    assert.deepStrictEqual(
      after.entries.map((e) => e.demerit_total),
      before.entries.map((e) => e.demerit_total),
      "the classification must not add or remove a single demerit point"
    );
  });

  it("a gated offer scores exactly what it scored before it was classified", () => {
    const subject = index.offers.find((o) => o.vendor === "DynamoDB Local");
    assert.ok(subject, "DynamoDB Local must be in the catalogue for this test to mean anything");
    const withoutRole = { ...subject } as Offer;
    delete withoutRole.product_role;
    const opts = { queryKey: "score-check", changes: [], date: "2026-08-25" };
    assert.deepStrictEqual(
      rankOffers([subject], opts).ranked.map((e) => e.demerit_total),
      rankOffers([withoutRole], opts).ranked.map((e) => e.demerit_total)
    );
  });
});

describe("#1032 every classification in the catalogue is publishable", () => {
  const classified = index.offers.filter((o) => o.product_role);

  it("classifies at least one record, so the assertions below have a subject", () => {
    assert.ok(classified.length > 0, "no record carries a product_role, so nothing below is being checked");
  });

  it("uses only the three published deployment models", () => {
    for (const o of classified) {
      assert.ok(
        DEPLOYMENT_MODELS.includes(o.product_role!.deployment_model),
        `${o.vendor} carries an unpublished deployment model: ${o.product_role!.deployment_model}`
      );
    }
  });

  it("carries a source on an outside site and the sentence read from it", () => {
    for (const o of classified) {
      const role = o.product_role!;
      assert.ok(role.source_url.startsWith("https://"), `${o.vendor} needs an https source`);
      assert.ok(!role.source_url.includes("agentdeals"), `${o.vendor} must cite the vendor, not us`);
      assert.ok(role.source_quote.trim().length > 20, `${o.vendor} needs the sentence it was read from`);
      assert.match(role.reviewed, /^\d{4}-\d{2}-\d{2}$/, `${o.vendor} needs the date it was read`);
    }
  });

  it("marks an add-on with what it extends", () => {
    for (const o of classified.filter((x) => x.product_role!.is_addon)) {
      assert.ok((o.product_role!.augments ?? "").length > 0, `${o.vendor} is gated as an add-on without saying what it extends`);
    }
  });

  it("says in one sentence what the classification means for where the offer appears", () => {
    for (const o of classified) {
      const sentence = productRoleSentence(o)!;
      assert.ok(sentence.includes(o.vendor), `${o.vendor}'s published sentence must name it`);
      assert.ok(sentence.includes(o.category), `${o.vendor}'s published sentence must say where it is still listed`);
    }
    assert.equal(productRoleSentence(unreviewed), null, "an unreviewed offer publishes no sentence");
  });
});

describe("#1032 what the gates do to the catalogue", () => {
  const categories = [...new Set(index.offers.map((o) => o.category))];

  it("leaves the two entries the issue names out of the Neon alternatives set", () => {
    const neon = index.offers.find((o) => o.vendor === "Neon");
    assert.ok(neon, "Neon must be in the catalogue for this test to mean anything");
    const kept = filterAlternatives(
      index.offers.filter((o) => o.category === neon.category && o.vendor !== neon.vendor),
      neon
    ).map((o) => o.vendor);
    assert.ok(kept.length > 0, "the Neon alternatives set must not be empty");
    assert.ok(!kept.includes("Prisma Accelerate"), "a connection pool is not an alternative to a database");
    assert.ok(!kept.includes("DynamoDB Local"), "a downloadable emulator is not an alternative to a hosted database");
  });

  it("does not drop any category's alternatives list below three entries", () => {
    const thin: string[] = [];
    for (const category of categories) {
      const inCategory = index.offers.filter((o) => o.category === category);
      if (inCategory.length < 4) continue;
      for (const subject of inCategory) {
        const kept = filterAlternatives(inCategory.filter((o) => o.vendor !== subject.vendor), subject);
        if (kept.length < 3) thin.push(`${subject.vendor} (${category}): ${kept.length}`);
      }
    }
    assert.deepStrictEqual(thin, [], `these alternatives lists fall below three entries: ${thin.join("; ")}`);
  });

  it("leaves reviewed products that are their own category's real thing ungated", () => {
    const mustStay = ["MinIO", "Bruno", "Insomnia", "Playwright", "LanceDB", "AWS SAM CLI", "Appetize", "ElasticMQ"];
    for (const vendor of mustStay) {
      const record = index.offers.find((o) => o.vendor === vendor);
      assert.ok(record, `${vendor} must be in the catalogue for this test to mean anything`);
      assert.deepStrictEqual(
        [...membershipGatesFor(record)],
        [],
        `${vendor} runs real workloads and must stay in its category's alternatives lists`
      );
    }
  });
});
