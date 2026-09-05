import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  quotesTheStoredTermsAsPrevious,
  supersedingChange,
  storedTermsAreSuperseded,
} = await import("../dist/superseded-description.js");
const { toSlug } = await import("../dist/slug.js");
const { qualityBudget } = await import("../dist/page-reviews.js");
const { supersededCensus } = await import("../dist/superseded-census.js");
const { utcDate } = await import("../dist/ranking.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const changes: DealChange[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"),
).changes;

const A_RUN_MAY_RAISE_IT =
  "The daily re-verification run raises this by reading pages, and lowers it by correcting a " +
  "record, so scripts/ratchet-quality-budgets.js writes what it measures into " +
  "data/quality_budgets.json in the same commit as the data. Nothing else may raise it.";

const changesByVendor = new Map<string, DealChange[]>();
for (const change of changes) {
  const key = change.vendor.toLowerCase();
  const held = changesByVendor.get(key);
  if (held) held.push(change);
  else changesByVendor.set(key, [change]);
}

function changesFor(vendor: string): DealChange[] {
  return changesByVendor.get(vendor.toLowerCase()) ?? [];
}

function supersededRecords(): { offer: Offer; change: DealChange }[] {
  const found: { offer: Offer; change: DealChange }[] = [];
  for (const offer of offers) {
    const change = supersedingChange(offer, changesFor(offer.vendor));
    if (change) found.push({ offer, change });
  }
  return found;
}

function firstRecordFor(vendor: string): Offer {
  return offers.find((o) => o.vendor === vendor)!;
}

function supersededPagesRender(): { offer: Offer; change: DealChange }[] {
  return supersededRecords().filter(({ offer }) => firstRecordFor(offer.vendor) === offer);
}

const A_RECORD = {
  vendor: "Quotacorp",
  category: "Cloud Hosting",
  description: "Free plan: 100 GB egress, 1 GiB storage, 5 projects",
  tier: "Free",
  url: "https://quotacorp.example/pricing",
  tags: ["hosting"],
  verifiedDate: "2026-08-01",
};

const A_CHANGE_QUOTING_IT = {
  vendor: "Quotacorp",
  change_type: "limits_reduced",
  date: "2026-08-28",
  date_source: "discovered",
  summary: "Egress on the free plan is now 20 GiB, down from 100 GB.",
  previous_state: A_RECORD.description,
  current_state: "Free plan: 20 GiB egress, 1 GiB storage, 5 projects",
  impact: "high",
  source_url: "https://quotacorp.example/pricing",
  category: "Cloud Hosting",
  alternatives: [],
};

describe("#1103 a change record that quotes our stored terms as the previous ones", () => {
  it("recognises the quote", () => {
    assert.strictEqual(quotesTheStoredTermsAsPrevious(A_CHANGE_QUOTING_IT, A_RECORD.description), true);
  });

  it("reads through whitespace and case, which the detector does not preserve", () => {
    const reflowed = { ...A_CHANGE_QUOTING_IT, previous_state: "  free plan: 100 GB egress,\n 1 GiB storage,  5 projects " };
    assert.strictEqual(quotesTheStoredTermsAsPrevious(reflowed, A_RECORD.description), true);
  });

  it("does not fire on a change that quotes nothing", () => {
    for (const empty of [undefined, null, "", "   "]) {
      assert.strictEqual(
        quotesTheStoredTermsAsPrevious({ ...A_CHANGE_QUOTING_IT, previous_state: empty }, A_RECORD.description),
        false,
        `previous_state ${JSON.stringify(empty)} must not match`,
      );
    }
  });

  it("does not let a record with no stored terms be superseded by a change that quotes none", () => {
    const blank = { ...A_RECORD, description: "   " };
    const quotingNothing = { ...A_CHANGE_QUOTING_IT, previous_state: "" };
    assert.strictEqual(storedTermsAreSuperseded(blank, [quotingNothing]), false);
    assert.ok(
      changes.filter((c) => !(c.previous_state ?? "").trim()).length > 50,
      "too few changes quote nothing for that guard to be worth holding",
    );
  });

  it("does not fire on a change that quotes part of the stored terms", () => {
    const head = A_RECORD.description.slice(0, 30);
    assert.ok(head.length > 20 && A_RECORD.description.startsWith(head));
    assert.strictEqual(storedTermsAreSuperseded(A_RECORD, [{ ...A_CHANGE_QUOTING_IT, previous_state: head }]), false);
    const extended = { ...A_RECORD, description: `${A_RECORD.description}, 2 seats` };
    assert.strictEqual(storedTermsAreSuperseded(extended, [A_CHANGE_QUOTING_IT]), false);
  });

  it("does not fire once the record carries what the change says replaced the terms", () => {
    const applied = { ...A_RECORD, description: A_CHANGE_QUOTING_IT.current_state };
    assert.strictEqual(storedTermsAreSuperseded(applied, [A_CHANGE_QUOTING_IT]), false);
  });

  it("stops firing when the change is resolved, which is the way back", () => {
    const retracted = {
      ...A_CHANGE_QUOTING_IT,
      resolution: { state: "retracted", date: "2026-09-05", detail: "The plan table still lists 100 GB." },
    };
    assert.strictEqual(storedTermsAreSuperseded(A_RECORD, [retracted]), false);
  });

  it("takes the newest of several", () => {
    const older = { ...A_CHANGE_QUOTING_IT, date: "2026-08-02" };
    const newer = { ...A_CHANGE_QUOTING_IT, date: "2026-09-04" };
    assert.strictEqual(supersedingChange(A_RECORD, [newer, older])?.date, "2026-09-04");
    assert.strictEqual(supersedingChange(A_RECORD, [older, newer])?.date, "2026-09-04");
  });
});

