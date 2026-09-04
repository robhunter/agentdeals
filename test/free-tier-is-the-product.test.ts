import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.AGENTDEALS_REFUSALS_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "refusals-free-tier-is-the-product-")),
  "change_refusals.json"
);

const {
  describesChange,
  gateCandidates,
  marksFreeTierAsTheProduct,
  vendorsWhoseFreeTierIsTheProduct,
  FREE_TIER_IS_THE_PRODUCT_FIELD,
  FREE_TIER_REMOVED,
  GATE_REASONS,
  REJECT_FREE_TIER_IS_THE_PRODUCT,
} = await import("../scripts/change-gate.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataFile = (name: string) =>
  JSON.parse(readFileSync(path.join(__dirname, "..", "data", name), "utf-8"));

const OFFERS = dataFile("index.json").offers as Array<Record<string, any>>;
const STORED = dataFile("deal_changes.json").changes as Array<Record<string, any>>;

const DISCORD = {
  vendor: "Discord",
  change_type: FREE_TIER_REMOVED,
  date: "2026-09-04",
  summary:
    "Discord no longer offers a completely free tier with unlimited servers and messages. While core functionality remains accessible, features like custom emojis, larger file uploads (50MB for Nitro Basic, 500MB for Nitro), HD streaming, and more are now part of paid Nitro subscriptions ($2.99/month for Basic, $9.99/month for full Nitro).",
  previous_state:
    "Unlimited servers, channels, messages. Voice/video calls (up to 25 in DM groups). Screen sharing (720p/30fps). Go Live streaming (720p/30fps). 25 MB file upload limit. No HD streaming or animated avatars on free.",
  current_state:
    "Nitro Basic costs $2.99/month and includes 50MB uploads, custom emojis, and custom app icons. Nitro costs $9.99/month and includes 500MB uploads, HD streaming, and more.",
  impact: "high",
  source_url: "https://discord.com/nitro",
};

const GOOGLE_MEET = {
  vendor: "Google Meet",
  change_type: FREE_TIER_REMOVED,
  date: "2026-09-04",
  summary:
    "Google Meet's own page now redirects to workspace.google.com. The free tier information is no longer directly presented. The lowest tier is 'Starter' at $5.60/user/month (with a discount) or $7.00/user/month. The page details features available in paid tiers, including video meetings with up to 1000 participants and recording capabilities.",
  previous_state:
    "1-hour group meetings (up to 100 participants). Unlimited 1-on-1 calls (24-hour limit). Screen sharing. Real-time captions. Background effects. No recording or breakout rooms on free.",
  current_state:
    "The lowest available plan is 'Starter' at $5.60/user/month (with a discount) or $7.00/user/month. Features like recording and more than 100 participants require paid plans.",
  impact: "high",
  source_url: "https://apps.google.com/meet/pricing/",
};

const MOMENTO = {
  vendor: "Momento",
  change_type: FREE_TIER_REMOVED,
  date: "2026-09-04",
  summary:
    "Momento Cache Flex starts at $13 per GB-month. Pub/sub Topics are priced at $1 per 1M operations. Data transfer is $0.01 per GB for Valkey Router and $0.05/GiB for ingress/egress.",
  previous_state:
    "Serverless cache and pub/sub — 5 GB data transfer/month free, sub-millisecond latency, no infrastructure to manage",
  current_state:
    "Momento Cache Flex from $13 per GB-month. Pub / sub Topics from $1 per 1M operations. Valkey Router $0.01 per GB of data transfer. Data Transfer Ingress + Egress 200 GiB included per month $0.05 GiB",
  impact: "high",
  source_url: "https://www.gomomento.com/pricing",
};

const BONSAI = {
  vendor: "bonsai.io",
  change_type: FREE_TIER_REMOVED,
  date: "2026-09-04",
  summary:
    "The free tier no longer exists. The lowest tier is now a 'Staging' plan at $15/month with 1 GB storage and 256 MB memory.",
  previous_state:
    "Free Sandbox plan: 125 MB memory, 125 MB storage, 35K documents. Free forever. Managed Elasticsearch.",
  current_state:
    "The lowest available plan is 'Staging' at $15/month, offering 1 GB storage, 256 MB memory, and 100k documents.",
  impact: "high",
  source_url: "https://bonsai.io/pricing",
};

const DISCORD_RAISED_ITS_UPLOAD_LIMIT = {
  vendor: "Discord",
  change_type: "limits_increased",
  date: "2026-09-04",
  summary: "The free upload limit is now 50 MB, up from 25 MB.",
  previous_state: "25 MB file upload limit",
  current_state: "50 MB file upload limit",
  impact: "low",
  source_url: "https://discord.com/",
};

const DISCORD_SHUT_A_PRODUCT_DOWN = {
  vendor: "Discord",
  change_type: "product_deprecated",
  date: "2026-09-04",
  summary: "Discord is retiring its Go Live streaming feature on 2026-12-01.",
  previous_state: "Go Live streaming (720p/30fps)",
  current_state: "Go Live streaming is retired on 2026-12-01.",
  impact: "high",
  source_url: "https://discord.com/",
};

const withoutMarkers = (offers: Array<Record<string, any>>) =>
  offers.map(({ [FREE_TIER_IS_THE_PRODUCT_FIELD]: _marker, ...rest }) => rest);

const gate = (candidates: Array<Record<string, any>>, offers = OFFERS) =>
  gateCandidates(candidates, { offers });

describe("a free tier that is the product cannot be evidenced by a plan page (#1340)", () => {
  describe("the marker", () => {
    it("is carried by the offer, so the vendors it covers are named in the catalogue", () => {
      const marked = OFFERS.filter(marksFreeTierAsTheProduct).map(o => o.vendor);
      for (const vendor of ["Discord", "Google Meet", "Signal", "Telegram", "WhatsApp"]) {
        assert.ok(marked.includes(vendor), `${vendor} is marked as a free tier that is the product`);
      }
    });

    it("holds one value, so an offer either carries the claim or does not make it", () => {
      const other = OFFERS.filter(
        o => FREE_TIER_IS_THE_PRODUCT_FIELD in o && o[FREE_TIER_IS_THE_PRODUCT_FIELD] !== true
      ).map(o => `${o.vendor}: ${JSON.stringify(o[FREE_TIER_IS_THE_PRODUCT_FIELD])}`);
      assert.deepStrictEqual(other, [], `offers carrying a value other than true:\n${other.join("\n")}`);
    });

    it("is not read from a vendor that does not carry it", () => {
      assert.strictEqual(marksFreeTierAsTheProduct({ vendor: "Slack" }), false);
      assert.strictEqual(marksFreeTierAsTheProduct(undefined), false);
    });

    it("resolves a candidate to the offer it was read from by the name the record carries", () => {
      const vendors = vendorsWhoseFreeTierIsTheProduct(OFFERS);
      assert.ok(vendors.has("Discord"));
      assert.ok(!vendors.has("Slack"));
      assert.strictEqual(vendorsWhoseFreeTierIsTheProduct().size, 0);
    });
  });

  describe("the gate refuses a removal for a marked offer when it is written", () => {
    it("refuses both records the 2026-09-04 batch holds for a marked vendor", async () => {
      const { accepted, rejected } = await gate([DISCORD, GOOGLE_MEET]);
      assert.deepStrictEqual(accepted, []);
      assert.deepStrictEqual(
        rejected.map(r => [r.candidate.vendor, r.reason]),
        [
          ["Discord", REJECT_FREE_TIER_IS_THE_PRODUCT],
          ["Google Meet", REJECT_FREE_TIER_IS_THE_PRODUCT],
        ]
      );
    });

    it("records the same two when the offer makes no such claim, so the marker is what refused them", async () => {
      const { accepted, rejected } = await gate([DISCORD, GOOGLE_MEET], withoutMarkers(OFFERS));
      assert.deepStrictEqual(rejected, []);
      assert.deepStrictEqual(accepted.map(c => c.vendor), ["Discord", "Google Meet"]);
    });

    it("states which product the page was about, so the refusal can be checked", async () => {
      const { rejected } = await gate([DISCORD]);
      assert.match(String(rejected[0].detail), /Discord's free tier is the product itself/);
    });

    it("keeps the removals of vendors that do publish a plan", async () => {
      const { accepted, rejected } = await gate([MOMENTO, BONSAI]);
      assert.deepStrictEqual(rejected, []);
      assert.deepStrictEqual(accepted.map(c => c.vendor), ["Momento", "bonsai.io"]);
    });

    it("names its own reason among the reasons the gate reports", () => {
      assert.ok(GATE_REASONS.includes(REJECT_FREE_TIER_IS_THE_PRODUCT));
    });
  });

  describe("a marked offer is still re-verified for every other change type", () => {
    it("records a limit that moved on a marked vendor", async () => {
      const { accepted, rejected } = await gate([DISCORD_RAISED_ITS_UPLOAD_LIMIT]);
      assert.deepStrictEqual(rejected, []);
      assert.deepStrictEqual(accepted.map(c => c.change_type), ["limits_increased"]);
    });

    it("records a product the vendor is shutting down", async () => {
      const { accepted, rejected } = await gate([DISCORD_SHUT_A_PRODUCT_DOWN]);
      assert.deepStrictEqual(rejected, []);
      assert.deepStrictEqual(accepted.map(c => c.change_type), ["product_deprecated"]);
    });

    it("exempts one conclusion rather than the vendor", () => {
      const marked = { freeTierIsTheProduct: true };
      for (const change_type of ["limits_reduced", "pricing_restructured", "restriction", "new_tier"]) {
        const verdict = describesChange({ ...DISCORD, change_type }, marked);
        assert.notStrictEqual(
          verdict.reason,
          REJECT_FREE_TIER_IS_THE_PRODUCT,
          `${change_type} is not refused for being a product that is free`
        );
      }
    });
  });

  describe("what the catalogue publishes about a marked offer", () => {
    const marked = OFFERS.filter(marksFreeTierAsTheProduct);

    it("sends the reader to a page about the free product, not the paid one beside it", () => {
      const paidProductPath = /\/(nitro|premium|plus|pro|upgrade|subscribe|buy|business)(\/|$)/i;
      const upsells = marked
        .filter(o => paidProductPath.test(new URL(o.url).pathname))
        .map(o => `${o.vendor}: ${o.url}`);
      assert.deepStrictEqual(upsells, [], `marked offers linking to a paid product page:\n${upsells.join("\n")}`);
    });

    it("holds no removal still in force for a marked vendor", () => {
      const vendors = vendorsWhoseFreeTierIsTheProduct(OFFERS);
      const standing = STORED.filter(
        c => c.change_type === FREE_TIER_REMOVED && !c.resolution && vendors.has(c.vendor)
      ).map(c => `${c.vendor} ${c.date}: ${c.summary}`);
      assert.deepStrictEqual(standing, [], `standing removals for a marked vendor:\n${standing.join("\n")}`);
    });

    it("covers vendors outside the one category the class was found in", () => {
      const elsewhere = marked.filter(o => o.category !== "Communication & Messaging");
      assert.ok(
        elsewhere.length > 0,
        "the marker is carried by at least one offer outside Communication & Messaging"
      );
    });
  });
});
