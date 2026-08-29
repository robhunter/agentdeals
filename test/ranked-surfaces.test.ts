// #1025 part 2: the surfaces that were still resolving order by file order,
// by a risk bucket, or by our commercial interest.
//
// The enumeration behind this file matters more than any single assertion:
// three of these were recommendation surfaces nobody had listed, and one of
// them (`/vendor/:slug` alternatives) sits on the highest-traffic page type on
// the site while being decided by nothing but the order of data/index.json.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
let serverPort = 0;
let proc: ChildProcess | null = null;

function startHttpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 15000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, text: await res.text() };
};

before(async () => { proc = await startHttpServer(); });
after(() => { if (proc) proc.kill(); });

const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*|\*\/)/.test(l)).join("\n");

describe("the templates no longer name winners", () => {
  const stacks = stripComments(readFileSync(path.join(REPO, "src", "stacks.ts"), "utf8"));

  it("preferredVendors is deleted, not repointed", () => {
    assert.ok(!/preferredVendors/.test(stacks), "retyping the fiat is not the fix");
  });

  it("the publicOffers[0] file-order fallback is gone", () => {
    assert.ok(!/publicOffers/.test(stacks), "index order must not decide a recommendation");
    assert.ok(!/findBestOffer/.test(stacks), "the single-winner selector must be gone");
  });

  it("no vendor name from the index survives in the selection path", () => {
    const index = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")) as { offers: { vendor: string }[] };
    const vendors = [...new Set(index.offers.map((o) => o.vendor))].filter((v) => v.length >= 4);
    const hits = vendors.filter((v) => new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(stacks));
    assert.deepStrictEqual(hits, [], `vendor names still reachable from stack selection: ${hits.join(", ")}`);
  });
});

