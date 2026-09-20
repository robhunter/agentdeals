import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { enrichOffers, loadOffers } from "../dist/data.js";
import {
  REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS,
  REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE,
  howWeSettledTheRead,
  refusalSettledTheRead,
  type RefusedRead,
} from "../dist/change-refusal.js";
import {
  WHAT_A_SETTLED_READ_FOUND,
  WHAT_THE_LAST_READ_FOUND,
  lastReadNote,
  readingSettledByRefusals,
  whatTheLastReadFound,
  type LastReading,
} from "../dist/read-date.js";
import { resetVerificationStateCache } from "../dist/verification-state.js";
import { rankOffers } from "../dist/ranking.js";
import type { Offer } from "../dist/types.js";
import { assertPopulationFloor } from "./population-floor.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const READ = "2026-09-11";
const A_DISAGREEMENT_STANDS = WHAT_THE_LAST_READ_FOUND.changed;
const RESTATED = WHAT_A_SETTLED_READ_FOUND.restated_the_terms_we_publish;
const NO_FIGURE_MOVED = WHAT_A_SETTLED_READ_FOUND.named_no_figure_that_moved;

const refused = (reason: string, refused_date = READ): RefusedRead => ({ reason, refused_date });

function reading(over: Partial<LastReading> & { outcome: string }): LastReading {
  return {
    date: READ,
    confirmed: over.outcome === "confirmed",
    settles: over.outcome === "confirmed" || over.outcome === "changed",
    read_the_page: true,
    found: WHAT_THE_LAST_READ_FOUND[over.outcome] ?? null,
    consecutive_failures: 0,
    last_success: null,
    last_error: null,
    ...over,
  };
}

interface StateRecord {
  vendor: string;
  url: string;
  last_attempt_at: string | null;
  last_outcome: string | null;
  last_success: string | null;
}

interface StoredRefusal {
  vendor: string;
  reason: string;
  refused_date: string;
}

function storedState(): StateRecord[] {
  const at = process.env.AGENTDEALS_VERIFICATION_STATE_PATH
    || path.join(REPO, "data", "verification_state.json");
  return JSON.parse(readFileSync(at, "utf-8")).records;
}

function storedRefusals(): StoredRefusal[] {
  const at = process.env.AGENTDEALS_REFUSALS_PATH || path.join(REPO, "data", "change_refusals.json");
  return JSON.parse(readFileSync(at, "utf-8")).refusals;
}

function refusalsByVendorName(): Map<string, StoredRefusal[]> {
  const held = new Map<string, StoredRefusal[]>();
  for (const refusal of storedRefusals()) {
    const key = refusal.vendor.trim().toLowerCase();
    const kept = held.get(key);
    if (kept) kept.push(refusal);
    else held.set(key, [refusal]);
  }
  return held;
}

describe("what our own refusal says about the read that raised it", () => {
  it("answers nothing where no refusal carries the day of the read", () => {
    assert.strictEqual(howWeSettledTheRead([], READ), null);
    assert.strictEqual(howWeSettledTheRead([refused("confirmed_unchanged", "2026-09-10")], READ), null);
    assert.strictEqual(howWeSettledTheRead([refused("confirmed_unchanged", "2026-09-12")], READ), null);
  });

  it("reads a same-day refusal that restated the terms we publish", () => {
    assert.deepStrictEqual(howWeSettledTheRead([refused("confirmed_unchanged")], READ), {
      settlement: "restated_the_terms_we_publish",
      refusal: refused("confirmed_unchanged"),
    });
  });

  it("reads a same-day refusal that measured no figure moving", () => {
    assert.deepStrictEqual(howWeSettledTheRead([refused("measures_no_change")], READ), {
      settlement: "named_no_figure_that_moved",
      refusal: refused("measures_no_change"),
    });
  });

  it("leaves the disagreement standing where one same-day refusal rests on other grounds", () => {
    assert.strictEqual(
      howWeSettledTheRead([refused("confirmed_unchanged"), refused("unquantified_limit")], READ),
      null,
    );
    assert.strictEqual(
      howWeSettledTheRead([refused("measures_no_change"), refused("page_does_not_name_vendor")], READ),
      null,
    );
  });

  it("prefers the reason that restated our terms where both are recorded on the day", () => {
    const settled = howWeSettledTheRead(
      [refused("measures_no_change"), refused("free_tier_still_offered")],
      READ,
    );
    assert.strictEqual(settled?.settlement, "restated_the_terms_we_publish");
  });

  it("settles on every reason in the two sets we publish and on no other", () => {
    for (const reason of [
      ...REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS,
      ...REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE,
    ]) {
      assert.ok(refusalSettledTheRead({ reason }), `${reason} does not settle the read it refused`);
      assert.ok(howWeSettledTheRead([refused(reason)], READ), `${reason} settles nothing on the day it was refused`);
    }
    for (const reason of ["unquantified_limit", "same_transition_graded_differently", "measures_the_opposite", "states_no_terms"]) {
      assert.ok(!refusalSettledTheRead({ reason }), `${reason} settles a read it does not settle`);
      assert.strictEqual(howWeSettledTheRead([refused(reason)], READ), null);
    }
  });
});

