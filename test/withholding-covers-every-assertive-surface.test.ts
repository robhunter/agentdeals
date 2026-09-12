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
  levelWithheldReason,
  SOURCE_CHECK_OUTCOMES,
  TERMS_ONLY_OUTCOMES,
} from "../dist/source-check.js";
import { supersededTermsNotice, supersedingChange } from "../dist/superseded-description.js";
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
const OUTCOMES_THAT_LEAVE_THE_TERMS_UNCONFIRMED = SOURCE_CHECK_OUTCOMES.filter(outcome => outcome !== "ok");

interface AssertiveSurface {
  name: string;
  asserts: (page: Page) => boolean;
}

interface Page {
  slug: string;
  vendor: string;
  category: string;
  outcome: string | null;
  html: string;
  faq: Map<string, string>;
  visibleFaq: Map<string, string>;
  meta: string;
  badgeTag: string | null;
  termsTag: string | null;
  caveats: string[];
  unconfirmed: { sentence: string; theReadFoundAFreePlan: boolean } | null;
}

const A_MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
const A_BARE_VERIFICATION = new RegExp(`(?<!Not )Verified ${A_MONTH} \\d{4}\\.`);

function statedFlat(page: Page, answer: string, states: (answer: string) => boolean): boolean {
  return states(answer) && page.caveats.every(caveat => !answer.includes(caveat));
}

