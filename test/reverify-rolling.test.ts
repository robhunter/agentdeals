import { describe, it } from "node:test";
import assert from "node:assert";

const {
  pickOldestEntries,
  lastAttemptedDate,
  repickedNextRun,
  quarantineRetryBudget,
  runAiMode,
  runUrlMode,
  summaryLines,
} = await import("../scripts/reverify-rolling.js");
const {
  ATTEMPT_CHANGED,
  ATTEMPT_CONFIRMED,
  ATTEMPT_FETCH_FAILED,
  ATTEMPT_SOURCE_UNUSABLE,
  ATTEMPT_UNCLEAR,
  FAILURE_BOT_BLOCK,
  QUARANTINE_AFTER_FAILURES,
  QUARANTINE_RETRY_DAYS,
  recordAttempts,
} = await import("../scripts/verification-state.js");
const {
  SOURCE_CHECK_OK,
  SOURCE_CHECK_NO_TERMS,
  SOURCE_CHECK_UNREADABLE,
  SOURCE_CHECK_OUTCOMES,
} = await import("../scripts/vendor-naming.js");

describe("rolling re-verification", () => {
  describe("pickOldestEntries", () => {
    it("picks the N oldest entries by verifiedDate", () => {
      const offers = [
        { vendor: "Newest", verifiedDate: "2026-04-20" },
        { vendor: "Middle", verifiedDate: "2026-04-10" },
        { vendor: "Oldest", verifiedDate: "2026-03-01" },
        { vendor: "Newer", verifiedDate: "2026-04-15" },
      ];
      const { picked, oldestRemaining } = pickOldestEntries(offers, 2);
      assert.strictEqual(picked.length, 2);
      assert.strictEqual(picked[0].offer.vendor, "Oldest");
      assert.strictEqual(picked[1].offer.vendor, "Middle");
      assert.strictEqual(oldestRemaining, "2026-04-15");
    });

    it("treats missing verifiedDate as oldest", () => {
      const offers = [
        { vendor: "Recent", verifiedDate: "2026-04-20" },
        { vendor: "NoDate" },
        { vendor: "Old", verifiedDate: "2026-03-01" },
      ];
      const { picked } = pickOldestEntries(offers, 2);
      assert.strictEqual(picked[0].offer.vendor, "NoDate");
      assert.strictEqual(picked[1].offer.vendor, "Old");
    });

    it("preserves the original index for in-place updates", () => {
      const offers = [
        { vendor: "A", verifiedDate: "2026-04-20" },
        { vendor: "B", verifiedDate: "2026-03-01" },
        { vendor: "C", verifiedDate: "2026-04-10" },
      ];
      const { picked } = pickOldestEntries(offers, 2);
      assert.strictEqual(picked[0].index, 1);
      assert.strictEqual(picked[1].index, 2);
    });

    it("returns null oldestRemaining when limit covers everything", () => {
      const offers = [{ vendor: "Only", verifiedDate: "2026-04-20" }];
      const { picked, oldestRemaining } = pickOldestEntries(offers, 100);
      assert.strictEqual(picked.length, 1);
      assert.strictEqual(oldestRemaining, null);
    });

    it("is idempotent in selection given a fixed input", () => {
      const offers = [
        { vendor: "A", verifiedDate: "2026-04-20" },
        { vendor: "B", verifiedDate: "2026-03-01" },
        { vendor: "C", verifiedDate: "2026-04-10" },
      ];
      const first = pickOldestEntries(offers, 2);
      const second = pickOldestEntries(offers, 2);
      assert.deepStrictEqual(
        first.picked.map((p) => p.offer.vendor),
        second.picked.map((p) => p.offer.vendor)
      );
    });
  });

  describe("the date a read publishes is the day the read happened", () => {
    const NOW = new Date("2026-04-21T00:30:00Z");
    const THE_DAY_WE_READ = "2026-04-21";
    const A_WHOLE_BATCH = 24;

    const readable = Array.from({ length: A_WHOLE_BATCH }, (_, i) => {
      const name = `Vendor${"abcdefghijklmnopqrstuvwx"[i]}`;
      return {
        vendor: name,
        url: `https://${name.toLowerCase()}.example/pricing`,
        description: "Free tier: 10 GB",
        category: "Storage",
        verifiedDate: "2026-01-01",
      };
    });
    const picked = readable.map((offer, index) => ({ index, offer }));

    const pageNaming = async (url: string) => {
      const vendor = url.split("//")[1].split(".")[0];
      return { ok: true, text: `${vendor} pricing. Free tier: 10 GB per month for $0.`, truncated: false };
    };
    const everyOneReachable = async (batch: any[]) => ({
      verified: batch.map((b) => ({ index: b.index, vendor: b.offer.vendor })),
      flagged: [],
    });

    it("stamps the day of the read on every record a URL-mode run confirms", async () => {
      const data = { offers: readable.map((o) => ({ ...o })) };
      const result = await runUrlMode(picked, data, false, NOW, {
        batchFn: everyOneReachable,
        fetchFn: pageNaming,
      });
      assert.strictEqual(result.verified, A_WHOLE_BATCH);
      assert.deepStrictEqual([...new Set(data.offers.map((o: any) => o.verifiedDate))], [THE_DAY_WE_READ]);
    });

    it("stamps the day of the read on every record an AI-mode run confirms", async () => {
      const data = { offers: readable.map((o) => ({ ...o })) };
      const result = await runAiMode(picked, data, false, NOW, {
        fetchFn: pageNaming,
        verifyFn: async () => ({ status: "confirmed" }),
        confirmFn: async () => ({ describes_change: true }),
        rateLimitMs: 0,
      });
      assert.strictEqual(result.verified, A_WHOLE_BATCH);
      assert.deepStrictEqual([...new Set(data.offers.map((o: any) => o.verifiedDate))], [THE_DAY_WE_READ]);
    });

    it("publishes the same day the state file records the confirmation on", async () => {
      const data = { offers: readable.map((o) => ({ ...o })) };
      const result = await runAiMode(picked, data, false, NOW, {
        fetchFn: pageNaming,
        verifyFn: async () => ({ status: "confirmed" }),
        confirmFn: async () => ({ describes_change: true }),
        rateLimitMs: 0,
      });
      const state = new Map();
      recordAttempts(state, result.attempts, NOW);
      const confirmed = [...state.values()].filter((r: any) => r.last_outcome === ATTEMPT_CONFIRMED);
      assert.strictEqual(confirmed.length, A_WHOLE_BATCH);
      const published = new Map(data.offers.map((o: any) => [o.vendor, o.verifiedDate]));
      const disagreeing = confirmed.filter((r: any) => published.get(r.vendor) !== r.last_success);
      assert.deepStrictEqual(disagreeing, []);
    });

    it("holds the published date where the source check could not read terms", async () => {
      const data = { offers: readable.map((o) => ({ ...o })) };
      const result = await runAiMode(picked, data, false, NOW, {
        fetchFn: async () => ({ ok: true, text: "An about page naming nobody and pricing nothing.", truncated: false }),
        verifyFn: async () => ({ status: "confirmed" }),
        confirmFn: async () => ({ describes_change: true }),
        rateLimitMs: 0,
      });
      assert.strictEqual(result.verified, 0);
      assert.deepStrictEqual([...new Set(data.offers.map((o: any) => o.verifiedDate))], ["2026-01-01"]);
    });
  });
});

