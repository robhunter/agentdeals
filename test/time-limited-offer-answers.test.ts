import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPopulationFloor } from "./population-floor.ts";

const { classifyTier, gateFor, timeLimitedTierRule, utcDate, GATES_LEAVING_NO_FREE_TIER } = await import("../dist/ranking.js");
const { toSlug } = await import("../dist/slug.js");
const { loadDealChanges, refusalsForVendor } = await import("../dist/data.js");
const { supersedingChange, supersededTermsVerdictSentence } = await import("../dist/superseded-description.js");
const { vendorVerdictContextFrom } = await import("../dist/vendor-verdict-input.js");
const { whyWeCannotConfirmTheseTerms } = await import("../dist/vendor-verdict.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;
type ListingCondition = import("../src/types.ts").ListingCondition;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const TODAY = utcDate();

const catalogue: { offers: Offer[] } = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
const dealChanges: DealChange[] = loadDealChanges();
const changesOf = (vendor: string) => dealChanges.filter(c => c.vendor.toLowerCase() === vendor.toLowerCase());

const LAPSED_TRIAL: Offer = {
  vendor: "Zqtrial Lapsed",
  category: "Monitoring",
  description: "Uptime checks for web services. A 14-day free trial, then paid plans from $9 a month.",
  tier: "Trial",
  url: "https://zqtrial-lapsed.example/pricing",
  tags: ["monitoring"],
  verifiedDate: "2025-01-15",
};
const RESTRICTED_CREDITS: Offer = {
  vendor: "Zqcredit Restricted",
  category: "Monitoring",
  description: "Log search for students. A one-time $50 credit, then usage-billed.",
  tier: "Free Credits",
  url: "https://zqcredit-restricted.example/pricing",
  tags: ["monitoring"],
  verifiedDate: TODAY,
  eligibility: { type: "student", conditions: ["Enrolled students only"], program: "Zq Student Credits" },
};

const EXPIRED_ON = "2026-01-31";
const EXPIRED_TRIAL: Offer = {
  vendor: "Zqtrial Expired",
  category: "Monitoring",
  description: "Synthetic checks for APIs. A 30-day free trial, then paid plans from $19 a month.",
  tier: "Trial",
  url: "https://zqtrial-expired.example/pricing",
  tags: ["monitoring"],
  verifiedDate: TODAY,
  expires_date: EXPIRED_ON,
};

const daysBefore = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const NARROWED_ON = daysBefore(17);
const NARROWED_TRIAL: Offer = {
  vendor: "Zqtrial Narrowed",
  category: "Testing",
  description: "Browser test runs in the cloud. A 14-day free trial, then paid plans from $29 a month.",
  tier: "Trial",
  url: "https://zqtrial-narrowed.example/pricing",
  tags: ["testing"],
  verifiedDate: TODAY,
};
const NARROWING: DealChange = {
  vendor: NARROWED_TRIAL.vendor,
  change_type: "limits_reduced",
  date: NARROWED_ON,
  summary: `Zqtrial Narrowed's trial no longer includes parallel cloud runs. Its pricing table gave the trial "Parallel runs (unlimited)" on the Internet Archive's capture of ${daysBefore(46)} and marks parallel runs unavailable on the trial from the capture of ${NARROWED_ON}.`,
  previous_state: `Trial: "Parallel runs (unlimited)" (pricing table, capture of ${daysBefore(46)})`,
  current_state: `Trial: "Parallel runs" unavailable (capture of ${NARROWED_ON})`,
  impact: "medium",
  source_url: `http://web.archive.org/web/${NARROWED_ON.replace(/-/g, "")}150023/https://zqtrial-narrowed.example/pricing`,
  category: "Testing",
  alternatives: [],
  recorded_date: daysBefore(4),
  date_source: "hand_written",
} as DealChange;

const ABANDONED_ON = daysBefore(40);
const ABANDONED_CREDITS: Offer = {
  vendor: "Zqcredit Abandoned",
  category: "Storage",
  description: "Object storage with an open-source server. New accounts get a one-time $25 credit, then usage-billed.",
  tier: "Free Credits",
  url: "https://zqcredit-abandoned.example/pricing",
  tags: ["storage"],
  verifiedDate: TODAY,
};
const ABANDONMENT: DealChange = {
  vendor: ABANDONED_CREDITS.vendor,
  change_type: "open_source_killed",
  date: ABANDONED_ON,
  summary: `Zqcredit Abandoned archived its open-source server repository on ${ABANDONED_ON}, ending the community edition with no further fixes. Development continues in its commercial server.`,
  previous_state: "Open-source community edition, maintained",
  current_state: "Repository archived and read-only",
  impact: "high",
  source_url: "https://github.com/zqcredit-abandoned/server/commit/0000000000000000000000000000000000000000",
  category: "Storage",
  alternatives: [],
  recorded_date: daysBefore(30),
  date_source: "hand_written",
} as DealChange;

const SCHOLARSHIP: Offer = {
  vendor: "Zqaward Scholarship",
  category: "Monitoring",
  description: "Error tracking for open-source maintainers. A scholarship award on application, renewed each year.",
  tier: "Scholarship",
  url: "https://zqaward-scholarship.example/pricing",
  tags: ["monitoring"],
  verifiedDate: TODAY,
};
const PREVIEW: Offer = {
  vendor: "Zqpreview Public",
  category: "Monitoring",
  description: "Log search in public preview. Up to 10 GB storage while the preview runs.",
  tier: "Public Preview",
  url: "https://zqpreview-public.example/pricing",
  tags: ["monitoring"],
  verifiedDate: TODAY,
};

const BARE_PREVIEW: Offer = {
  vendor: "Zqpreview Bare",
  category: "Monitoring",
  description: "Uptime checks in private beta.",
  tier: "Beta",
  url: "https://zqpreview-bare.example/pricing",
  tags: ["monitoring"],
  verifiedDate: TODAY,
};

const FIXTURES = [LAPSED_TRIAL, RESTRICTED_CREDITS, EXPIRED_TRIAL, NARROWED_TRIAL, ABANDONED_CREDITS, SCHOLARSHIP, PREVIEW, BARE_PREVIEW];
const scratch = mkdtempSync(path.join(tmpdir(), "time-limited-offer-answers-"));
const scratchIndex = path.join(scratch, "index.json");
const scratchChanges = path.join(scratch, "deal_changes.json");
writeFileSync(scratchIndex, JSON.stringify({ ...catalogue, offers: [...catalogue.offers, ...FIXTURES] }));
const changeLog = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
writeFileSync(scratchChanges, JSON.stringify({ ...changeLog, changes: [...changeLog.changes, NARROWING, ABANDONMENT] }));

interface Subject {
  vendor: string;
  slug: string;
  tier: string;
  note: string;
  description: string;
  supersededBy: DealChange | null;
  superseded: boolean;
  levelWithheld: boolean;
  productionRuledOutBy: ListingCondition | null;
  termsUnconfirmed: boolean;
  restriction: string;
}

const primaries = new Map<string, Offer>();
for (const offer of catalogue.offers) if (!primaries.has(offer.vendor)) primaries.set(offer.vendor, offer);

function leavesNoFreeTier(offer: Offer): boolean {
  const gate = gateFor(offer, TODAY, changesOf(offer.vendor));
  return gate !== null && GATES_LEAVING_NO_FREE_TIER.includes(gate.code);
}

function subjectOf(offer: Offer): Subject {
  const context = vendorVerdictContextFrom({
    vendor: offer.vendor,
    vendorOffers: catalogue.offers.filter(o => o.vendor === offer.vendor),
    vendorChanges: changesOf(offer.vendor),
    refusedReads: refusalsForVendor(offer.vendor),
    servedOn: TODAY,
  });
  const supersededBy = supersedingChange(offer, changesOf(offer.vendor));
  const gate = gateFor(offer, TODAY, changesOf(offer.vendor));
  return {
    vendor: offer.vendor,
    slug: toSlug(offer.vendor),
    tier: offer.tier,
    note: classifyTier(offer.tier).note,
    description: offer.description,
    supersededBy,
    superseded: supersededBy !== null,
    levelWithheld: (context?.levelWithheld ?? null) !== null,
    productionRuledOutBy: supersededBy ? null : (offer.conditions ?? []).find(c => (c.rules_out ?? []).includes("production")) ?? null,
    termsUnconfirmed: context ? whyWeCannotConfirmTheseTerms(context.input) !== null : false,
    restriction: gate?.code === "eligibility_restricted" ? `${gate.reason} ` : "",
  };
}

const timeLimited: Subject[] = [...primaries.values()]
  .filter(o => classifyTier(o.tier).class === "time_limited" && !leavesNoFreeTier(o))
  .map(subjectOf);
const freeClass: Subject[] = [...primaries.values()]
  .filter(o => classifyTier(o.tier).class === "free" && !leavesNoFreeTier(o))
  .map(subjectOf);

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

interface Faq {
  q: string;
  a: string;
}

interface Page {
  status: number;
  body: Faq[];
  ld: Faq[];
  meta: string;
  verdict: string;
  title: string;
  h1: string;
  growthHeading: string | null;
  growthBullets: string[];
}

function readPage(status: number, html: string): Page {
  const body = [...html.matchAll(/<summary class="faq-q">([\s\S]*?)<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>/g)]
    .map(m => ({ q: decode(m[1]), a: decode(m[2]) }));
  const ld: Faq[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let block: Record<string, any>;
    try { block = JSON.parse(m[1]); } catch { continue; }
    if (block["@type"] !== "FAQPage") continue;
    for (const item of block.mainEntity) ld.push({ q: item.name, a: item.acceptedAnswer.text });
  }
  const meta = decode(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "");
  const verdict = decode((html.match(/<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/<[^>]+>/g, ""));
  const title = decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "");
  const h1 = decode((html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? "").replace(/<span class="risk-badge"[\s\S]*?<\/span>/, "").replace(/<[^>]+>/g, "")).trim();
  const growth = html.match(/<div class="section growth-section">\s*<h2>([^<]*)<\/h2>\s*<ul class="growth-list">([\s\S]*?)<\/ul>/);
  const growthBullets = growth ? [...growth[2].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => decode(m[1].replace(/<[^>]+>/g, ""))) : [];
  return { status, body, ld, meta, verdict, title, h1, growthHeading: growth ? decode(growth[1]) : null, growthBullets };
}

let port = 0;
let proc: ChildProcess | null = null;
const pages = new Map<string, Page>();

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost",
        TZ: "UTC",
        AGENTDEALS_INDEX_PATH: scratchIndex,
        AGENTDEALS_CHANGES_PATH: scratchChanges,
      },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function fetchAll(paths: string[], workers = 12): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, paths.length) }, async () => {
      while (next < paths.length) {
        const pathname = paths[next++];
        const res = await fetch(`http://localhost:${port}${pathname}`);
        pages.set(pathname, readPage(res.status, await res.text()));
      }
    }),
  );
}