describe("#1103 the catalogue population", () => {
  it("holds no more records than the recorded count, so a widening has to be looked at", () => {
    const budget = qualityBudget("records_with_superseded_terms");
    const measured = supersededRecords().length;
    assert.ok(
      measured <= budget,
      `${measured} records hold terms a change record supersedes, over the ${budget} recorded in ` +
        `data/quality_budgets.json. ${A_RUN_MAY_RAISE_IT}`,
    );
  });

  it("holds no more vendor pages than the recorded count, which is smaller where the vendor has a second record", () => {
    const budget = qualityBudget("vendor_pages_withholding_superseded_terms");
    const measured = supersededPagesRender().length;
    assert.ok(
      measured <= budget,
      `${measured} vendor pages render a superseded record, over the ${budget} recorded in ` +
        `data/quality_budgets.json. ${A_RUN_MAY_RAISE_IT}`,
    );
  });

  it("measures the same population the ratchet writes the budget from", () => {
    const census = supersededCensus(offers, changes, utcDate());
    assert.strictEqual(census.records_with_superseded_terms, supersededRecords().length);
    assert.strictEqual(census.vendor_pages_withholding_superseded_terms, supersededPagesRender().length);
  });

  it("puts one more record over the ceiling every run leaves behind", () => {
    const today = utcDate();
    const atRest = supersededCensus(offers, changes, today).records_with_superseded_terms;
    assert.ok(atRest <= qualityBudget("records_with_superseded_terms"));

    const untouched = offers.find((o) => !supersedingChange(o, changesFor(o.vendor)))!;
    const joining = {
      ...A_CHANGE_QUOTING_IT,
      vendor: untouched.vendor,
      previous_state: untouched.description,
    } as DealChange;

    const grown = supersededCensus(offers, [...changes, joining], today).records_with_superseded_terms;
    assert.strictEqual(grown, atRest + 1);
    assert.ok(!(grown <= atRest), `${grown} passed a ceiling of ${atRest}`);
  });

  it("keeps a record correction under the ceiling, which is the only exit a data pull request has", () => {
    const today = utcDate();
    const budget = qualityBudget("records_with_superseded_terms");
    const atRest = supersededCensus(offers, changes, today).records_with_superseded_terms;
    const { offer } = supersededRecords()[0];
    const corrected = offers.map((o) =>
      o === offer ? { ...o, description: `${o.description}, re-read on ${today}` } : o,
    );

    const after = supersededCensus(corrected, changes, today).records_with_superseded_terms;
    assert.strictEqual(after, atRest - 1);
    assert.ok(after <= budget, "correcting a record must not go red");
  });

  it("finds one superseding change per record, so no page has to choose between two", () => {
    for (const offer of offers) {
      const quoting = changesFor(offer.vendor).filter(
        (c) => !c.resolution && quotesTheStoredTermsAsPrevious(c, offer.description),
      );
      assert.ok(quoting.length <= 1, `${offer.vendor} has ${quoting.length} changes quoting its stored terms`);
    }
  });
});

