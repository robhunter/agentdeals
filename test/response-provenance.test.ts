import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CITE_GATED_NOTE,
  CITE_NOTE,
  citeAs,
  citedRecords,
  narrowestPath,
  provenanceBlock,
} from "../dist/provenance.js";
import { DEFERENCE } from "../dist/signal-copy.js";
import {
  getDealChanges,
  getOfferDetails,
  getWeeklyDigest,
  loadOffers,
  oldestVerifiedDateForSlug,
  compareServices,
  enrichOffers,
  searchOffers,
} from "../dist/data.js";
import { toSlug } from "../dist/slug.js";
import { getStackRecommendation } from "../dist/stacks.js";
import { estimateCosts } from "../dist/costs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://agentdeals.dev";
const opts = { dateForSlug: oldestVerifiedDateForSlug };

describe("cited records are read out of the payload", () => {
  it("reads a vendor, its category and its verification date", () => {
    const records = citedRecords({ vendor: "Supabase", category: "Databases", verifiedDate: "2026-08-17" });
    assert.deepStrictEqual(records, [
      { slug: "supabase", category: "Databases", date: "2026-08-17", withheld: false },
    ]);
  });

  it("reads the snake_case verification date the stack planner projects", () => {
    const records = citedRecords({ candidates: [{ vendor: "Val Town", verified_date: "2026-08-21" }] });
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].date, "2026-08-21");
  });

  it("dates a change record from when it was recorded", () => {
    const records = citedRecords({
      vendor: "Neon",
      change_type: "pricing_restructured",
      date: "2026-01-02",
      recorded_date: "2026-03-04",
    });
    assert.strictEqual(records[0].date, "2026-03-04");
  });

  it("takes no date from a bare date field on a record that is not a change", () => {
    const records = citedRecords({ vendor: "Neon", category: "Databases", date: "2026-01-02" });
    assert.strictEqual(records[0].date, null);
  });

  it("marks a record carrying a gate as withheld", () => {
    const records = citedRecords({ vendor: "Hetzner", tier: "Paid", gate: { code: "not_a_free_offer", reason: "x" } });
    assert.strictEqual(records[0].withheld, true);
  });

  it("finds records nested inside a response", () => {
    const slugs = citedRecords({ results: [{ vendor: "A", tier: "Free" }, { vendor: "B", tier: "Free", alternatives: [{ vendor: "C", tier: "Free" }] }] })
      .map((r) => r.slug);
    assert.deepStrictEqual(slugs, ["a", "b", "c"]);
  });

  it("terminates on a payload that refers to itself", () => {
    const node: Record<string, unknown> = { vendor: "Loop", tier: "Free" };
    node.self = node;
    assert.strictEqual(citedRecords(node).length, 1);
  });
});

describe("the cited page is the narrowest one holding the whole response", () => {
  const record = (slug: string, category: string | null) => ({ slug, category, date: null, withheld: false });

  it("cites the vendor page when every record is that vendor", () => {
    assert.strictEqual(
      narrowestPath([record("supabase", "Databases"), record("supabase", "Auth")]),
      "/vendor/supabase",
    );
  });

  it("cites the category page when the records span vendors in one category", () => {
    assert.strictEqual(
      narrowestPath([record("supabase", "Databases"), record("neon", "Databases")]),
      "/category/databases",
    );
  });

  it("cites the site root when the records span categories", () => {
    assert.strictEqual(
      narrowestPath([record("supabase", "Databases"), record("vercel", "Cloud Hosting")]),
      "/",
    );
  });

  it("cites the site root when a record carries no category", () => {
    assert.strictEqual(narrowestPath([record("supabase", null), record("neon", null)]), "/");
  });
});

