import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const GONE_URL = "https://example.com/gone/pricing";
const linkHealth = JSON.parse(readFileSync(path.join(REPO, "data", "link_health.json"), "utf8"));
linkHealth.links.push({
  url: GONE_URL,
  outcome: "unreachable",
  terminal: true,
  status: 410,
  checked: "2026-09-01",
  last_reachable: "2026-05-01",
});
const linkHealthPath = path.join(mkdtempSync(path.join(tmpdir(), "llm-readme-links-")), "link_health.json");
writeFileSync(linkHealthPath, JSON.stringify(linkHealth));
process.env.AGENTDEALS_LINK_HEALTH_PATH = linkHealthPath;

const {
  README_CATEGORIES,
  generateReadme,
  ratingWord,
  readmeCensus,
  readmeRows,
  renderRow,
} = await import("../dist/llm-api-readme.js");
const { CHANGE_KIND_NOUN } = await import("../dist/vendor-verdict.js");
const { NOT_FREE_TIER_RULES, TIME_LIMITED_TIER_RULES } = await import("../dist/ranking.js");
const { supersedingChange } = await import("../dist/superseded-description.js");
import type { DealChange, Offer } from "../src/types.ts";

const catalogue: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")).offers;
const catalogueChanges: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"),
).changes;

const ON = "2026-09-09";
const CONTEXT = { servedOn: ON, nowMs: Date.parse(`${ON}T00:00:00Z`), staleAfterDays: 70 };

const publishedRecords = catalogue.filter(o => (README_CATEGORIES as readonly string[]).includes(o.category));
const rows = readmeRows(catalogue, catalogueChanges, CONTEXT);
const rendered = generateReadme(catalogue, catalogueChanges, CONTEXT);

function offer(overrides: Partial<Offer>): Offer {
  return {
    vendor: "Fixture Vendor",
    category: "AI / ML",
    description: "Free tier with 1,000 requests/month and one seat",
    tier: "Free",
    url: "https://example.com/pricing",
    tags: ["ai"],
    verifiedDate: "2026-09-01",
    ...overrides,
  } as Offer;
}

function change(overrides: Partial<DealChange>): DealChange {
  return {
    vendor: "Fixture Vendor",
    change_type: "limits_reduced",
    date: "2026-08-01",
    summary: "The monthly request allowance fell from 1,000 to 100",
    impact: "medium",
    source_url: "https://example.com/pricing",
    ...overrides,
  } as DealChange;
}

function rowFor(offers: Offer[], changes: DealChange[], vendor: string) {
  const built = readmeRows(offers, changes, CONTEXT).find(r => r.vendor === vendor);
  assert.ok(built, `no row built for ${vendor}`);
  return built;
}

describe("the generated index publishes one row per catalogue record", () => {
  it("publishes every record in the published categories and nothing else", () => {
    assert.equal(rows.length, publishedRecords.length);
    assert.deepEqual(
      rows.map(r => `${r.vendor}|${r.tier}`).sort(),
      publishedRecords.map(o => `${o.vendor}|${o.tier}`).sort(),
    );
  });

  it("drops no record for having no rating to publish", () => {
    const census = readmeCensus(rows);
    assert.equal(census.rated + census.ended + census.withheld, census.rows);
    assert.ok(census.withheld > 0, "the fixture catalogue holds records whose rating is withheld");
  });

  it("renders one table row per record, every one with five cells", () => {
    const tableRows = rendered.split("\n").filter(line => line.startsWith("| [") && line.endsWith(" |"));
    assert.equal(tableRows.length, rows.length);
    for (const line of tableRows) {
      assert.equal(line.split(/(?<!\\)\|/).length - 2, 5, line.slice(0, 120));
    }
  });

  it("keeps a plan table the vendor wrote with pipes inside one cell", () => {
    const piped = offer({
      vendor: "Tabular Vendor",
      description: "Free: 10 GB | Pro: 1 TB | Business: 20 TB",
    });
    const line = renderRow(rowFor([piped], [], "Tabular Vendor"));
    assert.equal(line.split(/(?<!\\)\|/).length - 2, 5, line);
    assert.ok(line.includes("Free: 10 GB \\| Pro: 1 TB \\| Business: 20 TB"), line);
  });

  it("names each category with the number of records under it", () => {
    for (const category of README_CATEGORIES) {
      const inCategory = rows.filter(r => r.category === category).length;
      assert.match(rendered, new RegExp(`## ${category.replace("/", "\\/")} — ${inCategory} records`));
    }
  });
});