describe("#1383 which of the two directions holds a scheduled data commit", () => {
  const CENSUS = [
    "records_with_superseded_terms",
    "vendor_pages_withholding_superseded_terms",
    "ungated_pages_withholding_superseded_terms",
  ] as const;

  it("names the three counts a data run may raise, and no others", async () => {
    const { QUALITY_BUDGETS_A_DATA_RUN_MAY_RAISE, QUALITY_BUDGET_NAMES } = await import("../dist/page-reviews.js");
    assert.deepStrictEqual([...QUALITY_BUDGETS_A_DATA_RUN_MAY_RAISE], [...CENSUS]);
    for (const name of CENSUS) assert.ok(QUALITY_BUDGET_NAMES.includes(name), `${name} is not a budget`);
  });

  it("writes a rise in one of the three rather than reporting it over budget", async () => {
    const { ratchet } = await import("../scripts/ratchet-quality-budgets.js");
    const budgets = { records_with_superseded_terms: 237, stale_fact_pages: 57 };
    const { next, raised, over } = ratchet(budgets, { records_with_superseded_terms: 263, stale_fact_pages: 57 });
    assert.strictEqual(next.records_with_superseded_terms, 263);
    assert.deepStrictEqual(raised, [{ name: "records_with_superseded_terms", from: 237, to: 263 }]);
    assert.deepStrictEqual(over, []);
  });

  it("still reports a rise in a budget outside the three, so that one holds the commit", async () => {
    const { ratchet } = await import("../scripts/ratchet-quality-budgets.js");
    const budgets = { records_with_superseded_terms: 237, stale_fact_pages: 57 };
    const { next, raised, over } = ratchet(budgets, { records_with_superseded_terms: 237, stale_fact_pages: 58 });
    assert.strictEqual(next.stale_fact_pages, 57);
    assert.deepStrictEqual(raised, []);
    assert.deepStrictEqual(over, [{ name: "stale_fact_pages", budget: 57, measured: 58 }]);
  });

  it("lowers one of the three the same way every other budget is lowered", async () => {
    const { ratchet } = await import("../scripts/ratchet-quality-budgets.js");
    const budgets = { records_with_superseded_terms: 237 };
    const { next, lowered, raised } = ratchet(budgets, { records_with_superseded_terms: 235 });
    assert.strictEqual(next.records_with_superseded_terms, 235);
    assert.deepStrictEqual(lowered, [{ name: "records_with_superseded_terms", from: 237, to: 235 }]);
    assert.deepStrictEqual(raised, []);
  });

  it("measures the three from the shipped data under the ceilings the shipped budgets hold", async () => {
    const { measureBudgets } = await import("../scripts/ratchet-quality-budgets.js");
    const measured = measureBudgets(utcDate());
    for (const name of CENSUS) {
      assert.ok(
        measured[name] <= qualityBudget(name),
        `the ratchet measures ${name} at ${measured[name]}, over the ${qualityBudget(name)} it holds`,
      );
    }
  });

  it("leaves no equality assertion pinning the population in either direction", () => {
    const pinned = /assert\.strictEqual\([^)]*(SUPERSEDED|WITHHOLDING|RENDERING)/;
    for (const file of ["superseded-terms.test.ts", "gated-vendor-answers.test.ts"]) {
      const source = readFileSync(path.join(REPO, "test", file), "utf-8");
      assert.ok(!pinned.test(source), `${file} still pins the population with an equality assertion`);
    }
  });
});

const FIXTURE_VENDOR = "Deno Deploy";
const FIXTURE_SLUG = toSlug(FIXTURE_VENDOR);

function fixtureFrom(withResolution: boolean) {
  const record = JSON.parse(JSON.stringify(offers.find((o) => o.vendor === FIXTURE_VENDOR)));
  const change = JSON.parse(JSON.stringify(changes.find((c) => c.vendor === FIXTURE_VENDOR)));
  assert.ok(record && change, "the fixture is built from the record and change this issue names");
  record.description = change.previous_state;
  if (withResolution) {
    change.resolution = { state: "reversed", date: "2026-09-04", detail: "The vendor restored the earlier limits." };
  }
  return { record, change };
}

function writeFixture(dir: string, name: string, withResolution: boolean) {
  const { record, change } = fixtureFrom(withResolution);
  writeFileSync(path.join(dir, `${name}-index.json`), JSON.stringify({ offers: [record, ...offers.filter((o) => o.vendor !== FIXTURE_VENDOR)] }));
  writeFileSync(path.join(dir, `${name}-changes.json`), JSON.stringify({ changes: [change] }));
  return { record, change };
}

