import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  arraysHoldingASlug,
  buildersHoldingASlug,
  fieldsDenyingTheFreeTier,
  freeTierClaimsIn,
  hardcodedRowsCarryingASlug,
  statesThereIsNoFreeTier,
  rowAt,
  type HardcodedRow,
} from "./hardcoded-vendor-rows.ts";
import { assertCoversPopulation, assertSharesPopulation, rowsCarryingAVendorSlug } from "./population-floor.ts";

const { resolveVendorSlug } = await import("../dist/vendor-slug.js");
const { toSlug } = await import("../dist/slug.js");
const { loadOffers } = await import("../dist/data.js");

type Offer = import("../src/types.ts").Offer;
type Resolution = ReturnType<typeof resolveVendorSlug>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = loadOffers();
const firstRecordFor = new Map<string, Offer>();
for (const offer of offers) {
  const slug = toSlug(offer.vendor);
  if (slug && !firstRecordFor.has(slug)) firstRecordFor.set(slug, offer);
}

const RETIRED = "Retired";

const rows = hardcodedRowsCarryingASlug();

interface JoinedRow {
  row: HardcodedRow;
  resolution: Resolution;
  record: Offer | null;
}

const joined: JoinedRow[] = rows.map(row => {
  const resolution = resolveVendorSlug(row.slug);
  const record = resolution.type === "exact" ? firstRecordFor.get(resolution.slug) ?? null : null;
  return { row, resolution, record };
});

const namingARecord = joined.filter(j => j.resolution.type === "exact");
const joiningARetiredRecord = joined.filter(j => j.record?.tier === RETIRED);

function siteOf(row: HardcodedRow): string {
  return `${row.builder ?? "module"}.${row.array ?? "anonymous"}:${row.line} (${row.slug})`;
}

describe("a hardcoded comparison row does not sell a tier its own record has retired", () => {
  it("reads every row in the page source that carries a vendor slug", () => {
    assertCoversPopulation(joined.length, rowsCarryingAVendorSlug(), "hardcoded rows this check read");
    assert.ok(
      arraysHoldingASlug(rows).length > 1 && buildersHoldingASlug(rows).length > 1,
      `${arraysHoldingASlug(rows).length} arrays across ${buildersHoldingASlug(rows).length} page builders carry a slug, which is too few to be the whole source`,
    );
  });

  it("resolves most of those rows to a record, so the join is worth asking about", () => {
    assertSharesPopulation(
      namingARecord.length,
      rowsCarryingAVendorSlug(),
      0.5,
      "hardcoded rows whose slug names a record exactly",
    );
  });

  it("finds rows standing on a retired record, so the rule reads a population and not an empty set", () => {
    assert.ok(
      joiningARetiredRecord.length > 0,
      `no hardcoded row resolves to a record recorded as ${RETIRED}, so this check read an empty population`,
    );
  });

  it("affirms no free tier on any row whose record is retired", () => {
    const affirming = joiningARetiredRecord
      .map(j => ({ site: siteOf(j.row), vendor: j.record!.vendor, fields: freeTierClaimsIn(j.row) }))
      .filter(j => j.fields.length > 0);
    assert.deepStrictEqual(
      affirming,
      [],
      `${affirming.length} of ${joiningARetiredRecord.length} rows standing on a retired record still affirm a free tier:\n`
        + affirming.map(a => `  ${a.site} — ${a.vendor} — ${a.fields.join(", ")}`).join("\n"),
    );
  });

  it("says on every such row that there is no free tier, rather than only withholding the old one", () => {
    const silent = joiningARetiredRecord
      .filter(j => fieldsDenyingTheFreeTier(j.row).length === 0)
      .map(j => `  ${siteOf(j.row)} — ${j.record!.vendor}`);
    assert.deepStrictEqual(
      silent,
      [],
      `${silent.length} rows stand on a retired record and no field of theirs says so:\n${silent.join("\n")}`,
    );
  });
});

