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
  EXCLUSION_RULES,
  README_CATEGORIES,
  README_SUBTYPES,
  README_TAXONOMY,
  excludedByReason,
  generateReadme,
  ratingWord,
  readmeCensus,
  readmeRows,
  readmeSelection,
  renderRow,
} = await import("../dist/llm-api-readme.js");
const { CHANGE_KIND_NOUN } = await import("../dist/vendor-verdict.js");
const { NOT_FREE_TIER_RULES, TIME_LIMITED_TIER_RULES } = await import("../dist/ranking.js");
const { SUBTYPE_TAXONOMIES } = await import("../dist/product-role.js");
const { supersedingChange } = await import("../dist/superseded-description.js");
import type { DealChange, Offer } from "../src/types.ts";

const catalogue: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf8")).offers;
const catalogueChanges: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf8"),
).changes;

const ON = "2026-09-09";
const CONTEXT = { servedOn: ON, nowMs: Date.parse(`${ON}T00:00:00Z`), staleAfterDays: 70 };

const serving = new Set<string>(README_SUBTYPES);
const drawnFrom = new Set<string>(README_CATEGORIES);
const labelsOf = (o: Offer) => (o.product_subtypes ? o.product_subtypes.labels.map(l => l.subtype) : null);
const publishedRecords = catalogue.filter(o => labelsOf(o)?.some(l => serving.has(l)));
const selection = readmeSelection(catalogue, catalogueChanges, CONTEXT);
const rows = selection.rows;
const rendered = generateReadme(catalogue, catalogueChanges, CONTEXT);

function labelled(subtype: string) {
  return {
    taxonomy: README_TAXONOMY,
    labels: [{ subtype, source_url: "https://example.com/docs", source_quote: "serves models behind an API" }],
    reviewed: "2026-09-01",
  };
}

