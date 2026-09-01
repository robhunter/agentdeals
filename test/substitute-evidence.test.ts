import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { partitionSubstitutes, subtypeGateBinds, substitutesFor } from "../dist/product-role.js";
import type { Offer } from "../src/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;

const CLASSIFIED_CATEGORIES = ["Databases", "Cloud Hosting"];
const SENDGRID_WRONG_CLASS = ["Bench", "Remote for Startups", "Esri Startup Program"];
const SENDGRID_CURATED = ["Postmark", "Resend", "Amazon SES"];

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
  it("offers no substitute, heads no list of them, and still answers", async () => {
    const { status, body } = await get("/alternative-to/datadog");
    assert.strictEqual(status, 200);
    assert.strictEqual((body.match(/class="alt-vendor-name"/g) ?? []).length, 0);
    assert.doesNotMatch(body, /All Free Alternatives \(/);
    assert.ok(!jsonLdBlocks(body).some(b => b["@type"] === "ItemList"), "an empty set must not ship as an ItemList");
    const ogDescription = body.match(/<meta property="og:description" content="([^"]*)"/)?.[1] ?? "";
    assert.doesNotMatch(ogDescription, /Compare 0 /);
    const subhead = body.match(/<p class="page-meta">([\s\S]*?)<\/p>/)?.[1] ?? "";
    assert.doesNotMatch(subhead, /^0 free alternative/, "the subhead counts a list the page does not publish");
    assert.doesNotMatch(subhead, /Sorted by/, "the subhead claims an ordering over an empty list");
  });

  it("asks no question it cannot answer", async () => {
    const { body } = await get("/alternative-to/datadog");
    const faq = jsonLdBlocks(body).find(b => b["@type"] === "FAQPage") as { mainEntity: Array<{ name: string }> } | undefined;
    assert.ok(faq, "the page must still ship FAQPage structured data");
    assert.ok(
      !faq.mainEntity.some(q => q.name.startsWith("What are the best free alternatives")),
      "the page asks for a best alternative it publishes none of",
    );
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

describe("the categories we did classify are untouched", () => {
  const CONTROLS: Array<[string, number]> = [["neon", 20], ["vercel", 31], ["supabase", 26]];

  for (const [slug, expected] of CONTROLS) {
    it(`/alternative-to/${slug} still offers ${expected}`, async () => {
      const { status, body } = await get(`/alternative-to/${slug}`);
      assert.strictEqual(status, 200);
      const heading = body.match(/All Free Alternatives \((\d+)\)/);
      assert.ok(heading, `/alternative-to/${slug} must still head a list`);
      assert.strictEqual(Number(heading[1]), expected);
    });
  }
});
