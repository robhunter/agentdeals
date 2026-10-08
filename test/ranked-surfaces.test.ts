import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOffers, gateForOffer } from "../dist/data.js";
import { substitutesFor } from "../dist/product-role.js";
import { toSlug, vendorSlugMap } from "../dist/vendor-slug.js";
import { changesByVendor, evaluate, utcDate } from "../dist/ranking.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
let serverPort = 0;
let proc: ChildProcess | null = null;

const TODAY = utcDate();
const LAST_REACHABLE = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
const liveLinkHealth: { links: Array<{ url: string; outcome: string }> } = JSON.parse(
  readFileSync(path.join(REPO, "data", "link_health.json"), "utf8"),
);

const liveVerificationState: { records: Array<{ vendor: string; url: string }> } = JSON.parse(
  readFileSync(path.join(REPO, "data", "verification_state.json"), "utf8"),
);
const LAST_READ = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);

function firstUngatedAlternative(passOver: ReadonlySet<string> = new Set()) {
  const offers = loadOffers();
  const unreachableToday = new Set(liveLinkHealth.links.filter((l) => l.outcome === "unreachable").map((l) => l.url));
  for (const vendor of [...new Set(offers.map((o) => o.vendor))].sort()) {
    if (vendorSlugMap.get(toSlug(vendor)) !== vendor) continue;
    const subject = offers.find((o) => o.vendor === vendor)!;
    const alternative = substitutesFor(offers, subject)
      .map((a) => offers.find((o) => o.vendor === a.vendor)!)
      .find((a) => gateForOffer(a) === null && !unreachableToday.has(a.url) && !passOver.has(a.vendor));
    if (alternative) return { slug: toSlug(vendor), alternative };
  }
  return null;
}

const deadLink = firstUngatedAlternative();
const unconfirmedRead = firstUngatedAlternative(new Set(deadLink ? [deadLink.alternative.vendor] : []));

const scratchData = mkdtempSync(path.join(tmpdir(), "ranked-surfaces-data-"));
const linkHealthWithOneDeadAlternative = path.join(scratchData, "link_health.json");
const verificationStateWithOneUnconfirmedRead = path.join(scratchData, "verification_state.json");
writeFileSync(verificationStateWithOneUnconfirmedRead, JSON.stringify({
  ...liveVerificationState,
  records: [
    ...liveVerificationState.records.filter((r) =>
      !(unconfirmedRead && r.vendor === unconfirmedRead.alternative.vendor && r.url === unconfirmedRead.alternative.url)),
    ...(unconfirmedRead
      ? [{
          vendor: unconfirmedRead.alternative.vendor,
          url: unconfirmedRead.alternative.url,
          last_attempt_at: LAST_READ,
          last_outcome: "states_no_price",
          last_error: null,
          failure_category: null,
          consecutive_failures: 0,
          last_success: null,
          last_read_at: LAST_READ,
          quarantined_since: null,
        }]
      : []),
  ],
}));
writeFileSync(linkHealthWithOneDeadAlternative, JSON.stringify({
  ...liveLinkHealth,
  links: [
    ...liveLinkHealth.links.filter((l) => l.url !== deadLink?.alternative.url),
    ...(deadLink
      ? [{
          url: deadLink.alternative.url,
          checked: TODAY,
          outcome: "unreachable",
          detail: "HTTP 404",
          terminal: false,
          last_reachable: LAST_REACHABLE,
          consecutive_unreachable: 3,
        }]
      : []),
  ],
}));

function startHttpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost",
        AGENTDEALS_LINK_HEALTH_PATH: linkHealthWithOneDeadAlternative,
        AGENTDEALS_VERIFICATION_STATE_PATH: verificationStateWithOneUnconfirmedRead,
      },
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
after(() => {
  if (proc) proc.kill();
  rmSync(scratchData, { recursive: true, force: true });
});

const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*|\*\/)/.test(l)).join("\n");

