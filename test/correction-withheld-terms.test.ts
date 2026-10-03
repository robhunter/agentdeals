import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  CORRECTED_TERMS_LABEL,
  SUPERSEDED_TERMS_LABEL,
  STORED_TERMS_WITHHELD_PHRASE,
  storedTermsLabel,
  supersededTermsAnswer,
  supersededTermsMetaSentence,
  supersededTermsNotice,
  supersededTermsVerdictSentence,
  supersedingChange,
} = await import("../dist/superseded-description.js");
const { vendorVerdictSentence } = await import("../dist/vendor-verdict.js");
const { toSlug } = await import("../dist/slug.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;
type VendorVerdictInput = import("../src/vendor-verdict.ts").VendorVerdictInput;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const VENDOR = "Fixture Ledger Cloud";

const A_LISTING_OUR_CORRECTION_WITHHOLDS = {
  vendor: VENDOR,
  category: "Monitoring",
  description: "Free plan includes 3 dashboards, 10,000 events a month and 7 days of retention.",
  tier: "Free",
  url: "https://ledger.example/pricing",
  tags: [],
  verifiedDate: daysAgo(5),
  source_check: { checked: daysAgo(5), outcome: "ok", detail: "the page names Fixture Ledger Cloud and states amounts" },
} as unknown as Offer;

const READING = "Free plan: 5 dashboards, 50,000 events a month, 14 days of retention.";

const OUR_CORRECTION_OF_IT = {
  vendor: VENDOR,
  change_type: "record_corrected",
  date: daysAgo(30),
  date_source: "discovered",
  summary: `Data correction - Not a change by ${VENDOR}. An Internet Archive copy of its page from ${daysAgo(200)} already states the terms this record called new.`,
  previous_state: A_LISTING_OUR_CORRECTION_WITHHOLDS.description,
  current_state: READING,
  impact: "low",
  source_url: "https://ledger.example/pricing",
  category: "Monitoring",
  alternatives: [],
  recorded_date: daysAgo(30),
} as unknown as DealChange;

const THE_SAME_RECORD_AS_A_VENDOR_CHANGE = { ...OUR_CORRECTION_OF_IT, change_type: "limits_increased" } as DealChange;
const OUR_CORRECTION_WITHOUT_A_READING = { ...OUR_CORRECTION_OF_IT, current_state: null } as unknown as DealChange;
const A_WITHDRAWN_RECORD = {
  ...THE_SAME_RECORD_AS_A_VENDOR_CHANGE,
  resolution: { state: "retracted", date: daysAgo(10), detail: "No such change happened." },
} as unknown as DealChange;

const OUR_REASON = `our own correction record says they did not match ${VENDOR}'s page`;

describe("stored terms our own correction record withholds", () => {
  it("names the correction, not a previous version, as the reason, beside the reading", () => {
    const notice = supersededTermsNotice(VENDOR, OUR_CORRECTION_OF_IT);
    assert.ok(notice.includes(`We are not publishing our stored ${VENDOR} terms beside it — ${OUR_REASON}.`), notice);
    assert.ok(!notice.includes(STORED_TERMS_WITHHELD_PHRASE), notice);
    assert.ok(!notice.includes("pricing change record"), notice);
    const control = supersededTermsNotice(VENDOR, THE_SAME_RECORD_AS_A_VENDOR_CHANGE);
    assert.ok(control.includes(STORED_TERMS_WITHHELD_PHRASE), control);
  });

  it("dates nothing in the reason, because the record keeps the day of our misreading", () => {
    assert.strictEqual(
      supersededTermsNotice(VENDOR, OUR_CORRECTION_WITHOUT_A_READING),
      `We are not publishing our stored ${VENDOR} terms — ${OUR_REASON}. We have not re-read ${VENDOR}'s pricing page since that record.`,
    );
    const verdict = supersededTermsVerdictSentence(VENDOR, OUR_CORRECTION_OF_IT);
    assert.strictEqual(verdict.split(" — ").pop(), `${OUR_REASON}.`, verdict);
  });

  it("introduces what the record says as our correction record's statement, not as a change", () => {
    const answer = supersededTermsAnswer(VENDOR, OUR_CORRECTION_OF_IT);
    assert.ok(answer.includes(`Our correction record states: ${OUR_CORRECTION_OF_IT.summary}`), answer);
    assert.ok(!answer.includes("What our record says changed"), answer);
    const control = supersededTermsAnswer(VENDOR, THE_SAME_RECORD_AS_A_VENDOR_CHANGE);
    assert.ok(control.includes("What our record says changed:"), control);
  });

  it("says in the meta description that the terms are withheld, and calls nothing superseded", () => {
    const beside = supersededTermsMetaSentence(VENDOR, OUR_CORRECTION_OF_IT);
    assert.ok(beside.endsWith(`Our stored ${VENDOR} terms are withheld.`), beside);
    assert.strictEqual(
      supersededTermsMetaSentence(VENDOR, OUR_CORRECTION_WITHOUT_A_READING),
      `Our stored ${VENDOR} terms are withheld: ${OUR_REASON}.`,
    );
    for (const sentence of [beside, supersededTermsMetaSentence(VENDOR, OUR_CORRECTION_WITHOUT_A_READING)]) {
      assert.ok(!/supersed/i.test(sentence), sentence);
    }
    assert.ok(supersededTermsMetaSentence(VENDOR, THE_SAME_RECORD_AS_A_VENDOR_CHANGE).includes("superseded and withheld"));
  });

  it("labels the notice Withheld where the record is our correction, and Superseded where the vendor changed", () => {
    assert.strictEqual(storedTermsLabel(OUR_CORRECTION_OF_IT), CORRECTED_TERMS_LABEL);
    assert.strictEqual(CORRECTED_TERMS_LABEL, "Withheld");
    assert.strictEqual(storedTermsLabel(THE_SAME_RECORD_AS_A_VENDOR_CHANGE), SUPERSEDED_TERMS_LABEL);
  });
});

function inputWith(over: Partial<VendorVerdictInput>): VendorVerdictInput {
  return {
    vendor: VENDOR,
    tier: "Free",
    level: "stable",
    historyLevel: "stable",
    cause: null,
    changes: [],
    levelWithheld: null,
    unconfirmableSince: "",
    termsConfirmedOn: daysAgo(5),
    lastReadOn: daysAgo(5),
    refusedReads: [],
    ...over,
  } as VendorVerdictInput;
}

const ONE_CORRECTION = "The one record we hold corrects our own earlier entry rather than reporting a change the vendor made.";
const TWO_CORRECTIONS = "All 2 records we hold correct our own earlier entries rather than reporting changes the vendor made.";

describe("a gated or withheld verdict where every record we hold is our own", () => {
  const gated = (changes: DealChange[]) => inputWith({ gate: "eligibility_restricted", changes });
  const withheld = (changes: DealChange[]) =>
    inputWith({ level: null, levelWithheld: "does_not_name_product", unconfirmableSince: daysAgo(9), changes });

  it("ends a gated verdict by saying its one record corrects our own entry", () => {
    const verdict = vendorVerdictSentence(gated([OUR_CORRECTION_OF_IT]));
    assert.ok(verdict.endsWith(` ${ONE_CORRECTION}`), verdict);
  });

  it("ends a withheld verdict with the plural form where it holds two corrections", () => {
    const verdict = vendorVerdictSentence(withheld([OUR_CORRECTION_OF_IT, { ...OUR_CORRECTION_OF_IT, date: daysAgo(60) }]));
    assert.ok(verdict.endsWith(` ${TWO_CORRECTIONS}`), verdict);
    assert.ok(verdict.includes("cannot confirm these terms today"), verdict);
  });

  it("says nothing of the kind where a record of the vendor's own sits beside the correction", () => {
    for (const input of [gated([OUR_CORRECTION_OF_IT, THE_SAME_RECORD_AS_A_VENDOR_CHANGE]), withheld([OUR_CORRECTION_OF_IT, THE_SAME_RECORD_AS_A_VENDOR_CHANGE])]) {
      const verdict = vendorVerdictSentence(input);
      assert.ok(!/corrects? our own earlier entr/.test(verdict), verdict);
    }
  });

  it("leaves a verdict whose only record was withdrawn as it was", () => {
    for (const input of [gated([A_WITHDRAWN_RECORD]), withheld([A_WITHDRAWN_RECORD])]) {
      assert.strictEqual(vendorVerdictSentence(input), vendorVerdictSentence({ ...input, changes: [] }));
    }
  });
});

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

const unescaped = (html: string): string =>
  html
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function faqAnswer(html: string, question: string): string {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed["@type"] !== "FAQPage") continue;
      const found = parsed.mainEntity.find((q: { name: string }) => q.name === question);
      if (found) return found.acceptedAnswer.text;
    } catch { continue; }
  }
  return "";
}