const SURFACES: AssertiveSurface[] = [
  {
    name: "the structured-data answer to whether the vendor is free states the terms flat",
    asserts: (page) => statedFlat(
      page,
      page.faq.get(`Is ${page.vendor} free?`) ?? "",
      answer => answer.startsWith("Yes, "),
    ),
  },
  {
    name: "the structured-data answer naming the free tier states it flat",
    asserts: (page) => statedFlat(
      page,
      page.faq.get(`What is ${page.vendor}'s free tier?`) ?? "",
      answer => answer.includes(`${page.vendor}'s free tier is called "`),
    ),
  },
  {
    name: "the visible question-and-answer block states the terms flat",
    asserts: (page) => statedFlat(
      page,
      page.visibleFaq.get(`Is ${page.vendor} free?`) ?? "",
      answer => answer.includes(`Yes, ${page.vendor} offers a free tier`),
    ),
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

const unescaped = (text: string): string => text
  .replace(/&quot;/g, '"')
  .replace(/&gt;/g, ">")
  .replace(/&lt;/g, "<")
  .replace(/&amp;/g, "&");

function visibleFaqAnswersIn(html: string): Map<string, string> {
  const answers = new Map<string, string>();
  const item = /<summary class="faq-q">([\s\S]*?)<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>/g;
  for (const block of html.matchAll(item)) {
    answers.set(unescaped(block[1]), unescaped(block[2]));
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
    const unconfirmed = whyWeCannotConfirmTheseTerms(context.input);
    const superseded = supersedingChange(context.primary, context.vendorChanges);
    return [{
      slug,
      vendor,
      category: context.primary.category,
      outcome: context.primary.source_check?.outcome ?? null,
      badgeTag: because ? withholdingTag(because) : null,
      termsTag: unconfirmed ? withholdingTag(unconfirmed.because) : null,
      caveats: [
        ...(unconfirmed ? [unconfirmed.sentence] : []),
        ...(superseded ? [supersededTermsNotice(vendor, superseded)] : []),
      ],
      unconfirmed,
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
      read.push({
        ...subject,
        html,
        faq: faqAnswersIn(html),
        visibleFaq: visibleFaqAnswersIn(html),
        meta: metaDescriptionIn(html),
      });
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
      const population = pages.filter(page => page.termsTag === tag);
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
    const covered = pages.filter(page => page.termsTag !== null);
    assertSharesPopulation(
      covered.length,
      vendorsInTheCatalogue(),
      0.2,
      "vendor pages whose withholding says we could not read the terms",
    );
    const empty = TAGS_THAT_WITHHOLD_THE_TERMS.filter(tag => !pages.some(page => page.termsTag === tag));
    assert.ok(
      empty.length < TAGS_THAT_WITHHOLD_THE_TERMS.length,
      `no page carries any of the withholdings this sweep covers: ${empty.join(", ")}`,
    );
  });

  it("still states the terms on a page carrying no withholding at all", () => {
    const stating = pages.filter(page => page.termsTag === null && page.badgeTag === null
      && SURFACES.some(surface => surface.asserts(page)));
    assertSharesPopulation(
      stating.length,
      vendorsInTheCatalogue(),
      0.2,
      "vendor pages that state the terms with nothing withheld",
    );
  });

  it("takes a withholding from every source-check outcome that is not a clean read", () => {
    const unclassified = OUTCOMES_THAT_LEAVE_THE_TERMS_UNCONFIRMED.filter(outcome => {
      const input = inputWith({
        sourceCheck: outcome,
        levelWithheld: levelWithheldReason({ source_check: { outcome, checked: "2026-09-01", detail: "" } }, null),
      });
      const unconfirmed = whyWeCannotConfirmTheseTerms(input);
      return unconfirmed === null || !withholdsTheTerms(unconfirmed.because);
    });
    assert.deepStrictEqual(
      unclassified,
      [],
      `a source-check outcome states no reason the surfaces can publish: ${unclassified.join(", ")}`,
    );
    assert.ok(
      OUTCOMES_THAT_LEAVE_THE_TERMS_UNCONFIRMED.length < SOURCE_CHECK_OUTCOMES.length,
      "every source-check outcome leaves the terms unconfirmed, so the outcome decides nothing",
    );

    const silent = pages
      .filter(page => page.outcome !== null && page.outcome !== "ok" && page.unconfirmed === null)
      .map(page => `${page.slug} (${page.outcome})`);
    assert.deepStrictEqual(
      silent.slice(0, 20),
      [],
      `${silent.length} live pages carry a source check that is not a clean read and publish no reason for it`,
    );
    const read = pages.filter(page => page.outcome !== null && page.outcome !== "ok").length;
    assertSharesPopulation(read, vendorsInTheCatalogue(), 0.2, "vendor pages whose source check is not a clean read");
  });

  it("leaves the rating standing where the read found the plan and not the amount", () => {
    const ratedOnAReadWeCouldNotQuantify = TERMS_ONLY_OUTCOMES.filter(outcome => {
      const input = inputWith({ sourceCheck: outcome });
      return badgeWithholding(input) === null && whyWeCannotConfirmTheseTerms(input) !== null;
    });
    assert.deepStrictEqual(
      ratedOnAReadWeCouldNotQuantify,
      TERMS_ONLY_OUTCOMES,
      "an outcome that withholds only the terms is withholding the rating as well",
    );
    assert.ok(TERMS_ONLY_OUTCOMES.length > 0, "no source-check outcome withholds the terms alone");
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
    const refused = pages.filter(page => page.unconfirmed && page.termsTag !== null
      && ["read_not_reconciled", "change_measured_no_difference"].includes(page.termsTag));
    const silent = refused.filter(page => !(page.faq.get(`Is ${page.vendor} free?`) ?? "")
      .includes(page.unconfirmed!.sentence)).map(page => page.slug);
    assert.deepStrictEqual(
      silent.slice(0, 20),
      [],
      `${silent.length} of ${refused.length} answers name no day for the read they withhold on`,
    );
  });

  it("still answers yes where the read found the free plan and could not read the amount", () => {
    const affirming = pages.filter(page => page.unconfirmed?.theReadFoundAFreePlan);
    const answersOf = (page: Page) => [
      page.faq.get(`Is ${page.vendor} free?`) ?? "",
      page.visibleFaq.get(`Is ${page.vendor} free?`) ?? "",
    ];
    const denying = affirming
      .filter(page => answersOf(page).some(answer => answer.includes("We cannot confirm that today.")))
      .map(page => page.slug);
    assert.deepStrictEqual(
      denying.slice(0, 20),
      [],
      `${denying.length} pages say they cannot confirm a free tier their own read found`,
    );
    const uncaveated = affirming
      .filter(page => answersOf(page)
        .some(answer => answer !== "" && page.caveats.every(caveat => !answer.includes(caveat))))
      .map(page => page.slug);
    assert.deepStrictEqual(
      uncaveated.slice(0, 20),
      [],
      `${uncaveated.length} pages state the limits without saying the page we cite does not carry them`,
    );
    assertSharesPopulation(
      affirming.length,
      vendorsInTheCatalogue(),
      0.03,
      "vendor pages whose read found the free plan and not the amount",
    );
    assertSharesPopulation(
      affirming.filter(page => answersOf(page).every(answer => answer.startsWith(`Yes, ${page.vendor} offers`))).length,
      vendorsInTheCatalogue(),
      0.025,
      "vendor pages answering yes over a read that found the plan and not the amount",
    );

    const control = pages.find(page => page.slug === "jsdelivr");
    assert.strictEqual(control?.outcome, "states_no_amount", "/vendor/jsdelivr is no longer the control this was written against");
    for (const answer of answersOf(control)) {
      assert.ok(answer.startsWith("Yes, jsDelivr offers a free tier: Free."), answer.slice(0, 120));
      assert.ok(
        answer.includes("The page we cite for jsDelivr names a plan but states no amount, so these limits come from our own record rather than from that page."),
        answer.slice(0, 400),
      );
    }
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
      WITHHOLDING_TAGS.filter(tag => !(tag in WITHHOLDING_BADGE_LABELS)).sort(),
      TERMS_ONLY_OUTCOMES.slice().sort(),
      "a withholding the badge can name is missing from the scope this sweep reads",
    );
    const unscoped = [...new Set(pages.flatMap(page => [page.badgeTag, page.termsTag]))]
      .filter(tag => tag !== null && !WITHHOLDING_TAGS.includes(tag as never));
    assert.deepStrictEqual(unscoped, [], `a page carries a withholding no scope covers: ${unscoped.join(", ")}`);
    assert.ok(
      TAGS_THAT_WITHHOLD_THE_TERMS.length > 0 && TAGS_THAT_WITHHOLD_THE_TERMS.length < WITHHOLDING_TAGS.length,
      "every withholding was given the same scope, so the scope decides nothing",
    );
    const silent = pages
      .filter(page => page.badgeTag !== null && TAGS_THAT_WITHHOLD_THE_TERMS.includes(page.badgeTag as never))
      .filter(page => page.unconfirmed === null)
      .map(page => `${page.slug} (${page.badgeTag})`);
    assert.deepStrictEqual(
      silent.slice(0, 20),
      [],
      `${silent.length} pages withhold the terms and offer no reason the surfaces can publish`,
    );
    const exempted = pages
      .filter(page => page.termsTag !== null)
      .filter(page => !TAGS_THAT_WITHHOLD_THE_TERMS.includes(page.termsTag as never))
      .map(page => `${page.slug} (${page.termsTag})`);
    assert.deepStrictEqual(
      exempted.slice(0, 20),
      [],
      `${exempted.length} pages publish a reason they cannot confirm the terms under a withholding this sweep exempts`,
    );
  });
});