const page = (pathname: string): Page => {
  const read = pages.get(pathname);
  assert.ok(read, `${pathname} was read`);
  return read;
};
const both = (p: Page): Faq[] => [...p.body, ...p.ld];
const answerTo = (faqs: Faq[], question: string): string | undefined => faqs.find(f => f.q === question)?.a;
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function phrasesPresumingAFreeTier(vendor: string): RegExp[] {
  return [
    /offers a free tier/i,
    /has a free tier/i,
    /free tier offers/i,
    /free tier is usable/i,
    /free tier can be suitable/i,
    /free tier is considered/i,
    /free tier requires caution/i,
    /free tier \([^)]*\) is considered/i,
    new RegExp(`outgrow ${escaped(vendor)}'s free tier`, "i"),
    new RegExp(`${escaped(vendor)} free tier includes`, "i"),
  ];
}

const YEAR = new Date().getUTCFullYear();
const OFFER_TEXT: Record<string, { name: string; heading: (vendor: string) => string; bullet: string | null }> = {
  credit: { name: "Free Credits", heading: v => `When ${v}'s Free Credits Run Out`, bullet: "When credits run out or expire, you must pay for further use." },
  trial: { name: "Free Trial", heading: v => `When ${v}'s Free Trial Ends`, bullet: "When the trial ends, you must pay for further use." },
  scholarship: { name: "Scholarship", heading: v => `When ${v}'s Scholarship Ends`, bullet: "When the award period ends, you must pay for further use." },
  preview: { name: "Free Preview", heading: v => `When ${v}'s Free Preview Ends`, bullet: null },
};
const offerTextOf = (tier: string) => OFFER_TEXT[timeLimitedTierRule(tier)!.kind];
const GENERIC_BULLET = "When your usage exceeds the free tier limits, you'll need to upgrade.";
const THRESHOLD_BULLET = /^At .+, you'll need to upgrade\.$/;
const ALTERNATIVES_BULLET = /^At that point, the \d+ alternatives in /;

