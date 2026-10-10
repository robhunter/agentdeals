import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Offer = import("../src/types.ts").Offer;
type ListingCondition = import("../src/types.ts").ListingCondition;

const { USES_A_VENDOR_CAN_RULE_OUT, conditionsInPlainText, conditionsOf, productionAnswerOpening, theVendorsRuleOnProduction, withConditionsAfter } = await import("../dist/listing-conditions.js");
const { citationLabel } = await import("../dist/change-citation.js");
const { toSlug } = await import("../dist/slug.js");
const { ruleOnRestating } = await import("../dist/restatement.js");
const { applyRestatements, revertRestatement } = await import("../scripts/restate-superseded-terms.js");

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const NARROWED_ON = daysAgo(30);
const RESTORED_ON = daysAgo(10);

const slugOf = (vendor: string) => vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function condition(vendor: string, marker: string, rulesOut?: ListingCondition["rules_out"]): ListingCondition {
  return {
    text: `The free plan carries a rule ${marker}-text.`,
    quote: `The free plan is not for ${marker}-quote.`,
    url: `https://${slugOf(vendor)}.example/terms/${marker}`,
    read_on: TODAY,
    ...(rulesOut ? { rules_out: rulesOut } : {}),
  };
}

function listing(vendor: string, conditions: ListingCondition[]): Offer {
  const url = `https://${slugOf(vendor)}.example/pricing`;
  return {
    vendor,
    category: "Databases",
    description: `${vendor} free plan: 3 databases and 1 GB of storage.`,
    tier: "Free",
    url,
    tags: ["database"],
    verifiedDate: TODAY,
    source_check: { checked: TODAY, outcome: "ok", detail: `the page names ${vendor} as "${slugOf(vendor)}"` },
    conditions,
  } as Offer;
}

function trialListing(vendor: string, conditions: ListingCondition[]): Offer {
  return { ...listing(vendor, conditions), tier: "Trial", description: `${vendor} gives new accounts $5 of trial credit.` } as Offer;
}

const NOTED = listing("Noted Conditions Co", [condition("Noted Conditions Co", "noted-marker")]);
const TRIAL_NO_PRODUCTION = trialListing("Trial No Production Conditions Co", [
  condition("Trial No Production Conditions Co", "trial-no-production-marker", ["production"]),
]);
const TRIAL_NOTED = trialListing("Trial Noted Conditions Co", [condition("Trial Noted Conditions Co", "trial-noted-marker")]);
const NO_PRODUCTION = listing("No Production Conditions Co", [
  condition("No Production Conditions Co", "no-production-marker", ["production"]),
]);
const NO_COMMERCIAL_USE = listing("No Commercial Use Conditions Co", [
  condition("No Commercial Use Conditions Co", "no-commercial-use-marker", ["commercial use"]),
]);
const NEITHER = listing("Neither Production Nor Commercial Conditions Co", [
  condition("Neither Production Nor Commercial Conditions Co", "neither-marker", ["production", "commercial use"]),
]);
const ESCAPED = listing("Escaped Conditions Co", [{
  ...condition("Escaped Conditions Co", "escaped-marker"),
  text: "Accounts & keys are personal <escaped-marker>.",
}]);
const SUPERSEDED = listing("Superseded Conditions Co", [condition("Superseded Conditions Co", "superseded-marker", ["production"])]);
const CAUTION = listing("Caution Conditions Co", [condition("Caution Conditions Co", "caution-marker", ["production"])]);
const RESTORED = listing("Restored Conditions Co", [condition("Restored Conditions Co", "restored-marker", ["commercial use"])]);
const UNRATED = listing("Unrated Conditions Co", [condition("Unrated Conditions Co", "unrated-marker", ["production"])]);
const WITHHELD = {
  ...listing("Withheld Conditions Co", [condition("Withheld Conditions Co", "withheld-marker", ["production"])]),
  source_check: { checked: TODAY, outcome: "does_not_name_vendor", detail: "the page names no vendor" },
} as Offer;
const GATED = {
  ...listing("Gated Conditions Co", [condition("Gated Conditions Co", "gated-marker", ["production"])]),
  verifiedDate: daysAgo(200),
} as Offer;
const GATED_WITH_A_CHANGE = {
  ...listing("Gated Caution Conditions Co", [condition("Gated Caution Conditions Co", "gated-caution-marker", ["production"])]),
  verifiedDate: daysAgo(200),
} as Offer;
const WIDENED = listing("Widened Conditions Co", [condition("Widened Conditions Co", "widened-marker", ["production"])]);
const UNNAMED = { checked: TODAY, outcome: "does_not_name_vendor", detail: "the page names no vendor" };
const ENDED_WITHHELD = {
  ...listing("Ended Withheld Conditions Co", [condition("Ended Withheld Conditions Co", "ended-withheld-marker", ["production"])]),
  source_check: UNNAMED,
} as Offer;
const NOT_FREE_WITHHELD = {
  ...listing("Not Free Withheld Conditions Co", [condition("Not Free Withheld Conditions Co", "not-free-withheld-marker", ["production"])]),
  tier: "None",
  description: "No free tier. Plans start at $10 a month for 3 databases.",
  source_check: UNNAMED,
} as Offer;