describe("a record that has been checked does not return to the head of the queue", () => {
  const NOW = new Date("2026-08-28T10:00:00Z");

  function offer(vendor: string, verifiedDate: string) {
    return { vendor, url: `https://${vendor.toLowerCase()}.example/pricing`, verifiedDate, description: `${vendor} free tier` };
  }

  function stateFor(rows: Array<{ vendor: string; outcome: string; days?: number; category?: string }>) {
    const state = new Map();
    for (const row of rows) {
      const at = new Date(NOW.getTime() - (row.days ?? 0) * 86_400_000);
      recordAttempts(
        state,
        [{ vendor: row.vendor, url: `https://${row.vendor.toLowerCase()}.example/pricing`, outcome: row.outcome, category: row.category ?? null }],
        at,
      );
    }
    return state;
  }

  it("reads the attempt stamp, not only the date the record was last confirmed", () => {
    const checked = offer("Checked", "2026-04-12");
    const state = stateFor([{ vendor: "Checked", outcome: ATTEMPT_CHANGED }]);
    assert.strictEqual(
      lastAttemptedDate(checked, null, state.get("Checked|https://checked.example/pricing")),
      "2026-08-28",
    );
  });

  it("sends a record whose check produced a change to the back of the queue", () => {
    const offers = [offer("Changed", "2026-04-12"), offer("Untouched", "2026-07-01")];
    const state = stateFor([{ vendor: "Changed", outcome: ATTEMPT_CHANGED }]);
    const { picked } = pickOldestEntries(offers, 1, NOW, { verificationState: state });
    assert.strictEqual(picked[0].offer.vendor, "Untouched");
  });

  it("leaves the record's own verifiedDate alone, so the site still says it is stale", () => {
    const changed = offer("Changed", "2026-04-12");
    const state = stateFor([{ vendor: "Changed", outcome: ATTEMPT_CHANGED }]);
    pickOldestEntries([changed], 1, NOW, { verificationState: state });
    assert.strictEqual(changed.verifiedDate, "2026-04-12");
  });

  it("sends a record the model could not read a verdict from to the back too", () => {
    const offers = [offer("Unclear", "2026-04-12"), offer("Untouched", "2026-07-01")];
    const state = stateFor([{ vendor: "Unclear", outcome: ATTEMPT_UNCLEAR }]);
    const { picked } = pickOldestEntries(offers, 1, NOW, { verificationState: state });
    assert.strictEqual(picked[0].offer.vendor, "Untouched");
  });

  it("reports how much of this run's work the next run would repeat", () => {
    const offers = [
      offer("A", "2026-04-12"),
      offer("B", "2026-04-13"),
      offer("C", "2026-07-01"),
      offer("D", "2026-07-02"),
    ];
    const picked = pickOldestEntries(offers, 2, NOW).picked;
    assert.deepStrictEqual(picked.map((p: any) => p.offer.vendor), ["A", "B"]);
    assert.strictEqual(repickedNextRun(picked, offers, 2, NOW), 2);
    const state = stateFor([
      { vendor: "A", outcome: ATTEMPT_CHANGED },
      { vendor: "B", outcome: ATTEMPT_CHANGED },
    ]);
    assert.strictEqual(repickedNextRun(picked, offers, 2, NOW, { verificationState: state }), 0);
  });
});