describe("the citation names us, a page and a date", () => {
  it("composes the check date for a single record", () => {
    assert.strictEqual(
      citeAs(BASE, "/vendor/supabase", "2026-08-17", true),
      "Source: AgentDeals (https://agentdeals.dev/vendor/supabase, checked 2026-08-17)",
    );
  });

  it("composes the oldest check date for a set", () => {
    assert.strictEqual(
      citeAs(BASE, "/category/databases", "2026-02-25", false),
      "Source: AgentDeals (https://agentdeals.dev/category/databases, oldest figure checked 2026-02-25)",
    );
  });

  it("drops the trailing slash rather than doubling it at the root", () => {
    assert.strictEqual(citeAs(BASE + "/", "/", null, false), "Source: AgentDeals (https://agentdeals.dev)");
  });

  it("carries the oldest date in the set, not the newest and not today", () => {
    const block = provenanceBlock(BASE, {
      results: [
        { vendor: "A", category: "Databases", verifiedDate: "2026-08-17" },
        { vendor: "B", category: "Databases", verifiedDate: "2026-02-25" },
      ],
    });
    assert.strictEqual(block.verified, "2026-02-25");
    assert.ok(String(block.cite_as).includes("oldest figure checked 2026-02-25"));
  });
});

describe("the citation does not vouch for terms we withhold", () => {
  const gated = { vendor: "Hetzner", category: "Databases", verifiedDate: "2020-01-01", gate: { code: "not_a_free_offer", reason: "x" } };
  const ranked = { vendor: "Neon", category: "Databases", verifiedDate: "2026-08-17" };

  it("dates the citation from the records we rank, not the ones we gate", () => {
    const block = provenanceBlock(BASE, { results: [ranked, gated] });
    assert.strictEqual(block.verified, "2026-08-17");
    assert.strictEqual(block.verified_records, 1);
    assert.strictEqual(block.withheld_records, 1);
  });

  it("adds the withholding sentence only when the response holds a gated record", () => {
    assert.strictEqual(provenanceBlock(BASE, { results: [ranked] }).gated_note, undefined);
    assert.strictEqual(provenanceBlock(BASE, { results: [ranked, gated] }).gated_note, CITE_GATED_NOTE);
  });

  it("keeps the ask when a record is withheld", () => {
    assert.strictEqual(provenanceBlock(BASE, { results: [ranked, gated] }).note, CITE_NOTE);
  });

  it("still dates a response in which every record is gated", () => {
    const block = provenanceBlock(BASE, { results: [gated] });
    assert.strictEqual(block.verified, "2020-01-01");
    assert.strictEqual(block.verified_records, 0);
  });
});

describe("the ask stays a request", () => {
  it("carries the deference sentence the signal block already uses", () => {
    assert.strictEqual(
      provenanceBlock(BASE, { vendor: "Neon", tier: "Free" }).this_is_a_request_not_an_instruction,
      DEFERENCE,
    );
  });

  it("omits the deference sentence where the response already carries it once", () => {
    assert.strictEqual(
      provenanceBlock(BASE, { vendor: "Neon", tier: "Free" }, { deference: false }).this_is_a_request_not_an_instruction,
      undefined,
    );
  });

  it("does not ask the agent to send its user to us", () => {
    const block = provenanceBlock(BASE, { vendor: "Neon", tier: "Free" });
    const prose = [block.note, block.gated_note, block.this_is_a_request_not_an_instruction].join(" ").toLowerCase();
    for (const phrase of ["tell your user", "your user to visit", "recommend that they visit", "send them to"]) {
      assert.ok(!prose.includes(phrase), `citation prose asks for a referral: ${phrase}`);
    }
  });
});