const SYNTHETIC = [NOTED, NO_PRODUCTION, NO_COMMERCIAL_USE, NEITHER, ESCAPED, SUPERSEDED, CAUTION, RESTORED, UNRATED, WITHHELD, GATED, GATED_WITH_A_CHANGE, WIDENED, ENDED_WITHHELD, NOT_FREE_WITHHELD, TRIAL_NO_PRODUCTION, TRIAL_NOTED];

function withoutConditions(offer: Offer): Offer {
  const { conditions: _theFieldUnderTest, ...rest } = offer;
  return rest as Offer;
}

const SYNTHETIC_VENDORS = new Set(SYNTHETIC.map(offer => offer.vendor));

function withoutTheSyntheticConditions(offer: Offer): Offer {
  return SYNTHETIC_VENDORS.has(offer.vendor) ? withoutConditions(offer) : offer;
}

const SUPERSEDING_CHANGE = {
  vendor: SUPERSEDED.vendor,
  change_type: "limits_reduced",
  date: TODAY,
  summary: `${SUPERSEDED.vendor} cut its free plan to 1 database.`,
  tier: "Free",
  previous_state: SUPERSEDED.description,
  current_state: "1 database and 500 MB of storage",
  impact: "medium",
  source_url: SUPERSEDED.url,
  category: "Databases",
  alternatives: [],
  recorded_date: TODAY,
  date_source: "vendor_page",
};

const dir = mkdtempSync(path.join(tmpdir(), "listing-conditions-"));
const catalogue = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
const changeLog = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
const changesPath = path.join(dir, "deal_changes.json");
function narrowing(offer: Offer, over: Record<string, unknown> = {}) {
  return {
    vendor: offer.vendor,
    change_type: "limits_reduced",
    date: NARROWED_ON,
    summary: `${offer.vendor} cut its free plan from 6 databases to 3.`,
    tier: "Free",
    previous_state: "6 databases and 2 GB of storage",
    current_state: "3 databases and 1 GB of storage",
    impact: "medium",
    source_url: offer.url,
    category: "Databases",
    alternatives: [],
    recorded_date: NARROWED_ON,
    date_source: "vendor_page",
    ...over,
  };
}

const RATING_CHANGES = [
  narrowing(CAUTION),
  narrowing(RESTORED, {
    change_type: "free_tier_removed",
    summary: `${RESTORED.vendor} replaced its free plan with a 14-day trial.`,
    previous_state: "Free plan, $0 a month",
    current_state: "14-day trial only",
    impact: "high",
    resolution: { state: "reversed", date: RESTORED_ON, detail: "The free plan is back on the pricing page.", source_url: RESTORED.url },
  }),
  narrowing(UNRATED, { source_url: null }),
  narrowing(GATED_WITH_A_CHANGE),
  narrowing(ENDED_WITHHELD, {
    change_type: "free_tier_removed",
    summary: `${ENDED_WITHHELD.vendor} replaced its free plan with a 14-day trial.`,
    previous_state: "Free plan, $0 a month",
    current_state: "14-day trial only",
    impact: "high",
  }),
  narrowing(WIDENED, {
    change_type: "limits_increased",
    summary: `${WIDENED.vendor} raised its free plan from 3 databases to 6.`,
    previous_state: "3 databases and 1 GB of storage",
    current_state: "6 databases and 2 GB of storage",
    impact: "low",
  }),
];