function offer(overrides: Partial<Offer>): Offer {
  return {
    vendor: "Fixture Vendor",
    category: "AI / ML",
    description: "Free tier with 1,000 requests/month and one seat",
    tier: "Free",
    url: "https://example.com/pricing",
    tags: ["ai"],
    verifiedDate: "2026-09-01",
    product_subtypes: labelled("llm_api"),
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
  it("publishes a record labelled with a serving subtype, and no record without one", () => {
    const published = new Set(rows.map(r => `${r.vendor}|${r.tier}`));
    const eligible = publishedRecords.map(o => `${o.vendor}|${o.tier}`);
    const leftOut = new Set(selection.excluded.map(e => `${e.vendor}|${e.tier}`));
    assert.ok(eligible.length > 0, "the catalogue holds records carrying a serving subtype");
    for (const key of eligible) {
      assert.ok(published.has(key) || leftOut.has(key), `${key} is neither published nor accounted for`);
    }
    for (const row of rows) {
      const record = catalogue.find(o => o.vendor === row.vendor && o.tier === row.tier);
      assert.ok(labelsOf(record!)?.some(l => serving.has(l)), `${row.vendor} is published carrying no serving label`);
    }
  });

  it("accounts for every record it drew from and did not publish", () => {
    const candidates = catalogue.filter(
      o => drawnFrom.has(o.category) || labelsOf(o)?.some(l => serving.has(l)),
    );
    assert.equal(rows.length + selection.excluded.length, candidates.length);
    const published = new Set(rows.map(r => `${r.vendor}|${r.tier}`));
    for (const left of selection.excluded) {
      assert.ok(!published.has(`${left.vendor}|${left.tier}`), `${left.vendor} is both published and left out`);
    }
  });

  it("selects on subtypes its own taxonomy defines", () => {
    const known = new Set((SUBTYPE_TAXONOMIES[README_TAXONOMY] ?? []).map((e: { subtype: string }) => e.subtype));
    assert.ok(known.size > 0, `${README_TAXONOMY} publishes no taxonomy to select on`);
    for (const subtype of README_SUBTYPES) {
      assert.ok(known.has(subtype), `${subtype} is not a subtype ${README_TAXONOMY} defines`);
    }
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

  it("heads the table with the number of records under it", () => {
    assert.match(rendered, new RegExp(`## The records — ${rows.length}\\n`));
  });
});

describe("the file states the rule that decided what is in it", () => {
  it("publishes the definition of every subtype it selects on", () => {
    for (const subtype of README_SUBTYPES) {
      const entry = (SUBTYPE_TAXONOMIES[README_TAXONOMY] ?? []).find(
        (e: { subtype: string }) => e.subtype === subtype,
      );
      assert.ok(rendered.includes(`\`${subtype}\` — ${entry.definition}`), subtype);
    }
  });

  it("publishes a count and a reason for every record it left out", () => {
    const counts = excludedByReason(selection.excluded);
    for (const [reason, rule] of Object.entries(EXCLUSION_RULES)) {
      assert.ok(rendered.includes(`| \`${reason}\` | ${counts[reason]} | ${rule} |`), reason);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(total, selection.excluded.length, "every excluded record is counted under exactly one reason");
    assert.ok(rendered.includes(`${selection.excluded.length} records there are left out`));
  });

  it("names the records it left out for what their own reading says", () => {
    const named = selection.excluded.filter(e => e.reason === "reading_names_no_price_of_nothing");
    assert.ok(named.length > 0, "the catalogue holds a row whose current reading names no price of nothing");
    for (const record of named) {
      assert.ok(rendered.includes(`**${record.vendor}** (tier \`${record.tier}\`)`), record.vendor);
    }
  });

  it("leaves a labelled record out for its label rather than for its category", () => {
    const observability = offer({ vendor: "Watcher", product_subtypes: labelled("llm_observability") });
    const { rows: built, excluded } = readmeSelection([observability], [], CONTEXT);
    assert.deepEqual(built.map(r => r.vendor), []);
    assert.deepEqual(excluded, [{ vendor: "Watcher", tier: "Free", reason: "another_function" }]);
  });

  it("separates a record read against the taxonomy from one nobody has read", () => {
    const unread = offer({ vendor: "Unread", product_subtypes: undefined });
    const readAndUnmatched = offer({
      vendor: "Unmatched",
      product_subtypes: { taxonomy: README_TAXONOMY, labels: [], reviewed: "2026-09-01" },
    });
    const { excluded } = readmeSelection([unread, readAndUnmatched], [], CONTEXT);
    assert.deepEqual(
      excluded.map(e => `${e.vendor}:${e.reason}`),
      ["Unread:not_read_against_subtypes", "Unmatched:no_subtype_applies"],
    );
  });

  it("publishes a serving record whose category is not one it draws from", () => {
    const elsewhere = offer({ vendor: "Off-Category", category: "Cloud Hosting" });
    const { rows: built, excluded } = readmeSelection([elsewhere], [], CONTEXT);
    assert.deepEqual(built.map(r => r.vendor), ["Off-Category"]);
    assert.deepEqual(excluded, []);
  });

  it("counts no record it never drew from", () => {
    const unrelated = offer({ vendor: "Unrelated", category: "Cloud Hosting", product_subtypes: undefined });
    const { rows: built, excluded } = readmeSelection([unrelated], [], CONTEXT);
    assert.deepEqual(built, []);
    assert.deepEqual(excluded, []);
  });
});

describe("a row whose current reading names no price of nothing is not published under a free-tier title", () => {
  const priced = offer({ vendor: "Priced Vendor", tier: "Free Credits" });
  const priceSheet = change({
    vendor: "Priced Vendor",
    change_type: "terms_superseded",
    date: "2026-08-20",
    summary: "The free tier was replaced by a per-token price sheet",
    current_state: "Input $2.00 / 1M tokens, Output $6.00 / 1M tokens",
    previous_state: priced.description,
    source_url: "https://example.com/pricing",
  });

  it("leaves out a row whose newest reading is a price sheet", () => {
    const { rows: built, excluded } = readmeSelection([priced], [priceSheet], CONTEXT);
    assert.deepEqual(built, []);
    assert.deepEqual(excluded, [
      { vendor: "Priced Vendor", tier: "Free Credits", reason: "reading_names_no_price_of_nothing" },
    ]);
  });

  it("keeps a row whose newest reading states a price of nothing", () => {
    const stillFree = { ...priceSheet, current_state: "Free plan: 1,000 requests/month, then $2.00 / 1M tokens" };
    const { rows: built, excluded } = readmeSelection([priced], [stillFree], CONTEXT);
    assert.deepEqual(built.map(r => r.vendor), ["Priced Vendor"]);
    assert.deepEqual(excluded, []);
  });

  it("reads a recurring credit as a price of nothing rather than as a price sheet", () => {
    const credits = { ...priceSheet, current_state: "Starter Free $20 credits on sign-up with $10 credits every month" };
    const { rows: built } = readmeSelection([priced], [credits], CONTEXT);
    assert.deepEqual(built.map(r => r.vendor), ["Priced Vendor"]);
  });

  it("reads a fraction of a cent as a price rather than as nothing", () => {
    const fractions = { ...priceSheet, current_state: "input token prices range from $0.007 to $0.44 per 1M tokens" };
    const { rows: built } = readmeSelection([priced], [fractions], CONTEXT);
    assert.deepEqual(built, []);
  });

  it("keeps a row whose terms are our own record rather than a newer reading", () => {
    const ours = offer({ vendor: "Our Record", description: "1,000 requests/month and one seat" });
    const { rows: built, excluded } = readmeSelection([ours], [], CONTEXT);
    assert.deepEqual(built.map(r => r.vendor), ["Our Record"]);
    assert.deepEqual(excluded, []);
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
    const behindARow = new Set(rows.map(r => `${r.vendor}|${r.tier}`));
    const expected = publishedRecords.filter(o => {
      if (!behindARow.has(`${o.vendor}|${o.tier}`)) return false;
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