describe("/vendor/:slug alternatives", () => {
  it("are not served in data/index.json order", async () => {
    const index = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")) as { offers: { vendor: string; category: string }[] };
    const { status, text } = await get("/vendor/supabase");
    assert.strictEqual(status, 200);
    const shown = [...text.matchAll(/\/vendor\/([a-z0-9-]+)"[^>]*class="alt-vendor-name"/g)].map((m) => m[1]);
    const fileOrder = index.offers
      .filter((o) => o.category === "Databases" && o.vendor !== "Supabase")
      .map((o) => o.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
    if (shown.length >= 3) {
      assert.notDeepStrictEqual(shown, fileOrder.slice(0, shown.length), "alternatives are still in raw file order");
    }
  });
});

describe("/alternative-to/:slug", () => {
  it("names the recorded fact behind every demotion", async () => {
    const { status, text } = await get("/alternative-to/openai");
    assert.strictEqual(status, 200);
    assert.match(text, /<strong>&minus;3 free_tier_withdrawn<\/strong> Recorded [a-z ]+ on \d{4}-\d{2}-\d{2}/, "a withdrawn free tier must name the change and its date");
    assert.match(text, /<strong>&minus;2 time_limited_offer<\/strong> Tier &quot;[^&]+&quot; is a credit grant/, "a credit grant must say so");
    assert.match(text, /<strong>&minus;1 stale_verification<\/strong>[^<]*not a change by the vendor/, "our own verification gap must be labelled as ours");
    assert.match(text, /How we rank/);
  });

  it("no longer claims to be sorted by stability", async () => {
    const { text } = await get("/alternative-to/vercel");
    assert.ok(!text.includes("Sorted by stability"), "that copy described the ordering we removed");
    assert.match(text, /carry no recorded demerit/);
  });

  it("puts every unblemished alternative above every demoted one, and is not alphabetical", async () => {
    const { text } = await get("/alternative-to/vercel");
    const list = text.slice(text.indexOf("All Free Alternatives"));
    const cards = list.split('<div class="alt-row').slice(1);
    assert.ok(cards.length >= 10, `expected a full alternatives list, got ${cards.length}`);

    const demeritAt = cards.findIndex((c) => c.includes("alt-demerit"));
    if (demeritAt > -1) {
      const cleanAfter = cards.slice(demeritAt).filter((c) => !c.includes("alt-demerit"));
      assert.strictEqual(cleanAfter.length, 0, "an offer we hold nothing against was ranked below a demoted one");
    }

    const vendors = cards.map((c) => c.match(/class="alt-vendor-name">([^<]+)</)?.[1] ?? "");
    assert.notDeepStrictEqual(vendors, [...vendors].sort((a, b) => a.localeCompare(b)), "alternatives are still alphabetical");
  });

  it("does not empty out a page whose category peers are all eligibility-gated", async () => {
    // 91 /alternative-to pages would have gone to zero alternatives if the
    // gates removed offers here the way they do on a /best/ page.
    const { status, text } = await get("/alternative-to/brex");
    assert.strictEqual(status, 200);
    const shown = (text.match(/class="alt-vendor-name"/g) ?? []).length;
    assert.ok(shown > 0, "a gated category must still list its peers, labelled");
    assert.match(text, /eligibility_restricted/, "the gate must be stated on the entries it applies to");
  });
});

describe("/api/vendor-risk alternatives", () => {
  it("carry the evidence behind them", async () => {
    const { status, text } = await get("/api/vendor-risk/openai");
    assert.strictEqual(status, 200);
    const body = JSON.parse(text);
    assert.ok(Array.isArray(body.alternatives));
    for (const a of body.alternatives) {
      assert.ok(Array.isArray(a.demerits), `${a.vendor} must carry its demerits`);
    }
  });
});

describe("/referral-programs stops being ordered by our own money", () => {
  it("splits into two explicitly headed sections", async () => {
    const { status, text } = await get("/referral-programs");
    assert.strictEqual(status, 200);
    const paid = text.indexOf("Programs we have a referral link for");
    const unpaid = text.indexOf("Programs we don");
    assert.ok(paid > -1, "the paid section must be headed as such");
    assert.ok(unpaid > paid, "the unpaid section must follow it, separately headed");
    assert.match(text, /we may earn a commission/);
  });

  it("puts the disclosure on the section header, not only per item", async () => {
    const { text } = await get("/referral-programs");
    const paid = text.indexOf("Programs we have a referral link for");
    const unpaid = text.indexOf("Programs we don");
    const sectionNote = text.slice(paid, unpaid);
    assert.match(sectionNote, /href="\/disclosure"/, "the paid section header must carry the disclosure link");
  });

  it("is no longer one list with the paying vendors silently on top", async () => {
    const { text } = await get("/referral-programs");
    const tables = text.split("<table class=\"programs-table\">").length - 1;
    assert.strictEqual(tables, 2, "expected exactly two tables, one per section");
    // Every "Use our code" link must be inside the first table.
    const secondTableAt = text.indexOf("<table class=\"programs-table\">", text.indexOf("<table class=\"programs-table\">") + 1);
    const paidLinksAfterSplit = text.slice(secondTableAt).match(/status-active/g) ?? [];
    assert.strictEqual(paidLinksAfterSplit.length, 0, "a monetized link leaked into the unpaid section");
  });

  it("orders within a section by rotation, not the alphabet", async () => {
    const { text } = await get("/referral-programs");
    // The unpaid section — the second table — is the larger of the two, and is
    // the one this pins.
    const secondBodyAt = text.indexOf("<tbody>", text.indexOf("</tbody>"));
    const secondTable = text.slice(secondBodyAt, text.indexOf("</tbody>", secondBodyAt));
    const vendors = [...secondTable.matchAll(/class="vendor-link">([^<]+)</g)].map((m) => m[1]);
    assert.ok(vendors.length >= 4, `expected several unpaid programmes, got ${vendors.length}`);
    assert.notDeepStrictEqual(vendors, [...vendors].sort((a, b) => a.localeCompare(b)), "still alphabetical inside the section");

    // Pinned to the rotation the module actually produces over the source
    // order, so reintroducing any other sort fails here.
    const { rotateListing } = await import("../src/ranking.ts");
    const { hasOurReferralLink } = await import("../dist/referral-surfaces.js");
    const index = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")) as {
      offers: { vendor: string; referral?: unknown; referral_program?: { available?: boolean } }[];
    };
    const seen = new Set<string>();
    const sourceOrder: string[] = [];
    for (const o of index.offers) {
      if (o.referral_program?.available && !seen.has(o.vendor)) {
        seen.add(o.vendor);
        if (!hasOurReferralLink(o.vendor, o)) sourceOrder.push(o.vendor);
      }
    }
    assert.deepStrictEqual(vendors, rotateListing(sourceOrder, "referral-programs:without-code"));
  });
});

describe("the criteria are discoverable by an agent that never renders HTML", () => {
  it("llms.txt states the ranking policy and links the method", async () => {
    const { status, text } = await get("/llms.txt");
    assert.strictEqual(status, 200);
    assert.match(text, /Recommendations are not for sale/);
    assert.match(text, /can only be demoted/);
    assert.match(text, /do NOT model technical fit/i);
    assert.match(text, /\/criteria/);
  });

  it("the plan_stack tool description says what it now returns", async () => {
    const { text } = await get("/llms.txt");
    assert.match(text, /not a single pick/);
  });

  it("/api/stack carries the method with every response", async () => {
    const { status, text } = await get("/api/stack?use_case=Next.js+SaaS+app");
    assert.strictEqual(status, 200);
    const body = JSON.parse(text);
    assert.strictEqual(body.method.criteria_url, "/criteria");
    assert.match(body.method.not_modelled, /do NOT model technical fit/i);
    for (const role of body.stack) {
      assert.ok(role.candidates.length > 0);
      assert.match(role.tie_break.seed, /^[0-9a-f]{64}$/);
    }
  });

  it("/criteria no longer carries the interim caveat now that plan_stack has moved", async () => {
    const { text } = await get("/criteria");
    assert.ok(!text.includes("are being moved onto this same module"), "the caveat must come out with the work");
    assert.match(text, /the <code>\/api\/stack<\/code> endpoint and the <code>plan_stack<\/code> MCP tool/);
  });
});
