import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const { loadOffers, loadDealChanges } = await import("../dist/data.js");
const { vendorSlugMap } = await import("../dist/vendor-slug.js");
const { supersedingChange } = await import("../dist/superseded-description.js");
const { discontinuedOnOrBefore } = await import("../dist/product-deprecation.js");
const { utcDate } = await import("../dist/ranking.js");
const { unconfirmedTermsClause, withheldLevelClause } = await import("../dist/source-check.js");
const { termsUnconfirmedBySource, unconfirmedTermsMetaSentence } = await import("../dist/vendor-verdict.js");

type Outcome = "ok" | "states_no_amount" | "does_not_name_vendor" | "states_no_terms" | "unreadable";

interface Subject {
  slug: string;
  vendor: string;
  outcome: Outcome | null;
  verifiedMonth: string;
  termsSuperseded: boolean;
  discontinuedOn: string | null;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(isoDate: string): string {
  const [year, month] = isoDate.split("-");
  return `${MONTHS[parseInt(month, 10) - 1]} ${year}`;
}

const VERIFIED_ASSERTION = new RegExp(`Verified (?:${MONTHS.join("|")}) \\d{4}`);

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function assertedMonth(text: string): string | null {
  const m = text.match(VERIFIED_ASSERTION);
  return m ? m[0].replace("Verified ", "") : null;
}

let subjects: Subject[] = [];
let serverPort = 0;
let proc: ChildProcess | null = null;

function startHttpServer(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

before(async () => {
  const offers = loadOffers();
  const changesByVendor = new Map<string, Array<{ vendor: string }>>();
  for (const change of loadDealChanges() as Array<{ vendor: string }>) {
    const key = change.vendor.toLowerCase();
    const held = changesByVendor.get(key);
    if (held) held.push(change);
    else changesByVendor.set(key, [change]);
  }

  const servedOn = utcDate();
  subjects = [...vendorSlugMap.entries()].flatMap(([slug, vendor]: [string, string]) => {
    const primary = offers.find((o: { vendor: string }) => o.vendor === vendor);
    if (!primary) return [];
    const vendorChanges = changesByVendor.get(vendor.toLowerCase()) ?? [];
    return [{
      slug,
      vendor,
      outcome: (primary.source_check?.outcome ?? null) as Outcome | null,
      verifiedMonth: monthLabel(primary.verifiedDate),
      termsSuperseded: supersedingChange(primary, vendorChanges) !== null,
      discontinuedOn: discontinuedOnOrBefore(vendorChanges, servedOn),
    }];
  });

  assert.ok(subjects.length > 1000, `the catalogue did not load: ${subjects.length} vendors`);
  const started = await startHttpServer();
  proc = started.child;
  serverPort = started.port;
});

after(() => { if (proc) proc.kill(); });

interface Rendered {
  meta: string;
  byline: string;
  verdict: string;
  amountLine: string;
}

let rendered: Map<string, Rendered> | null = null;

function extract(html: string): Rendered {
  return {
    meta: html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "",
    byline: html.match(/<p class="page-meta">([\s\S]*?)<\/p>/)?.[1] ?? "",
    verdict: html.match(/<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "",
    amountLine: html.match(/<p class="amount-unstated-line"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "",
  };
}

async function everyVendorPage(): Promise<Map<string, Rendered>> {
  if (rendered) return rendered;
  const pages = new Map<string, Rendered>();
  let queue = 0;
  const worker = async () => {
    while (queue < subjects.length) {
      const { slug } = subjects[queue++];
      const res = await fetch(`http://localhost:${serverPort}/vendor/${slug}`);
      assert.strictEqual(res.status, 200, `/vendor/${slug} returned ${res.status}`);
      pages.set(slug, extract(await res.text()));
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  rendered = pages;
  return pages;
}

const sourceCheckFailed = (s: Subject) => s.outcome !== null && s.outcome !== "ok";

describe("#1412 the meta description withholds wherever the source check failed", () => {
  it("asserts a verification on no vendor whose cited page did not confirm the terms", async () => {
    const pages = await everyVendorPage();
    const population = subjects.filter(sourceCheckFailed);
    assert.ok(population.length > 700, `only ${population.length} records have a failed source check`);

    const claiming = population.filter(s => assertedMonth(pages.get(s.slug)!.meta) !== null);
    assert.deepStrictEqual(
      claiming.map(s => `${s.slug} [${s.outcome}]`).slice(0, 20),
      [],
      `${claiming.length} of ${population.length} meta descriptions assert a verification the source check did not make`,
    );
  });

  it("publishes in the meta the same withholding the page body publishes", async () => {
    const pages = await everyVendorPage();
    const population = subjects
      .filter(sourceCheckFailed)
      .filter(s => !s.termsSuperseded && s.discontinuedOn === null);
    assert.ok(population.length > 700, `only ${population.length} records to compare surfaces on`);

    const disagreeing: string[] = [];
    let compared = 0;
    for (const subject of population) {
      const page = pages.get(subject.slug)!;
      const clause = unconfirmedTermsClause(subject.outcome as Exclude<Outcome, "ok">);
      const aboutThisVendor = clause.replace("this offer", subject.vendor);
      const body = `${page.verdict} ${page.amountLine}`;
      const forms = [clause, capitalise(clause), aboutThisVendor, capitalise(aboutThisVendor)];
      if (!forms.some(form => body.includes(form))) continue;
      compared++;
      if (!page.meta.includes(clause)) disagreeing.push(`${subject.slug} [${subject.outcome}]`);
    }

    assert.ok(compared > 700, `only ${compared} pages state the withholding in the body`);
    assert.deepStrictEqual(
      disagreeing.slice(0, 20),
      [],
      `${disagreeing.length} of ${compared} meta descriptions omit a withholding the body states`,
    );
  });

  it("says a product has been discontinued rather than that its terms are unconfirmed", async () => {
    const pages = await everyVendorPage();
    const population = subjects.filter(sourceCheckFailed).filter(s => s.discontinuedOn !== null);
    assert.ok(population.length > 0, "no discontinued record has a failed source check");

    const wrong: string[] = [];
    for (const subject of population) {
      const meta = pages.get(subject.slug)!.meta;
      if (!meta.includes(`Discontinued ${subject.discontinuedOn}.`)) wrong.push(`${subject.slug}: no discontinuation date`);
      if (meta.includes("Not verified")) wrong.push(`${subject.slug}: withholds as well as discontinues`);
    }
    assert.deepStrictEqual(wrong.slice(0, 20), [], `${wrong.length} of ${population.length} discontinued records`);
  });

  it("leaves the verification claim standing wherever the source check passed", async () => {
    const pages = await everyVendorPage();
    const population = subjects.filter(s => s.outcome === "ok" && !s.termsSuperseded);
    assert.ok(population.length > 600, `only ${population.length} records passed their source check`);

    const wrongMonth: string[] = [];
    const droppedFromTheMeta: string[] = [];
    const withheldWithoutCause: string[] = [];
    let asserting = 0;
    for (const subject of population) {
      const page = pages.get(subject.slug)!;
      const inMeta = assertedMonth(page.meta);
      const inByline = assertedMonth(page.byline);
      if (page.meta.includes("Not verified")) withheldWithoutCause.push(subject.slug);
      if (inByline !== null && inMeta === null) droppedFromTheMeta.push(subject.slug);
      if (inMeta === null) continue;
      asserting++;
      if (inMeta !== subject.verifiedMonth) {
        wrongMonth.push(`${subject.slug}: meta says ${inMeta}, the record says ${subject.verifiedMonth}`);
      }
    }

    assert.ok(asserting > 550, `only ${asserting} passing records still carry a verification month`);
    assert.deepStrictEqual(withheldWithoutCause.slice(0, 20), [], `${withheldWithoutCause.length} passing records withhold`);
    assert.deepStrictEqual(droppedFromTheMeta.slice(0, 20), [], `${droppedFromTheMeta.length} meta descriptions dropped a month the byline still states`);
    assert.deepStrictEqual(wrongMonth.slice(0, 20), [], `${wrongMonth.length} meta descriptions state a month the record does not`);
  });
});

describe("#1412 the withholding predicate is the one the badge and the body read", () => {
  it("answers only for the outcomes that leave the terms unconfirmed", () => {
    const base = { vendor: "Example", level: null, cause: null, changes: [], levelWithheld: null, unconfirmableSince: "" };
    assert.strictEqual(termsUnconfirmedBySource({ ...base, sourceCheck: "ok" }), null);
    assert.strictEqual(termsUnconfirmedBySource({ ...base, sourceCheck: null }), null);
    assert.strictEqual(termsUnconfirmedBySource(base), null);
    for (const outcome of ["states_no_amount", "does_not_name_vendor", "states_no_terms", "unreadable"] as const) {
      assert.strictEqual(termsUnconfirmedBySource({ ...base, sourceCheck: outcome }), outcome);
    }
  });

  it("quotes the body's own clause for every outcome the level rules also cover", () => {
    for (const reason of ["does_not_name_vendor", "states_no_terms", "unreadable"] as const) {
      assert.strictEqual(unconfirmedTermsClause(reason), withheldLevelClause(reason));
    }
  });

  it("gives each outcome a sentence a reader can tell apart from the others", () => {
    const outcomes = ["states_no_amount", "does_not_name_vendor", "states_no_terms", "unreadable"] as const;
    const sentences = outcomes.map(o => unconfirmedTermsMetaSentence(o));
    assert.strictEqual(new Set(sentences).size, outcomes.length);
    for (const sentence of sentences) {
      assert.ok(sentence.startsWith("Not verified"), sentence);
      assert.ok(sentence.endsWith("."), sentence);
      assert.strictEqual(assertedMonth(sentence), null, sentence);
      assert.ok(sentence.length <= 90, `${sentence.length} characters: ${sentence}`);
    }
  });
});