describe("quarantine keeps a failing record out of the daily budget without dropping it", () => {
  const NOW = new Date("2026-08-28T10:00:00Z");

  function offer(vendor: string, verifiedDate = "2026-04-12") {
    return { vendor, url: `https://${vendor.toLowerCase()}.example/pricing`, verifiedDate };
  }

  function failUntilQuarantined(state: Map<string, unknown>, vendor: string, lastAttempt: Date) {
    for (let i = QUARANTINE_AFTER_FAILURES - 1; i >= 0; i--) {
      recordAttempts(
        state,
        [{ vendor, url: `https://${vendor.toLowerCase()}.example/pricing`, outcome: ATTEMPT_FETCH_FAILED, category: FAILURE_BOT_BLOCK, detail: "HTTP 403" }],
        new Date(lastAttempt.getTime() - i * 86_400_000),
      );
    }
    return state;
  }

  it("excludes a quarantined record from the oldest-N selection", () => {
    const offers = [offer("Blocked"), offer("Fine", "2026-07-01")];
    const state = failUntilQuarantined(new Map(), "Blocked", NOW);
    const { picked, quarantineHeld } = pickOldestEntries(offers, 1, NOW, { verificationState: state });
    assert.strictEqual(picked[0].offer.vendor, "Fine");
    assert.strictEqual(quarantineHeld, 1);
  });

  it("retries it once the backoff has elapsed", () => {
    const offers = [offer("Blocked"), offer("Fine", "2026-07-01")];
    const state = failUntilQuarantined(new Map(), "Blocked", NOW);
    const later = new Date(NOW.getTime() + QUARANTINE_RETRY_DAYS * 86_400_000);
    const { picked, retriedFromQuarantine } = pickOldestEntries(offers, 2, later, { verificationState: state });
    assert.strictEqual(retriedFromQuarantine, 1);
    assert.deepStrictEqual(picked.map((p: any) => p.offer.vendor).sort(), ["Blocked", "Fine"]);
  });

  it("never lets due retries take more than their share of a run", () => {
    const offers: any[] = [];
    const state = new Map();
    for (let i = 0; i < 40; i++) {
      offers.push(offer(`Blocked${i}`));
      failUntilQuarantined(state, `Blocked${i}`, new Date(NOW.getTime() - 30 * 86_400_000));
    }
    for (let i = 0; i < 40; i++) offers.push(offer(`Fresh${i}`, "2026-07-01"));
    const { picked, retriedFromQuarantine } = pickOldestEntries(offers, 10, NOW, { verificationState: state });
    assert.strictEqual(picked.length, 10);
    assert.strictEqual(retriedFromQuarantine, quarantineRetryBudget(10));
    assert.ok(retriedFromQuarantine < 10, "a run of due retries must not consume the whole budget");
  });

  it("gives the spare slots to quarantine when there is nothing else left to check", () => {
    const offers: any[] = [];
    const state = new Map();
    for (let i = 0; i < 5; i++) {
      offers.push(offer(`Blocked${i}`));
      failUntilQuarantined(state, `Blocked${i}`, new Date(NOW.getTime() - 30 * 86_400_000));
    }
    offers.push(offer("Fine", "2026-07-01"));
    const { picked, retriedFromQuarantine } = pickOldestEntries(offers, 6, NOW, { verificationState: state });
    assert.strictEqual(picked.length, 6);
    assert.strictEqual(retriedFromQuarantine, 5);
  });

  it("puts a released record straight back into normal rotation", () => {
    const offers = [offer("Blocked"), offer("Fine", "2026-07-01")];
    const state = failUntilQuarantined(new Map(), "Blocked", NOW);
    recordAttempts(state, [{ vendor: "Blocked", url: "https://blocked.example/pricing", outcome: ATTEMPT_CONFIRMED }], NOW);
    const { picked, quarantineHeld } = pickOldestEntries(offers, 2, NOW, { verificationState: state });
    assert.strictEqual(quarantineHeld, 0);
    assert.strictEqual(picked.length, 2);
  });
});