writeFileSync(changesPath, JSON.stringify({ ...changeLog, changes: [...changeLog.changes, SUPERSEDING_CHANGE, ...RATING_CHANGES] }));

function catalogueAt(name: string, offers: Offer[]): string {
  const indexPath = path.join(dir, name);
  writeFileSync(indexPath, JSON.stringify({ ...catalogue, offers: [...catalogue.offers, ...offers] }));
  return indexPath;
}

const WITH_THE_FIELD = catalogueAt("with.json", SYNTHETIC);
const WITHOUT_THE_FIELD = catalogueAt("without.json", SYNTHETIC.map(withoutConditions));

function startServer(indexPath: string): Promise<{ proc: ChildProcess; base: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost",
        TZ: "UTC",
        AGENTDEALS_INDEX_PATH: indexPath,
        AGENTDEALS_CHANGES_PATH: changesPath,
      },
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server startup timeout")); }, 60000);
    child.stderr!.on("data", (buffer: Buffer) => {
      const found = buffer.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (found) { clearTimeout(timer); resolve({ proc: child, base: `http://localhost:${found[1]}` }); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

const theVendorsWords = (offer: Offer) => {
  const stated = offer.conditions![0];
  return `by ${offer.vendor}'s own terms: "${stated.quote}" (From ${citationLabel(stated.url)}, read ${stated.read_on}.)`;
};
const productionRuledOut = (offer: Offer, uses: string) => `No. ${offer.vendor}'s free tier is not for ${uses}, ${theVendorsWords(offer)}`;
const commercialUseRuledOut = (offer: Offer) =>
  `${offer.vendor}'s free tier is not for commercial use, ${theVendorsWords(offer)} Personal, non-commercial use of the free tier is still allowed.`;
const stableBeside = (offer: Offer) => `We rate ${offer.vendor}'s pricing stable. This rating is about how its terms have changed, not what they allow.`;
const PRODUCTION_CLOSING = "Consider free alternatives in Databases.";
const COMMERCIAL_USE_CLOSING = "For commercial use, consider free alternatives in Databases.";

const WHAT_IS = (offer: Offer) => `What is ${offer.vendor}'s free tier?`;
const OFFER_NOUN = (offer: Offer) => offer.tier === "Trial" ? "free offer" : "free tier";
const PRODUCTION = (offer: Offer) => `Is ${offer.vendor}'s ${OFFER_NOUN(offer)} good for production?`;
const TRIAL_RULED_OUT = (offer: Offer) => {
  const stated = offer.conditions![0];
  return `No. ${stated.text} (From ${citationLabel(stated.url)}, read ${stated.read_on}.) The trial also expires.`;
};
const TODAYS_STABLE_PRODUCTION_WORDS = ["suitable for small production workloads", "reasonable starting point"];

function decodeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function visibleFaq(html: string): Map<string, string> {
  const answers = new Map<string, string>();
  for (const match of html.matchAll(/<summary class="faq-q">([\s\S]*?)<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>/g)) {
    answers.set(decodeHtml(match[1]), decodeHtml(match[2]));
  }
  return answers;
}

function jsonLdFaq(html: string): Map<string, string> {
  const answers = new Map<string, string>();
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const block = JSON.parse(match[1]);
    if (block["@type"] !== "FAQPage") continue;
    for (const question of block.mainEntity) answers.set(question.name, question.acceptedAnswer.text);
  }
  return answers;
}

function freeTierDetails(html: string): string {
  const start = html.indexOf('<div class="desc-block">');
  assert.ok(start >= 0, "the page has no Free Tier Details block");
  return html.slice(start, html.indexOf("</div>", start));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CONDITIONS_IN_PLAIN_TEXT = [...new Set(SYNTHETIC.flatMap(offer => {
  if (!offer.conditions?.length) return [];
  const plain = ` ${conditionsInPlainText(offer.conditions)}`;
  return [plain, plain.replace(/<[^>]*>/g, "")];
}))];

function withoutThePlainConditions(value: unknown): unknown {
  if (typeof value === "string") return CONDITIONS_IN_PLAIN_TEXT.reduce((text, plain) => text.split(plain).join(""), value);
  if (Array.isArray(value)) return value.map(withoutThePlainConditions);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, withoutThePlainConditions(inner)]));
  return value;
}

