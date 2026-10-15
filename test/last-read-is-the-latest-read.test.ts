import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const {
  NO_CONFIRMATION_HELD,
  contradictedTermsSentence,
  figuresInASentence,
  figuresTheCheckStated,
  figuresTheCheckStatedOnce,
  lastReadDate,
  lastReadNote,
  latestReadWeHold,
  readThatContradictsOurTerms,
  statesAnAmountOfZero,
} = await import("../dist/read-date.js");
const {
  measuredNoDifferenceThenReadAgainClause,
  readHadNoStandingClause,
  readHadNoStandingThenReadAgainClause,
  theRefusedReadAlone,
  unreconciledReadThenReadAgainClause,
} = await import("../dist/change-refusal.js");
const { resetVerificationStateCache } = await import("../dist/verification-state.js");
const { resetRefusalStoreCache } = await import("../dist/refusal-store.js");
const { refusalsForVendor } = await import("../dist/data.js");
const { figuresWeAlsoPublish } = await import("../scripts/change-gate.js");
const { statesAnAmountOfZero: writerReadsAZero } = await import("../scripts/vendor-naming.js");
const { reportedFigures } = await import("../scripts/withdraw-figures-we-do-not-publish.js");

const VENDOR = "Examplebase";
const URL = "https://examplebase.dev/pricing";

interface StateRecord {
  vendor: string;
  url: string;
  last_attempt_at: string | null;
  last_outcome: string | null;
  last_success: string | null;
  last_read_at?: string | null;
}

interface Refusal {
  vendor: string;
  reason: string;
  refused_date: string;
  source_url: string | null;
}

interface Listing {
  vendor: string;
  url: string;
  verifiedDate: string;
  description?: string;
  source_check?: { checked: string; outcome: string; detail: string };
  restated_from?: { reading_date: string; source_url: string };
}

const rotation = (over: Partial<StateRecord> = {}): StateRecord => ({
  vendor: VENDOR,
  url: URL,
  last_attempt_at: "2026-08-20",
  last_outcome: "states_no_price",
  last_success: null,
  last_read_at: "2026-08-20",
  ...over,
});

const refusal = (over: Partial<Refusal> = {}): Refusal => ({
  vendor: VENDOR,
  reason: "unquantified_limit",
  refused_date: "2026-09-11",
  source_url: URL,
  ...over,
});

const listing = (over: Partial<Listing> = {}): Listing => ({ vendor: VENDOR, url: URL, verifiedDate: "2026-07-14", ...over });

const FOURSQUARE_CHECK = {
  checked: "2026-10-06",
  outcome: "ok",
  detail: 'the page names Foursquare as "foursquare" and states "$0" and "$0.00" and "$15.00" and "$12.00"',
};

const FOURSQUARE_PRICES = "Places API Pro endpoints: 0-500 Calls $0.00 CPM, 501 to 100,000 Calls $15.00 CPM,"
  + " 100,001 to 500,000 Calls $12.00 CPM, 500,001+ Calls $9.00 CPM. Places API Premium endpoints:"
  + " 0-100,000 Calls $18.75 CPM, 100,001 to 500,000 Calls $15.00 CPM, 500,001+ Calls $11.25 CPM.";

const foursquare = (description: string): Listing => listing({
  vendor: "Foursquare",
  url: "https://foursquare.com/pricing/",
  verifiedDate: "2026-08-25",
  description,
  source_check: FOURSQUARE_CHECK,
});

const passingCheck = (checked: string, figures: string[]) => ({
  checked,
  outcome: "ok",
  detail: `the page names ${VENDOR} as "examplebase" and states ${figures.map(f => `"${f}"`).join(" and ")}`,
});

let scratch = "";
const originalState = process.env.AGENTDEALS_VERIFICATION_STATE_PATH;
const originalRefusals = process.env.AGENTDEALS_REFUSALS_PATH;

function holding(records: StateRecord[], refusals: Refusal[] = []): void {
  writeFileSync(join(scratch, "verification_state.json"), JSON.stringify({ generated_at: "2026-10-01", records }));
  writeFileSync(join(scratch, "change_refusals.json"), JSON.stringify({ refusals }));
  resetVerificationStateCache();
  resetRefusalStoreCache();
}

