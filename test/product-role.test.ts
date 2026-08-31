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
  subtypesOf,
  subtypeDefinition,
  membershipGroupsFor,
  MEMBERSHIP_GATE_ORDER,
  MEMBERSHIP_GATE_RULES,
  SUBTYPE_TAXONOMIES,
  SUBTYPE_MEMBERSHIP_GROUPS,
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

function labelled(vendor: string, subtypes: string[], taxonomy = "Databases"): Offer {
  return {
    ...offer(vendor),
    category: taxonomy,
    product_subtypes: {
      taxonomy,
      labels: subtypes.map(subtype => ({
        subtype,
        source_url: `https://${vendor.toLowerCase()}.example/`,
        source_quote: `${vendor} is a ${subtype}`,
      })),
      reviewed: "2026-08-31",
    },
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

describe("#1032 Phase 2 subtypes gate on sharing at least one label", () => {
  const relational = labelled("Relational", ["relational"]);
  const vector = labelled("Vector", ["vector"]);
  const multi = labelled("Multi", ["relational", "vector"]);
  const none = labelled("None", []);
  const unlabelled = offer("Unlabelled");
  const otherTaxonomy = labelled("Hosted App", ["container_app"], "Cloud Hosting");

  it("removes a candidate that shares no subtype with the subject", () => {
    assert.equal(alternativeMembershipGate(vector, relational), "subtype_mismatch");
  });

  it("keeps a candidate that shares one subtype out of several", () => {
    assert.equal(alternativeMembershipGate(multi, relational), null);
    assert.equal(alternativeMembershipGate(multi, vector), null);
  });

  it("keeps a candidate on the page of a subject that shares one of its labels", () => {
    assert.equal(alternativeMembershipGate(relational, multi), null);
    assert.equal(alternativeMembershipGate(vector, multi), null);
  });

  it("removes a candidate that carries no subtype from a labelled subject", () => {
    assert.equal(alternativeMembershipGate(none, relational), "not_in_taxonomy");
  });

  it("never gates a record we have not classified, in either direction", () => {
    assert.equal(alternativeMembershipGate(unlabelled, relational), null);
    assert.equal(alternativeMembershipGate(relational, unlabelled), null);
  });

  it("applies no subtype gate on the page of a subject that carries no subtype of its own", () => {
    assert.equal(alternativeMembershipGate(relational, none), null);
    assert.equal(alternativeMembershipGate(vector, none), null);
  });

  it("never compares subtypes across two different taxonomies", () => {
    assert.equal(alternativeMembershipGate(otherTaxonomy, relational), null);
    assert.equal(alternativeMembershipGate(relational, otherTaxonomy), null);
  });

  it("lets a caller exempt a candidate from the subtype gate without exempting the role gates", () => {
    const gatedAddon = { ...labelled("CuratedAddon", ["vector"]), product_role: addon.product_role };
    const exempt = partitionAlternativesAcross([vector, gatedAddon], [relational], { subtypeExempt: () => true });
    assert.deepStrictEqual(exempt.kept.map(o => o.vendor), ["Vector"]);
    assert.deepStrictEqual(exempt.removed.map(r => r.gate), ["addon"]);
    const applied = partitionAlternativesAcross([vector], [relational]);
    assert.deepStrictEqual(applied.removed.map(r => r.gate), ["subtype_mismatch"]);
  });

  it("keeps two offers whose only shared property is a membership group", () => {
    const staticHost = labelled("StaticHost", ["static_site"], "Cloud Hosting");
    const containerHost = labelled("ContainerHost", ["container_app"], "Cloud Hosting");
    assert.equal(alternativeMembershipGate(containerHost, staticHost), null);
    assert.equal(alternativeMembershipGate(staticHost, containerHost), null);
  });

  it("still removes a subtype the group does not name from a grouped subject", () => {
    const staticHost = labelled("StaticHost", ["static_site"], "Cloud Hosting");
    const docsHost = labelled("DocsHost", ["managed_cms_hosting"], "Cloud Hosting");
    assert.equal(alternativeMembershipGate(docsHost, staticHost), "subtype_mismatch");
    assert.equal(alternativeMembershipGate(staticHost, docsHost), "subtype_mismatch");
  });

  it("removes an unlabelled record from a grouped subject as it always did", () => {
    const staticHost = labelled("StaticHost", ["static_site"], "Cloud Hosting");
    const noLabels = labelled("NoLabels", [], "Cloud Hosting");
    assert.equal(alternativeMembershipGate(noLabels, staticHost), "not_in_taxonomy");
  });

  it("applies no group to a taxonomy that declares none", () => {
    assert.deepStrictEqual(membershipGroupsFor("Databases"), []);
    assert.equal(alternativeMembershipGate(vector, relational), "subtype_mismatch");
  });

  it("names only subtypes its own taxonomy publishes in every group", () => {
    for (const [taxonomy, groups] of Object.entries(SUBTYPE_MEMBERSHIP_GROUPS)) {
      const known = new Set((SUBTYPE_TAXONOMIES[taxonomy] ?? []).map(e => e.subtype));
      assert.ok(known.size > 0, `${taxonomy} declares a group without a published taxonomy`);
      for (const group of groups) {
        assert.ok(group.subtypes.length > 1, `${taxonomy} declares a group of one, which is the rule it replaces`);
        assert.ok(group.rule.length > 40, `${taxonomy} needs a group rule a reader can check`);
        for (const subtype of group.subtypes) {
          assert.ok(known.has(subtype), `${taxonomy} groups ${subtype}, which its taxonomy does not name`);
        }
      }
    }
  });

  it("publishes a definition for every subtype the taxonomies name", () => {
    for (const [taxonomy, entries] of Object.entries(SUBTYPE_TAXONOMIES)) {
      for (const entry of entries) {
        assert.equal(subtypeDefinition(taxonomy, entry.subtype), entry.definition);
      }
    }
  });

  it("uses only subtypes its own taxonomy names", () => {
    const strays: string[] = [];
    for (const record of index.offers) {
      const classified = record.product_subtypes;
      if (!classified) continue;
      const known = new Set((SUBTYPE_TAXONOMIES[classified.taxonomy] ?? []).map(e => e.subtype));
      assert.ok(known.size > 0, `${classified.taxonomy} has no published taxonomy`);
      assert.equal(classified.taxonomy, record.category, `${record.vendor} is classified under a taxonomy that is not its category`);
      for (const label of classified.labels) {
        if (!known.has(label.subtype)) strays.push(`${record.vendor}: ${label.subtype}`);
      }
    }
    assert.deepStrictEqual(strays, []);
  });

  it("carries a source URL and the sentence read from it on every label", () => {
    const bare: string[] = [];
    for (const record of index.offers) {
      for (const label of record.product_subtypes?.labels ?? []) {
        if (!/^https:\/\//.test(label.source_url) || label.source_quote.trim().length < 10) {
          bare.push(`${record.vendor}: ${label.subtype}`);
        }
      }
    }
    assert.deepStrictEqual(bare, [], "a subtype nobody can check is not a published property");
  });

  it("reads back the labels it was given", () => {
    assert.deepStrictEqual([...subtypesOf(multi)!.subtypes], ["relational", "vector"]);
    assert.equal(subtypesOf(multi)!.taxonomy, "Databases");
    assert.equal(subtypesOf(unlabelled), null);
    assert.deepStrictEqual([...subtypesOf(none)!.subtypes], []);
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

describe("#1195 no commercial field can reach a membership decision", () => {
  const membershipSource = readFileSync(join(REPO, "src", "product-role.ts"), "utf8");

  it("the membership module does not mention a referral, sponsorship or commission field", () => {
    for (const banned of [/referral/i, /sponsor/i, /commission/i, /payout/i, /affiliate/i, /revenue/i]) {
      assert.ok(!banned.test(membershipSource), `the membership module must not read ${banned}`);
    }
  });

  it("attaching a referral to every candidate leaves every hosting page's partition identical", () => {
    const hosting = index.offers.filter(o => o.category === "Cloud Hosting");
    assert.ok(hosting.length > 20, `this test needs a category with enough records, found ${hosting.length}`);
    const paid = hosting.map(o => ({
      ...o,
      referral: {
        url: `https://${o.vendor.toLowerCase()}.example/r/agentdeals`,
        referee_value: "$100 credit",
        referrer_value: "$100 cash",
        referrer_compensation: "commission" as const,
        type: "dual-sided" as const,
        source: "curated" as const,
      },
      referral_program: {
        available: true,
        referrer_benefit: "$100 cash",
        referee_benefit: "$100 credit",
        program_url: `https://${o.vendor.toLowerCase()}.example/partners`,
        type: "affiliate-network" as const,
      },
    }));
    let subjectsChecked = 0;
    for (const subject of hosting) {
      const plainSubject = hosting.filter(o => o.vendor !== subject.vendor);
      const paidSubject = paid.filter(o => o.vendor !== subject.vendor);
      const before = partitionAlternatives(plainSubject, subject);
      const after = partitionAlternatives(paidSubject, paid.find(o => o.vendor === subject.vendor)!);
      subjectsChecked += 1;
      assert.deepStrictEqual(
        after.kept.map(o => o.vendor),
        before.kept.map(o => o.vendor),
        `${subject.vendor} keeps a different set once every candidate pays`
      );
      assert.deepStrictEqual(
        after.removed.map(r => `${r.offer.vendor}:${r.gate}`),
        before.removed.map(r => `${r.offer.vendor}:${r.gate}`),
        `${subject.vendor} removes a different set once every candidate pays`
      );
    }
    assert.ok(subjectsChecked > 20, `the sweep must actually run, ran ${subjectsChecked} times`);
  });
});

describe("#1032 neither property can reach scoring or ordering", () => {
  const rankingSource = readFileSync(join(REPO, "src", "ranking.ts"), "utf8");

  it("the selection module does not mention either property", () => {
    for (const banned of [/product_role/, /deployment_model/, /is_addon/, /local_dev_only/, /product_subtypes/, /subtypes/]) {
      assert.ok(!banned.test(rankingSource), `the selection module must not read ${banned}`);
    }
  });

  it("relabelling every subtype leaves the order of a listing byte-identical", () => {
    const candidates = index.offers.filter((o) => o.category === "Databases");
    assert.ok(candidates.length > 10, "this test needs a category with enough records to order");
    const opts = { queryKey: "order-check", changes: [], date: "2026-08-25" };
    const before = rankForListing(candidates, opts);
    const relabelled = candidates.map((o) => ({
      ...o,
      product_subtypes: {
        taxonomy: "Databases",
        labels: [{ subtype: "graph", source_url: "https://example.invalid/docs", source_quote: "relabelled for this test" }],
        reviewed: "2026-08-25",
      },
    }));
    const after = rankForListing(relabelled as Offer[], opts);
    assert.deepStrictEqual(
      after.entries.map((e) => e.offer.vendor),
      before.entries.map((e) => e.offer.vendor),
      "a subtype must not move a single position"
    );
    assert.deepStrictEqual(
      after.entries.map((e) => e.demerit_total),
      before.entries.map((e) => e.demerit_total),
      "a subtype must not add or remove a single demerit point"
    );
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

  function keptCounts(): Array<{ label: string; kept: number }> {
    const counts: Array<{ label: string; kept: number }> = [];
    for (const category of categories) {
      const inCategory = index.offers.filter((o) => o.category === category);
      if (inCategory.length < 4) continue;
      for (const subject of inCategory) {
        const kept = filterAlternatives(inCategory.filter((o) => o.vendor !== subject.vendor), subject);
        counts.push({ label: `${subject.vendor} (${category})`, kept: kept.length });
      }
    }
    return counts;
  }

  it("leaves no alternatives list empty", () => {
    const empty = keptCounts().filter((c) => c.kept === 0).map((c) => c.label).sort();
    assert.deepStrictEqual(empty, [], `an empty list states in our own voice that we index no peer at all: ${empty.join("; ")}`);
  });

  it("names every alternatives list the gates leave below three entries", () => {
    const thin = keptCounts().filter((c) => c.kept < 3).map((c) => `${c.label}: ${c.kept}`).sort();
    assert.deepStrictEqual(thin, [
      "InfluxDB Cloud (Databases): 1",
      "Neo4j AuraDB (Databases): 2",
    ]);
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