const withdrawalSubjectSlug = (() => {
  const offers = loadOffers();
  const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8")).changes;
  const byVendor = changesByVendor(changes);
  const today = utcDate();
  const demoted = new Set(
    offers
      .filter((o) => evaluate(o, { date: today, changesForVendor: byVendor.get(o.vendor.toLowerCase()) ?? [] })
        .demerits.some((d: { code: string }) => d.code === "free_tier_withdrawn"))
      .map((o) => o.vendor)
  );
  if (demoted.size === 0) return null;
  for (const vendor of [...new Set(offers.map((o) => o.vendor))].sort()) {
    if (vendorSlugMap.get(toSlug(vendor)) !== vendor) continue;
    const subject = offers.find((o) => o.vendor === vendor)!;
    if (substitutesFor(offers, subject).some((a) => demoted.has(a.vendor))) return toSlug(vendor);
  }
  return null;
})();

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
  const DEMOTION_EVIDENCE: Array<{ code: string; path: string; pattern: RegExp; why: string }> = [
    { code: "free_tier_withdrawn", path: `/alternative-to/${withdrawalSubjectSlug ?? ""}`, pattern: /<strong>&minus;3 free_tier_withdrawn<\/strong> Recorded [a-z ]+ on \d{4}-\d{2}-\d{2}/, why: "a withdrawn free tier must name the change and its date" },
    { code: "time_limited_offer", path: "/alternative-to/openai", pattern: /<strong>&minus;2 time_limited_offer<\/strong> Tier &quot;[^&]+&quot; is a credit grant/, why: "a credit grant must say so" },
    { code: "stale_verification", path: `/alternative-to/${unconfirmedRead?.slug ?? ""}`, pattern: /<strong>&minus;1 stale_verification<\/strong>[^<]*not a change by the vendor/, why: "our own verification gap must be labelled as ours" },
    { code: "link_unreachable", path: `/alternative-to/${deadLink?.slug ?? ""}`, pattern: new RegExp(`<strong>&minus;2 link_unreachable</strong>[^<]*pricing page has not resolved for us since ${LAST_REACHABLE}`), why: "a dead pricing page must name the date it was last reachable" },
  ];

  it("draws the withdrawal subject from a list that publishes one today", () => {
    assert.ok(
      withdrawalSubjectSlug,
      "no alternatives list publishes a vendor demoted on a withdrawal still in force, so the row below asserts nothing and needs a surface that does"
    );
  });

  async function cardOn(slug: string, vendor: string): Promise<string | undefined> {
    const { text } = await get(`/alternative-to/${slug}`);
    const name = vendor
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return text.split('<div class="alt-row').slice(1).find((c) => c.includes(`class="alt-vendor-name">${name}<`));
  }

  it("demotes the alternative whose pricing page a copy of the link health marks unreachable, on that alternative's own card", async () => {
    assert.ok(deadLink, "no alternatives list holds an alternative our gate lets through, so no pricing page can be marked unreachable");
    const card = await cardOn(deadLink.slug, deadLink.alternative.vendor);
    assert.ok(card, `${deadLink.alternative.vendor} is not listed on /alternative-to/${deadLink.slug}`);
    assert.match(
      card,
      new RegExp(`<strong>&minus;2 link_unreachable</strong>[^<]*pricing page has not resolved for us since ${LAST_REACHABLE}`),
      `${deadLink.alternative.vendor}'s card does not name the day its pricing page last resolved`,
    );
  });

  it("demotes the alternative whose last read a copy of the verification state says found no price, on that alternative's own card", async () => {
    assert.ok(unconfirmedRead, "no alternatives list holds a second alternative our gate lets through, so no read can be recorded against one");
    const card = await cardOn(unconfirmedRead.slug, unconfirmedRead.alternative.vendor);
    assert.ok(card, `${unconfirmedRead.alternative.vendor} is not listed on /alternative-to/${unconfirmedRead.slug}`);
    assert.match(
      card,
      new RegExp(`<strong>&minus;1 stale_verification</strong>[^<]*on ${LAST_READ}, could read no amount, tier or rate on the page[^<]*not a change by the vendor`),
      `${unconfirmedRead.alternative.vendor}'s card does not say what its last read found`,
    );
  });

  for (const { code, path, pattern, why } of DEMOTION_EVIDENCE) {
    it(`names the recorded fact behind every ${code} demotion on ${path}`, async () => {
      const { status, text } = await get(path);
      assert.strictEqual(status, 200);
      assert.match(text, /All Free Alternatives \(\d+\)/, `${path} must rank a list for the assertion to mean anything`);
      assert.match(text, pattern, why);
      assert.match(text, /How we rank/);
    });
  }

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

  it("offers no substitute from a category we hold no product taxonomy for", async () => {
    const { status, text } = await get("/alternative-to/brex");
    assert.strictEqual(status, 200);
    const shown = (text.match(/class="alt-vendor-name"/g) ?? []).length;
    assert.strictEqual(shown, 0, "Startup Perks carries no subtype taxonomy, so no record in it is offered as a substitute");
    assert.doesNotMatch(text, /All Free Alternatives \(/, "a page with no substitutes must not head a list of them");
    assert.doesNotMatch(text, /"@type":"ItemList"/, "an empty set must not ship as structured data");
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
    const secondTableAt = text.indexOf("<table class=\"programs-table\">", text.indexOf("<table class=\"programs-table\">") + 1);
    const paidLinksAfterSplit = text.slice(secondTableAt).match(/status-active/g) ?? [];
    assert.strictEqual(paidLinksAfterSplit.length, 0, "a monetized link leaked into the unpaid section");
  });

  it("orders within a section by rotation, not the alphabet", async () => {
    const { text } = await get("/referral-programs");
    const secondBodyAt = text.indexOf("<tbody>", text.indexOf("</tbody>"));
    const secondTable = text.slice(secondBodyAt, text.indexOf("</tbody>", secondBodyAt));
    const vendors = [...secondTable.matchAll(/class="vendor-link">([^<]+)</g)].map((m) => m[1]);
    assert.ok(vendors.length >= 4, `expected several unpaid programmes, got ${vendors.length}`);
    assert.notDeepStrictEqual(vendors, [...vendors].sort((a, b) => a.localeCompare(b)), "still alphabetical inside the section");

    const { rotateListing } = await import("../dist/ranking.js");
    const { hasOurReferralLink, documentsVendorReferralProgram } = await import("../dist/referral-surfaces.js");
    const index = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")) as {
      offers: { vendor: string; referral?: unknown; referral_program?: { available?: boolean } }[];
    };
    const seen = new Set<string>();
    const sourceOrder: string[] = [];
    for (const o of index.offers) {
      if (documentsVendorReferralProgram(o) && !seen.has(o.vendor)) {
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

const RANKED_SURFACES: Array<{
  queryKeyPrefix: string;
  publishedAt: string;
  seedIn: "html" | "json";
  jsonSeed?: (body: any) => unknown;
}> = [
  { queryKeyPrefix: "best-of", publishedAt: "/best/free-databases", seedIn: "html" },
  { queryKeyPrefix: "alternatives", publishedAt: "/vendor/vercel", seedIn: "html" },
  { queryKeyPrefix: "alternative-to", publishedAt: "/alternative-to/vercel", seedIn: "html" },
  { queryKeyPrefix: "curated-alternatives", publishedAt: "/vendor/postman", seedIn: "html" },
  { queryKeyPrefix: "related", publishedAt: "/api/details/doppler", seedIn: "json", jsonSeed: (b) => b.tie_break?.seed },
  { queryKeyPrefix: "vendor-risk-alternatives", publishedAt: "/api/vendor-risk/doppler", seedIn: "json", jsonSeed: (b) => b.tie_break?.seed },
  { queryKeyPrefix: "stack", publishedAt: "/api/stack?use_case=Next.js+SaaS+app", seedIn: "json", jsonSeed: (b) => b.stack?.[0]?.tie_break?.seed },
];

function rankingCallQueryKeyPrefixes(): string[] {
  const prefixes: string[] = [];
  for (const file of ["serve.ts", "data.ts", "stacks.ts"]) {
    const src = readFileSync(path.join(REPO, "src", file), "utf8");
    for (const m of src.matchAll(/\brank(?:Offers|ForListing)\(/g)) {
      const window = src.slice(m.index!, m.index! + 600);
      const key = window.match(/queryKey:\s*`([a-z-]+)/);
      assert.ok(key, `a ranking call in src/${file} passes no literal query key prefix`);
      prefixes.push(key![1]);
    }
  }
  return prefixes;
}

describe("every ranked surface publishes the seed that ordered it", () => {
  it("no ranking call site is missing from the enumeration above", () => {
    const found = [...new Set(rankingCallQueryKeyPrefixes())].sort();
    const registered = [...new Set(RANKED_SURFACES.map((s) => s.queryKeyPrefix))].sort();
    assert.deepStrictEqual(
      found,
      registered,
      "a surface resolves through the ranking module without a row saying where it publishes its seed",
    );
  });

  for (const surface of RANKED_SURFACES) {
    it(`${surface.publishedAt} publishes the date, query_key, seed and tie_count for ${surface.queryKeyPrefix}`, async () => {
      const { status, text } = await get(surface.publishedAt);
      assert.strictEqual(status, 200);
      if (surface.seedIn === "json") {
        assert.match(String(surface.jsonSeed!(JSON.parse(text))), /^[0-9a-f]{64}$/);
        return;
      }
      const blocks = text.match(/<div class="audit-block">[\s\S]*?<\/div>/g) ?? [];
      assert.ok(blocks.length > 0, "the page ranks a list and renders no audit block");
      const block = blocks.find((b) => new RegExp(`<dt>query_key</dt><dd>${surface.queryKeyPrefix}:`).test(b));
      assert.ok(block, `no audit block on the page names ${surface.queryKeyPrefix}`);
      assert.match(block, /<dt>date<\/dt><dd>\d{4}-\d{2}-\d{2}<\/dd>/);
      assert.match(block, /<dt>seed<\/dt><dd>[0-9a-f]{64}<\/dd>/);
      assert.match(block, /<dt>tie_count<\/dt><dd>\d+<\/dd>/);
    });
  }

  it("the seed a page prints is the one the published algorithm derives", async () => {
    const { createHash } = await import("node:crypto");
    for (const p of ["/best/free-databases", "/vendor/supabase", "/alternative-to/vercel"]) {
      const { text } = await get(p);
      const block = text.match(/<div class="audit-block">[\s\S]*?<\/div>/)![0];
      const date = block.match(/<dt>date<\/dt><dd>([^<]+)</)![1];
      const queryKey = block.match(/<dt>query_key<\/dt><dd>([^<]+)</)![1].replace(/&amp;/g, "&");
      const seed = block.match(/<dt>seed<\/dt><dd>([^<]+)</)![1];
      assert.strictEqual(createHash("sha256").update(`${date}|${queryKey}|p0`).digest("hex"), seed, `${p} prints a seed its own inputs do not produce`);
    }
  });

  it("every best-of card previews a ranked order the page it links to publishes a seed for", async () => {
    const { text } = await get("/best");
    const slugs = [...new Set([...text.matchAll(/href="\/best\/([a-z0-9-]+)"/g)].map((m) => m[1]))];
    assert.ok(slugs.length > 40, `expected the full best-of index, got ${slugs.length}`);
    for (const slug of slugs.slice(0, 5)) {
      const { text: page } = await get(`/best/${slug}`);
      assert.match(page, /<div class="audit-block">/, `/best/${slug} carries no seed for the order previewed on /best`);
    }
  });

  it("the tie figures on /criteria are the ones the best-of pages themselves publish", async () => {
    const { text: index } = await get("/best");
    const slugs = [...new Set([...index.matchAll(/href="\/best\/([a-z0-9-]+)"/g)].map((m) => m[1]))];
    const tieCounts: number[] = [];
    for (const slug of slugs) {
      const { text } = await get(`/best/${slug}`);
      const block = text.match(/<div class="audit-block">[\s\S]*?<\/div>/)![0];
      tieCounts.push(Number(block.match(/<dt>tie_count<\/dt><dd>(\d+)<\/dd>/)![1]));
    }
    const uniqueTop = tieCounts.filter((n) => n === 1).length;
    const meanTie = (tieCounts.reduce((a, b) => a + b, 0) / tieCounts.length).toFixed(1);

    const { text: criteria } = await get("/criteria");
    const claim = criteria.match(/<div class="callout">([\s\S]*?)<\/div>/)![1];
    assert.match(claim, new RegExp(`of the ${slugs.length} product functions with a best-of page`), "the denominator must be the number of best-of pages");
    assert.match(claim, new RegExp(`${uniqueTop === 0 ? "Zero" : String(uniqueTop)} of the`), `the page must publish the ${uniqueTop} its own best-of pages add up to`);
    assert.ok(claim.includes(`${meanTie} offers tie at the top`), `the mean must be ${meanTie}, the mean of the published tie counts`);

    const { text: llms } = await get("/llms.txt");
    assert.match(llms, new RegExp(`${uniqueTop} of the ${slugs.length} product functions with a best-of page`), "llms.txt must carry the same figure and the same scope");
  });

  it("the vendor page says the ranked order it shows is the whole of it", async () => {
    for (const slug of ["supabase", "vercel"]) {
      const { text } = await get(`/vendor/${slug}`);
      const at = text.indexOf('<h2 id="alternatives">');
      assert.notEqual(at, -1, `/vendor/${slug} publishes no alternatives, so it cannot say how many it shows`);
      const section = text.slice(at);
      const claim = section.match(/The list above is every one of the (\d+) entries in that order, not a prefix of it\./);
      assert.ok(claim, `/vendor/${slug} does not say how much of the ranked order it is showing`);
      const listed = [...section.matchAll(/<td><a href="\/vendor\/[a-z0-9-]+">/g)].length;
      assert.equal(listed, Number(claim[1]), `/vendor/${slug} lists ${listed} alternatives under a claim of ${claim[1]}`);
      assert.ok(!/The list above is the first/.test(text), "a list that shows every entry must not claim to be a prefix");
    }
  });

  it("a vendor page with no alternatives claims nothing about a list it does not publish", async () => {
    const { text } = await get("/vendor/doppler");
    assert.equal(text.indexOf('<h2 id="alternatives">'), -1, "this test needs a page that publishes no alternatives");
    assert.ok(!/The list above is/.test(text), "a page with no ranked list published a claim about one");
  });
});