const noteFor = (offer: Listing, refusals: Refusal[] = []) =>
  lastReadNote(offer, null, refusals.map(r => ({ reason: r.reason, refused_date: r.refused_date })));

describe("the Last read date and the read it names", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "latest-read-"));
    process.env.AGENTDEALS_VERIFICATION_STATE_PATH = join(scratch, "verification_state.json");
    process.env.AGENTDEALS_REFUSALS_PATH = join(scratch, "change_refusals.json");
  });

  after(() => {
    if (originalState === undefined) delete process.env.AGENTDEALS_VERIFICATION_STATE_PATH;
    else process.env.AGENTDEALS_VERIFICATION_STATE_PATH = originalState;
    if (originalRefusals === undefined) delete process.env.AGENTDEALS_REFUSALS_PATH;
    else process.env.AGENTDEALS_REFUSALS_PATH = originalRefusals;
    resetVerificationStateCache();
    resetRefusalStoreCache();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("is the day of a source check that read the page after the rotation did", () => {
    holding([rotation()]);
    const offer = listing({ source_check: passingCheck("2026-09-20", ["40 requests per minute"]) });
    assert.strictEqual(lastReadDate(offer), "2026-09-20");
    assert.deepStrictEqual(latestReadWeHold(offer), { kind: "source_check", on: "2026-09-20" });
  });

  it("is the day of a refused change read from the page we cite, where nothing read it later", () => {
    holding([rotation({ last_attempt_at: "2026-10-04", last_outcome: "fetch_failed" })], [refusal()]);
    assert.strictEqual(lastReadDate(listing()), "2026-09-11");
  });

  it("is the day of the read our terms were restated from, where nothing read the page later", () => {
    holding([rotation()]);
    const offer = listing({ restated_from: { reading_date: "2026-09-07", source_url: URL } });
    assert.strictEqual(lastReadDate(offer), "2026-09-07");
  });

  it("does not move for a refusal or a restatement that read another page", () => {
    holding([rotation()], [refusal({ source_url: "https://examplebase.dev/limits" })]);
    const offer = listing({ restated_from: { reading_date: "2026-09-07", source_url: "https://examplebase.dev/limits" } });
    assert.strictEqual(lastReadDate(offer), "2026-08-20");
  });

  it("does not move for a fetch that never reached the page", () => {
    holding([rotation({ last_attempt_at: "2026-10-04", last_outcome: "fetch_failed" })]);
    const offer = listing({ source_check: { checked: "2026-10-05", outcome: "unreadable", detail: "HTTP 403" } });
    assert.strictEqual(lastReadDate(offer), "2026-08-20");
  });

  it("keeps describing the rotation's read where a source check read the page the same day", () => {
    holding([rotation({ last_attempt_at: "2026-09-20", last_read_at: "2026-09-20" })]);
    const offer = listing({ source_check: passingCheck("2026-09-20", ["40 requests per minute"]) });
    assert.strictEqual(latestReadWeHold(offer)!.kind, "rotation");
    assert.match(noteFor(offer), /could read no amount, tier or rate on the page/);
  });

  it("describes the source check where a refusal was recorded the same day", () => {
    holding([rotation()], [refusal({ refused_date: "2026-09-20" })]);
    const offer = listing({ source_check: { checked: "2026-09-20", outcome: "does_not_name_vendor", detail: `the page never names ${VENDOR}` } });
    assert.strictEqual(latestReadWeHold(offer)!.kind, "source_check");
  });
});