describe("every checked record leaves an attempt behind", () => {
  const NOW = new Date("2026-08-28T10:00:00Z");

  const offers = [
    { vendor: "Confirmed", url: "https://confirmed.example/pricing", description: "Free tier: 10 GB", verifiedDate: "2026-04-12", category: "Storage" },
    { vendor: "Changed", url: "https://changed.example/pricing", description: "Free tier: 10 GB", verifiedDate: "2026-04-12", category: "Storage" },
    { vendor: "Unclear", url: "https://unclear.example/pricing", description: "Free tier: 10 GB", verifiedDate: "2026-04-12", category: "Storage" },
    { vendor: "Unfetchable", url: "https://unfetchable.example/pricing", description: "Free tier: 10 GB", verifiedDate: "2026-04-12", category: "Storage" },
    { vendor: "Erroring", url: "https://erroring.example/pricing", description: "Free tier: 10 GB", verifiedDate: "2026-04-12", category: "Storage" },
  ];
  const picked = offers.map((offer, index) => ({ index, offer }));

  const pageFor = async (url: string) => {
    if (url.includes("unfetchable")) return { ok: false, error: "HTTP 403" };
    const vendor = url.split("//")[1].split(".")[0];
    return { ok: true, text: `${vendor} pricing. Free tier: 10 GB per month for $0.`, truncated: false };
  };

  const verdictFor = async (offer: any) => {
    if (offer.vendor === "Changed") {
      return { status: "changed", summary: "the free tier is now 5 GB", change_type: "limits_reduced", current_state: "Free tier: 5 GB", impact: "medium" };
    }
    if (offer.vendor === "Unclear") return { status: "unclear", summary: "the page states no limits" };
    if (offer.vendor === "Erroring") throw new Error("upstream returned 500");
    return { status: "confirmed" };
  };

  it("records one attempt per checked record, whatever the verdict was", async () => {
    const data = { offers: offers.map((o) => ({ ...o })) };
    const result = await runAiMode(picked, data, true, NOW, {
      fetchFn: pageFor,
      verifyFn: verdictFor,
      confirmFn: async () => ({ describes_change: true }),
      rateLimitMs: 0,
    });
    assert.strictEqual(result.attempts.length, offers.length);
    const byVendor = new Map(result.attempts.map((a: any) => [a.vendor, a]));
    assert.strictEqual(byVendor.get("Confirmed").outcome, ATTEMPT_CONFIRMED);
    assert.strictEqual(byVendor.get("Changed").outcome, ATTEMPT_CHANGED);
    assert.strictEqual(byVendor.get("Unclear").outcome, ATTEMPT_UNCLEAR);
    assert.strictEqual(byVendor.get("Unfetchable").outcome, ATTEMPT_FETCH_FAILED);
    assert.strictEqual(byVendor.get("Unfetchable").category, FAILURE_BOT_BLOCK);
    assert.strictEqual(byVendor.get("Erroring").outcome, "ai_error");
  });

  it("records the source as the reason when the page we cite is not usable", async () => {
    const stranger = { vendor: "Stranger", url: "https://aggregator.example/offers", description: "Free tier: 10 GB", verifiedDate: "2026-04-12", category: "Storage" };
    const data = { offers: [{ ...stranger }] };
    const result = await runAiMode([{ index: 0, offer: stranger }], data, true, NOW, {
      fetchFn: async () => ({ ok: true, text: "A page about something else entirely, priced at $9 per month.", truncated: false }),
      verifyFn: async () => ({ status: "confirmed" }),
      confirmFn: async () => ({ describes_change: false }),
      rateLimitMs: 0,
    });
    assert.strictEqual(result.attempts.length, 1);
    assert.strictEqual(result.attempts[0].outcome, ATTEMPT_SOURCE_UNUSABLE);
  });

  it("records an attempt for every record in URL mode too", async () => {
    const data = { offers: offers.map((o) => ({ ...o })) };
    const batchFn = async (batch: any[]) => ({
      verified: batch.filter((b) => b.offer.vendor !== "Unfetchable").map((b) => ({ index: b.index })),
      flagged: batch.filter((b) => b.offer.vendor === "Unfetchable").map((b) => ({ vendor: b.offer.vendor, url: b.offer.url, error: "HTTP 403" })),
    });
    const result = await runUrlMode(picked, data, true, NOW, { batchFn, fetchFn: pageFor });
    assert.strictEqual(result.attempts.length, offers.length);
    const blocked = result.attempts.find((a: any) => a.vendor === "Unfetchable");
    assert.strictEqual(blocked.outcome, ATTEMPT_FETCH_FAILED);
    assert.strictEqual(blocked.category, FAILURE_BOT_BLOCK);
  });
});