describe("the rows this rule must leave alone", () => {
  const accepted: Array<{ builder: string; array: string; slug: string; because: string }> = [
    {
      builder: "buildAiCodingPricing2026Page",
      array: "tools",
      slug: "augment-code",
      because: "its record is retired and the row already says there is no free tier",
    },
    {
      builder: "buildAiCodingToolsPricingPage",
      array: "tools",
      slug: "augment-code",
      because: "its record is retired and the row already says there is no free tier",
    },
    {
      builder: "buildHostingPricingPage",
      array: "services",
      slug: "heroku",
      because: "the slug reaches a record only by redirect, and that record is a different product",
    },
    {
      builder: "buildLlmApiPricingPage",
      array: "providers",
      slug: "openai",
      because: "its record is not retired",
    },
  ];

  for (const fixture of accepted) {
    it(`accepts ${fixture.builder}.${fixture.array} for ${fixture.slug} because ${fixture.because}`, () => {
      const row = rowAt(rows, fixture.builder, fixture.array, fixture.slug);
      assert.ok(row !== null, `${fixture.builder}.${fixture.array} no longer holds a row for ${fixture.slug}`);
      const resolution = resolveVendorSlug(row.slug);
      const record = resolution.type === "exact" ? firstRecordFor.get(resolution.slug) ?? null : null;
      const inScope = record?.tier === RETIRED;
      assert.ok(
        !inScope || freeTierClaimsIn(row).length === 0,
        `${siteOf(row)} is read by this rule and refused by it: ${freeTierClaimsIn(row).join(", ")}`,
      );
    });
  }

  it("reads the Heroku row against no record, because the only record its slug reaches is another product", () => {
    const row = rowAt(rows, "buildHostingPricingPage", "services", "heroku");
    assert.ok(row !== null, "the hosting comparison no longer holds a row for heroku");
    const resolution = resolveVendorSlug(row.slug);
    assert.strictEqual(resolution.type, "redirect");
    assert.ok(
      freeTierClaimsIn(row).length > 0,
      "the heroku row no longer states a free allowance, so it no longer shows what widening this rule to redirects would cost",
    );
  });

  it("reads the OpenAI row against a record that is not retired, so its free tier stands", () => {
    const row = rowAt(rows, "buildLlmApiPricingPage", "providers", "openai");
    assert.ok(row !== null, "the LLM pricing comparison no longer holds a row for openai");
    const resolution = resolveVendorSlug(row.slug);
    assert.strictEqual(resolution.type, "exact");
    assert.notStrictEqual(firstRecordFor.get("openai")?.tier, RETIRED);
    assert.ok(
      freeTierClaimsIn(row).length > 0,
      "the openai row no longer states a free tier, so it no longer shows what scoping this rule on a removal record would cost",
    );
  });
});

const STATES_FREENESS = /\bfree\b|\bno cost\b|\$0(?![.,\d])/i;
const SENTENCE = /[^.!?]+[.!?]?/g;

interface PublishedPair {
  page: string;
  slug: string;
  vendor: string;
}

function pairsTheRegisterRecords(): PublishedPair[] {
  const at = process.env.AGENTDEALS_PAGE_REVIEWS_PATH || path.join(REPO, "data", "page-reviews.json");
  const register: Array<{ path: string; vendors_tabulated?: string[]; vendors_asserted?: string[] }> =
    JSON.parse(readFileSync(at, "utf-8")).pages;
  const found: PublishedPair[] = [];
  for (const page of register) {
    const named = new Set([...(page.vendors_tabulated ?? []), ...(page.vendors_asserted ?? [])]);
    for (const slug of named) {
      const record = firstRecordFor.get(slug);
      if (record?.tier === RETIRED) found.push({ page: page.path, slug, vendor: record.vendor });
    }
  }
  return found;
}

function decodeEntities(html: string): string {
  return html
    .replace(/&nbsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rarr;/g, "→")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(?:td|th|li|p|div|h[1-6]|dd|dt|tr)>/gi, ". ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function structuredStrings(html: string): string[] {
  const found: string[] = [];
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      found.push(block[1]);
      continue;
    }
    const walk = (value: unknown): void => {
      if (typeof value === "string") found.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(parsed);
  }
  return found;
}

function claimsNaming(text: string, vendor: string): string[] {
  return (text.match(SENTENCE) ?? []).filter(sentence => sentence.includes(vendor)).map(s => s.trim());
}

let port = 0;
let server: ChildProcess | null = null;

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const running = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (running) {
        port = parseInt(running[1], 10);
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.on("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe("a page naming a vendor whose offer has ended does not present it as free", () => {
  const pairs = pairsTheRegisterRecords();

  before(async () => {
    server = await startServer();
  });

  after(() => {
    server?.kill();
  });

  it("has pages to read, and reads every page the register says names one", async () => {
    assert.ok(
      pairs.length > 0,
      "the review register records no page tabulating a vendor whose record is retired, so this sweep read nothing",
    );
    let read = 0;
    for (const pair of pairs) {
      const response = await fetch(`http://localhost:${port}${pair.page}`, { redirect: "manual" });
      assert.strictEqual(response.status, 200, `${pair.page} answered ${response.status}`);
      await response.text();
      read++;
    }
    assert.strictEqual(read, pairs.length);
  });

  it("publishes no claim of a free tier for one, in the page text or in its structured data", async () => {
    const affirming: string[] = [];
    for (const pair of pairs) {
      const html = await (await fetch(`http://localhost:${port}${pair.page}`, { redirect: "manual" })).text();
      const surfaces: Array<{ where: string; claim: string }> = [
        ...claimsNaming(visibleText(html), pair.vendor).map(claim => ({ where: "page text", claim })),
        ...structuredStrings(html).flatMap(value =>
          claimsNaming(value, pair.vendor).map(claim => ({ where: "structured data", claim })),
        ),
      ];
      for (const surface of surfaces) {
        if (!STATES_FREENESS.test(surface.claim)) continue;
        if (statesThereIsNoFreeTier(surface.claim)) continue;
        affirming.push(`  ${pair.page} — ${pair.vendor} — ${surface.where}: ${surface.claim.slice(0, 200)}`);
      }
    }
    assert.deepStrictEqual(
      affirming,
      [],
      `${affirming.length} published claims present a retired offer as free, over ${pairs.length} page and vendor pairs the register records:\n${affirming.join("\n")}`,
    );
  });
});