describe("what the Last read note says that read found", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "latest-read-note-"));
    process.env.AGENTDEALS_VERIFICATION_STATE_PATH = join(scratch, "verification_state.json");
    process.env.AGENTDEALS_REFUSALS_PATH = join(scratch, "change_refusals.json");
  });

  after(() => {
    if (originalState === undefined) delete process.env.AGENTDEALS_VERIFICATION_STATE_PATH;
    else process.env.AGENTDEALS_VERIFICATION_STATE_PATH = originalState;
    if (originalRefusals === undefined) delete process.env.AGENTDEALS_REFUSALS_PATH;
    else process.env.AGENTDEALS_REFUSALS_PATH = originalRefusals;
    resetVerificationStateCache();
    resetRefusalStoreCache();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("names the one figure the check stated, and claims no missing confirmation", () => {
    holding([rotation()]);
    const note = noteFor(listing({
      description: "The free plan allows 40 requests per minute.",
      source_check: passingCheck("2026-10-12", ["40 requests per minute"]),
    }));
    assert.strictEqual(
      note,
      "The day we last read the vendor's page. On 2026-10-12, the page we cite for Examplebase stated 40 requests per minute, a figure this listing gives.",
    );
    assert.ok(!note.includes(NO_CONFIRMATION_HELD), note);
  });

  it("joins two figures with and, and three or more with commas and a final and", () => {
    holding([rotation()]);
    const description = "Model A costs $2.00 input and $6.00 output per 1M tokens, and model B $1.00 input and $1.25 output.";
    assert.match(
      noteFor(listing({ description, source_check: passingCheck("2026-10-06", ["$2.00", "$6.00"]) })),
      /stated \$2\.00 and \$6\.00, figures this listing gives\.$/,
    );
    assert.match(
      noteFor(listing({ description, source_check: passingCheck("2026-10-06", ["$2.00", "$6.00", "$1.00", "$1.25"]) })),
      /On 2026-10-06, the page we cite for Examplebase stated \$2\.00, \$6\.00, \$1\.00 and \$1\.25, figures this listing gives\.$/,
    );
    assert.strictEqual(figuresInASentence(["A", "B", "C"]), "A, B and C");
  });

  it("says only what the check looks for where the only figure it stated is a price of zero", () => {
    holding([rotation()]);
    const note = noteFor(listing({ description: "The free plan costs $0 a month.", source_check: passingCheck("2026-10-04", ["$0"]) }));
    assert.match(note, /Our last read of it, on 2026-10-04, checked the page for Examplebase's name and a price\./);
    assert.match(note, new RegExp(`${NO_CONFIRMATION_HELD} — the 2026-07-14 beside this date`));
  });

  for (const [outcome, detail] of [
    ["does_not_name_vendor", `the page never names ${VENDOR}, on a domain that carries its name`],
    ["does_not_name_product", `the page names the platform in the domain we cite ${VENDOR} from and never names it`],
    ["states_a_free_price", `the page names ${VENDOR} and states its price in words as "Free forever"`],
    ["states_no_amount", `the page names ${VENDOR} and says "starts at" but states no amount, rate or price we can read`],
    ["ok", `the page names ${VENDOR} as "examplebase" and states amounts, none of which we matched to the terms we publish`],
  ] as const) {
    it(`says what the check looks for after a check that came back ${outcome}`, () => {
      holding([rotation()]);
      const note = noteFor(listing({ source_check: { checked: "2026-10-10", outcome, detail } }));
      assert.match(note, /^The day we last read the vendor's page\. Our last read of it, on 2026-10-10, checked the page for Examplebase's name and a price\. /);
      assert.ok(note.includes(NO_CONFIRMATION_HELD), note);
    });
  }

  it("keeps its own clause for a check that read no terms on the page", () => {
    holding([rotation()]);
    const note = noteFor(listing({ source_check: { checked: "2026-10-12", outcome: "states_no_terms", detail: `the page names ${VENDOR} but states no amount, tier or rate we can read` } }));
    assert.match(note, /Our last read of it, on 2026-10-12, could read no amount, tier or rate on the page\./);
  });

  it("says a refused read found the page different, where that refusal did not settle the read", () => {
    const refused = [refusal()];
    holding([rotation({ last_attempt_at: "2026-10-04", last_outcome: "fetch_failed" })], refused);
    assert.strictEqual(
      noteFor(listing({ verifiedDate: "2026-07-16" }), refused),
      "The day we last read the vendor's page. Our last read of it, on 2026-09-11, found the page different from the terms we hold."
        + ` ${NO_CONFIRMATION_HELD} — the 2026-07-16 beside this date is not one we can source to a read that confirmed them.`
        + " We tried again on 2026-10-04 and did not read the page, so that attempt confirmed nothing.",
    );
  });

  it("says a refused read found the terms we published, where the refusal restated them", () => {
    const refused = [refusal({ reason: "confirmed_unchanged", refused_date: "2026-09-10" })];
    holding([rotation({ last_attempt_at: "2026-09-28", last_outcome: "fetch_failed" })], refused);
    assert.strictEqual(
      noteFor(listing({ verifiedDate: "2026-08-20" }), refused),
      "The day we last read the vendor's page. Our last read of it, on 2026-09-10, found the terms we published that day."
        + " We tried again on 2026-09-28 and did not read the page, so that attempt confirmed nothing.",
    );
  });

  it("says the terms came from the read it names, where that read is the restatement's", () => {
    holding([rotation()]);
    const note = noteFor(listing({ restated_from: { reading_date: "2026-09-07", source_url: URL } }));
    assert.match(note, /Our last read of it, on 2026-09-07, is where the terms above come from\./);
  });

  it("keeps saying an earlier read found the page different, where nothing settled that read", () => {
    holding([rotation({ last_attempt_at: "2026-09-21", last_outcome: "changed", last_read_at: "2026-09-21" })]);
    const note = noteFor(listing({ source_check: passingCheck("2026-10-04", ["$0"]) }));
    assert.strictEqual(
      note,
      "The day we last read the vendor's page. Our last read of it, on 2026-10-04, checked the page for Examplebase's name and a price."
        + " Our read on 2026-09-21 found the page different from the terms we hold, and we hold no confirmation of the terms we publish.",
    );
  });

  it("keeps saying an earlier read found the page different beside the figures a later check stated", () => {
    holding([rotation({ last_attempt_at: "2026-09-26", last_outcome: "changed", last_read_at: "2026-09-26" })]);
    const note = noteFor(listing({
      description: "Basic is $10.00 a month and Pro is $50.00 a month.",
      source_check: passingCheck("2026-10-02", ["$10.00", "$50.00"]),
    }));
    assert.strictEqual(
      note,
      "The day we last read the vendor's page. On 2026-10-02, the page we cite for Examplebase stated $10.00 and $50.00, figures this listing gives."
        + " Our read on 2026-09-26 found the page different from the terms we hold, and we hold no confirmation of the terms we publish.",
    );
  });

  it("states an earlier difference once, where the refusal the rating waits on already states that read", () => {
    holding([rotation({ last_attempt_at: "2026-10-01", last_outcome: "changed", last_read_at: "2026-10-01" })], [refusal({ refused_date: "2026-10-01" })]);
    const offer = listing({ source_check: passingCheck("2026-10-06", ["$0"]) });
    const waitsOn = { clause: "when we read the page we cite for this offer on 2026-10-01, we found a change we could not reconcile with the terms we publish", on: "2026-10-01" };
    const note = lastReadNote(offer, null, [{ reason: "unquantified_limit", refused_date: "2026-10-01" }], waitsOn);
    assert.ok(!note.includes("found the page different"), note);
    assert.ok(note.includes(NO_CONFIRMATION_HELD), note);
    assert.ok(note.endsWith("When we read the page we cite for this offer on 2026-10-01, we found a change we could not reconcile with the terms we publish."), note);
  });

  it("quotes only the figures the description still gives, after a data change moves one the check stated", () => {
    holding([]);
    assert.strictEqual(
      noteFor(foursquare(FOURSQUARE_PRICES)),
      "The day we last read the vendor's page. On 2026-10-06, the page we cite for Foursquare stated $0, $0.00, $15.00 and $12.00, figures this listing gives.",
    );
    assert.strictEqual(
      noteFor(foursquare(FOURSQUARE_PRICES.replaceAll("$15.00", "$14.50"))),
      "The day we last read the vendor's page. On 2026-10-06, the page we cite for Foursquare stated $0, $0.00 and $12.00, figures this listing gives.",
    );
  });

  it("says only what the check looks for where the description no longer gives a figure the check stated", () => {
    holding([]);
    const note = noteFor(foursquare("Places API Pro endpoints: 501 to 100,000 Calls $14.50 CPM."));
    assert.match(note, /^The day we last read the vendor's page\. Our last read of it, on 2026-10-06, checked the page for Foursquare's name and a price\. /);
    assert.ok(note.includes(NO_CONFIRMATION_HELD), note);
  });

  it("quotes each figure once, without the punctuation the page set after it", () => {
    holding([]);
    const check = { checked: "2026-10-01", outcome: "ok", detail: 'the page names Hexclave as "hexclave" and states "$0," and "$0" and "1,000 emails per month"' };
    assert.deepStrictEqual(figuresTheCheckStatedOnce(check), ["$0", "1,000 emails per month"]);
    const note = noteFor(listing({
      vendor: "Hexclave",
      url: "https://www.hexclave.com/pricing",
      description: "Free tier is $0 forever: up to 10,000 auth users, 1 dashboard admin, 1,000 emails per month.",
      source_check: check,
    }));
    assert.strictEqual(
      note,
      "The day we last read the vendor's page. On 2026-10-01, the page we cite for Hexclave stated $0 and 1,000 emails per month, figures this listing gives.",
    );
  });

  it("names the refused read the rating waits on, and not the later read the check already describes, where the note quotes the check", () => {
    holding([rotation({ last_attempt_at: "2026-09-16", last_read_at: "2026-09-16" })], [refusal({ refused_date: "2026-09-16" })]);
    const offer = listing({ description: "The default weekly quota is 50 hours of use.", source_check: passingCheck("2026-10-14", ["50 hours"]) });
    const waitsOn = { clause: readHadNoStandingThenReadAgainClause("2026-09-16", "2026-10-14", "could read no amount, tier or rate on the page"), on: "2026-09-16" };
    assert.strictEqual(
      lastReadNote(offer, null, [{ reason: "unquantified_limit", refused_date: "2026-09-16" }], waitsOn),
      "The day we last read the vendor's page. On 2026-10-14, the page we cite for Examplebase stated 50 hours, a figure this listing gives."
        + " When we read the page we cite for this offer on 2026-09-16, we could read no amount, tier or rate on the page.",
    );
  });

  it("states an earlier difference once beside the check's figures, where the refusal the rating waits on states that read", () => {
    holding([rotation({ last_attempt_at: "2026-10-01", last_outcome: "changed", last_read_at: "2026-10-01" })], [refusal({ refused_date: "2026-10-01" })]);
    const offer = listing({ description: "Basic is $10.00 a month.", source_check: passingCheck("2026-10-06", ["$10.00"]) });
    const waitsOn = { clause: unreconciledReadThenReadAgainClause("2026-10-01", "2026-10-06"), on: "2026-10-01" };
    assert.strictEqual(
      lastReadNote(offer, null, [{ reason: "unquantified_limit", refused_date: "2026-10-01" }], waitsOn),
      "The day we last read the vendor's page. On 2026-10-06, the page we cite for Examplebase stated $10.00, a figure this listing gives."
        + " When we read the page we cite for this offer on 2026-10-01, we found a change we could not reconcile with the terms we publish.",
    );
  });

  it("keeps the later read in the refusal, where the note does not quote the check", () => {
    holding([rotation({ last_attempt_at: "2026-09-16", last_read_at: "2026-09-16" })], [refusal({ refused_date: "2026-09-16" })]);
    const offer = listing({ description: "The free plan costs $0 a month.", source_check: passingCheck("2026-10-14", ["$0"]) });
    const waitsOn = { clause: readHadNoStandingThenReadAgainClause("2026-09-16", "2026-10-14", "could read no amount, tier or rate on the page"), on: "2026-09-16" };
    const note = lastReadNote(offer, null, [{ reason: "unquantified_limit", refused_date: "2026-09-16" }], waitsOn);
    assert.ok(note.endsWith(
      " When we read the page we cite for this offer on 2026-09-16, we could read no amount, tier or rate on the page,"
        + " and we have read it again since, on 2026-10-14, without confirming the terms above.",
    ), note);
  });

  it("cuts every kind of refusal at the later read, and leaves one with no later read whole", () => {
    assert.strictEqual(
      theRefusedReadAlone(unreconciledReadThenReadAgainClause("2026-10-01", "2026-10-06")),
      "when we read the page we cite for this offer on 2026-10-01, we found a change we could not reconcile with the terms we publish",
    );
    assert.strictEqual(
      theRefusedReadAlone(measuredNoDifferenceThenReadAgainClause("2026-10-01", "2026-10-06")),
      "when we read the page we cite for this offer on 2026-10-01, we refused the change we considered recording because it named no figure that had moved",
    );
    assert.strictEqual(
      theRefusedReadAlone(readHadNoStandingThenReadAgainClause("2026-10-01", "2026-10-06", "could read no amount, tier or rate on the page")),
      "when we read the page we cite for this offer on 2026-10-01, we could read no amount, tier or rate on the page",
    );
    const whole = readHadNoStandingClause("2026-10-01", "could read no amount, tier or rate on the page");
    assert.strictEqual(theRefusedReadAlone(whole), whole);
  });

  it("drops an earlier difference that a refusal of the same day settled", () => {
    const refused = [refusal({ reason: "confirmed_unchanged", refused_date: "2026-09-21" })];
    holding([rotation({ last_attempt_at: "2026-09-21", last_outcome: "changed", last_read_at: "2026-09-21" })], refused);
    const note = noteFor(listing({ source_check: passingCheck("2026-10-04", ["$0"]) }), refused);
    assert.ok(!note.includes("found the page different"), note);
  });

  it("names no attempt that did not read the page as later, where a check read it after that attempt", () => {
    holding([rotation({ last_attempt_at: "2026-10-10", last_outcome: "source_unusable", last_read_at: null })]);
    const note = noteFor(listing({ source_check: { checked: "2026-10-10", outcome: "does_not_name_vendor", detail: `the page never names ${VENDOR}` } }));
    assert.ok(!note.includes("We tried again"), note);
  });
});

function figuresTheNotePrints(note: string, stated: string[]): string[] | null {
  const list = /stated (.*), (?:a figure|figures) this listing gives\./.exec(note)?.[1];
  if (list === undefined) return null;
  for (let mask = 1; mask < 1 << stated.length; mask++) {
    const chosen = stated.filter((_, at) => mask & (1 << at));
    if (figuresInASentence(chosen) === list) return chosen;
  }
  return null;
}

describe("the catalogue's Last read notes", () => {
  const offers: Listing[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
  const notes = offers.map(o => ({ offer: o, note: lastReadNote(o, null, refusalsForVendor(o.vendor)) }));
  const quoting = notes.filter(({ note }) => / this listing gives\./.test(note));

  it("states only figures the listing gives, on every note that quotes its check", () => {
    assert.ok(quoting.length > 0);
    const strangers = quoting.flatMap(({ offer, note }) => {
      const printed = figuresTheNotePrints(note, figuresTheCheckStatedOnce(offer.source_check));
      if (printed === null) return [`${offer.vendor}: a figure the check did not state`];
      return printed
        .filter(figure => figuresWeAlsoPublish([figure], offer.description ?? "").length === 0)
        .map(figure => `${offer.vendor}: ${figure}`);
    });
    assert.deepStrictEqual(strangers, []);
  });

  it("never pairs the figures a check stated with a sentence saying we hold no confirmation, other than the sentence stating a difference no later read settled", () => {
    const both = quoting.filter(({ offer, note }) => {
      const standing = readThatContradictsOurTerms(offer);
      const rest = standing ? note.replace(contradictedTermsSentence(standing), "") : note;
      return rest.toLowerCase().includes(NO_CONFIRMATION_HELD.toLowerCase());
    }).map(({ offer }) => offer.vendor);
    assert.deepStrictEqual(both, []);
  });

  it("reads the same figures out of every passing check that the check's own writer reads back", () => {
    const differing = offers
      .filter(o => o.source_check?.outcome === "ok")
      .filter(o => JSON.stringify(figuresTheCheckStated(o.source_check)) !== JSON.stringify(reportedFigures(o.source_check!.detail)?.figures ?? []))
      .map(o => o.vendor);
    assert.deepStrictEqual(differing, []);
  });

  it("reads a price of zero the way the check's own writer does", () => {
    const figures = offers.flatMap(o => figuresTheCheckStated(o.source_check));
    assert.ok(figures.some(figure => statesAnAmountOfZero(figure)) && figures.some(figure => !statesAnAmountOfZero(figure)));
    assert.deepStrictEqual(figures.filter(figure => statesAnAmountOfZero(figure) !== writerReadsAZero(figure)), []);
  });
});
