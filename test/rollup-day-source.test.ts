import { describe, it } from "node:test";
import assert from "node:assert";
import { splitDayPageViews, splitSignalKeys, getRollupDaySource, getRollupDatesAvailable } from "../src/stats.ts";

describe("splitting a stored day into rollup input", () => {
  it("counts served views from the route keys, never from the stored total", () => {
    const split = splitDayPageViews({
      total: 210,
      "/vendor/:slug": 100,
      "/search": 50,
      "/": 30,
      __not_found__: 17,
      __redirect__: 9,
      __unmatched__: 4,
    });
    assert.equal(split.served, 180);
    assert.equal(split.not_found, 17);
    assert.equal(split.redirects, 9);
  });

  it("keeps the pseudo keys out of the route map so none is ever read as a page", () => {
    const split = splitDayPageViews({
      total: 10,
      "/": 6,
      __not_found__: 3,
      __redirect__: 1,
      __unmatched__: 2,
    });
    assert.deepEqual(Object.keys(split.by_route), ["/"]);
  });

  it("reports the excess a stored total carries over its surviving route keys", () => {
    const split = splitDayPageViews({ total: 500, "/": 20, __unmatched__: 5 });
    assert.equal(split.served, 20);
    assert.equal(split.unclassified_legacy, 480);
  });

  it("reads an empty day as measured zero rather than as missing", () => {
    const split = splitDayPageViews({});
    assert.equal(split.served, 0);
    assert.equal(split.not_found, 0);
    assert.deepEqual(split.by_route, {});
  });

  it("routes each signal facet to its own bucket", () => {
    const split = splitSignalKeys({
      total: 6,
      "e:recommended": 5,
      "e:converted": 1,
      "t:post": 6,
      "c:ai_agent": 6,
      "s:/vendor/:slug": 4,
      "a:some-agent": 6,
      "v:recommended:neon": 3,
      "u:a name we do not carry": 2,
      "x:an unlisted event": 1,
    });
    assert.equal(split.total, 6);
    assert.deepEqual(split.by_event, { recommended: 5, converted: 1 });
    assert.deepEqual(split.by_transport, { post: 6 });
    assert.deepEqual(split.by_client_class, { ai_agent: 6 });
    assert.deepEqual(split.by_source, { "/vendor/:slug": 4 });
    assert.deepEqual(split.by_reporting_agent, { "some-agent": 6 });
    assert.deepEqual(split.by_vendor, { "recommended:neon": 3 });
    assert.deepEqual(split.unresolved_vendor_names, { "a name we do not carry": 2 });
    assert.deepEqual(split.unrecognized_events, { "an unlisted event": 1 });
  });

  it("keeps a source key containing the separator intact", () => {
    const split = splitSignalKeys({ "s:/compare/:slug": 3 });
    assert.deepEqual(split.by_source, { "/compare/:slug": 3 });
  });

  it("ignores a facet letter it does not know rather than misfiling it", () => {
    const split = splitSignalKeys({ "z:something": 9, total: 1 });
    assert.equal(split.total, 1);
    for (const bucket of Object.values(split)) {
      if (typeof bucket === "number") continue;
      assert.ok(!("something" in bucket));
    }
  });

  it("reports a day as unavailable rather than empty when storage is not configured", () => {
    const source = getRollupDaySource("2026-08-20");
    assert.equal(source.available, false);
    assert.equal(source.reason, "redis-not-configured");
    assert.equal(source.page_views.served, 0);
  });

  it("offers no dates when there is no snapshot to read them from", () => {
    assert.deepEqual(getRollupDatesAvailable(), []);
  });
});
