import { describe, it } from "node:test";
import assert from "node:assert";
import { assertFutureChangesInDigestWindow } from "./weekly-deadline-window.ts";

const today = "2026-11-01";
const earlier = { vendor: "Earlier Model", date: "2026-11-20" };
const finalDay = { vendor: "Final Model", date: "2026-11-26" };
const tied = { vendor: "Tied Model", date: "2026-11-26" };
const later = { vendor: "Later Model", date: "2026-11-27" };
const digest = {
  summary: "No pricing change with a known effective date this week. 2 upcoming deadlines through 2026-11-26.",
  upcoming_deadlines: [earlier, finalDay],
  deal_changes: [] as Array<{ vendor: string; date: string }>,
};

describe("the weekly digest's stated deadline window", () => {
  it("allows a missing record dated after the stated last date", () => {
    assertFutureChangesInDigestWindow(digest, [earlier, finalDay, later], today);
  });

  it("rejects a missing record dated before the stated last date", () => {
    const missing = { vendor: "Missing Earlier Model", date: "2026-11-19" };
    assert.throws(
      () => assertFutureChangesInDigestWindow(digest, [earlier, finalDay, missing, later], today),
      /Missing Earlier Model 2026-11-19 should be an upcoming deadline through 2026-11-26/
    );
  });

  it("rejects a missing record sharing the last date with a returned record", () => {
    assert.throws(
      () => assertFutureChangesInDigestWindow(digest, [earlier, finalDay, tied, later], today),
      /Tied Model 2026-11-26 should be an upcoming deadline through 2026-11-26/
    );
  });

  it("requires the same vendor on each of its in-window dates", () => {
    const missing = { vendor: earlier.vendor, date: "2026-11-21" };
    assert.throws(
      () => assertFutureChangesInDigestWindow(digest, [earlier, missing, finalDay], today),
      /Earlier Model 2026-11-21 should be an upcoming deadline/
    );
  });

  it("rejects a future record reported as already tracked even beyond the deadline window", () => {
    for (const record of [earlier, finalDay, later]) {
      assert.throws(
        () => assertFutureChangesInDigestWindow({ ...digest, deal_changes: [record] }, [earlier, finalDay, later], today),
        /should not be reported as a change already tracked/
      );
    }
  });

  it("requires a stated last date matching the returned window", () => {
    for (const summary of ["2 upcoming deadlines.", "2 upcoming deadlines through 2026-11-20.", "2 upcoming deadlines through 2026-11-27."]) {
      assert.throws(() => assertFutureChangesInDigestWindow({ ...digest, summary }, [earlier, finalDay], today));
    }
  });

  it("requires the stated count to match the returned deadlines", () => {
    assert.throws(
      () => assertFutureChangesInDigestWindow({ ...digest, summary: "3 upcoming deadlines through 2026-11-26." }, [earlier, finalDay], today),
      /The summary must count the returned deadlines/
    );
  });

  it("allows an empty window only without future records or a stated last date", () => {
    const empty = { summary: "No pricing change with a known effective date this week.", upcoming_deadlines: [], deal_changes: [] };
    assertFutureChangesInDigestWindow(empty, [], today);
    assert.throws(() => assertFutureChangesInDigestWindow(empty, [later], today), /Future changes require a nonempty deadline window/);
    assert.throws(() => assertFutureChangesInDigestWindow({ ...empty, summary: digest.summary }, [], today), /An empty deadline list must not state a last date/);
  });
});