function withoutConditionsBesideDescriptions(html: string, faqAnswered: (question: string) => boolean = () => false): string {
  return CONDITIONS_IN_PLAIN_TEXT.reduce((text, plain) => text.split(escapeHtml(plain)).join(""), html)
    .replace(/\n\s*<ul class="listing-conditions"[\s\S]*?<\/ul>/g, "")
    .replace(/(<summary class="faq-q">([\s\S]*?)<\/summary>\s*<div class="faq-a">)([\s\S]*?)(<\/div>)/g,
      (whole, open, question, _answer, close) => faqAnswered(decodeHtml(question)) ? `${open}${close}` : whole)
    .replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, (_whole, body) => {
      const block = JSON.parse(body);
      if (block["@type"] === "FAQPage") {
        for (const question of block.mainEntity) if (faqAnswered(question.name)) question.acceptedAnswer.text = "";
      }
      return `<script type="application/ld+json">${JSON.stringify(withoutThePlainConditions(block))}</script>`;
    });
}

function withoutWhatTheFieldMoves(html: string, offer: Offer): string {
  const moved = new Set([WHAT_IS(offer), PRODUCTION(offer)]);
  return withoutConditionsBesideDescriptions(html, question => moved.has(question));
}

describe("a listing's conditions of use", () => {
  let withField: { proc: ChildProcess; base: string };
  let withoutField: { proc: ChildProcess; base: string };

  before(async () => {
    [withField, withoutField] = await Promise.all([startServer(WITH_THE_FIELD), startServer(WITHOUT_THE_FIELD)]);
  });

  after(() => {
    withField?.proc.kill("SIGKILL");
    withoutField?.proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  const fetchText = async (base: string, route: string) => {
    const res = await fetch(`${base}${route}`);
    assert.strictEqual(res.status, 200, `${route} answered ${res.status}`);
    return await res.text();
  };
  const page = (base: string, offer: Offer) => fetchText(base, `/vendor/${slugOf(offer.vendor)}`);

  it("renders each condition's text, then the page it is from, linked, and the date we read it, in Free Tier Details", async () => {
    const details = freeTierDetails(await page(withField.base, NOTED));
    const stated = NOTED.conditions![0];
    assert.ok(
      details.includes(`<li>${stated.text} (From <a href="${stated.url}" rel="nofollow noopener">${citationLabel(stated.url)}</a>, read ${stated.read_on}.)</li>`),
      details,
    );
  });

  it("escapes a condition's text where the page renders it", async () => {
    const details = freeTierDetails(await page(withField.base, ESCAPED));
    assert.ok(details.includes("Accounts &amp; keys are personal &lt;escaped-marker&gt;."), "the condition is not escaped");
    assert.ok(!details.includes("<escaped-marker>"), "the condition reaches the page unescaped");
  });

  it("states each condition's text and page in the answer to what the free tier is, on the page and in its FAQ data", async () => {
    const html = await page(withField.base, NOTED);
    const stated = NOTED.conditions![0];
    for (const [where, answers] of [["the visible FAQ", visibleFaq(html)], ["the FAQPage JSON-LD", jsonLdFaq(html)]] as const) {
      const answer = answers.get(WHAT_IS(NOTED));
      assert.ok(answer, `${where} has no answer to what the free tier is`);
      assert.ok(answer.endsWith(`${NOTED.description} ${stated.text} (From ${stated.url}, read ${stated.read_on}.)`), `${where}: ${answer}`);
    }
  });

  const productionAnswers = async (base: string, offer: Offer) => {
    const html = await page(base, offer);
    const shown = visibleFaq(html).get(PRODUCTION(offer));
    assert.ok(shown, `${offer.vendor} has no production answer`);
    assert.strictEqual(jsonLdFaq(html).get(PRODUCTION(offer)), shown, `${offer.vendor}'s FAQPage data answers otherwise`);
    return shown;
  };

  it("answers no where the vendor rules out production, in its own words, then rates the pricing stable as a statement about change, then names free alternatives", async () => {
    assert.strictEqual(await productionAnswers(withField.base, NO_PRODUCTION),
      `${productionRuledOut(NO_PRODUCTION, "production use")} ${stableBeside(NO_PRODUCTION)} ${PRODUCTION_CLOSING}`);
    assert.strictEqual(await productionAnswers(withField.base, NEITHER),
      `${productionRuledOut(NEITHER, "production or commercial use")} ${stableBeside(NEITHER)} ${PRODUCTION_CLOSING}`);
  });

  it("answers that only commercial use is ruled out, and that personal, non-commercial use of the free tier is still allowed", async () => {
    assert.strictEqual(await productionAnswers(withField.base, NO_COMMERCIAL_USE),
      `${commercialUseRuledOut(NO_COMMERCIAL_USE)} ${stableBeside(NO_COMMERCIAL_USE)} ${COMMERCIAL_USE_CLOSING}`);
  });

  it("rates caution beside the vendor's rule by the change that causes it, in place of calling the free tier usable for prototyping", async () => {
    assert.strictEqual(await productionAnswers(withField.base, CAUTION),
      `${productionRuledOut(CAUTION, "production use")} We also rate ${CAUTION.vendor}'s pricing caution, because of one recorded limit reduction, on ${NARROWED_ON}. ${PRODUCTION_CLOSING}`);
  });

  it("rates a restored removal caution beside the vendor's rule, naming its reversal", async () => {
    assert.strictEqual(await productionAnswers(withField.base, RESTORED),
      `${commercialUseRuledOut(RESTORED)} We also rate ${RESTORED.vendor}'s pricing caution. The one change we have recorded, a free tier removal on ${NARROWED_ON}, was reversed on ${RESTORED_ON}. ${COMMERCIAL_USE_CLOSING}`);
  });

  it("keeps today's withheld answer, unchanged, after the vendor's rule", async () => {
    const today = await productionAnswers(withoutField.base, WITHHELD);
    assert.ok(today.includes("we are not recommending it for production or for anything else"), today);
    assert.strictEqual(await productionAnswers(withField.base, WITHHELD), `${productionRuledOut(WITHHELD, "production use")} ${today}`);
  });

  it("states why no rating is published, between the vendor's rule and the free alternatives", async () => {
    const today = await productionAnswers(withoutField.base, UNRATED);
    const usable = `${UNRATED.vendor}'s free tier is usable for prototyping and development. `;
    assert.ok(today.startsWith(usable), today);
    assert.strictEqual(await productionAnswers(withField.base, UNRATED),
      `${productionRuledOut(UNRATED, "production use")} ${today.slice(usable.length)} ${PRODUCTION_CLOSING}`);
  });

  it("leaves out both rating sentences where a gate opens the answer, as today's answer leaves out the rating", async () => {
    const gate = await productionAnswers(withoutField.base, GATED);
    assert.ok(gate.startsWith("We have not been able to confirm this offer since") && gate.endsWith(" days."), gate);
    assert.strictEqual(await productionAnswers(withField.base, GATED), `${gate} ${productionRuledOut(GATED, "production use")} ${PRODUCTION_CLOSING}`);
  });

  it("keeps the history sentence between the vendor's rule and the free alternatives where a gate leaves no level", async () => {
    const gate = await productionAnswers(withoutField.base, GATED_WITH_A_CHANGE);
    assert.ok(gate.startsWith("We have not been able to confirm this offer since") && gate.endsWith(" days."), gate);
    const ruled = await productionAnswers(withField.base, GATED_WITH_A_CHANGE);
    const opening = `${gate} ${productionRuledOut(GATED_WITH_A_CHANGE, "production use")} `;
    assert.ok(ruled.startsWith(opening) && ruled.endsWith(` ${PRODUCTION_CLOSING}`), ruled);
    assert.ok(ruled.slice(opening.length, ruled.length - PRODUCTION_CLOSING.length).includes("warrants caution"), ruled);
  });

  it("keeps today's sentence on the recorded changes after the stable rating", async () => {
    const today = await productionAnswers(withoutField.base, WIDENED);
    const after = "a reasonable starting point. ";
    const changes = today.slice(today.indexOf(after) + after.length, today.indexOf(" Monitor your usage"));
    assert.ok(changes.includes("did not narrow"), today);
    assert.strictEqual(await productionAnswers(withField.base, WIDENED),
      `${productionRuledOut(WIDENED, "production use")} ${stableBeside(WIDENED)} ${changes} ${PRODUCTION_CLOSING}`);
  });

  it("keeps today's withheld answer, with no opening, where the free tier has ended or the listing has none", async () => {
    for (const offer of [ENDED_WITHHELD, NOT_FREE_WITHHELD]) {
      const today = await productionAnswers(withoutField.base, offer);
      assert.ok(today.includes("we are not recommending it for production or for anything else"), today);
      assert.strictEqual(await productionAnswers(withField.base, offer), today, offer.vendor);
    }
  });

  it("answers no where the vendor rules out production for a trial, in the condition's text with its page and the day we read it, then says the trial expires", async () => {
    assert.strictEqual(await productionAnswers(withField.base, TRIAL_NO_PRODUCTION), TRIAL_RULED_OUT(TRIAL_NO_PRODUCTION));
    assert.match(await productionAnswers(withoutField.base, TRIAL_NO_PRODUCTION), /^Not for long\. It is .+, so plan for paid usage before you depend on it\.$/);
  });

  it("keeps today's trial answer where no condition rules out production", async () => {
    const today = await productionAnswers(withoutField.base, TRIAL_NOTED);
    assert.match(today, /^Not for long\. /);
    assert.strictEqual(await productionAnswers(withField.base, TRIAL_NOTED), today);
  });

  it("opens the production answer with no on every listed page that states a condition ruling out production", async () => {
    const ruledOut = catalogue.offers.filter((offer: Offer) => conditionsOf(offer).some(c => (c.rules_out ?? []).includes("production")));
    const listed: string[] = [];
    for (const offer of [...ruledOut, NO_PRODUCTION, NEITHER, TRIAL_NO_PRODUCTION]) {
      const html = await fetchText(withField.base, `/vendor/${toSlug(offer.vendor)}`);
      const rule = conditionsOf(offer).find(c => (c.rules_out ?? []).includes("production"))!;
      if (!decodeHtml(freeTierDetails(html)).includes(rule.text)) continue;
      const answer = [...visibleFaq(html)].find(([question]) => / good for production\?$/.test(question))?.[1];
      assert.ok(answer?.startsWith("No. "), `${offer.vendor}: ${answer}`);
      listed.push(offer.vendor);
    }
    assert.deepStrictEqual(listed.slice(-3), [NO_PRODUCTION.vendor, NEITHER.vendor, TRIAL_NO_PRODUCTION.vendor]);
    assert.ok(listed.length > 3, `no listed vendor states a condition ruling out production: ${ruledOut.map((o: Offer) => o.vendor).join(", ")}`);
  });

  it("gives a listing without the field today's production answer", async () => {
    const answer = visibleFaq(await page(withoutField.base, NO_PRODUCTION)).get(PRODUCTION(NO_PRODUCTION));
    assert.ok(answer, "no production answer");
    for (const words of TODAYS_STABLE_PRODUCTION_WORDS) assert.ok(answer.includes(words), `today's answer lacks "${words}"`);
  });

  it("renders no condition, and no rule in the production answer, under a notice that a recorded change superseded the terms", async () => {
    const html = await page(withField.base, SUPERSEDED);
    assert.ok(html.includes("terms-superseded-text"), "the fixture's terms are not superseded, so the test says nothing");
    assert.ok(!html.includes("superseded-marker"), "a condition renders under the superseded-terms notice");
    assert.strictEqual(html, await page(withoutField.base, SUPERSEDED));
  });

  it("changes nothing else on the listing's own page: rating, badges, alternatives and every other answer", async () => {
    for (const offer of SYNTHETIC.filter(o => o !== SUPERSEDED)) {
      const withIt = await page(withField.base, offer);
      const withoutIt = await page(withoutField.base, offer);
      assert.notStrictEqual(withIt, withoutIt, `${offer.vendor}'s page does not move, so the comparison says nothing`);
      assert.strictEqual(withoutWhatTheFieldMoves(withIt, offer), withoutWhatTheFieldMoves(withoutIt, offer), offer.vendor);
    }
  });

  it("changes another page that lists the listings only by the conditions after each description it prints in full", async () => {
    const databases = catalogue.offers.filter((o: Offer) => o.category === "Databases").slice(0, 3);
    for (const route of ["/category/databases", ...databases.map((o: Offer) => `/vendor/${slugOf(o.vendor)}`)]) {
      const withIt = await fetchText(withField.base, route);
      assert.ok(withIt.includes(NOTED.vendor), `${route} does not list the listings, so the comparison says nothing`);
      assert.strictEqual(withoutConditionsBesideDescriptions(withIt), withoutConditionsBesideDescriptions(await fetchText(withoutField.base, route)), route);
    }
    const category = await fetchText(withField.base, "/category/databases");
    assert.ok(category.includes(`${escapeHtml(NOTED.description)}\n    <ul class="listing-conditions"`), "the category page prints the conditions right after the description");
  });

  it("orders the category in /api/offers as it does without the field", async () => {
    const route = "/api/offers?category=Databases&limit=1000";
    const withIt = (await (await fetch(`${withField.base}${route}`)).json()).offers as Offer[];
    const withoutIt = (await (await fetch(`${withoutField.base}${route}`)).json()).offers as Offer[];
    assert.ok(withIt.some(o => o.vendor === NOTED.vendor), "the category does not list the listings, so the comparison says nothing");
    assert.deepStrictEqual(withIt.map(withoutTheSyntheticConditions), withoutIt);
  });

  it("carries the field in /api/offers and /api/details, and nothing else about the listing moves", async () => {
    for (const offer of SYNTHETIC) {
      const query = `/api/offers?q=${encodeURIComponent(offer.vendor)}&limit=50`;
      const served = (await (await fetch(`${withField.base}${query}`)).json()).offers.find((o: Offer) => o.vendor === offer.vendor);
      const servedWithout = (await (await fetch(`${withoutField.base}${query}`)).json()).offers.find((o: Offer) => o.vendor === offer.vendor);
      assert.deepStrictEqual(served.conditions, offer.conditions, `/api/offers: ${offer.vendor}`);
      assert.deepStrictEqual(withoutConditions(served), servedWithout, `/api/offers: ${offer.vendor}`);
      const details = await (await fetch(`${withField.base}/api/details/${encodeURIComponent(offer.vendor)}`)).json();
      assert.deepStrictEqual(details.offer.conditions, offer.conditions, `/api/details: ${offer.vendor}`);
    }
  });

  it("documents the field on the offer in the OpenAPI spec, with the uses the data may name", async () => {
    const spec = JSON.parse(await fetchText(withField.base, "/api/openapi.json"));
    const documented = spec.components.schemas.Offer.properties.conditions;
    assert.ok(documented, "the Offer schema does not declare conditions");
    assert.deepStrictEqual(documented.items.required, ["text", "quote", "url", "read_on"]);
    assert.deepStrictEqual(documented.items.properties.rules_out.items.enum, [...USES_A_VENDOR_CAN_RULE_OUT]);
    assert.strictEqual(documented.description,
      "A list of the conditions a vendor attaches to using its free tier. Each item holds our sentence (text), the vendor's own words (quote), the page that states them (url) and the date we read that page (read_on). An optional list rules_out names the uses the vendor excludes: \"production\", \"commercial use\" or both. Our re-reads of the vendor's pricing page do not change this field.");
  });

  it("carries the field in search_deals, both when it searches and when it looks a vendor up", async () => {
    const mcp = async (sessionId: string | null, body: object) => {
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      if (sessionId) headers["mcp-session-id"] = sessionId;
      const res = await fetch(`${withField.base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
      const text = await res.text();
      const messages = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      return { messages, sessionId: res.headers.get("mcp-session-id") ?? sessionId };
    };
    const { sessionId } = await mcp(null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });
    await mcp(sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });
    const call = async (id: number, args: Record<string, unknown>) => {
      const { messages } = await mcp(sessionId, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "search_deals", arguments: args } });
      return JSON.parse(messages.find(message => message.id === id).result.content[0].text);
    };
    const searched = await call(2, { query: NO_PRODUCTION.vendor, limit: 50 });
    const found = (searched.results ?? searched.deals ?? []).find((o: Offer) => o.vendor === NO_PRODUCTION.vendor);
    assert.ok(found, "search_deals did not return the listing");
    assert.deepStrictEqual(found.conditions, NO_PRODUCTION.conditions);
    const lookedUp = await call(3, { vendor: NO_PRODUCTION.vendor });
    assert.deepStrictEqual((lookedUp.offer ?? lookedUp).conditions, NO_PRODUCTION.conditions);
  });
});

describe("restatement and its revert leave a listing's conditions as they were", () => {
  const RESTATED_ON = "2026-09-17";
  const offer = {
    vendor: "Restated Conditions Co",
    category: "hosting",
    description: "Free tier: 100 GB of transfer a month.",
    tier: "Free",
    url: "https://restated-conditions-co.example/pricing",
    tags: [],
    verifiedDate: "2026-08-01",
    conditions: [condition("Restated Conditions Co", "restated-marker", ["commercial use"])],
  } as Offer;
  const change = {
    vendor: offer.vendor,
    change_type: "limits_reduced",
    date: "2026-09-07",
    date_source: "vendor_page",
    summary: "The free tier moved to 50 GB.",
    previous_state: offer.description,
    current_state: "The free plan includes 50 GB of transfer a month.",
    impact: "medium",
    source_url: offer.url,
    category: "hosting",
    alternatives: [],
    recorded_date: "2026-09-07",
  };

  it("writes the restated description and leaves the conditions alone, then puts the description back and still leaves them", () => {
    const ruling = ruleOnRestating(offer, change, RESTATED_ON);
    assert.ok(ruling && ruling.refusal === null, "the fixture's reading is refused, so the test says nothing");
    const data = { offers: [structuredClone(offer)] };
    const written = applyRestatements(data, [ruling], RESTATED_ON);
    assert.strictEqual(written.length, 1);
    assert.notStrictEqual(data.offers[0].description, offer.description, "the restatement did not write, so the test says nothing");
    assert.deepStrictEqual(data.offers[0].conditions, offer.conditions);
    const { reverted } = revertRestatement(data, written, offer.vendor, "2026-09-19");
    assert.strictEqual(reverted, true);
    assert.strictEqual(data.offers[0].description, offer.description);
    assert.deepStrictEqual(data.offers[0].conditions, offer.conditions);
  });
});

describe("which rule opens the production answer", () => {
  const production = condition("Rule Co", "production-rule", ["production"]);
  const commercialUse = condition("Rule Co", "commercial-rule", ["commercial use"]);
  const both = condition("Rule Co", "both-rule", ["production", "commercial use"]);
  const neither = condition("Rule Co", "no-rule");

  it("is none where no condition rules out a use", () => {
    assert.strictEqual(theVendorsRuleOnProduction([]), null);
    assert.strictEqual(theVendorsRuleOnProduction([neither]), null);
  });

  it("is the condition that rules out production, ahead of one that rules out only commercial use", () => {
    assert.deepStrictEqual(theVendorsRuleOnProduction([commercialUse, production]), {
      use: "production", alsoRulesOutCommercialUse: false, condition: production,
    });
    assert.deepStrictEqual(theVendorsRuleOnProduction([neither, production]), {
      use: "production", alsoRulesOutCommercialUse: false, condition: production,
    });
    assert.deepStrictEqual(theVendorsRuleOnProduction([both]), {
      use: "production", alsoRulesOutCommercialUse: true, condition: both,
    });
  });

  it("is the commercial-use condition where nothing rules out production", () => {
    assert.deepStrictEqual(theVendorsRuleOnProduction([neither, commercialUse]), {
      use: "commercial use", alsoRulesOutCommercialUse: true, condition: commercialUse,
    });
  });

  it("names commercial use beside production only where the condition it quotes rules out both", () => {
    const opening = (conditions: ListingCondition[]) => productionAnswerOpening("Rule Co", theVendorsRuleOnProduction(conditions)!);
    assert.ok(opening([commercialUse, production]).startsWith("No. Rule Co's free tier is not for production use, by Rule Co's own terms: "));
    assert.ok(opening([both]).startsWith("No. Rule Co's free tier is not for production or commercial use, by Rule Co's own terms: "));
  });

  it("states every condition in plain text with the full address of its page and the date we read it", () => {
    assert.strictEqual(
      conditionsInPlainText([neither, production]),
      `${neither.text} (From ${neither.url}, read ${neither.read_on}.) ${production.text} (From ${production.url}, read ${production.read_on}.)`,
    );
  });

  it("ends the terms' last sentence before the conditions that follow them in plain text", () => {
    const stated = conditionsInPlainText([neither]);
    assert.strictEqual(withConditionsAfter("3 databases and 1 GB of storage", [neither]), `3 databases and 1 GB of storage. ${stated}`);
    assert.strictEqual(withConditionsAfter("3 databases and 1 GB of storage.", [neither]), `3 databases and 1 GB of storage. ${stated}`);
    assert.strictEqual(withConditionsAfter("3 databases and 1 GB of storage", []), "3 databases and 1 GB of storage");
  });
});
