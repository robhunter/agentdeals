import { describe, it } from "node:test";
import assert from "node:assert";
import { loadOffers, enrichOffers, loadDealChanges } from "../dist/data.js";
import {
  DEMERIT_TABLE,
  demeritTableRowText,
  rankOffers,
  utcDate,
  verificationDoubt,
  type Demerit,
  type VerificationDoubt,
  type VerificationLedger,
} from "../dist/ranking.js";
import { lastReadingFor, WHAT_THE_LAST_READ_FOUND, type LastReading } from "../dist/read-date.js";
import { loadVerificationState, verificationLedger } from "../dist/verification-state.js";
import { howWeSettledTheRead } from "../dist/change-refusal.js";
import { storedRefusalsFor } from "../dist/refusal-store.js";
import type { Offer } from "../dist/types.js";
import { assertPopulationFloor } from "./population-floor.ts";

const STALE_VERIFICATION_DAYS = 90;
const DATE = "2026-09-20";
const DAY_MS = 86_400_000;

const DAY_COUNT_SENTENCE = /We have not confirmed this offer against the vendor's pricing page since \d{4}-\d{2}-\d{2} \(\d+ days\)/;
const THE_READING_SENTENCE = /^Our last read of the vendor's pricing page, on (\d{4}-\d{2}-\d{2}),/;

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysApart(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

const READ_THE_PAGE = new Set(["confirmed", "changed", "link_ok", "states_no_price"]);

function reading(overrides: Partial<LastReading> & { outcome: string; date: string }): LastReading {
  return {
    confirmed: overrides.outcome === "confirmed",
    settles: overrides.outcome === "confirmed" || overrides.outcome === "changed",
    read_the_page: READ_THE_PAGE.has(overrides.outcome),
    found: null,
    consecutive_failures: 0,
    last_success: null,
    last_error: null,
    ...overrides,
  };
}

const READ_AND_DISAGREED = reading({
  date: shift(DATE, -3),
  outcome: "changed",
  found: "found the page different from the terms we hold",
});

const READ_AND_FOUND_NO_TERMS = reading({
  date: shift(DATE, -3),
  outcome: "states_no_price",
  found: "could read no amount, tier or rate on the page",
});

const READ_AND_CONFIRMED = reading({ date: shift(DATE, -3), outcome: "confirmed" });

const COULD_NOT_READ = reading({
  date: shift(DATE, -3),
  outcome: "fetch_failed",
  consecutive_failures: 4,
  last_error: "HTTP 403",
});

const FAILING_LEDGER: VerificationLedger = new Map([
  ["constructed", {
    vendor: "Constructed",
    url: "https://example.invalid/pricing",
    consecutive_failures: 4,
    last_success: null,
    last_attempt: shift(DATE, -3),
    last_error: "HTTP 403",
  }],
]);

function record(verifiedDate: string): Pick<Offer, "vendor" | "verifiedDate"> {
  return { vendor: "Constructed", verifiedDate };
}

const FRESH = shift(DATE, -10);
const PAST_THE_WINDOW = shift(DATE, -(STALE_VERIFICATION_DAYS + 60));

function doubtFor(
  verifiedDate: string,
  lastReading: LastReading | null,
  ledger?: VerificationLedger,
): VerificationDoubt | null {
  return verificationDoubt(record(verifiedDate), DATE, ledger, lastReading);
}

describe("the staleness demerit keys on the reading, not on the catalogue date", () => {
  it("clears where a reading inside the window confirmed the record, however old the catalogue date", () => {
    assert.equal(doubtFor(PAST_THE_WINDOW, READ_AND_CONFIRMED), null);
  });

  it("holds where a reading inside the window could not confirm the record, however fresh the catalogue date", () => {
    const doubt = doubtFor(FRESH, READ_AND_FOUND_NO_TERMS);
    assert.equal(doubt?.basis, "could_not_confirm");
  });

  it("holds where re-checks inside the window could not read the page, however fresh the catalogue date", () => {
    const doubt = doubtFor(FRESH, COULD_NOT_READ, FAILING_LEDGER);
    assert.equal(doubt?.basis, "could_not_read");
  });

  it("leaves a reading that disagreed to the catalogue date, as the issue rules", () => {
    assert.equal(doubtFor(FRESH, READ_AND_DISAGREED), null);
    assert.equal(doubtFor(PAST_THE_WINDOW, READ_AND_DISAGREED)?.basis, "unsettled");
  });

  it("counts days only where no reading falls inside the window", () => {
    const readBeforeTheWindow = reading({
      ...READ_AND_FOUND_NO_TERMS,
      date: shift(DATE, -(STALE_VERIFICATION_DAYS + 1)),
    });
    const doubt = doubtFor(PAST_THE_WINDOW, readBeforeTheWindow);
    assert.equal(doubt?.basis, "no_reading");
    assert.equal(doubt?.basis === "no_reading" && doubt.age, daysApart(PAST_THE_WINDOW, DATE));
    assert.equal(doubtFor(PAST_THE_WINDOW, null)?.basis, "no_reading");
  });

  it("clears a record with no reading and a catalogue date inside the window", () => {
    assert.equal(doubtFor(FRESH, null), null);
  });

  it("leaves a confirmation we hold standing when a later attempt did not read the page", () => {
    const attemptAfterAConfirmation = reading({ ...COULD_NOT_READ, last_success: shift(DATE, -20) });
    assert.equal(doubtFor(FRESH, attemptAfterAConfirmation), null);
    assert.equal(doubtFor(PAST_THE_WINDOW, attemptAfterAConfirmation), null);
  });

  it("stops holding that confirmation once it falls outside the window", () => {
    const old = reading({ ...COULD_NOT_READ, last_success: shift(DATE, -(STALE_VERIFICATION_DAYS + 1)) });
    assert.equal(doubtFor(FRESH, old)?.basis, "could_not_read");
  });

  it("ignores a reading dated after the day we are rendering", () => {
    const tomorrow = reading({ ...READ_AND_CONFIRMED, date: shift(DATE, 1) });
    assert.equal(doubtFor(PAST_THE_WINDOW, tomorrow)?.basis, "no_reading");
    assert.equal(doubtFor(FRESH, tomorrow), null);
  });

  it("does not let a confirmation stand against a reading that did reach the page", () => {
    const readAndConfirmedBefore = reading({ ...READ_AND_FOUND_NO_TERMS, last_success: shift(DATE, -20) });
    assert.equal(doubtFor(FRESH, readAndConfirmedBefore)?.basis, "could_not_confirm");
  });
});

describe("what the demerit publishes is what that reading found", () => {
  function demeritFor(
    verifiedDate: string,
    lastReading: LastReading | null,
    ledger?: VerificationLedger,
  ): Demerit {
    const offer = {
      vendor: "Constructed",
      url: "https://example.invalid/pricing",
      category: "Test",
      description: "A constructed record",
      tier: "Free",
      tags: [],
      verifiedDate,
    } as unknown as Offer;
    const result = rankOffers([offer], {
      queryKey: "constructed",
      changes: [],
      date: DATE,
      verificationLedger: ledger,
      linkHealth: () => null,
      lastReading: () => lastReading,
    });
    const entry = result.ranked[0];
    assert.ok(entry, "the constructed record must be ranked, not gated");
    const stale = entry.demerits.find(d => d.code === "stale_verification");
    assert.ok(stale, "the constructed record must carry a stale_verification demerit");
    return stale;
  }

  it("names the reading and its date, and states no number of days", () => {
    const stale = demeritFor(FRESH, READ_AND_FOUND_NO_TERMS);
    assert.match(stale.reason, THE_READING_SENTENCE);
    assert.equal(stale.reason.match(THE_READING_SENTENCE)?.[1], READ_AND_FOUND_NO_TERMS.date);
    assert.ok(stale.reason.includes(READ_AND_FOUND_NO_TERMS.found!));
    assert.doesNotMatch(stale.reason, DAY_COUNT_SENTENCE);
    assert.equal(stale.date, READ_AND_FOUND_NO_TERMS.date);
  });

  it("says the page disagreed where that is what the reading found", () => {
    const stale = demeritFor(PAST_THE_WINDOW, READ_AND_DISAGREED);
    assert.ok(stale.reason.includes(READ_AND_DISAGREED.found!));
    assert.doesNotMatch(stale.reason, DAY_COUNT_SENTENCE);
  });

  it("names the attempts where the re-checks could not read the page", () => {
    const stale = demeritFor(FRESH, COULD_NOT_READ, FAILING_LEDGER);
    assert.match(stale.reason, /4 consecutive re-check attempts have failed/);
    assert.ok(stale.reason.includes("HTTP 403"));
    assert.doesNotMatch(stale.reason, DAY_COUNT_SENTENCE);
  });

  it("agrees on the singular where one attempt has failed", () => {
    const once = reading({ ...COULD_NOT_READ, consecutive_failures: 1 });
    const stale = demeritFor(FRESH, once);
    assert.match(stale.reason, /1 consecutive re-check attempt has failed/);
  });

  it("counts the attempts recorded against the page it cites, not against the vendor", () => {
    const ownPage = reading({ ...COULD_NOT_READ, consecutive_failures: 2, date: shift(DATE, -5) });
    const stale = demeritFor(FRESH, ownPage, FAILING_LEDGER);
    assert.match(stale.reason, /2 consecutive re-check attempts have failed/);
    assert.ok(stale.reason.includes(ownPage.date));
    assert.ok(!stale.reason.includes(FAILING_LEDGER.get("constructed")!.last_attempt));
  });

  it("dates the attempts to the read that failed, not to the confirmation it lost", () => {
    const lapsed = reading({ ...COULD_NOT_READ, last_success: shift(DATE, -(STALE_VERIFICATION_DAYS + 1)) });
    const stale = demeritFor(FRESH, lapsed);
    assert.equal(stale.date, lapsed.date);
    assert.ok(stale.reason.includes(`most recently ${lapsed.date}`));
    assert.ok(stale.reason.includes(`last confirmed ${lapsed.last_success}`));
  });

  it("counts the days where no reading falls inside the window", () => {
    const stale = demeritFor(PAST_THE_WINDOW, null);
    assert.match(stale.reason, DAY_COUNT_SENTENCE);
    assert.ok(stale.reason.includes(`(${daysApart(PAST_THE_WINDOW, DATE)} days)`));
  });
});

describe("no published reason states a gap a reading we hold contradicts", () => {
  const offers = loadOffers();
  const changes = loadDealChanges();
  const ledger = verificationLedger();
  const TODAY = utcDate();

  function everyStaleReason(date: string): { offer: Offer; reason: string }[] {
    const result = rankOffers(enrichOffers(offers), {
      queryKey: "census",
      changes,
      date,
      verificationLedger: ledger,
    });
    const found: { offer: Offer; reason: string }[] = [];
    for (const entry of result.ranked) {
      for (const demerit of entry.demerits) {
        if (demerit.code === "stale_verification") found.push({ offer: entry.offer, reason: demerit.reason });
      }
    }
    return found;
  }

  it("holds over every record whose page we read inside the window", () => {
    const readInsideTheWindow = offers.filter(o => {
      const checked = o.source_check?.checked;
      return Boolean(checked) && daysApart(checked!, TODAY) <= STALE_VERIFICATION_DAYS;
    });
    assertPopulationFloor(readInsideTheWindow.length, 1100, "records read inside the staleness window");

    const readInside = new Set(readInsideTheWindow.map(o => `${o.vendor}|${o.url}`));
    const contradicted = everyStaleReason(TODAY)
      .filter(({ offer }) => readInside.has(`${offer.vendor}|${offer.url}`))
      .filter(({ reason }) => DAY_COUNT_SENTENCE.test(reason));
    assert.deepEqual(contradicted.map(c => c.offer.vendor), []);
  });

  it("dates every reason to the reading it is drawn from, where a reading falls inside the window", () => {
    const reasons = everyStaleReason(TODAY);
    assertPopulationFloor(reasons.length, 400, "records carrying a stale_verification demerit");
    const drawnFromAReading = reasons.filter(({ offer }) => {
      const held = lastReadingFor(offer);
      return Boolean(held) && daysApart(held!.date, TODAY) <= STALE_VERIFICATION_DAYS;
    });
    assertPopulationFloor(drawnFromAReading.length, 400, "demerits drawn from a reading inside the window");
    const undated = drawnFromAReading.filter(({ offer, reason }) => !reason.includes(lastReadingFor(offer)!.date));
    assert.deepEqual(undated.map(u => u.offer.vendor), []);
  });

  it("publishes no day count at all while every record has been read inside the window", () => {
    const counting = everyStaleReason(TODAY).filter(({ reason }) => DAY_COUNT_SENTENCE.test(reason));
    assert.deepEqual(counting.map(c => c.offer.vendor), []);
  });
});

describe("the controls this issue names", () => {
  const offers = loadOffers();
  const changes = loadDealChanges();
  const ledger = verificationLedger();

  function standingOf(vendor: string): { gate: string | null; staleReason: string | null } {
    const offer = offers.find(o => o.vendor === vendor);
    assert.ok(offer, `${vendor} must still be in the catalogue for this control to mean anything`);
    const result = rankOffers(enrichOffers([offer]), {
      queryKey: "control",
      changes,
      date: DATE,
      verificationLedger: ledger,
    });
    const gated = result.excluded[0];
    if (gated) return { gate: gated.gate.code, staleReason: null };
    const entry = result.ranked[0];
    return { gate: null, staleReason: entry.demerits.find(d => d.code === "stale_verification")?.reason ?? null };
  }

  const READ_CLEANLY_AND_DISAGREED = ["Make", "Canva", "SourceForge", "Namecheap Supersonic"];
  const READ_AND_THE_PAGE_STATED_NOTHING = ["pexels.com", "unsplash.com", "Substack", "Microsoft To Do"];
  const RANKED_CONTROLS = [...READ_CLEANLY_AND_DISAGREED, ...READ_AND_THE_PAGE_STATED_NOTHING];

  it("keeps demoting the records a clean reading disagreed with", () => {
    const undemoted = READ_CLEANLY_AND_DISAGREED.filter(v => standingOf(v).staleReason === null);
    assert.deepEqual(undemoted, []);
  });

  it("keeps demoting the records whose page states nothing that could confirm them", () => {
    const undemoted = READ_AND_THE_PAGE_STATED_NOTHING.filter(v => standingOf(v).staleReason === null);
    assert.deepEqual(undemoted, []);
  });

  it("states no number of days for any of them", () => {
    const counting = RANKED_CONTROLS.filter(v => DAY_COUNT_SENTENCE.test(standingOf(v).staleReason ?? ""));
    assert.deepEqual(counting, []);
  });

  it("dates each of them to the reading we hold for its own page", () => {
    const unnamed = RANKED_CONTROLS.filter(v => {
      const offer = offers.find(o => o.vendor === v)!;
      const read = lastReadingFor(offer);
      return !read || !(standingOf(v).staleReason ?? "").includes(read.date);
    });
    assert.deepEqual(unnamed, []);
  });

  it("names the read itself wherever the read reached the page", () => {
    const reachedThePage = RANKED_CONTROLS.filter(v => lastReadingFor(offers.find(o => o.vendor === v)!)?.read_the_page);
    assert.ok(reachedThePage.length >= 6, `only ${reachedThePage.length} controls were read, so this asserts nothing`);
    const unnamed = reachedThePage.filter(v => !THE_READING_SENTENCE.test(standingOf(v).staleReason ?? ""));
    assert.deepEqual(unnamed, []);
  });

  it("holds Segment out of the ranked population altogether, where it already was", () => {
    assert.equal(standingOf("Segment").gate, "eligibility_restricted");
    assert.equal(standingOf("Segment").staleReason, null);
  });

  it("keeps every other control inside the ranked population", () => {
    const gated = RANKED_CONTROLS.filter(v => standingOf(v).gate !== null);
    assert.deepEqual(gated, []);
  });
});

describe("the criteria page publishes the count and what moves it", () => {
  const offers = loadOffers();
  const ledger = verificationLedger();
  const row = DEMERIT_TABLE.find(d => d.code === "stale_verification")!;

  function census(date: string): string {
    return demeritTableRowText(row, offers, date, ledger, lastReadingFor);
  }

  function countedIn(sentence: string): number {
    const match = sentence.match(/records we hold, ([\d,]+) meet it/);
    return match ? Number(match[1].replace(/,/g, "")) : 0;
  }

  it("states a count that matches the rule it describes", () => {
    const stated = countedIn(census(DATE));
    const measured = offers.filter(o =>
      verificationDoubt(o, DATE, ledger, lastReadingFor(o)) !== null,
    ).length;
    assertPopulationFloor(measured, 400, "records meeting the stale_verification trigger");
    assert.equal(stated, measured);
  });

  it("separates the counts the calendar cannot move from the ones it can", () => {
    const now = census(DATE);
    const later = census("2026-12-01");
    assert.match(now, /where the page we read states nothing that could confirm the record/);
    assert.match(now, /where a reading did not settle the record/);
    assert.match(now, /where our re-checks have not been able to read the page at all/);
    assert.match(now, /does not grow with the calendar/);
    assert.ok(countedIn(later) >= countedIn(now));
  });
});

describe("what the catalogue records about a record's last reading", () => {
  const offers = loadOffers();
  const stored = loadVerificationState();
  const ABSENT = { vendor: "No Such Vendor", url: "https://example.invalid/pricing" };

  function aRefusalSettledItsLastRead(offer: Offer): boolean {
    const read = stored.get(`${offer.vendor}|${offer.url}`)?.last_attempt_at;
    return Boolean(read) && howWeSettledTheRead(storedRefusalsFor(offer.vendor), read!) !== null;
  }

  function recordWhoseLastOutcomeWas(outcome: string, passOver: (offer: Offer) => boolean = () => false): Offer {
    const offer = offers.find(o => stored.get(`${o.vendor}|${o.url}`)?.last_outcome === outcome && !passOver(o));
    assert.ok(offer, `no record's last reading is ${outcome}, so this asserts nothing`);
    return offer;
  }

  it("reads a confirmation as one, and as settling the record", () => {
    const read = lastReadingFor(recordWhoseLastOutcomeWas("confirmed"))!;
    assert.equal(read.confirmed, true);
    assert.equal(read.settles, true);
    assert.equal(read.read_the_page, true);
  });

  it("reads a disagreement as settling the record without confirming it", () => {
    const read = lastReadingFor(recordWhoseLastOutcomeWas("changed", aRefusalSettledItsLastRead))!;
    assert.equal(read.confirmed, false);
    assert.equal(read.settles, true);
    assert.equal(read.read_the_page, true);
    assert.equal(read.found, WHAT_THE_LAST_READ_FOUND.changed);
  });

  it("reads a page that stated no price as one that settles nothing", () => {
    const read = lastReadingFor(recordWhoseLastOutcomeWas("states_no_price"))!;
    assert.equal(read.confirmed, false);
    assert.equal(read.settles, false);
    assert.equal(read.read_the_page, true);
    assert.equal(read.found, WHAT_THE_LAST_READ_FOUND.states_no_price);
  });

  it("reads an attempt that never reached the page as one", () => {
    const read = lastReadingFor(recordWhoseLastOutcomeWas("fetch_failed"))!;
    assert.equal(read.read_the_page, false);
    assert.equal(read.settles, false);
    assert.equal(read.found, null);
    assert.ok(read.consecutive_failures > 0, "an attempt that failed must be counted");
  });

  it("falls back to the record's own source_check where the ledger holds nothing", () => {
    const read = lastReadingFor({ ...ABSENT, source_check: { checked: "2026-09-03", outcome: "states_no_terms" } });
    assert.equal(read?.date, "2026-09-03");
    assert.equal(read?.found, WHAT_THE_LAST_READ_FOUND.states_no_price);
    assert.equal(read?.settles, false);
    assert.equal(read?.confirmed, false);
  });

  it("reads no verdict into a source_check that only priced the page", () => {
    const read = lastReadingFor({ ...ABSENT, source_check: { checked: "2026-09-03", outcome: "ok" } });
    assert.equal(read?.date, "2026-09-03");
    assert.equal(read?.found, null);
    assert.equal(read?.settles, true);
    assert.equal(read?.confirmed, false);
  });

  it("holds no reading for a record with neither a ledger entry nor a source_check", () => {
    assert.equal(lastReadingFor(ABSENT), null);
  });
});