describe("the clause we publish for what a read found", () => {
  it("answers a settled read with what we did about the difference", () => {
    assert.strictEqual(
      whatTheLastReadFound("changed", howWeSettledTheRead([refused("confirmed_unchanged")], READ)),
      RESTATED,
    );
    assert.strictEqual(
      whatTheLastReadFound("changed", howWeSettledTheRead([refused("restates_stored_quantities")], READ)),
      NO_FIGURE_MOVED,
    );
  });

  it("states the disagreement where nothing settled the read", () => {
    assert.strictEqual(whatTheLastReadFound("changed", null), A_DISAGREEMENT_STANDS);
    assert.strictEqual(
      whatTheLastReadFound("changed", howWeSettledTheRead([refused("unquantified_limit")], READ)),
      A_DISAGREEMENT_STANDS,
    );
  });

  it("answers only a read that found the page changed", () => {
    const settled = howWeSettledTheRead([refused("confirmed_unchanged")], READ);
    assert.strictEqual(whatTheLastReadFound("states_no_price", settled), WHAT_THE_LAST_READ_FOUND.states_no_price);
    assert.strictEqual(whatTheLastReadFound("link_ok", settled), WHAT_THE_LAST_READ_FOUND.link_ok);
    assert.strictEqual(whatTheLastReadFound("confirmed", settled), null);
    assert.strictEqual(whatTheLastReadFound(null, settled), null);
  });
});

describe("the reading a settled refusal rewrites", () => {
  it("replaces what a changed read found and leaves every other field", () => {
    const raw = reading({ outcome: "changed" });
    const settled = readingSettledByRefusals(raw, [refused("confirmed_unchanged")])!;
    assert.strictEqual(settled.found, RESTATED);
    assert.deepStrictEqual({ ...settled, found: null }, { ...raw, found: null });
  });

  it("leaves a read that did not find the page changed alone", () => {
    for (const outcome of ["confirmed", "states_no_price", "link_ok", "fetch_failed"]) {
      const raw = reading({ outcome });
      assert.deepStrictEqual(readingSettledByRefusals(raw, [refused("confirmed_unchanged")]), raw);
    }
  });

  it("leaves a changed read alone where the refusal carries another day", () => {
    const raw = reading({ outcome: "changed" });
    assert.deepStrictEqual(
      readingSettledByRefusals(raw, [refused("confirmed_unchanged", "2026-09-04")]),
      raw,
    );
  });

  it("answers nothing for no reading", () => {
    assert.strictEqual(readingSettledByRefusals(null, [refused("confirmed_unchanged")]), null);
  });
});

describe("the demerit reason a settled read carries", () => {
  const offer = {
    vendor: "Examplebase",
    category: "Databases",
    description: "Free tier",
    tier: "Free",
    url: "https://examplebase.dev/pricing",
    tags: [],
    verifiedDate: "2026-04-12",
  } as unknown as Offer;

  function reasonFor(found: string | null): string {
    const ranked = rankOffers([offer], {
      queryKey: "what-the-last-read-found",
      date: "2026-09-20",
      changes: [],
      lastReading: () => reading({ outcome: "changed", found }),
    });
    assert.strictEqual(ranked.ranked.length, 1, "the record under test was not ranked");
    const stale = ranked.ranked[0].demerits.find((d) => d.code === "stale_verification");
    assert.ok(stale, "a record last read without confirming carries no staleness demerit");
    return stale.reason;
  }

  it("states what we did about the difference rather than a disagreement we do not hold", () => {
    assert.ok(reasonFor(RESTATED).includes(RESTATED));
    assert.ok(!reasonFor(RESTATED).includes(A_DISAGREEMENT_STANDS));
    assert.ok(reasonFor(NO_FIGURE_MOVED).includes(NO_FIGURE_MOVED));
  });

  it("still states the disagreement where nothing settled the read", () => {
    assert.ok(reasonFor(A_DISAGREEMENT_STANDS).includes(A_DISAGREEMENT_STANDS));
  });
});

