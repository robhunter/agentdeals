import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertSharesPopulation, vendorsInTheCatalogue } from "./population-floor.ts";
import { loadDealChanges, loadOffers, refusalsForVendor } from "../dist/data.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import { utcDate } from "../dist/ranking.js";
import { vendorVerdictContextFrom } from "../dist/vendor-verdict-input.js";
import {
  badgeWithholding,
  termsNotVerifiedMetaSentence,
  whyWeCannotConfirmTheseTerms,
  withholdingTag,
  withholdsTheTerms,
  WITHHOLDING_BADGE_LABELS,
  WITHHOLDING_SCOPE,
  type VendorVerdictInput,
} from "../dist/vendor-verdict.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const WITHHOLDING_TAGS = Object.keys(WITHHOLDING_SCOPE) as Array<keyof typeof WITHHOLDING_SCOPE>;
const TAGS_THAT_WITHHOLD_THE_TERMS = WITHHOLDING_TAGS.filter(tag => WITHHOLDING_SCOPE[tag] === "the_terms");

interface AssertiveSurface {
  name: string;
  asserts: (page: Page) => boolean;
}

interface Page {
  slug: string;
  vendor: string;
  category: string;
  html: string;
  faq: Map<string, string>;
  meta: string;
  tag: string | null;
  unconfirmed: { sentence: string } | null;
}

const A_MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
const A_BARE_VERIFICATION = new RegExp(`(?<!Not )Verified ${A_MONTH} \\d{4}\\.`);

const SURFACES: AssertiveSurface[] = [
  {
    name: "the structured-data answer to whether the vendor is free states the terms flat",
    asserts: (page) => (page.faq.get(`Is ${page.vendor} free?`) ?? "").startsWith("Yes, "),
  },
  {
    name: "the structured-data answer naming the free tier states it flat",
    asserts: (page) => (page.faq.get(`What is ${page.vendor}'s free tier?`) ?? "")
      .includes(`${page.vendor}'s free tier is called "`),
  },
  {
    name: "the visible question-and-answer block states the terms flat",
    asserts: (page) => page.html.includes(`Yes, ${page.vendor} offers a free tier`),
  },
  {
    name: "the meta description states the terms as verified",
    asserts: (page) => A_BARE_VERIFICATION.test(page.meta),
  },
  {
    name: "the opening verdict recommends the offer for a workload",
    asserts: (page) => page.html.includes(`Best for ${page.category.toLowerCase()} workloads`),
  },
];

let serverPort = 0;
let proc: ChildProcess | null = null;
let pages: Page[] = [];

function startHttpServer(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

function faqAnswersIn(html: string): Map<string, string> {
  const answers = new Map<string, string>();
  for (const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let parsed: { "@type"?: string; mainEntity?: Array<{ name?: string; acceptedAnswer?: { text?: string } }> };
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      continue;
    }
    if (parsed["@type"] !== "FAQPage") continue;
    for (const entry of parsed.mainEntity ?? []) {
      if (entry.name) answers.set(entry.name, entry.acceptedAnswer?.text ?? "");
    }
  }
  return answers;
}

const metaDescriptionIn = (html: string): string =>
  html.match(/<meta name="description" content="([\s\S]*?)">/)?.[1] ?? "";

function inputWith(over: Partial<VendorVerdictInput>): VendorVerdictInput {
  return {
    vendor: "Vendor A",
    tier: "Free",
    level: "stable",
    historyLevel: "stable",
    cause: null,
    changes: [],
    levelWithheld: null,
    unconfirmableSince: "",
    termsConfirmedOn: "2026-08-01",
    refusedReads: [],
    ...over,
  };
}

