import { describe, it } from "node:test";
import assert from "node:assert";
import { dayNamedBySince, sinceFilterDay, SINCE_ACCEPTS } from "../dist/since-parameter.js";

describe("reading the since parameter", () => {
  it("reads a calendar date as itself", () => {
    assert.equal(dayNamedBySince("2026-09-12"), "2026-09-12");
    assert.equal(dayNamedBySince("2024-02-29"), "2024-02-29");
    assert.equal(dayNamedBySince("2000-02-29"), "2000-02-29");
  });

  it("reads a timestamp as the day it names, whatever time it carries", () => {
    for (const suffix of [
      "T00:00:00Z",
      "T23:59:59Z",
      "T12:00:00.000Z",
      "T00:00:00+00:00",
      "T20:00:00-07:00",
      "T00:00",
      " 08:30:00",
      "T00:00:00",
      "T00:00:00.123456789Z",
      "T09:15:30+0530",
    ]) {
      assert.equal(dayNamedBySince(`2026-09-12${suffix}`), "2026-09-12", `2026-09-12${suffix} named a different day`);
    }
  });

  it("refuses a date the calendar does not have", () => {
    for (const value of ["2026-02-30", "2026-02-29", "2026-13-99", "2026-00-10", "2026-04-31", "2026-06-31", "1900-02-29", "2026-01-00"]) {
      assert.equal(dayNamedBySince(value), null, `${value} was read as a day`);
    }
  });

  it("refuses a time the clock does not have", () => {
    for (const value of ["2026-09-12T24:00:00Z", "2026-09-12T12:60:00Z", "2026-09-12T12:00:60Z", "2026-09-12T99:99:99Z"]) {
      assert.equal(dayNamedBySince(value), null, `${value} was read as a day`);
    }
  });

  it("refuses input that names no date at all", () => {
    for (const value of ["", "not-a-date", "2026-9-1", "2026", "2026-09", "2026-09-12T", "2026-09-12garbage", "12/09/2026", "1757635200"]) {
      assert.equal(dayNamedBySince(value), null, `${value} was read as a day`);
    }
  });

  it("leaves a value it cannot read untouched, so a caller that does not validate keeps the answer it had", () => {
    assert.equal(sinceFilterDay(undefined), undefined);
    assert.equal(sinceFilterDay("2026-09-12T00:00:00Z"), "2026-09-12");
    assert.equal(sinceFilterDay("not-a-date"), "not-a-date");
  });

  it("states the rule the routes publish", () => {
    assert.match(SINCE_ACCEPTS, /YYYY-MM-DD/);
    assert.match(SINCE_ACCEPTS, /ISO-8601/);
    assert.match(SINCE_ACCEPTS, /400/);
  });
});
