import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  offerEnded,
  offerRetired,
  endedHeadline,
  endedVerdictSentence,
  endedHistorySentence,
  endedReliabilitySentence,
  endedEmptyChangeHistorySentence,
  ENDED_BADGE_LABEL,
  ENDED_OFFER_CLAUSE,
  ENDED_SINCE_CHANGES_SENTENCE,
} = await import("../dist/retirement.js");
const { vendorVerdictSentence, vendorVerdictWord } = await import("../dist/vendor-verdict.js");
const { classifyTier, gateFor, rankOffers } = await import("../dist/ranking.js");

type Offer = import("../src/types.ts").Offer;
type DealChange = import("../src/types.ts").DealChange;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
const dealChanges: DealChange[] = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;

const TODAY = "2026-09-01";

function slugOf(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const endedRecords = offers.filter(o => offerEnded(o));
const retiredButNotEnded = offers.filter(o => offerRetired(o) && !offerEnded(o));

let port = 0;
let proc: ChildProcess | null = null;
const pages = new Map<string, string>();

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { port = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function page(pathname: string): Promise<string> {
  const cached = pages.get(pathname);
  if (cached !== undefined) return cached;
  const res = await fetch(`http://localhost:${port}${pathname}`);
  const body = await res.text();
  pages.set(pathname, body);
  return body;
}

function headingOf(html: string): string {
  const m = /<h1>([\s\S]*?)<\/h1>/.exec(html);
  return m ? m[1] : "";
}

function titleOf(html: string): string {
  const m = /<title>([\s\S]*?)<\/title>/.exec(html);
  return m ? m[1] : "";
}

function faqAnswer(html: string, questionFragment: string): string {
  const pattern = new RegExp(`"name":"([^"]*${questionFragment}[^"]*)","acceptedAnswer":\\{"@type":"Answer","text":"([\\s\\S]*?)"\\}`);
  const m = pattern.exec(html);
  return m ? m[2] : "";
}

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

before(async () => {
  proc = await startServer();
  for (const o of endedRecords) await page(`/vendor/${slugOf(o.vendor)}`);
  for (const o of retiredButNotEnded) await page(`/vendor/${slugOf(o.vendor)}`);
});

after(() => { proc?.kill(); });

describe("the sentences an ended offer publishes", () => {
  it("shares one clause across every form that names the ending", () => {
    assert.strictEqual(ENDED_OFFER_CLAUSE, "the offer has ended");
    assert.ok(endedHistorySentence("Acme").includes(ENDED_OFFER_CLAUSE));
    assert.ok(endedEmptyChangeHistorySentence("Acme").includes(ENDED_OFFER_CLAUSE));
  });

  it("heads the page and badges it", () => {
    assert.strictEqual(endedHeadline("Acme"), "Acme — free tier retired");
    assert.strictEqual(ENDED_BADGE_LABEL, "retired");
  });

  it("says the ending in the verdict without rating it", () => {
    assert.strictEqual(
      endedVerdictSentence(),
      "This offer has ended — we keep the page for the record and no longer rate it.",
    );
  });

  it("says an empty history is not evidence of stability", () => {
    assert.strictEqual(
      endedHistorySentence("Acme"),
      "No recorded pricing changes for Acme — but the offer has ended, so this history describes a tier that is no longer available. An empty history is not evidence of stability here.",
    );
  });

  it("says there is nothing to rate", () => {
    assert.strictEqual(
      endedReliabilitySentence("Acme"),
      "Acme has ended this offer, so there is nothing to rate. We keep the page so the question has an answer, but a stability judgement only applies to an offer you can still get.",
    );
  });

  it("says the empty history describes a tier that is gone", () => {
    assert.strictEqual(
      endedEmptyChangeHistorySentence("Acme"),
      "Acme has no recorded pricing changes, but the offer has ended — so the empty history describes a tier that is no longer available, not a stable one.",
    );
  });

  it("says the ending follows the changes it does hold", () => {
    assert.strictEqual(ENDED_SINCE_CHANGES_SENTENCE, "The offer has since ended.");
  });
});

describe("a tier closed to new accounts is not a free offer", () => {
  it("has a subject in the index", () => {
    const carriers = offers.filter(o => /^legacy free$/i.test(o.tier.trim()));
    assert.ok(carriers.length > 0, "no record carries the Legacy Free tier any more");
  });

  it("classifies the tier as not free, with the note the gate publishes", () => {
    assert.deepStrictEqual(classifyTier("Legacy Free"), {
      class: "not_free",
      note: "a free tier closed to new accounts",
    });
  });

  it("gates every carrier as not_a_free_offer rather than by eligibility", () => {
    for (const offer of offers.filter(o => /^legacy free$/i.test(o.tier.trim()))) {
      const gate = gateFor(offer, TODAY);
      assert.strictEqual(gate?.code, "not_a_free_offer", `${offer.vendor} took a different gate`);
      assert.strictEqual(gate?.reason, `Tier "${offer.tier}" is a free tier closed to new accounts.`);
    }
  });

  it("removes every carrier from its category's qualified set", () => {
    for (const offer of offers.filter(o => /^legacy free$/i.test(o.tier.trim()))) {
      const ranking = rankOffers(offers.filter(o => o.category === offer.category), {
        queryKey: `best-of:${offer.category}`,
        changes: dealChanges,
        date: TODAY,
      });
      assert.ok(
        !ranking.qualified.some((q: { offer: Offer }) => q.offer.vendor === offer.vendor),
        `${offer.vendor} is still ranked in ${offer.category}`,
      );
    }
  });

  it("matches the whole tier string, not a word inside it", () => {
    for (const near of ["Legacy Free Plus", "Free", "Legacy", "Legacy Free Tier", "Extended Legacy Free"]) {
      assert.notStrictEqual(
        classifyTier(near).note,
        "a free tier closed to new accounts",
        `${near} was read as a closed legacy tier`,
      );
    }
  });
});

describe("an ended offer is not rated, on every surface that rates one", () => {
  it("has subjects in the index", () => {
    assert.ok(endedRecords.length > 0, "no record carries an ended tier");
  });

  it("heads the page with the retirement form and badges it retired", async () => {
    for (const record of endedRecords) {
      const heading = headingOf(await page(`/vendor/${slugOf(record.vendor)}`));
      assert.ok(heading.includes(endedHeadline(record.vendor)), `${record.vendor} still heads with the free-tier form`);
      assert.ok(!/Free Tier \d{4}/.test(heading), `${record.vendor} still heads with a free-tier year`);
      assert.match(heading, new RegExp(`risk-badge[^>]*>${ENDED_BADGE_LABEL}<`), `${record.vendor} carries no retired badge`);
    }
  });

  it("says the offer has ended in the quick verdict", async () => {
    for (const record of endedRecords) {
      const html = await page(`/vendor/${slugOf(record.vendor)}`);
      const verdict = /<div class="quick-verdict">([\s\S]*?)<\/div>/.exec(html);
      assert.ok(verdict, `${record.vendor} has no quick verdict`);
      assert.ok(textOf(verdict![1]).includes(endedVerdictSentence()), `${record.vendor} still publishes a rating in its verdict`);
    }
  });

  it("says an empty history is not evidence of stability", async () => {
    for (const record of endedRecords) {
      const html = await page(`/vendor/${slugOf(record.vendor)}`);
      const changes = dealChanges.filter(c => c.vendor.toLowerCase() === record.vendor.toLowerCase());
      if (changes.length > 0) continue;
      assert.ok(
        textOf(html).includes(endedHistorySentence(record.vendor)),
        `${record.vendor} still reads its empty history as a good sign`,
      );
    }
  });

  it("answers the reliability question with nothing to rate", async () => {
    for (const record of endedRecords) {
      const html = await page(`/vendor/${slugOf(record.vendor)}`);
      assert.strictEqual(
        faqAnswer(html, "free tier reliable"),
        endedReliabilitySentence(record.vendor),
        `${record.vendor} still publishes a reliability judgement`,
      );
    }
  });

  it("names the ending in the change-history answer, whichever branch it takes", async () => {
    for (const record of endedRecords) {
      const html = await page(`/vendor/${slugOf(record.vendor)}`);
      const answer = faqAnswer(html, "changed in");
      assert.ok(answer.length > 0, `${record.vendor} has no change-history answer`);
      assert.ok(
        answer.includes(ENDED_OFFER_CLAUSE) || answer.includes(ENDED_SINCE_CHANGES_SENTENCE),
        `${record.vendor} answers the change question without naming the ending: ${answer}`,
      );
      const changes = dealChanges.filter(c => c.vendor.toLowerCase() === record.vendor.toLowerCase());
      if (changes.length === 0) {
        assert.strictEqual(answer, endedEmptyChangeHistorySentence(record.vendor));
      } else {
        assert.ok(answer.endsWith(ENDED_SINCE_CHANGES_SENTENCE), `${record.vendor} drops the ending after its recorded changes`);
      }
    }
  });

  it("publishes no stability reassurance anywhere on an ended record's page", async () => {
    const reassurances = [
      "This is a good sign — stable pricing",
      "is considered stable",
      "This is a positive stability signal",
      "It's stable — zero pricing changes recorded",
    ];
    for (const record of endedRecords) {
      const text = textOf(await page(`/vendor/${slugOf(record.vendor)}`));
      for (const phrase of reassurances) {
        assert.ok(!text.includes(phrase), `${record.vendor} still publishes "${phrase}"`);
      }
    }
  });
});

describe("the retirement branch is decided before the withholding branch", () => {
  const withheldAndEnded = {
    vendor: "Oaysus",
    level: null,
    cause: null,
    changes: [],
    levelWithheld: "states_no_terms" as const,
    unconfirmableSince: "",
    offerEnded: true,
  };

  it("states the ending rather than our inability to read the page", () => {
    assert.strictEqual(vendorVerdictSentence(withheldAndEnded), endedVerdictSentence());
    assert.strictEqual(vendorVerdictWord(withheldAndEnded), null);
  });

  it("publishes no rating word for an ended offer whose page we can read", () => {
    const endedOnly = { ...withheldAndEnded, levelWithheld: null, level: "stable" as const };
    assert.strictEqual(vendorVerdictSentence(endedOnly), endedVerdictSentence());
    assert.strictEqual(vendorVerdictWord(endedOnly), null);
  });

  it("still rates a live offer whose page we can read", () => {
    const live = { ...withheldAndEnded, levelWithheld: null, offerEnded: false, level: "stable" as const };
    assert.strictEqual(vendorVerdictWord(live), "stable");
  });

  it("still withholds when the offer has not ended", () => {
    const withheldOnly = { ...withheldAndEnded, offerEnded: false };
    assert.notStrictEqual(vendorVerdictSentence(withheldOnly), endedVerdictSentence());
    assert.strictEqual(vendorVerdictWord(withheldOnly), null);
  });

  it("covers records that would otherwise never reach the retirement copy", async () => {
    const withholding = endedRecords.filter(o => o.source_check?.outcome === "states_no_terms");
    assert.ok(withholding.length > 0, "no ended record withholds a level, so the ordering is untested by the data");
    for (const record of withholding) {
      const text = textOf(await page(`/vendor/${slugOf(record.vendor)}`));
      assert.ok(text.includes(endedVerdictSentence()), `${record.vendor} took the withholding branch instead`);
    }
  });
});

describe("a deprecated offer the ranker still rates keeps its rating", () => {
  it("has a subject in the index", () => {
    assert.ok(retiredButNotEnded.length > 0, "no record is retired-worded without being ended");
  });

  it("is not headed as retired and keeps its published rating", async () => {
    for (const record of retiredButNotEnded) {
      const html = await page(`/vendor/${slugOf(record.vendor)}`);
      const heading = headingOf(html);
      assert.ok(!heading.includes(endedHeadline(record.vendor)), `${record.vendor} is headed as ended`);
      assert.ok(!textOf(html).includes(endedVerdictSentence()), `${record.vendor} is told it has ended`);
    }
  });

  it("is demoted rather than gated, which is why it still has something to rate", () => {
    for (const record of retiredButNotEnded) {
      const ranking = rankOffers(offers.filter(o => o.category === record.category), {
        queryKey: `best-of:${record.category}`,
        changes: dealChanges,
        date: TODAY,
      });
      assert.ok(
        !ranking.excluded.some((e: { offer: Offer }) => e.offer.vendor === record.vendor),
        `${record.vendor} is gated, so the page should say the offer ended`,
      );
    }
  });
});

describe("the live catalog keeps the page it had", () => {
  it("heads all but the ended records with the form their own title uses", async () => {
    const live = offers.filter(o => !offerEnded(o)).slice(0, 60);
    let headed = 0;
    let titled = 0;
    for (const record of live) {
      const html = await page(`/vendor/${slugOf(record.vendor)}`);
      const heading = headingOf(html);
      if (/Free Tier \d{4}/.test(heading)) headed++;
      if (/ Free Tier \d{4}:/.test(titleOf(html))) titled++;
      assert.ok(!heading.includes("free tier retired"), `${record.vendor} is headed as retired`);
    }
    assert.ok(titled > 0, "no live record in this sample carries the free-tier title");
    assert.strictEqual(headed, titled, `${titled - headed} live records lost the free-tier heading`);
  });
});
