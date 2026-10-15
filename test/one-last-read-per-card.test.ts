import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { enrichOffers, loadDealChanges, loadOffers } from "../dist/data.js";
import { rankOffers, utcDate, type Demerit } from "../dist/ranking.js";
import { lastReadDate, latestReadWeHold } from "../dist/read-date.js";
import { resetVerificationStateCache, verificationLedger } from "../dist/verification-state.js";
import type { Offer } from "../dist/types.js";
import { assertPopulationFloor } from "./population-floor.ts";

const THE_READING_SENTENCE = /^Our last read of the vendor's pricing page, on (\d{4}-\d{2}-\d{2}),/;
const NO_PRICE_READ = "could read no amount, tier or rate on the page";

const RENDERED_ON = "2026-10-15";
const STORED_READ = "2026-10-03";
const LATER_CHECK = "2026-10-14";
const EARLIER_CHECK = "2026-09-20";
const CATALOGUE_DATE_INSIDE_THE_WINDOW = "2026-09-26";
const CATALOGUE_DATE_PAST_THE_WINDOW = "2026-05-01";

const VENDOR = "Constructed One Last Read";
const PAGE = "https://one-last-read.example/pricing";

const WHAT_EACH_CHECK_FOUND: Record<string, string> = {
  ok: "the page names the vendor and states a price",
  does_not_name_vendor: "the page never writes the vendor's name",
  does_not_name_product: "the page writes the platform's name and never the product's",
};

function constructed(checkedOn: string, verifiedDate: string, outcome = "ok"): Offer {
  return {
    vendor: VENDOR,
    url: PAGE,
    category: "Test",
    description: "A constructed record",
    tier: "Free",
    tags: [],
    verifiedDate,
    source_check: { checked: checkedOn, outcome, detail: WHAT_EACH_CHECK_FOUND[outcome] },
  } as unknown as Offer;
}

function staleDemeritOf(offer: Offer): Demerit | undefined {
  const result = rankOffers([offer], {
    queryKey: "one-last-read",
    changes: [],
    date: RENDERED_ON,
    verificationLedger: verificationLedger(),
    linkHealth: () => null,
  });
  const entry = result.ranked[0];
  assert.ok(entry, "the constructed record must be ranked, not gated");
  return entry.demerits.find(d => d.code === "stale_verification");
}

function dateTheReasonGivesOurLastRead(demerit: Demerit | undefined): string | null {
  return demerit?.reason.match(THE_READING_SENTENCE)?.[1] ?? null;
}

describe("a card's stale_verification reason dates our last read to the card's own Read date", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "one-last-read-"));
  const previous = process.env.AGENTDEALS_VERIFICATION_STATE_PATH;

  before(() => {
    const file = path.join(scratch, "verification_state.json");
    writeFileSync(file, JSON.stringify({
      records: [{
        vendor: VENDOR,
        url: PAGE,
        last_attempt_at: STORED_READ,
        last_outcome: "states_no_price",
        last_error: null,
        failure_category: null,
        consecutive_failures: 0,
        last_success: null,
        last_read_at: STORED_READ,
        quarantined_since: null,
      }],
    }));
    process.env.AGENTDEALS_VERIFICATION_STATE_PATH = file;
    resetVerificationStateCache();
  });

  after(() => {
    if (previous === undefined) delete process.env.AGENTDEALS_VERIFICATION_STATE_PATH;
    else process.env.AGENTDEALS_VERIFICATION_STATE_PATH = previous;
    resetVerificationStateCache();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("reads the source check where it is newer than the stored read, as the card does", () => {
    const offer = constructed(LATER_CHECK, CATALOGUE_DATE_PAST_THE_WINDOW);
    assert.equal(lastReadDate(offer), LATER_CHECK);
    const demerit = staleDemeritOf(offer);
    assert.ok(demerit, "a catalogue date past the window keeps the demerit, so the reason must still say which read it rests on");
    assert.equal(dateTheReasonGivesOurLastRead(demerit), LATER_CHECK);
    assert.ok(!demerit.reason.includes(STORED_READ), demerit.reason);
    assert.ok(!demerit.reason.includes(NO_PRICE_READ), demerit.reason);
  });

  it("lifts the demerit where that newer check settles a record whose catalogue date is inside the window", () => {
    const offer = constructed(LATER_CHECK, CATALOGUE_DATE_INSIDE_THE_WINDOW);
    assert.equal(staleDemeritOf(offer), undefined);
  });

  it("keeps the demerit, dated to that newer check, where the check found a page that does not name the vendor or the product", () => {
    for (const outcome of ["does_not_name_vendor", "does_not_name_product"]) {
      const offer = constructed(LATER_CHECK, CATALOGUE_DATE_INSIDE_THE_WINDOW, outcome);
      assert.equal(lastReadDate(offer), LATER_CHECK);
      const demerit = staleDemeritOf(offer);
      assert.ok(demerit, `a newer check reading ${outcome} lifted the demerit`);
      assert.equal(dateTheReasonGivesOurLastRead(demerit), LATER_CHECK);
    }
  });

  it("keeps the stored read where it is the latest read we hold, and the demerit it found", () => {
    const offer = constructed(EARLIER_CHECK, CATALOGUE_DATE_INSIDE_THE_WINDOW);
    assert.equal(lastReadDate(offer), STORED_READ);
    const demerit = staleDemeritOf(offer);
    assert.ok(demerit, "a read that found no price is a demerit while it is the latest read we hold");
    assert.equal(dateTheReasonGivesOurLastRead(demerit), STORED_READ);
    assert.ok(demerit.reason.includes(NO_PRICE_READ), demerit.reason);
  });
});

describe("no ranked card gives two different last reads", () => {
  const ranked = rankOffers(enrichOffers(loadOffers()), {
    queryKey: "one-last-read-census",
    changes: loadDealChanges(),
    date: utcDate(),
    verificationLedger: verificationLedger(),
  }).ranked;
  const statingOurLastRead = ranked.flatMap(entry => {
    const stated = dateTheReasonGivesOurLastRead(entry.demerits.find(d => d.code === "stale_verification"));
    return stated === null ? [] : [{ offer: entry.offer, stated }];
  });

  it("dates every reason that states our last read to the card's Read date, wherever a source check gives that date", () => {
    assertPopulationFloor(statingOurLastRead.length, 100, "ranked cards whose stale_verification reason states our last read");
    const twoReads = statingOurLastRead
      .filter(({ offer, stated }) => latestReadWeHold(offer)?.kind === "source_check" && stated !== lastReadDate(offer))
      .map(({ offer, stated }) => `${offer.vendor}: Read ${lastReadDate(offer)}, reason ${stated}`);
    assert.deepEqual(twoReads, []);
  });
});