before(async () => {
  const offers = loadOffers();
  const changes = loadDealChanges();
  const servedOn = utcDate();
  const offersByVendor = new Map<string, typeof offers>();
  for (const offer of offers) {
    const held = offersByVendor.get(offer.vendor);
    if (held) held.push(offer);
    else offersByVendor.set(offer.vendor, [offer]);
  }
  const changesByVendor = new Map<string, typeof changes>();
  for (const change of changes) {
    const key = change.vendor.toLowerCase();
    const held = changesByVendor.get(key);
    if (held) held.push(change);
    else changesByVendor.set(key, [change]);
  }

  const subjects = [...vendorSlugMap.entries()].flatMap(([slug, vendor]: [string, string]) => {
    const context = vendorVerdictContextFrom({
      vendor,
      vendorOffers: offersByVendor.get(vendor) ?? [],
      vendorChanges: changesByVendor.get(vendor.toLowerCase()) ?? [],
      refusedReads: refusalsForVendor(vendor),
      servedOn,
    });
    if (!context) return [];
    const because = badgeWithholding(context.input);
    return [{
      slug,
      vendor,
      category: context.primary.category,
      tag: because ? withholdingTag(because) : null,
      unconfirmed: whyWeCannotConfirmTheseTerms(context.input),
    }];
  });

  const started = await startHttpServer();
  proc = started.child;
  serverPort = started.port;

  const read: Page[] = [];
  let queue = 0;
  const worker = async () => {
    while (queue < subjects.length) {
      const subject = subjects[queue++];
      const res = await fetch(`http://localhost:${serverPort}/vendor/${subject.slug}`);
      assert.strictEqual(res.status, 200, `/vendor/${subject.slug} returned ${res.status}`);
      const html = await res.text();
      read.push({ ...subject, html, faq: faqAnswersIn(html), meta: metaDescriptionIn(html) });
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  pages = read;
});

after(() => { if (proc) proc.kill(); });

describe("a withholding we publish reaches every surface that states the terms", () => {
  it("states the terms nowhere on a page whose withholding says we could not read them", () => {
    const asserting: string[] = [];
    const cells: Record<string, number> = {};
    for (const tag of TAGS_THAT_WITHHOLD_THE_TERMS) {
      const population = pages.filter(page => page.tag === tag);
      cells[tag] = population.length;
      for (const surface of SURFACES) {
        for (const page of population.filter(page => surface.asserts(page))) {
          asserting.push(`${tag} × ${surface.name} — /vendor/${page.slug}`);
        }
      }
    }
    assert.deepStrictEqual(
      asserting.slice(0, 25),
      [],
      `a page states the terms under a withholding that says we could not read them:\n${asserting.slice(0, 25).join("\n")}\npages per withholding: ${JSON.stringify(cells)}`,
    );
    assertCoversPopulation(pages.length, vendorsInTheCatalogue(), "vendor pages read for a surface that states the terms");
  });

  it("reads a live population under every withholding it covers", () => {
    const covered = pages.filter(page => page.tag !== null && TAGS_THAT_WITHHOLD_THE_TERMS.includes(page.tag as never));
    assertSharesPopulation(
      covered.length,
      vendorsInTheCatalogue(),
      0.2,
      "vendor pages whose withholding says we could not read the terms",
    );
    const empty = TAGS_THAT_WITHHOLD_THE_TERMS.filter(tag => !pages.some(page => page.tag === tag));
    assert.ok(
      empty.length < TAGS_THAT_WITHHOLD_THE_TERMS.length,
      `no page carries any of the withholdings this sweep covers: ${empty.join(", ")}`,
    );
  });

  it("still states the terms on a page carrying no withholding at all", () => {
    const stating = pages.filter(page => page.tag === null && SURFACES.some(surface => surface.asserts(page)));
    assertSharesPopulation(
      stating.length,
      vendorsInTheCatalogue(),
      0.2,
      "vendor pages that state the terms with nothing withheld",
    );
  });

  it("opens the answer with the reason the page gives for withholding", () => {
    const carrying = pages.filter(page => {
      const unconfirmed = page.unconfirmed;
      if (!unconfirmed) return false;
      return (page.faq.get(`Is ${page.vendor} free?`) ?? "")
        .includes(`We cannot confirm that today. ${unconfirmed.sentence} `);
    });
    assertSharesPopulation(
      carrying.length,
      vendorsInTheCatalogue(),
      0.3,
      "vendor pages opening the free-tier answer with the reason they withhold",
    );
    const refused = pages.filter(page => page.unconfirmed && page.tag !== null
      && ["read_not_reconciled", "change_measured_no_difference"].includes(page.tag));
    const silent = refused.filter(page => !(page.faq.get(`Is ${page.vendor} free?`) ?? "")
      .includes(page.unconfirmed!.sentence)).map(page => page.slug);
    assert.deepStrictEqual(
      silent.slice(0, 20),
      [],
      `${silent.length} of ${refused.length} answers name no day for the read they withhold on`,
    );
  });

  it("names the day of the refused read wherever it withholds the terms", () => {
    const refused = inputWith({ refusedReads: [{ reason: "measures_no_change", refused_date: "2026-09-01" }] });
    const unconfirmed = whyWeCannotConfirmTheseTerms(refused);
    assert.ok(unconfirmed, "a refused read withholds nothing");
    assert.strictEqual(unconfirmed.because.reason, "change_measured_no_difference");
    assert.match(unconfirmed.sentence, /When we last read the page we cite for Vendor A, on 2026-09-01/);
    assert.match(unconfirmed.clause, /when we last read the page we cite for this offer, on 2026-09-01/);
    assert.strictEqual(
      termsNotVerifiedMetaSentence(refused),
      "Not verified — we refused the change we last considered recording, on 2026-09-01.",
    );

    const unreconciled = inputWith({ refusedReads: [{ reason: "unquantified_limit", refused_date: "2026-09-02" }] });
    const second = whyWeCannotConfirmTheseTerms(unreconciled);
    assert.ok(second, "an unreconciled read withholds nothing");
    assert.strictEqual(second.because.reason, "read_not_reconciled");
    assert.match(second.sentence, /we found a change we could not reconcile with the terms we publish/);
  });

  it("states no verification claim on a page we could confirm and none on one whose page we could not reach", () => {
    assert.strictEqual(termsNotVerifiedMetaSentence(inputWith({})), null);
    assert.strictEqual(
      termsNotVerifiedMetaSentence(inputWith({ levelWithheld: "link_unreachable", linkUnreachable: true })),
      null,
    );
    assert.strictEqual(
      termsNotVerifiedMetaSentence(inputWith({ levelWithheld: "states_no_terms", sourceCheck: "states_no_terms" })),
      "Not verified — the page we cite for this offer states no amount, tier or rate we can read.",
    );
    assert.strictEqual(
      termsNotVerifiedMetaSentence(inputWith({ sourceCheck: "states_no_amount" })),
      "Not verified — the page we cite for this offer names a plan but states no amount.",
    );
  });

  it("keeps the refusal out of a page that was read again and confirmed after it", () => {
    const superseded = inputWith({
      termsConfirmedOn: "2026-09-05",
      refusedReads: [{ reason: "measures_no_change", refused_date: "2026-09-01" }],
    });
    assert.strictEqual(whyWeCannotConfirmTheseTerms(superseded), null);
    assert.strictEqual(termsNotVerifiedMetaSentence(superseded), null);
  });

  it("names a scope for every withholding a page can carry", () => {
    assert.deepStrictEqual(
      Object.keys(WITHHOLDING_BADGE_LABELS).sort(),
      WITHHOLDING_TAGS.slice().sort(),
      "a withholding the badge can name is missing from the scope this sweep reads",
    );
    const unscoped = [...new Set(pages.map(page => page.tag))]
      .filter(tag => tag !== null && !WITHHOLDING_TAGS.includes(tag as never));
    assert.deepStrictEqual(unscoped, [], `a page carries a withholding no scope covers: ${unscoped.join(", ")}`);
    assert.ok(
      TAGS_THAT_WITHHOLD_THE_TERMS.length > 0 && TAGS_THAT_WITHHOLD_THE_TERMS.length < WITHHOLDING_TAGS.length,
      "every withholding was given the same scope, so the scope decides nothing",
    );
    const silent = pages
      .filter(page => page.tag !== null && TAGS_THAT_WITHHOLD_THE_TERMS.includes(page.tag as never))
      .filter(page => page.unconfirmed === null)
      .map(page => `${page.slug} (${page.tag})`);
    assert.deepStrictEqual(
      silent.slice(0, 20),
      [],
      `${silent.length} pages withhold the terms and offer no reason the surfaces can publish`,
    );
  });
});
