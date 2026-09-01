import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { partitionSubstitutes, subtypeGateBinds, substitutesFor, MEMBERSHIP_GATE_ORDER, MEMBERSHIP_GATE_RULES } from "../dist/product-role.js";
import { toSlug, vendorSlugMap } from "../dist/vendor-slug.js";
import { curatedAlternativeNames } from "../dist/curated-alternatives.js";
import type { DealChange, Offer } from "../src/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const changes: DealChange[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;

const CLASSIFIED_CATEGORIES = ["Databases", "Cloud Hosting"];
const SENDGRID_WRONG_CLASS = ["Bench", "Remote for Startups", "Esri Startup Program"];
const SENDGRID_CURATED = ["Postmark", "Resend", "Amazon SES"];

interface UnclassifiedSubject {
  vendor: string;
  slug: string;
  category: string;
  peers: number;
}

function unclassifiedSubject(): UnclassifiedSubject | null {
  const inCategory = new Map<string, Offer[]>();
  const classified = new Set<string>();
  for (const offer of offers) {
    if (!inCategory.has(offer.category)) inCategory.set(offer.category, []);
    inCategory.get(offer.category)!.push(offer);
    if ((offer.product_subtypes?.labels.length ?? 0) > 0) classified.add(offer.category);
  }
  const ranked = [...inCategory.entries()]
    .filter(([category]) => !classified.has(category))
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  for (const [category, list] of ranked) {
    const vendors = [...new Set(list.map(o => o.vendor))].sort();
    const vendor = vendors.find(v => curatedAlternativeNames(v, changes).length === 0 && vendorSlugMap.get(toSlug(v)) === v);
    if (vendor) return { vendor, slug: toSlug(vendor), category, peers: vendors.length - 1 };
  }
  return null;
}

const subjectWithNoClass = unclassifiedSubject();

function offerFixture(vendor: string, category: string, subtypes?: string[]): Offer {
  return {
    vendor,
    category,
    description: `${vendor} description`,
    tier: "Free",
    url: `https://${vendor.toLowerCase()}.example/pricing`,
    tags: [],
    verifiedDate: "2026-08-01",
    ...(subtypes
      ? {
          product_subtypes: {
            taxonomy: category,
            labels: subtypes.map(subtype => ({ subtype, source_url: "https://x.example", source_quote: "q" })),
            reviewed: "2026-08-01",
          },
        }
      : {}),
  } as Offer;
}