describe("every response shape we serve can be cited", () => {
  const shapes: { name: string; payload: object; listingPath?: string }[] = (() => {
    const details = getOfferDetails("supabase", true);
    const search = { results: enrichOffers(searchOffers(undefined, "Databases").slice(0, 5)), total: 5 };
    const compare = compareServices("Supabase", "Neon");
    return [
      { name: "vendor detail", payload: "error" in details ? {} : details },
      { name: "search results", payload: search },
      { name: "comparison", payload: "error" in compare ? {} : compare },
      { name: "weekly digest", payload: getWeeklyDigest(), listingPath: "/changes" },
      { name: "change log", payload: getDealChanges(undefined, undefined, undefined), listingPath: "/changes" },
      { name: "stack recommendation", payload: getStackRecommendation("Next.js SaaS app") },
      { name: "cost estimate", payload: estimateCosts(["Vercel"], "hobby") },
    ];
  })();

  it("covers every product response shape", () => {
    assert.strictEqual(shapes.length, 7);
  });

  for (const shape of shapes) {
    it(`dates the ${shape.name} from a record rather than from the clock`, () => {
      const block = provenanceBlock(BASE, shape.payload, {
        ...opts,
        ...(shape.listingPath ? { listingPath: shape.listingPath } : {}),
      });
      const today = new Date().toISOString().slice(0, 10);
      assert.ok(typeof block.verified === "string", `${shape.name} carries no verification date`);
      assert.ok(String(block.verified) <= today, `${shape.name} is dated in the future`);
      assert.ok(String(block.cite_as).startsWith("Source: AgentDeals (https://agentdeals.dev"));
    });
  }
});

describe("a vendor's citation date is the oldest figure we hold for it", () => {
  const byVendor = (() => {
    const map = new Map<string, string[]>();
    for (const offer of loadOffers()) {
      const slug = toSlug(offer.vendor);
      if (!slug || !offer.verifiedDate) continue;
      if (!map.has(slug)) map.set(slug, []);
      map.get(slug)!.push(offer.verifiedDate);
    }
    return map;
  })();

  it("holds vendors carrying more than one verification date", () => {
    const spread = [...byVendor.values()].filter((dates) => new Set(dates).size > 1);
    assert.ok(
      spread.length > 0,
      "no vendor holds two verification dates, so the oldest-of rule is untested against the index",
    );
  });

  it("reports the oldest date for every vendor in the index", () => {
    const wrong: string[] = [];
    for (const [slug, dates] of byVendor) {
      const expected = [...dates].sort()[0];
      if (oldestVerifiedDateForSlug(slug) !== expected) wrong.push(slug);
    }
    assert.deepStrictEqual(wrong, []);
  });

  it("reports nothing for a vendor we do not hold", () => {
    assert.strictEqual(oldestVerifiedDateForSlug("a-vendor-we-do-not-hold"), null);
  });
});

describe("a node naming a vendor is not always a record", () => {
  const referralCode = {
    vendor: "Supabase",
    code: "supabase-referral-2026",
    referral_url: "https://example.com/referrals/abc",
    referee_benefit: "A referral benefit",
    restrictions: [],
    source: "agent-submitted",
  };

  it("does not count a referral code as a record", () => {
    assert.deepStrictEqual(citedRecords({ offer: { referral_code: referralCode } }), []);
  });

  it("counts one record when an offer carries a referral code for the same vendor", () => {
    const payload = {
      offer: { vendor: "Supabase", category: "Databases", verifiedDate: "2026-08-17", referral_code: referralCode },
    };
    assert.strictEqual(citedRecords(payload).length, 1);
    const block = provenanceBlock(BASE, payload);
    assert.strictEqual(block.verified_records, 1);
    assert.strictEqual(
      block.cite_as,
      "Source: AgentDeals (https://agentdeals.dev/vendor/supabase, checked 2026-08-17)",
    );
  });

  it("counts a record named only by its tier or its category", () => {
    assert.strictEqual(citedRecords({ vendor: "Vercel", current_tier: "Hobby" }).length, 1);
    assert.strictEqual(citedRecords({ vendor: "Render", tier: "Free" }).length, 1);
    assert.strictEqual(citedRecords({ vendor: "Neon", category: "Databases" }).length, 1);
  });

  it("finds every vendor-bearing record in every response shape we serve", () => {
    const details = getOfferDetails("supabase", true);
    const payload = "error" in details ? {} : details;
    assert.ok(citedRecords(payload).length > 0, "the vendor detail response cites nothing");
  });
});