const proseOf = (html: string): string =>
  unescaped(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " "));

describe("the vendor page of a listing our own correction record withholds", () => {
  let scratch = "";
  let server: { proc: ChildProcess; port: number } | null = null;
  let page = "";
  let category = "";
  let comparison = "";

  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "correction-withheld-"));
    const index = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8"));
    const partner = (index.offers as Offer[]).find((o) => o.category === "Monitoring")!.vendor;
    index.offers.push(A_LISTING_OUR_CORRECTION_WITHHOLDS);
    const log = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8"));
    log.changes.push(OUR_CORRECTION_OF_IT);
    writeFileSync(path.join(scratch, "index.json"), JSON.stringify(index));
    writeFileSync(path.join(scratch, "deal_changes.json"), JSON.stringify(log));
    server = await startServer({
      AGENTDEALS_INDEX_PATH: path.join(scratch, "index.json"),
      AGENTDEALS_CHANGES_PATH: path.join(scratch, "deal_changes.json"),
    });
    page = await fetch(`http://localhost:${server.port}/vendor/${toSlug(VENDOR)}`).then((r) => r.text());
    category = await fetch(`http://localhost:${server.port}/category/${toSlug("Monitoring")}`).then((r) => r.text());
    comparison = await fetch(`http://localhost:${server.port}/compare/${toSlug(VENDOR)}-vs-${toSlug(partner)}`).then((r) => r.text());
  });

  after(() => {
    server?.proc.kill();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("withholds the listing's stored terms behind the correction on every surface that would state them", () => {
    assert.strictEqual(supersedingChange(A_LISTING_OUR_CORRECTION_WITHHOLDS, [OUR_CORRECTION_OF_IT]), OUR_CORRECTION_OF_IT);
    const surfaces: Record<string, string> = {
      "free tier details": page.match(/<div class="desc-block">[\s\S]*?<\/div>/)?.[0] ?? "",
      "quick verdict": page.match(/<div class="quick-verdict">[\s\S]*?<\/div>/)?.[0] ?? "",
      "meta description": page.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "",
      "free-tier answer": faqAnswer(page, `Is ${VENDOR} free?`),
    };
    for (const [surface, text] of Object.entries(surfaces)) {
      assert.ok(text.length > 0, `no ${surface} on the page`);
      assert.ok(!proseOf(text).includes(A_LISTING_OUR_CORRECTION_WITHHOLDS.description), `the ${surface} still states the terms our correction says never matched`);
    }
  });

  it("labels the notice Withheld on the vendor page, in the category table and on a comparison", () => {
    assert.ok(page.includes(`<strong>${CORRECTED_TERMS_LABEL}:</strong>`), "no Withheld label on the vendor page");
    assert.ok(category.includes(`<strong>${CORRECTED_TERMS_LABEL}:</strong>`), "no Withheld label in the category table");
    assert.ok(proseOf(category).includes(OUR_REASON), "the category row does not give the correction as its reason");
    assert.ok(comparison.includes(`<strong>${CORRECTED_TERMS_LABEL}:</strong>`), "no Withheld label on the comparison");
    assert.ok(!page.includes(`<strong>${SUPERSEDED_TERMS_LABEL}:</strong>`), "a Superseded label beside our own correction");
  });

  it("calls nothing on the page superseded", () => {
    const prose = proseOf(page);
    assert.ok(!/supersed/i.test(prose), prose.match(/.{0,120}supersed.{0,120}/i)?.[0]);
    assert.ok(!/supersed/i.test(unescaped(page.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "")));
  });

  it("answers the production question without naming figures we superseded", () => {
    const answer = faqAnswer(page, `Is ${VENDOR}'s free tier good for production?`);
    assert.ok(answer.endsWith(`so we are not recommending it for production.`), answer);
    assert.ok(answer.includes(OUR_REASON), answer);
  });

  it("introduces the record in the free-tier answer as our correction record's statement", () => {
    const answer = faqAnswer(page, `Is ${VENDOR} free?`);
    assert.ok(answer.includes(`Our correction record states: ${OUR_CORRECTION_OF_IT.summary}`), answer);
  });

  it("ends the verdict by saying the one record we hold corrects our own entry", () => {
    const verdict = proseOf(page.match(/<div class="quick-verdict">[\s\S]*?<\/div>/)?.[0] ?? "").replace(/\s+/g, " ").trim();
    assert.ok(verdict.includes(OUR_REASON), verdict);
    assert.ok(verdict.endsWith(ONE_CORRECTION), verdict);
  });
});