describe("a category is not a product class", () => {
  it("offers nothing from a category the subject carries no subtype for", () => {
    const subject = offerFixture("Subject", "Email");
    const peer = offerFixture("Peer", "Email");
    const partition = partitionSubstitutes([peer], [subject]);
    assert.deepStrictEqual(partition.kept, []);
    assert.deepStrictEqual(partition.unclassified.map(o => o.vendor), ["Peer"]);
  });

  it("keeps the gated pool where the subject carries a subtype", () => {
    const subject = offerFixture("Subject", "Databases", ["relational"]);
    const sameClass = offerFixture("SameClass", "Databases", ["relational"]);
    const otherClass = offerFixture("OtherClass", "Databases", ["graph"]);
    const partition = partitionSubstitutes([sameClass, otherClass], [subject]);
    assert.deepStrictEqual(partition.kept.map(o => o.vendor), ["SameClass"]);
    assert.deepStrictEqual(partition.removed.map(r => r.gate), ["subtype_mismatch"]);
    assert.deepStrictEqual(partition.unclassified, []);
  });

  it("offers nothing to a record we classified as none of its category's subtypes", () => {
    const subject = offerFixture("Subject", "Databases", []);
    const peer = offerFixture("Peer", "Databases", ["relational"]);
    assert.strictEqual(subtypeGateBinds([subject], "Databases"), false);
    assert.deepStrictEqual(partitionSubstitutes([peer], [subject]).kept, []);
  });

  it("lets a name written down for this vendor through an unclassified category", () => {
    const subject = offerFixture("Subject", "Email");
    const curated = offerFixture("Curated", "Email");
    const peer = offerFixture("Peer", "Email");
    const partition = partitionSubstitutes([curated, peer], [subject], {
      subtypeExempt: candidate => candidate.vendor === "Curated",
    });
    assert.deepStrictEqual(partition.kept.map(o => o.vendor), ["Curated"]);
    assert.deepStrictEqual(partition.unclassified.map(o => o.vendor), ["Peer"]);
  });

  it("still applies the product-role gates to a name written down for this vendor", () => {
    const subject = offerFixture("Subject", "Databases", ["relational"]);
    const emulator = { ...offerFixture("Emulator", "Databases"), product_role: { deployment_model: "local_dev_only", is_addon: false, source_url: "https://x.example", source_quote: "q", reviewed: "2026-08-01" } } as Offer;
    const partition = partitionSubstitutes([emulator], [subject], { subtypeExempt: () => true });
    assert.deepStrictEqual(partition.kept, []);
    assert.deepStrictEqual(partition.removed.map(r => r.gate), ["local_dev_only"]);
  });

  it("holds a taxonomy for the two categories the published controls rest on", () => {
    for (const category of CLASSIFIED_CATEGORIES) {
      const classified = offers.filter(o => o.category === category && (o.product_subtypes?.labels.length ?? 0) > 0);
      assert.ok(classified.length > 0, `${category} must carry a taxonomy for the controls below to be controls`);
    }
  });

  it("reaches every same-category consumer through one rule", () => {
    const sendgrid = offers.find(o => o.vendor === "SendGrid")!;
    assert.ok(sendgrid, "SendGrid must be in the index");
    assert.deepStrictEqual(substitutesFor(offers, sendgrid), []);
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

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, body: await res.text() };
};

function jsonLdBlocks(body: string): Array<Record<string, unknown>> {
  return [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter((b): b is Record<string, unknown> => b !== null);
}

before(async () => { proc = await startServer(); });
after(() => { proc?.kill(); });

describe("/alternative-to/sendgrid", () => {
  it("names no product from another class on any surface that carries the list", async () => {
    const { status, body } = await get("/alternative-to/sendgrid");
    assert.strictEqual(status, 200);

    const blocks = jsonLdBlocks(body);
    const itemList = blocks.find(b => b["@type"] === "ItemList") as { itemListElement: Array<{ item: { name: string } }> } | undefined;
    const faq = blocks.find(b => b["@type"] === "FAQPage") as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> } | undefined;
    assert.ok(itemList, "the page must ship an ItemList for this assertion to mean anything");
    assert.ok(faq, "the page must ship FAQPage structured data");

    const ogDescription = body.match(/<meta property="og:description" content="([^"]*)"/)?.[1] ?? "";
    const rendered = [...body.matchAll(/class="alt-vendor-name">([^<]+)</g)].map(m => m[1]);
    const listed = itemList.itemListElement.map(e => e.item.name);
    const faqText = faq.mainEntity.map(e => `${e.name} ${e.acceptedAnswer.text}`).join(" ");

    for (const wrong of SENDGRID_WRONG_CLASS) {
      assert.ok(!rendered.includes(wrong), `${wrong} is still rendered as a SendGrid alternative`);
      assert.ok(!listed.includes(wrong), `${wrong} is still in the ItemList`);
      assert.ok(!ogDescription.includes(wrong), `${wrong} is still in og:description`);
      assert.ok(!faqText.includes(wrong), `${wrong} is still in an FAQ answer`);
    }

    for (const name of SENDGRID_CURATED) {
      assert.ok(rendered.includes(name), `${name} was written down for SendGrid and must survive`);
      assert.ok(listed.includes(name), `${name} must reach the ItemList`);
    }

    assert.deepStrictEqual([...new Set(listed)].sort(), [...new Set(rendered)].sort(), "the ItemList and the rendered list are not the same set");
    assert.ok(ogDescription.includes(String(listed.length)), "og:description must count the set the page publishes");
  });
});

describe("a page with no evidence of a product class", () => {
  it("draws its subject from the largest category no record carries a subtype for", () => {
    assert.ok(
      subjectWithNoClass,
      "every category now carries a subtype, so this block has no subject left and needs one that publishes an empty substitute list for another reason",
    );
    assert.ok(subjectWithNoClass!.peers >= 3, `${subjectWithNoClass!.vendor} must have same-category peers it would be offered but for the gate, found ${subjectWithNoClass!.peers}`);
  });

  it("offers no substitute, heads no list of them, and still answers", async () => {
    const { status, body } = await get(`/alternative-to/${subjectWithNoClass!.slug}`);
    assert.strictEqual(status, 200);
    assert.strictEqual((body.match(/class="alt-vendor-name"/g) ?? []).length, 0, `/alternative-to/${subjectWithNoClass!.slug} names a substitute`);
    assert.doesNotMatch(body, /All Free Alternatives \(/);
    assert.ok(!jsonLdBlocks(body).some(b => b["@type"] === "ItemList"), "an empty set must not ship as an ItemList");
    const ogDescription = body.match(/<meta property="og:description" content="([^"]*)"/)?.[1] ?? "";
    assert.doesNotMatch(ogDescription, /Compare 0 /);
    const subhead = body.match(/<p class="page-meta">([\s\S]*?)<\/p>/)?.[1] ?? "";
    assert.doesNotMatch(subhead, /^0 free alternative/, "the subhead counts a list the page does not publish");
    assert.doesNotMatch(subhead, /Sorted by/, "the subhead claims an ordering over an empty list");
  });

  it("asks no question it cannot answer", async () => {
    const { body } = await get(`/alternative-to/${subjectWithNoClass!.slug}`);
    const faq = jsonLdBlocks(body).find(b => b["@type"] === "FAQPage");
    assert.ok(!faq, "a page with no substitute list publishes no questions about one");
    const vendor = await get(`/vendor/${subjectWithNoClass!.slug}`);
    const vendorFaq = jsonLdBlocks(vendor.body).find(b => b["@type"] === "FAQPage") as { mainEntity: Array<{ name: string }> } | undefined;
    assert.ok(vendorFaq, "the questions we can answer about the vendor stay published on the vendor page");
    assert.ok(
      !vendorFaq.mainEntity.some(q => q.name.startsWith("What are the best free alternatives")),
      "the vendor page asks for a best alternative it publishes none of",
    );
  });

  it("counts no list on the vendor page either", async () => {
    const { status, body } = await get(`/vendor/${subjectWithNoClass!.slug}`);
    assert.strictEqual(status, 200);
    const subhead = body.match(/<p class="page-meta">([\s\S]*?)<\/p>/)?.[1] ?? "";
    assert.ok(subhead.length > 0, "the vendor page must carry a subhead for this to test anything");
    assert.doesNotMatch(subhead, /\b0 alternatives\b/, "the subhead counts a list the page does not publish");
    const metaDesc = body.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
    assert.doesNotMatch(metaDesc, /\b0 (free )?alternatives\b/);
  });

  it("names none of them through the vendor page or the API either", async () => {
    const vendor = await get("/vendor/sendgrid");
    assert.strictEqual(vendor.status, 200);
    const risk = await get("/api/vendor-risk/SendGrid");
    assert.strictEqual(risk.status, 200);
    const named = JSON.parse(risk.body).alternatives.map((a: { vendor: string }) => a.vendor);
    for (const wrong of SENDGRID_WRONG_CLASS) {
      assert.ok(!named.includes(wrong), `${wrong} is still offered through /api/vendor-risk`);
      assert.ok(!vendor.body.includes(`>${wrong}<`), `${wrong} is still named on /vendor/sendgrid`);
    }
  });
});

describe("what a classified page leaves out, and why it says it left it out", () => {
  const SUBJECT = "Vercel";

  function pagePartition(vendorName: string) {
    const vendorOffers = offers.filter(o => o.vendor === vendorName);
    const categories = new Set(vendorOffers.map(o => o.category));
    const seen = new Set<string>();
    const pool: Offer[] = [];
    for (const o of offers) {
      if (o.vendor === vendorName || !categories.has(o.category) || seen.has(o.vendor)) continue;
      seen.add(o.vendor);
      pool.push(o);
    }
    return partitionSubstitutes(pool, vendorOffers);
  }

  it("names every excluded record with the reason our own partition assigned it", async () => {
    const { status, body } = await get(`/alternative-to/${toSlug(SUBJECT)}`);
    assert.strictEqual(status, 200);
    const notice = body.match(/<p class="alt-excluded"[\s\S]*?<\/p>/)?.[0];
    assert.ok(notice, `/alternative-to/${toSlug(SUBJECT)} must publish the line that names what it left out`);

    const removed = pagePartition(SUBJECT).removed;
    assert.ok(removed.length > 0, `${SUBJECT} must exclude something for this to test anything`);
    for (const { offer, gate } of removed) {
      const label = MEMBERSHIP_GATE_RULES[gate].label.toLowerCase();
      assert.ok(
        notice.includes(`>${offer.vendor}</a> (${label})`),
        `${offer.vendor} is excluded as ${gate} and the page does not say so`
      );
    }
  });

  it("separates a record it read and found nothing for from one it never read", async () => {
    const { body } = await get(`/alternative-to/${toSlug(SUBJECT)}`);
    const notice = body.match(/<p class="alt-excluded"[\s\S]*?<\/p>/)?.[0] ?? "";
    const byGate = new Map<string, string[]>();
    for (const { offer, gate } of pagePartition(SUBJECT).removed) {
      if (!byGate.has(gate)) byGate.set(gate, []);
      byGate.get(gate)!.push(offer.vendor);
    }
    for (const gate of ["not_in_taxonomy", "not_yet_classified"] as const) {
      assert.ok((byGate.get(gate) ?? []).length > 0, `${SUBJECT}'s page must exclude at least one record as ${gate}`);
    }
    assert.notStrictEqual(
      MEMBERSHIP_GATE_RULES.not_in_taxonomy.label.toLowerCase(),
      MEMBERSHIP_GATE_RULES.not_yet_classified.label.toLowerCase()
    );
    assert.ok(notice.includes(MEMBERSHIP_GATE_RULES.not_in_taxonomy.label.toLowerCase()));
    assert.ok(notice.includes(MEMBERSHIP_GATE_RULES.not_yet_classified.label.toLowerCase()));
  });

  it("still turns a product-role finding away under its own reason", () => {
    const neon = offers.filter(o => o.vendor === "Neon");
    assert.ok(neon.length > 0, "Neon must be in the index");
    const gates = new Map(pagePartition("Neon").removed.map(r => [r.offer.vendor, r.gate]));
    assert.strictEqual(gates.get("Hasura Cloud"), "addon");
    assert.strictEqual(gates.get("Prisma Accelerate"), "addon");
    assert.strictEqual(gates.get("DynamoDB Local"), "local_dev_only");
  });

  it("does not blame a record that does say what kind of product it is", async () => {
    const classifiedWithNothingToOffer = offers
      .filter(o => (o.product_subtypes?.labels.length ?? 0) > 0 && vendorSlugMap.get(toSlug(o.vendor)) === o.vendor)
      .find(o => substitutesFor(offers, o).length === 0);
    assert.ok(
      classifiedWithNothingToOffer,
      "every classified record now has a substitute, so the branch that explains an empty list to a classified subject has no subject"
    );
    const { status, body } = await get(`/alternative-to/${toSlug(classifiedWithNothingToOffer!.vendor)}`);
    assert.strictEqual(status, 200);
    assert.doesNotMatch(
      body,
      /'s does not yet, so this page names none/,
      `${classifiedWithNothingToOffer!.vendor} carries a subtype and the page says its record does not`
    );
    assert.match(body, /nothing else we track says it is the same kind of product/);
  });

  it("publishes the new reason on /criteria beside the four it already published", async () => {
    const { status, body } = await get("/criteria");
    assert.strictEqual(status, 200);
    for (const gate of MEMBERSHIP_GATE_ORDER) {
      assert.ok(body.includes(`<code>${gate}</code>`), `/criteria does not name the ${gate} gate it applies`);
      assert.ok(body.includes(MEMBERSHIP_GATE_RULES[gate].label), `/criteria does not publish the ${gate} label the pages render`);
    }
    assert.doesNotMatch(body, /offered as one to no one/, "the page claims an absolute the curated exemption breaks");
  });
});

describe("the categories we did classify are untouched", () => {
  const CONTROLS = ["neon", "vercel", "supabase"];
  const readAgainstItsSubtypes = new Set(offers.filter(o => o.product_subtypes).map(o => o.vendor));

  for (const slug of CONTROLS) {
    it(`/alternative-to/${slug} heads a list, and every name on it is one we read`, async () => {
      const { status, body } = await get(`/alternative-to/${slug}`);
      assert.strictEqual(status, 200);
      const heading = body.match(/All Free Alternatives \((\d+)\)/);
      assert.ok(heading, `/alternative-to/${slug} must still head a list`);

      const listed = body.slice(body.indexOf("All Free Alternatives"));
      const rendered = [...listed.matchAll(/class="alt-vendor-name">([^<]+)</g)].map(m => m[1]);
      assert.strictEqual(rendered.length, Number(heading[1]), "the heading counts a different list from the one below it");
      assert.ok(rendered.length >= 15, `/alternative-to/${slug} publishes ${rendered.length}, which is a collapse rather than a gate`);

      const curated = new Set(curatedAlternativeNames(vendorSlugMap.get(slug)!, changes));
      const unread = rendered.filter(v => !readAgainstItsSubtypes.has(v) && !curated.has(v));
      assert.deepStrictEqual(unread, [], `offered as substitutes without ever being read against ${slug}'s taxonomy: ${unread.join(", ")}`);
    });
  }

  it("offers no record it has never read as a substitute anywhere, unless a person named it", () => {
    const curatedEverywhere = new Set(changes.flatMap(c => c.alternatives ?? []));
    const leaked = new Set<string>();
    for (const subject of offers) {
      for (const substitute of substitutesFor(offers, subject)) {
        if (!substitute.product_subtypes && !curatedEverywhere.has(substitute.vendor)) {
          leaked.add(`${subject.vendor} -> ${substitute.vendor}`);
        }
      }
    }
    assert.deepStrictEqual([...leaked].sort(), [], `substitutes we never read against the subject's taxonomy: ${[...leaked].sort().join("; ")}`);
  });
});