function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", ...env },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ proc: child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function jsonLdOfType(html: string, type: string): Record<string, any> | undefined {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed["@type"] === type) return parsed;
    } catch { continue; }
  }
  return undefined;
}

function metaDescriptionOf(html: string): string {
  return /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "";
}

function descriptionBlockOf(html: string): string {
  return /<div class="desc-block">[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
}

function faqAnswersOf(html: string): { question: string; answer: string }[] {
  const faq = jsonLdOfType(html, "FAQPage");
  return (faq?.mainEntity ?? []).map((item: { name: string; acceptedAnswer: { text: string } }) => ({
    question: item.name,
    answer: item.acceptedAnswer.text,
  }));
}

function unescaped(html: string): string {
  return html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

describe("#1103 a page whose stored terms its own change log quotes as previous", () => {
  let dir = "";
  let superseded: { proc: ChildProcess; port: number } | null = null;
  let resolved: { proc: ChildProcess; port: number } | null = null;
  let supersededPage = "";
  let resolvedPage = "";
  let storedTerms = "";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "superseded-terms-"));
    const built = writeFixture(dir, "superseded", false);
    writeFixture(dir, "resolved", true);
    storedTerms = built.record.description;
    [superseded, resolved] = await Promise.all([
      startServer({
        AGENTDEALS_INDEX_PATH: path.join(dir, "superseded-index.json"),
        AGENTDEALS_CHANGES_PATH: path.join(dir, "superseded-changes.json"),
      }),
      startServer({
        AGENTDEALS_INDEX_PATH: path.join(dir, "resolved-index.json"),
        AGENTDEALS_CHANGES_PATH: path.join(dir, "resolved-changes.json"),
      }),
    ]);
    supersededPage = await fetch(`http://localhost:${superseded.port}/vendor/${FIXTURE_SLUG}`).then((r) => r.text());
    resolvedPage = await fetch(`http://localhost:${resolved.port}/vendor/${FIXTURE_SLUG}`).then((r) => r.text());
  });

  after(() => {
    superseded?.proc.kill();
    resolved?.proc.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("builds a fixture whose stored terms are the change's previous_state", () => {
    const { record, change } = fixtureFrom(false);
    assert.strictEqual(record.description, change.previous_state);
    assert.notStrictEqual(change.previous_state, change.current_state);
    assert.ok(storedTerms.length > 60, "the stored terms must be long enough for the assertions below to bite");
  });

  it("does not state the stored terms in the description block", () => {
    assert.ok(!unescaped(descriptionBlockOf(supersededPage)).includes(storedTerms));
  });

  it("does not state the stored terms in the meta description", () => {
    const meta = unescaped(metaDescriptionOf(supersededPage));
    assert.ok(!meta.includes(storedTerms.slice(0, 60)), meta);
    assert.ok(meta.includes("superseded by a pricing change we recorded on"), meta);
  });

  it("offers no upgrade threshold read off terms it will not publish", () => {
    assert.ok(!supersededPage.includes(`class="section growth-section"`), "the page still tells the reader when they outgrow figures it withholds");
    assert.ok(resolvedPage.includes(`class="section growth-section"`), "the same page without the supersession must carry one, or the assertion above is vacuous");
  });

  it("does not state the stored terms in the structured description a machine reads", () => {
    const page = jsonLdOfType(supersededPage, "WebPage");
    assert.ok(page, "the page must ship WebPage structured data for the assertion to mean anything");
    assert.ok(!page!.mainEntity.description.includes(storedTerms));
    assert.ok(!String(page!.description).includes(storedTerms.slice(0, 60)));
  });

  it("does not state the stored terms in any structured answer", () => {
    const stating = faqAnswersOf(supersededPage).filter((pair) => pair.answer.includes(storedTerms.slice(0, 60)));
    assert.deepStrictEqual(stating.map((pair) => pair.question), []);
  });

  it("does not answer that the vendor offers the tier we can no longer stand behind", () => {
    const answers = faqAnswersOf(supersededPage);
    const isFree = answers.find((pair) => pair.question === `Is ${FIXTURE_VENDOR} free?`);
    assert.ok(isFree, "the page must still ask whether the vendor is free");
    assert.ok(!isFree!.answer.startsWith("Yes,"), isFree!.answer);
    assert.ok(isFree!.answer.includes("previous terms"), isFree!.answer);
  });

  it("still names the tier while withholding the figures behind it", () => {
    const tier = faqAnswersOf(supersededPage).find(
      (pair) => pair.question === `What is ${FIXTURE_VENDOR}'s free tier?`,
    );
    assert.ok(tier, "the page must still answer what the tier is called");
    assert.ok(tier!.answer.includes(`is called "Free"`), tier!.answer);
    assert.ok(!tier!.answer.includes(storedTerms.slice(0, 60)), tier!.answer);
  });

  it("does not offer a price of zero to a machine reading the record", () => {
    const page = jsonLdOfType(supersededPage, "WebPage");
    assert.ok(!("offers" in page!.mainEntity), JSON.stringify(page!.mainEntity.offers ?? null));
  });

  it("keeps the terms on the page as what the change record replaced", () => {
    assert.ok(unescaped(supersededPage).includes(storedTerms));
    assert.ok(supersededPage.includes("Before:"));
  });

  it("publishes the same terms as current once the change is resolved", () => {
    assert.ok(unescaped(descriptionBlockOf(resolvedPage)).includes(storedTerms));
    const isFree = faqAnswersOf(resolvedPage).find((pair) => pair.question === `Is ${FIXTURE_VENDOR} free?`);
    assert.ok(isFree!.answer.startsWith("Yes,"), isFree!.answer);
    assert.ok("offers" in jsonLdOfType(resolvedPage, "WebPage")!.mainEntity);
  });
});