const productionSentence = (s: Subject) => `Not for long. It is ${s.note}, so plan for paid usage before you depend on it.`;
const THE_TRIAL_EXPIRES = "The trial also expires.";
const whatItOffers = (s: Subject) => `No. What ${s.vendor} offers is ${s.note}:`;
const whatItOffersBeforeTheCaveat = (s: Subject) => `No. What ${s.vendor} offers is ${s.note}. We cannot confirm that today.`;
const verdictLead = (s: Subject) => `${s.vendor} has no ongoing free tier; what it offers is ${s.note}: `;
const NOT_RECOMMENDED_FOR_PRODUCTION = /we are not recommending it for production/;

describe("a vendor whose listed tier is a trial or a credit grant is not said to offer a free tier", () => {
  before(async () => {
    proc = await startServer();
    await fetchAll([
      ...timeLimited.flatMap(s => [`/vendor/${s.slug}`, `/alternative-to/${s.slug}`]),
      ...freeClass.flatMap(s => [`/vendor/${s.slug}`, `/alternative-to/${s.slug}`]),
      ...FIXTURES.map(f => `/vendor/${toSlug(f.vendor)}`),
    ]);
  });

  after(() => {
    proc?.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("reads every vendor page whose listed tier runs out", () => {
    assertPopulationFloor(timeLimited.length, 20, "vendor pages whose listed tier is a trial or a credit grant");
    for (const s of timeLimited) assert.strictEqual(page(`/vendor/${s.slug}`).status, 200, `/vendor/${s.slug}`);
  });

  it("asks and answers nothing that presumes a free tier, in the quick verdict, the page body, the structured data or the meta description", () => {
    const presuming: string[] = [];
    for (const s of timeLimited) {
      const p = page(`/vendor/${s.slug}`);
      assert.ok(p.ld.length > 0 && p.body.length === p.ld.length, `/vendor/${s.slug} prints the questions its structured data holds`);
      assert.ok(p.verdict.length > 0, `/vendor/${s.slug} prints a quick verdict`);
      for (const text of [p.verdict, ...both(p).flatMap(f => [f.q, f.a]), p.meta]) {
        for (const phrase of phrasesPresumingAFreeTier(s.vendor)) {
          if (phrase.test(text)) presuming.push(`/vendor/${s.slug}: ${text.match(phrase)![0]}`);
        }
      }
    }
    assert.deepStrictEqual(presuming, []);
  });

  it("answers whether it is free with no, naming what the vendor offers instead", () => {
    const answered = timeLimited.filter(s => !s.superseded);
    assertPopulationFloor(answered.length, 20, "trial and credit vendor pages that publish their stored terms");
    for (const s of answered) {
      for (const faqs of [page(`/vendor/${s.slug}`).body, page(`/vendor/${s.slug}`).ld]) {
        const answer = answerTo(faqs, `Is ${s.vendor} free?`) ?? "";
        const opening = s.termsUnconfirmed ? whatItOffersBeforeTheCaveat(s) : `${whatItOffers(s)} ${s.description.slice(0, 30)}`;
        assert.ok(answer.includes(opening), `/vendor/${s.slug} answers "${answer.slice(0, 160)}"`);
        assert.ok(answer.includes(s.description.slice(0, 30)), `/vendor/${s.slug} answers without its terms: "${answer.slice(0, 160)}"`);
      }
    }
  });

  it("leads with no where we cannot confirm the terms, and follows it with that caveat", () => {
    const unconfirmed = timeLimited.filter(s => !s.superseded && s.termsUnconfirmed);
    assertPopulationFloor(unconfirmed.length, 3, "trial and credit vendor pages whose stored terms we cannot confirm");
    const caveatFirst: string[] = [];
    for (const s of unconfirmed) {
      for (const faqs of [page(`/vendor/${s.slug}`).body, page(`/vendor/${s.slug}`).ld]) {
        const answer = answerTo(faqs, `Is ${s.vendor} free?`) ?? "";
        const no = answer.indexOf(whatItOffersBeforeTheCaveat(s));
        const caveat = answer.indexOf("We cannot confirm that today");
        if (no < 0 || caveat < no) caveatFirst.push(`/vendor/${s.slug}: ${answer.slice(0, 120)}`);
      }
    }
    assert.deepStrictEqual(caveatFirst, []);
  });

  it("asks about the free offer rather than a free tier, and drops the questions only a free tier answers", () => {
    for (const s of timeLimited) {
      const questions = both(page(`/vendor/${s.slug}`)).map(f => f.q);
      assert.ok(!questions.includes(`What is ${s.vendor}'s free tier?`), `/vendor/${s.slug} asks what the free tier is`);
      assert.ok(!questions.some(q => q.startsWith("When will I outgrow")), `/vendor/${s.slug} asks when the reader outgrows a free tier`);
      assert.ok(questions.includes(`Is ${s.vendor}'s free offer good for production?`), `/vendor/${s.slug} asks ${JSON.stringify(questions)}`);
      assert.ok(!questions.some(q => /free tier (reliable|good for production)\?$/.test(q)), `/vendor/${s.slug} asks ${JSON.stringify(questions)}`);
    }
  });

  it("tells the reader the offer runs out when asked about production, unless the page recommends it for nothing", () => {
    const toldItRunsOut = timeLimited.filter(s => !s.superseded && !s.levelWithheld);
    assertPopulationFloor(toldItRunsOut.length, 15, "trial and credit vendor pages answering that the offer runs out");
    for (const s of timeLimited) {
      const answer = answerTo(page(`/vendor/${s.slug}`).ld, `Is ${s.vendor}'s free offer good for production?`) ?? "";
      if (toldItRunsOut.includes(s) && s.productionRuledOutBy) {
        assert.ok(answer.includes(`No. ${s.productionRuledOutBy.text} (From `), `/vendor/${s.slug} answers "${answer.slice(0, 200)}"`);
        assert.ok(answer.endsWith(` ${THE_TRIAL_EXPIRES}`), `/vendor/${s.slug} answers "${answer.slice(0, 200)}"`);
      } else if (toldItRunsOut.includes(s)) assert.ok(answer.endsWith(productionSentence(s)), `/vendor/${s.slug} answers "${answer.slice(0, 200)}"`);
      else assert.match(answer, NOT_RECOMMENDED_FOR_PRODUCTION, `/vendor/${s.slug} answers "${answer.slice(0, 200)}"`);
    }
  });

  it("opens the meta description with the tier's class", () => {
    for (const s of timeLimited.filter(t => !t.superseded)) {
      const meta = page(`/vendor/${s.slug}`).meta;
      assert.ok(meta.startsWith(`${s.restriction}${s.vendor} has no ongoing free tier; what it offers is ${s.note}. `), `/vendor/${s.slug}: "${meta}"`);
    }
  });

  it("opens the quick verdict with the tier's class, followed by the stored terms", () => {
    for (const s of timeLimited.filter(t => !t.superseded)) {
      const verdict = page(`/vendor/${s.slug}`).verdict;
      assert.ok(verdict.startsWith(s.restriction + verdictLead(s)), `/vendor/${s.slug}: "${verdict.slice(0, 200)}"`);
      const openingOfTheTerms = verdict.slice((s.restriction + verdictLead(s)).length).split("…")[0].slice(0, 30);
      assert.ok(openingOfTheTerms.length >= 20 && s.description.startsWith(openingOfTheTerms), `/vendor/${s.slug}: "${verdict.slice(0, 200)}"`);
    }
  });

  it("opens the quick verdict on the superseding record where the stored terms are withheld", () => {
    for (const s of timeLimited.filter(t => t.supersededBy !== null)) {
      const verdict = page(`/vendor/${s.slug}`).verdict;
      assert.ok(verdict.startsWith(s.restriction + supersededTermsVerdictSentence(s.vendor, s.supersededBy)), `/vendor/${s.slug}: "${verdict.slice(0, 200)}"`);
    }
  });

  it("answers that the free tier is not available on the vendor's alternatives page", () => {
    const asked = timeLimited.filter(s => page(`/alternative-to/${s.slug}`).ld.length > 0);
    assertPopulationFloor(asked.length, 15, "alternatives pages answering for a trial or credit vendor");
    for (const s of asked) {
      for (const faqs of [page(`/alternative-to/${s.slug}`).body, page(`/alternative-to/${s.slug}`).ld]) {
        const answer = answerTo(faqs, `Is ${s.vendor}'s free tier still available?`) ?? "";
        assert.match(answer, new RegExp(`No\\. What ${escaped(s.vendor)} offers is ${escaped(s.note)} \\(${escaped(s.tier)}\\)(\\. |, but |, and )\\S`), `/alternative-to/${s.slug} answers "${answer.slice(0, 200)}"`);
        for (const phrase of phrasesPresumingAFreeTier(s.vendor)) {
          assert.doesNotMatch(answer, phrase, `/alternative-to/${s.slug}`);
        }
      }
    }
  });

  it("keeps a gate's sentence in front of the answer", () => {
    const lapsed = subjectOf(LAPSED_TRIAL);
    const lapsedFaqs = page(`/vendor/${lapsed.slug}`).ld;
    assert.match(
      answerTo(lapsedFaqs, `Is ${lapsed.vendor} free?`) ?? "",
      new RegExp(`^We have not been able to confirm this offer since ${LAPSED_TRIAL.verifiedDate}[^.]*\\. ${escaped(whatItOffers(lapsed))} ${escaped(LAPSED_TRIAL.description.slice(0, 40))}`),
    );
    assert.match(
      answerTo(lapsedFaqs, `Is ${lapsed.vendor}'s free offer good for production?`) ?? "",
      new RegExp(`^We have not been able to confirm this offer since ${LAPSED_TRIAL.verifiedDate}[^.]*\\. ${escaped(productionSentence(lapsed))}$`),
    );
    assert.match(
      page(`/vendor/${lapsed.slug}`).verdict,
      new RegExp(`^We have not been able to confirm this offer since ${LAPSED_TRIAL.verifiedDate}[^.]*\\. ${escaped(verdictLead(lapsed) + LAPSED_TRIAL.description.slice(0, 40))}`),
    );

    const restricted = subjectOf(RESTRICTED_CREDITS);
    const restrictedFaqs = page(`/vendor/${restricted.slug}`).ld;
    const restriction = "Restricted to student (Zq Student Credits) applicants — not generally available.";
    assert.ok(
      (answerTo(restrictedFaqs, `Is ${restricted.vendor} free?`) ?? "").startsWith(`${restriction} ${whatItOffers(restricted)} ${RESTRICTED_CREDITS.description}`),
      answerTo(restrictedFaqs, `Is ${restricted.vendor} free?`),
    );
    assert.strictEqual(answerTo(restrictedFaqs, `Is ${restricted.vendor}'s free offer good for production?`), `${restriction} ${productionSentence(restricted)}`);
    assert.ok(page(`/vendor/${restricted.slug}`).meta.startsWith(`${restriction} ${restricted.vendor} has no ongoing free tier; what it offers is ${restricted.note}. `));
    assert.ok(page(`/vendor/${restricted.slug}`).verdict.startsWith(`${restriction} ${verdictLead(restricted)}${RESTRICTED_CREDITS.description}`), page(`/vendor/${restricted.slug}`).verdict);
  });

  it("says nothing about what an expired offer gives, beyond its expiry", () => {
    const expired = subjectOf(EXPIRED_TRIAL);
    const p = page(`/vendor/${expired.slug}`);
    const expiry = `Offer expired on ${EXPIRED_ON}.`;
    assert.ok((answerTo(p.ld, `Is ${expired.vendor} free?`) ?? "").startsWith(`${expiry} ${EXPIRED_TRIAL.description}`), answerTo(p.ld, `Is ${expired.vendor} free?`));
    assert.strictEqual(answerTo(p.ld, `Is ${expired.vendor}'s free tier good for production?`), `${expiry} There is no free tier here to run in production.`);
    for (const text of [p.verdict, ...both(p).flatMap(f => [f.q, f.a]), p.meta]) {
      assert.ok(!text.includes(`${expired.vendor} offers is`) && !text.includes("what it offers is"), text);
    }
  });

  it("rates the free offer, not a free tier, when a recorded change narrows or abandons it", () => {
    const narrowed = subjectOf(NARROWED_TRIAL);
    const faqs = page(`/vendor/${narrowed.slug}`).ld;
    assert.ok(
      (answerTo(faqs, `Is ${narrowed.vendor}'s free offer reliable?`) ?? "").startsWith(
        `${narrowed.vendor}'s free offer requires caution because of one specific recorded change, on ${NARROWED_ON}: `,
      ),
      JSON.stringify(faqs.map(f => f.q)),
    );
    assert.strictEqual(answerTo(faqs, `Is ${narrowed.vendor}'s free offer good for production?`), productionSentence(narrowed));

    const abandoned = subjectOf(ABANDONED_CREDITS);
    const abandonedFaqs = page(`/vendor/${abandoned.slug}`).ld;
    assert.ok(
      (answerTo(abandonedFaqs, `Is ${abandoned.vendor}'s free offer reliable?`) ?? "").startsWith(
        `${abandoned.vendor}'s free offer is considered risky because of one specific recorded change, on ${ABANDONED_ON}: `,
      ),
      JSON.stringify(abandonedFaqs.map(f => f.q)),
    );
  });

  it("names the offer by its class in the title, the H1 and the section heading, and none of them says Free Tier", () => {
    const retitled = timeLimited.filter(s => !page(`/vendor/${s.slug}`).title.startsWith(`${s.vendor} Pricing `));
    assertPopulationFloor(retitled.length, 20, "trial and credit vendor pages titled by their offer");
    for (const s of timeLimited) {
      const p = page(`/vendor/${s.slug}`);
      for (const text of [p.title, p.h1, p.growthHeading ?? ""]) assert.ok(!text.includes("Free Tier"), `/vendor/${s.slug}: ${text}`);
      if (p.growthHeading !== null) assert.strictEqual(p.growthHeading, offerTextOf(s.tier).heading(s.vendor), `/vendor/${s.slug}`);
    }
    for (const s of retitled) {
      const p = page(`/vendor/${s.slug}`);
      assert.strictEqual(p.h1, `${s.vendor} ${offerTextOf(s.tier).name} ${YEAR}`);
      assert.strictEqual(p.title, `${s.vendor} ${offerTextOf(s.tier).name} ${YEAR}: Limits, Pricing & What Changed | AgentDeals`);
    }
  });

  it("says what follows the offer where a free tier's page says the usage exceeds its limits", () => {
    const sayingWhatFollows = timeLimited.filter(s => page(`/vendor/${s.slug}`).growthBullets.includes(offerTextOf(s.tier).bullet ?? ""));
    assert.notStrictEqual(sayingWhatFollows.length, 0, "no trial or credit page says what follows its offer");
    for (const s of timeLimited.filter(t => !t.superseded)) {
      const p = page(`/vendor/${s.slug}`);
      if (p.growthHeading === null || p.title.startsWith(`${s.vendor} Pricing `)) continue;
      const thresholds = p.growthBullets.filter(b => THRESHOLD_BULLET.test(b) || b.startsWith("We record "));
      if (thresholds.length === 0) assert.strictEqual(p.growthBullets[0], offerTextOf(s.tier).bullet, `/vendor/${s.slug}`);
    }
    for (const s of timeLimited) {
      for (const bullet of page(`/vendor/${s.slug}`).growthBullets) {
        assert.ok(
          bullet === offerTextOf(s.tier).bullet || THRESHOLD_BULLET.test(bullet) || ALTERNATIVES_BULLET.test(bullet) || bullet.startsWith("We record "),
          `/vendor/${s.slug}: ${bullet}`,
        );
      }
    }
  });

  it("names a scholarship and a preview by their class, and says nothing follows a preview", () => {
    const award = page(`/vendor/${toSlug(SCHOLARSHIP.vendor)}`);
    assert.strictEqual(award.h1, `${SCHOLARSHIP.vendor} Scholarship ${YEAR}`);
    assert.strictEqual(award.title, `${SCHOLARSHIP.vendor} Scholarship ${YEAR}: Limits, Pricing & What Changed | AgentDeals`);
    assert.strictEqual(award.growthHeading, `When ${SCHOLARSHIP.vendor}'s Scholarship Ends`);
    assert.strictEqual(award.growthBullets[0], "When the award period ends, you must pay for further use.");

    const preview = page(`/vendor/${toSlug(PREVIEW.vendor)}`);
    assert.strictEqual(preview.h1, `${PREVIEW.vendor} Free Preview ${YEAR}`);
    assert.strictEqual(preview.title, `${PREVIEW.vendor} Free Preview ${YEAR}: Limits, Pricing & What Changed | AgentDeals`);
    assert.strictEqual(preview.growthHeading, `When ${PREVIEW.vendor}'s Free Preview Ends`);
    assert.ok(preview.growthBullets.length > 0 && preview.growthBullets.every(b => THRESHOLD_BULLET.test(b) || ALTERNATIVES_BULLET.test(b)), JSON.stringify(preview.growthBullets));
    const bare = page(`/vendor/${toSlug(BARE_PREVIEW.vendor)}`);
    assert.strictEqual(bare.h1, `${BARE_PREVIEW.vendor} Free Preview ${YEAR}`);
    assert.ok(bare.growthBullets.every(b => !b.endsWith("you must pay for further use.")), JSON.stringify(bare.growthBullets));
  });

  it("leaves the pages of a vendor whose listed tier is an ongoing free tier as they were", () => {
    assertPopulationFloor(freeClass.length, 1000, "vendor pages whose listed tier is an ongoing free tier");
    const changed: string[] = [];
    for (const s of freeClass) {
      const p = page(`/vendor/${s.slug}`);
      const texts = [p.verdict, ...both(p).flatMap(f => [f.q, f.a]), p.meta];
      const timeLimitedWording = [
        whatItOffers(s),
        `${s.vendor}'s free offer`,
        `It is ${s.note}, so plan for paid usage`,
        `${s.vendor} has no ongoing free tier; what it offers is`,
      ];
      if (texts.some(t => timeLimitedWording.some(w => t.includes(w)))) changed.push(`/vendor/${s.slug}`);
      const titled = p.title === `${s.vendor} Free Tier ${YEAR}: Limits, Pricing & What Changed | AgentDeals` || p.title === `${s.vendor} Pricing ${YEAR}: Plans, Costs & Free Alternatives | AgentDeals`;
      const headed = p.growthHeading === null || p.growthHeading === `When You'll Outgrow ${s.vendor}'s Free Tier`;
      if (!titled || !headed || p.growthBullets.some(b => Object.values(OFFER_TEXT).some(o => o.bullet === b))) changed.push(`/vendor/${s.slug} (title, heading or bullet)`);
    }
    assert.deepStrictEqual(changed, []);
    const answeringAlternatives = freeClass.filter(s => page(`/alternative-to/${s.slug}`).ld.length > 0);
    assertPopulationFloor(answeringAlternatives.length, 100, "alternatives pages answering for a vendor with an ongoing free tier");
    const answeredNo = answeringAlternatives
      .filter(s => both(page(`/alternative-to/${s.slug}`)).some(f => f.a.includes(`No. What ${s.vendor} offers is`)))
      .map(s => `/alternative-to/${s.slug}`);
    assert.deepStrictEqual(answeredNo, []);
  });
});