describe("the catalogue as it stands", () => {
  const enriched = enrichOffers(loadOffers());
  const state = new Map(storedState().map((r) => [`${r.vendor}|${r.url}`, r]));
  const refusals = refusalsByVendorName();

  function settledFromStore(offer: { vendor: string; url: string }): string | null {
    const record = state.get(`${offer.vendor}|${offer.url}`);
    if (!record || record.last_outcome !== "changed" || !record.last_attempt_at) return null;
    const sameDay = (refusals.get(offer.vendor.trim().toLowerCase()) ?? [])
      .filter((r) => r.refused_date === record.last_attempt_at);
    if (sameDay.length === 0) return null;
    if (sameDay.some((r) => !refusalSettledTheRead(r))) return null;
    return sameDay.some((r) => (REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS as readonly string[]).includes(r.reason))
      ? RESTATED
      : NO_FIGURE_MOVED;
  }

  const settled = enriched.filter((o) => settledFromStore(o) !== null);

  it("holds records whose last read was settled by a refusal recorded the same day", () => {
    assertPopulationFloor(settled.length, 40, "records whose last read our own change gate then refused");
  });

  it("reports no disagreement where our own gate refused the change that day", () => {
    const contradicted = settled.filter((o) => o.last_read_found === A_DISAGREEMENT_STANDS);
    assert.deepStrictEqual(
      contradicted.map((o) => `${o.vendor} (${o.last_read_date})`),
      [],
      "these records publish a disagreement our own refusal of the same read does not support",
    );
  });

  it("publishes the clause the stored refusal reason selects", () => {
    const wrong = settled.filter((o) => o.last_read_found !== settledFromStore(o));
    assert.deepStrictEqual(wrong.map((o) => `${o.vendor}: ${o.last_read_found}`), []);
  });

  it("leaves a read no refusal settled reporting the difference it found", () => {
    const unsettled = enriched.filter((o) => {
      const record = state.get(`${o.vendor}|${o.url}`);
      return record?.last_outcome === "changed"
        && o.last_read_date === record.last_attempt_at
        && settledFromStore(o) === null;
    });
    assertPopulationFloor(unsettled.length, 200, "records whose last read found a difference we still hold");
    const quiet = unsettled.filter((o) => o.last_read_found !== A_DISAGREEMENT_STANDS);
    assert.deepStrictEqual(quiet.map((o) => `${o.vendor}: ${o.last_read_found}`), []);
  });

  it("carries the outcome of the read whose date it publishes", () => {
    const dated = enriched.filter((o) => o.last_read_outcome !== null);
    assertPopulationFloor(dated.length, 900, "records publishing what the read on their last read date concluded");
    for (const offer of dated) {
      const record = state.get(`${offer.vendor}|${offer.url}`);
      if (!record?.last_attempt_at) continue;
      if (record.last_attempt_at !== offer.last_read_date) continue;
      assert.strictEqual(
        offer.last_read_outcome,
        record.last_outcome,
        `${offer.vendor} publishes an outcome the verification store does not hold for ${offer.last_read_date}`,
      );
    }
  });

  it("answers nothing about a read date the store holds no outcome for", () => {
    const mismatched = enriched.filter((o) => {
      const record = state.get(`${o.vendor}|${o.url}`);
      return record?.last_attempt_at && record.last_attempt_at !== o.last_read_date;
    });
    assertPopulationFloor(mismatched.length, 100, "records whose last read date is earlier than their last attempt");
    const claiming = mismatched.filter((o) => o.last_read_outcome !== null || o.last_read_found !== null);
    assert.deepStrictEqual(claiming.map((o) => o.vendor), []);
  });
});

describe("the note the vendor page renders beside the day we last read", () => {
  const record = { vendor: "Examplebase", url: "https://examplebase.dev/pricing", verifiedDate: "2026-08-26" };
  const held = process.env.AGENTDEALS_VERIFICATION_STATE_PATH;
  let scratch = "";

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "settled-read-"));
    process.env.AGENTDEALS_VERIFICATION_STATE_PATH = join(scratch, "verification_state.json");
  });

  after(() => {
    if (held === undefined) delete process.env.AGENTDEALS_VERIFICATION_STATE_PATH;
    else process.env.AGENTDEALS_VERIFICATION_STATE_PATH = held;
    rmSync(scratch, { recursive: true, force: true });
    resetVerificationStateCache();
  });

  function readOn(date: string): void {
    writeFileSync(
      process.env.AGENTDEALS_VERIFICATION_STATE_PATH!,
      JSON.stringify({
        generated_at: date,
        records: [{ ...record, last_attempt_at: date, last_outcome: "changed", last_success: null, consecutive_failures: 0 }],
      }),
    );
    resetVerificationStateCache();
  }

  it("states what we did about the difference where a refusal carries the day of the read", () => {
    readOn("2026-09-11");
    const note = lastReadNote(record, null, [refused("confirmed_unchanged", "2026-09-11")]);
    assert.ok(note.includes(RESTATED), note);
    assert.ok(!note.includes(A_DISAGREEMENT_STANDS), note);
  });

  it("states the disagreement where the only refusal carries the catalogue date instead", () => {
    readOn("2026-09-11");
    const note = lastReadNote(record, null, [refused("confirmed_unchanged", record.verifiedDate)]);
    assert.ok(note.includes(A_DISAGREEMENT_STANDS), note);
    assert.ok(!note.includes(RESTATED), note);
  });

  it("states the disagreement where we hold no refusal of that read at all", () => {
    readOn("2026-09-11");
    assert.ok(lastReadNote(record, null, []).includes(A_DISAGREEMENT_STANDS));
  });

  it("states the disagreement where the same-day refusal rests on other grounds", () => {
    readOn("2026-09-11");
    const note = lastReadNote(record, null, [refused("unquantified_limit", "2026-09-11")]);
    assert.ok(note.includes(A_DISAGREEMENT_STANDS), note);
  });
});