describe("#1103 every catalogue record whose stored terms are superseded", () => {
  let server: { proc: ChildProcess; port: number } | null = null;
  const bodies = new Map<string, string>();
  const population = supersededPagesRender();

  before(async () => {
    server = await startServer({});
    const queue = population.map(({ offer }) => `/vendor/${toSlug(offer.vendor)}`);
    let next = 0;
    await Promise.all(
      Array.from({ length: 12 }, async () => {
        while (next < queue.length) {
          const pathname = queue[next++];
          bodies.set(pathname, await fetch(`http://localhost:${server!.port}${pathname}`).then((r) => r.text()));
        }
      }),
    );
  });

  after(() => { server?.proc.kill(); });

  it("renders a page for every one of them", () => {
    assert.strictEqual(bodies.size, population.length);
  });

  it("states the stored terms in no description block", () => {
    const stating = population.filter(({ offer }) =>
      unescaped(descriptionBlockOf(bodies.get(`/vendor/${toSlug(offer.vendor)}`)!)).includes(offer.description),
    );
    assert.deepStrictEqual(stating.map(({ offer }) => offer.vendor), []);
  });

  it("states the stored terms in no structured answer and no structured description", () => {
    const stating: string[] = [];
    for (const { offer, change } of population) {
      const html = bodies.get(`/vendor/${toSlug(offer.vendor)}`)!;
      const opening = offer.description.slice(0, 60);
      const withoutWhatTheChangeItselfSays = (text: string) => text.split(change.summary).join(" ");
      const page = jsonLdOfType(html, "WebPage");
      if (page && String(page.mainEntity?.description ?? "").includes(opening)) stating.push(`${offer.vendor} :: mainEntity`);
      if (page && String(page.description ?? "").includes(opening)) stating.push(`${offer.vendor} :: WebPage`);
      for (const pair of faqAnswersOf(html)) {
        if (withoutWhatTheChangeItselfSays(pair.answer).includes(opening)) stating.push(`${offer.vendor} :: ${pair.question}`);
      }
    }
    assert.deepStrictEqual(stating, []);
  });

  it("offers a price of zero to none of them", () => {
    const offering = population.filter(({ offer }) =>
      "offers" in (jsonLdOfType(bodies.get(`/vendor/${toSlug(offer.vendor)}`)!, "WebPage")?.mainEntity ?? {}),
    );
    assert.deepStrictEqual(offering.map(({ offer }) => offer.vendor), []);
  });

  it("names an upgrade threshold on none of them", () => {
    const telling = population
      .filter(({ offer }) => bodies.get(`/vendor/${toSlug(offer.vendor)}`)!.includes(`class="section growth-section"`))
      .map(({ offer }) => offer.vendor);
    assert.deepStrictEqual(telling.slice(0, 20), []);
  });

  it("says in the meta description of every one why the terms are withheld", () => {
    const silent = population
      .filter(({ offer }) => !metaDescriptionOf(bodies.get(`/vendor/${toSlug(offer.vendor)}`)!).includes("superseded by a pricing change we recorded on"))
      .map(({ offer }) => offer.vendor);
    assert.deepStrictEqual(silent.slice(0, 20), []);
  });
});