describe("the run summary says whether the queue moved", () => {
  const base = { useAi: true, checked: 75, oldestRemaining: "2026-07-13", total: 1580 };
  const result = {
    verified: 6, flagged: 6, changed: 63, changes: [], recorded: [], suppressed: [],
    unclassified: [], rejected: [], unchecked: [], reclassified: [], overruled: [], sourceChecks: new Map(),
  };

  it("states how many of the records just checked come back on the next run", () => {
    const lines = summaryLines(result, { ...base, repicked: 48 });
    assert.ok(lines.some((l: string) => l === "Checked again on the next run: 48 of 75"), lines.join("\n"));
  });

  it("separates a retry from an entry and a release", () => {
    const lines = summaryLines(result, {
      ...base,
      repicked: 0,
      quarantine: { retried: 15, entered: 4, left: 2, total: 65, byCategory: new Map([[FAILURE_BOT_BLOCK, 27]]) },
    });
    const text = lines.join("\n");
    assert.match(text, /Retried from quarantine: 15/);
    assert.match(text, /Left quarantine \(checked successfully\): 2/);
    assert.match(text, /Entered quarantine \(3 consecutive failures\): 4/);
    assert.match(text, /In quarantine, retried every 7 days: 65/);
    assert.match(text, /bot_block: 27/);
  });

  it("says nothing about quarantine when the run reported none", () => {
    const lines = summaryLines(result, base);
    assert.ok(!lines.some((l: string) => l.includes("quarantine")), lines.join("\n"));
  });
});