describe("every row carries its own date and its own source", () => {
  it("dates each row from the record behind it, never from the file", () => {
    for (const row of rows) {
      const dated = row.terms.as_of ?? row.verification.verifiedDate ?? row.verification.lastReachable;
      assert.match(dated ?? "", /^\d{4}-\d{2}-\d{2}$/, row.vendor);
      assert.match(row.terms.source_url, /^https?:\/\//, row.vendor);
    }
  });

  it("publishes no single freshness stamp for the whole file", () => {
    const generatedTwiceADayApart = generateReadme(catalogue, catalogueChanges, {
      ...CONTEXT,
      servedOn: "2026-09-10",
      nowMs: Date.parse("2026-09-10T00:00:00Z"),
    });
    const datesInProse = (text: string) =>
      text.split("\n").filter(line => !line.startsWith("| ")).join("\n").match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    assert.deepEqual(datesInProse(rendered), []);
    assert.deepEqual(datesInProse(generatedTwiceADayApart), []);
  });

  it("regenerating the same records on the same day produces the same bytes", () => {
    assert.equal(generateReadme(catalogue, catalogueChanges, CONTEXT), rendered);
  });
});

describe("a row never states a rating the catalogue withholds", () => {
  it("prints a reason, and no rating word, wherever the rating is withheld", () => {
    for (const row of rows.filter(r => r.verdict.kind === "withheld")) {
      assert.equal(ratingWord(row), "unrated", row.vendor);
      assert.ok(row.verdict.sentence.trim().length > 0, row.vendor);
      const line = renderRow(row);
      assert.ok(!/`(stable|caution|risky)`/.test(line), `${row.vendor} prints a withheld rating`);
      assert.ok(line.includes(row.verdict.sentence.split("<br>")[0].slice(0, 40)), row.vendor);
    }
  });

  it("says an offer that is not a free tier is not rated, rather than omitting it", () => {
    const paid = offer({ vendor: "Metered Vendor", tier: "Pay-as-you-go" });
    const row = rowFor([paid], [], "Metered Vendor");
    assert.equal(ratingWord(row), "unrated");
    assert.match(row.verdict.sentence, /usage-billed from the first request/);
    assert.match(renderRow(row), /Metered Vendor/);
  });

  it("says the page could not be read, rather than rating the record stable", () => {
    const unreadable = offer({
      vendor: "Unread Vendor",
      source_check: { checked: "2026-09-05", outcome: "unreadable", detail: "HTTP 403" },
    });
    const row = rowFor([unreadable], [], "Unread Vendor");
    assert.equal(ratingWord(row), "unrated");
    assert.match(row.verdict.sentence, /could not read the page we cite for Unread Vendor/);
  });

  it("keeps a rating the catalogue does publish", () => {
    const rated = offer({ vendor: "Narrowed Vendor" });
    const row = rowFor([rated], [change({ vendor: "Narrowed Vendor" })], "Narrowed Vendor");
    assert.equal(ratingWord(row), "caution");
    assert.match(renderRow(row), /`caution`/);
    assert.match(row.verdict.sentence, /limit reduction/);
  });

  it("marks an ended offer as ended rather than rating it", () => {
    const retired = offer({ vendor: "Gone Vendor", tier: "Retired" });
    const row = rowFor([retired], [], "Gone Vendor");
    assert.equal(ratingWord(row), "ended");
    assert.match(row.verdict.sentence, /This offer has ended/);
  });
});

describe("a row we cannot vouch for says so in the row", () => {
  it("withholds the verification date and publishes the day the link last worked", () => {
    const dead = offer({ vendor: "Unreachable Vendor", url: GONE_URL, verifiedDate: "2026-08-20" });
    const row = rowFor([dead], [], "Unreachable Vendor");
    assert.equal(row.verification.verifiedDate, null);
    assert.equal(row.verification.lastReachable, "2026-05-01");
    const line = renderRow(row);
    assert.match(line, /link last resolved 2026-05-01/);
    assert.match(line, /read from .* while that link still resolved:/);
    assert.ok(!line.includes("2026-08-20"), "the withheld verification date is published anyway");
  });

  it("says when a record is older than the re-read interval", () => {
    const old = offer({ vendor: "Unread Since Vendor", verifiedDate: "2026-05-01" });
    const row = rowFor([old], [], "Unread Since Vendor");
    assert.deepEqual(row.caveats.map(c => c.kind), ["not_re_read"]);
    assert.match(renderRow(row), /not re-read this page since 2026-05-01/);
    assert.match(renderRow(row), /70-day re-read interval/);
  });

  it("says nothing about a re-read interval a record is inside", () => {
    const fresh = offer({ vendor: "Fresh Vendor", verifiedDate: "2026-09-08" });
    assert.deepEqual(rowFor([fresh], [], "Fresh Vendor").caveats, []);
  });

  it("names which rule withheld a rating, not merely that one did", () => {
    const paid = offer({ vendor: "Metered Vendor", tier: "Pay-as-you-go" });
    const unread = offer({
      vendor: "Unread Vendor",
      source_check: { checked: "2026-09-05", outcome: "unreadable", detail: "HTTP 403" },
    });
    const census = readmeCensus(readmeRows([paid, unread], [], CONTEXT));
    assert.deepEqual(census.withheldByReason, { "gate:not_a_free_offer": 1, unreadable: 1 });
    assert.match(generateReadme([paid, unread], [], CONTEXT), /`gate:not_a_free_offer` 1/);
  });

  it("counts the caveats it published in the file itself", () => {
    const census = readmeCensus(rows);
    assert.match(rendered, new RegExp(`\\| Carrying a caveat about our own reading \\| ${census.caveated} \\|`));
    assert.match(rendered, new RegExp(`${census.withheld} of ${census.rows} `));
  });
});

describe("a record whose terms were superseded shows what they replaced", () => {
  it("shows the prior terms and the date they stopped being current", () => {
    const superseded = rows.filter(r => r.prior !== null);
    const expected = publishedRecords.filter(o => {
      const forVendor = catalogueChanges.filter(c => c.vendor.toLowerCase() === o.vendor.toLowerCase());
      const superseding = supersedingChange(o, forVendor);
      return Boolean(superseding && (superseding.previous_state ?? "").trim());
    });
    assert.equal(superseded.length, expected.length);
    assert.ok(superseded.length > 0, "the catalogue holds records whose stored terms are superseded");
    for (const row of superseded) {
      const line = renderRow(row);
      assert.ok(line.includes(`**Until ${row.prior!.until}, our record read:**`), row.vendor);
      assert.ok(line.includes(row.prior!.text.slice(0, 40).replace(/\|/g, "\\|")), row.vendor);
    }
  });

  it("quotes the newer reading from the change record's own source", () => {
    const vendor = "Superseded Vendor";
    const stored = offer({ vendor, description: "Free tier with 1,000 requests/month" });
    const narrowing = change({
      vendor,
      date: "2026-08-14",
      previous_state: "Free tier with 1,000 requests/month",
      current_state: "Free tier with 100 requests/month",
      source_url: "https://example.com/new-pricing",
      recorded_date: "2026-08-15",
    });
    const row = rowFor([stored], [narrowing], vendor);
    assert.equal(row.terms.quoted, true);
    assert.equal(row.terms.text, "Free tier with 100 requests/month");
    assert.equal(row.terms.as_of, "2026-08-15");
    assert.deepEqual(row.prior, { text: "Free tier with 1,000 requests/month", until: "2026-08-14" });
    const line = renderRow(row);
    assert.match(line, /As of 2026-08-15, .*example\.com\/new-pricing.* reads: Free tier with 100 requests\/month/);
    assert.match(line, /\*\*Until 2026-08-14, our record read:\*\* Free tier with 1,000 requests\/month/);
  });

  it("says a record is ours where no change record has superseded it", () => {
    const row = rowFor([offer({ vendor: "Unsuperseded Vendor" })], [], "Unsuperseded Vendor");
    assert.equal(row.terms.quoted, false);
    assert.equal(row.prior, null);
    assert.match(renderRow(row), /Our record, read from .*example\.com\/pricing.* on 2026-09-01:/);
  });
});

describe("the file states the rules a reader can check a row against", () => {
  it("publishes every tier rule the classifier applies", () => {
    for (const rule of [...NOT_FREE_TIER_RULES, ...TIME_LIMITED_TIER_RULES]) {
      assert.ok(rendered.includes(`\`${rule.pattern.source}\``), rule.pattern.source);
      assert.ok(rendered.includes(rule.note), rule.note);
    }
  });

  it("publishes every change type the catalogue can record, under its direction", () => {
    for (const changeType of Object.keys(CHANGE_KIND_NOUN)) {
      assert.ok(rendered.includes(`\`${changeType}\``), changeType);
    }
  });

  it("says the order is not a ranking", () => {
    const vendors = rows.map(r => r.vendor);
    assert.deepEqual(vendors, [...vendors].sort((a, b) => a.localeCompare(b, "en")));
    assert.match(rendered, /not a ranking/);
  });

  it("sends a reader to the record behind every row", () => {
    for (const row of rows) {
      assert.ok(renderRow(row).includes(`/vendor/${row.slug})`), row.vendor);
    }
  });
});