describe("a read that failed buys the record no reprieve", () => {
  const NOW = new Date("2026-09-02T10:00:00Z");
  const CONFIRMED_ON = "2026-07-05";
  const READ_ON = "2026-09-02";

  function offer(vendor: string, outcome: string | null, verifiedDate = CONFIRMED_ON) {
    const url = `https://${vendor.toLowerCase()}.example/pricing`;
    const base: any = { vendor, url, verifiedDate, description: `${vendor} free tier` };
    if (outcome) base.source_check = { outcome, checked: READ_ON, detail: `${vendor} read` };
    return base;
  }

  function stateOf(rows: Array<{ vendor: string; outcome: string }>, at = NOW) {
    const state = new Map();
    for (const row of rows) {
      recordAttempts(state, [{ vendor: row.vendor, url: `https://${row.vendor.toLowerCase()}.example/pricing`, outcome: row.outcome }], at);
    }
    return state;
  }

  it("counts the day we read the page whatever the read found", () => {
    for (const outcome of SOURCE_CHECK_OUTCOMES) {
      assert.strictEqual(
        lastAttemptedDate(offer("Read", outcome)),
        READ_ON,
        `a check that returned ${outcome} is a day we looked at the page`,
      );
    }
  });

  it("gives the same queue date to a page we could not read as to one we could", () => {
    const unreadable = lastAttemptedDate(offer("Unreadable", SOURCE_CHECK_UNREADABLE));
    const read = lastAttemptedDate(offer("Read", SOURCE_CHECK_OK));
    assert.strictEqual(unreadable, read);
  });

  it("lets the check's outcome decide nothing about which of two same-day reads goes first", () => {
    const unreadable = offer("Unreadable", SOURCE_CHECK_UNREADABLE);
    const read = offer("Read", SOURCE_CHECK_OK);
    for (const pair of [[unreadable, read], [read, unreadable]]) {
      const { picked } = pickOldestEntries(pair, 1, NOW);
      assert.strictEqual(picked[0].offer.vendor, pair[0].vendor);
    }
  });

  it("places no record whose last read failed behind one of the same age whose read answered", () => {
    const rows = [];
    for (let i = 0; i < 24; i++) {
      rows.push({ vendor: `Vendor${i}`, answered: i % 2 === 0 });
    }
    const offers = rows.map((row) => offer(row.vendor, SOURCE_CHECK_OK));
    const state = stateOf(rows.map((row) => ({
      vendor: row.vendor,
      outcome: row.answered ? ATTEMPT_CONFIRMED : ATTEMPT_SOURCE_UNUSABLE,
    })));
    const { picked } = pickOldestEntries(offers, offers.length, NOW, { verificationState: state });
    const answeredBy = new Map(rows.map((row) => [row.vendor, row.answered]));
    const order = picked.map((entry: any) => entry.offer.vendor);
    const failedPlaces = order.map((v: string, i: number) => (answeredBy.get(v) ? -1 : i)).filter((i: number) => i >= 0);
    const answeredPlaces = order.map((v: string, i: number) => (answeredBy.get(v) ? i : -1)).filter((i: number) => i >= 0);
    assert.strictEqual(failedPlaces.length + answeredPlaces.length, rows.length);
    assert.ok(
      Math.max(...failedPlaces) < Math.min(...answeredPlaces),
      `a record read on ${READ_ON} without an answer sits behind one that answered: ${order.join(", ")}`,
    );
  });

  it("still puts an older record ahead of a newer one whose read failed", () => {
    const older = offer("Older", SOURCE_CHECK_OK, "2026-06-01");
    delete older.source_check;
    const newer = offer("Newer", SOURCE_CHECK_NO_TERMS);
    const state = stateOf([{ vendor: "Newer", outcome: ATTEMPT_SOURCE_UNUSABLE }]);
    const { picked } = pickOldestEntries([newer, older], 1, NOW, { verificationState: state });
    assert.strictEqual(picked[0].offer.vendor, "Older");
  });

  it("does not read a record nobody has attempted yet as one whose read failed", () => {
    const answered = offer("Answered", SOURCE_CHECK_OK);
    const unattempted = offer("Unattempted", SOURCE_CHECK_OK);
    const state = stateOf([{ vendor: "Answered", outcome: ATTEMPT_CONFIRMED }]);
    for (const pair of [[answered, unattempted], [unattempted, answered]]) {
      const { picked, pickedAfterAFailedRead } = pickOldestEntries(pair, 2, NOW, { verificationState: state });
      assert.strictEqual(pickedAfterAFailedRead, 0);
      assert.strictEqual(picked[0].offer.vendor, pair[0].vendor);
    }
  });

  it("counts how much of the batch it drew after a read that failed", () => {
    const rows = [
      { vendor: "Answered", outcome: ATTEMPT_CONFIRMED },
      { vendor: "Unusable", outcome: ATTEMPT_SOURCE_UNUSABLE },
      { vendor: "Unfetched", outcome: ATTEMPT_FETCH_FAILED },
    ];
    const offers = rows.map((row) => offer(row.vendor, SOURCE_CHECK_OK));
    const { picked, pickedAfterAFailedRead } = pickOldestEntries(offers, 3, NOW, { verificationState: stateOf(rows) });
    assert.strictEqual(picked.length, 3);
    assert.strictEqual(pickedAfterAFailedRead, 2);
  });
});
