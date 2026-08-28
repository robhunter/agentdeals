import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  ATTEMPT_AI_ERROR,
  ATTEMPT_CHANGED,
  ATTEMPT_CONFIRMED,
  ATTEMPT_FETCH_FAILED,
  ATTEMPT_LINK_OK,
  ATTEMPT_SOURCE_UNUSABLE,
  ATTEMPT_UNCLEAR,
  FAILURE_AI_EXTRACTION,
  FAILURE_BOT_BLOCK,
  FAILURE_EMPTY_PAGE,
  FAILURE_HTTP_ERROR,
  FAILURE_NETWORK,
  FAILURE_SOURCE_UNUSABLE,
  FAILURE_TIMEOUT,
  FAILURE_UNREACHABLE,
  QUARANTINE_AFTER_FAILURES,
  QUARANTINE_RETRY_DAYS,
  applyAttempt,
  backfillFailureCount,
  backfillVerificationState,
  classifyFetchError,
  emptyRecord,
  failureCategoryCounts,
  isQuarantined,
  nextRetryDate,
  pruneToOffers,
  quarantineRetryDue,
  quarantinedRecords,
  readVerificationState,
  recordAttempts,
  shiftIsoDays,
  writeVerificationState,
} = await import("../scripts/verification-state.js");

const DAY = "2026-08-28";

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    vendor: "Acme",
    url: "https://acme.example/pricing",
    outcome: ATTEMPT_CONFIRMED,
    detail: null,
    category: null,
    date: DAY,
    ...overrides,
  };
}

describe("verification state", () => {
  describe("classifyFetchError", () => {
    it("separates being refused from the destination being gone", () => {
      assert.strictEqual(classifyFetchError("HTTP 403"), FAILURE_BOT_BLOCK);
      assert.strictEqual(classifyFetchError("HTTP 429"), FAILURE_BOT_BLOCK);
      assert.strictEqual(classifyFetchError("HTTP 401"), FAILURE_BOT_BLOCK);
      assert.strictEqual(classifyFetchError("HTTP 404"), FAILURE_UNREACHABLE);
      assert.strictEqual(classifyFetchError("HTTP 410"), FAILURE_UNREACHABLE);
    });

    it("keeps a gateway error apart from both", () => {
      assert.strictEqual(classifyFetchError("HTTP 502"), FAILURE_HTTP_ERROR);
      assert.strictEqual(classifyFetchError("HTTP 503"), FAILURE_HTTP_ERROR);
      assert.strictEqual(classifyFetchError("HTTP 402"), FAILURE_HTTP_ERROR);
    });

    it("reads the liveness job's own detail format", () => {
      assert.strictEqual(classifyFetchError("GET 403"), FAILURE_BOT_BLOCK);
      assert.strictEqual(classifyFetchError("GET 404"), FAILURE_UNREACHABLE);
      assert.strictEqual(classifyFetchError("HEAD 502"), FAILURE_HTTP_ERROR);
    });

    it("names a timeout, a page that rendered nothing, and a hostname that does not resolve", () => {
      assert.strictEqual(classifyFetchError("timeout"), FAILURE_TIMEOUT);
      assert.strictEqual(
        classifyFetchError("page content too short (likely JS-rendered SPA)"),
        FAILURE_EMPTY_PAGE,
      );
      assert.strictEqual(classifyFetchError("getaddrinfo ENOTFOUND acme.example"), FAILURE_UNREACHABLE);
    });

    it("treats a transient DNS failure as our network, not a dead host", () => {
      assert.strictEqual(classifyFetchError("GET EAI_AGAIN"), FAILURE_NETWORK);
      assert.strictEqual(classifyFetchError("fetch failed"), FAILURE_NETWORK);
    });
  });

  describe("applyAttempt", () => {
    it("stamps the attempt date on an outcome that found a change", () => {
      const record = applyAttempt(null, attempt({ outcome: ATTEMPT_CHANGED }));
      assert.strictEqual(record.last_attempt_at, DAY);
      assert.strictEqual(record.consecutive_failures, 0);
    });

    it("advances last_success only when the record agreed with its page", () => {
      const changed = applyAttempt(null, attempt({ outcome: ATTEMPT_CHANGED }));
      assert.strictEqual(changed.last_success, null);
      const confirmed = applyAttempt(null, attempt({ outcome: ATTEMPT_CONFIRMED }));
      assert.strictEqual(confirmed.last_success, DAY);
    });

    it("counts consecutive failures and keeps the reason", () => {
      let record = applyAttempt(null, attempt({ outcome: ATTEMPT_FETCH_FAILED, detail: "HTTP 403", category: FAILURE_BOT_BLOCK }));
      assert.strictEqual(record.consecutive_failures, 1);
      assert.strictEqual(record.last_error, "HTTP 403");
      assert.strictEqual(record.failure_category, FAILURE_BOT_BLOCK);
      record = applyAttempt(record, attempt({ outcome: ATTEMPT_UNCLEAR, detail: "no pricing on the page", date: "2026-08-29" }));
      assert.strictEqual(record.consecutive_failures, 2);
    });

    it("quarantines on the third consecutive failure and not before", () => {
      let record: any = null;
      for (let i = 1; i < QUARANTINE_AFTER_FAILURES; i++) {
        record = applyAttempt(record, attempt({ outcome: ATTEMPT_AI_ERROR, category: FAILURE_AI_EXTRACTION }));
        assert.strictEqual(isQuarantined(record), false);
      }
      record = applyAttempt(record, attempt({ outcome: ATTEMPT_AI_ERROR, category: FAILURE_AI_EXTRACTION }));
      assert.strictEqual(isQuarantined(record), true);
      assert.strictEqual(record.quarantined_since, DAY);
    });

    it("never quarantines a record that produced a change", () => {
      let record: any = null;
      for (let i = 0; i < QUARANTINE_AFTER_FAILURES * 2; i++) {
        record = applyAttempt(record, attempt({ outcome: ATTEMPT_CHANGED }));
      }
      assert.strictEqual(isQuarantined(record), false);
      assert.strictEqual(record.consecutive_failures, 0);
    });

    it("releases a quarantined record the moment a check succeeds, and forgets the count", () => {
      let record: any = null;
      for (let i = 0; i < QUARANTINE_AFTER_FAILURES; i++) {
        record = applyAttempt(record, attempt({ outcome: ATTEMPT_FETCH_FAILED, category: FAILURE_BOT_BLOCK }));
      }
      assert.strictEqual(isQuarantined(record), true);
      record = applyAttempt(record, attempt({ outcome: ATTEMPT_LINK_OK, date: "2026-09-10" }));
      assert.strictEqual(isQuarantined(record), false);
      assert.strictEqual(record.consecutive_failures, 0);
      assert.strictEqual(record.last_error, null);
      assert.strictEqual(record.failure_category, null);
    });

    it("keeps the date the record first entered quarantine across later failures", () => {
      let record: any = null;
      for (let i = 0; i < QUARANTINE_AFTER_FAILURES; i++) {
        record = applyAttempt(record, attempt({ outcome: ATTEMPT_FETCH_FAILED, category: FAILURE_BOT_BLOCK }));
      }
      record = applyAttempt(record, attempt({ outcome: ATTEMPT_FETCH_FAILED, category: FAILURE_BOT_BLOCK, date: "2026-09-20" }));
      assert.strictEqual(record.quarantined_since, DAY);
      assert.strictEqual(record.last_attempt_at, "2026-09-20");
    });

    it("carries the last confirmation forward through a run of failures", () => {
      let record = applyAttempt(null, attempt({ outcome: ATTEMPT_CONFIRMED }));
      record = applyAttempt(record, attempt({ outcome: ATTEMPT_FETCH_FAILED, date: "2026-09-01" }));
      record = applyAttempt(record, attempt({ outcome: ATTEMPT_FETCH_FAILED, date: "2026-09-02" }));
      assert.strictEqual(record.last_success, DAY);
    });
  });

  describe("backoff", () => {
    it("gives a record outside quarantine no retry date", () => {
      assert.strictEqual(nextRetryDate(emptyRecord("Acme", "https://acme.example")), null);
    });

    it("holds a quarantined record for the full backoff and then releases it", () => {
      let record: any = null;
      for (let i = 0; i < QUARANTINE_AFTER_FAILURES; i++) {
        record = applyAttempt(record, attempt({ outcome: ATTEMPT_FETCH_FAILED }));
      }
      const due = shiftIsoDays(DAY, QUARANTINE_RETRY_DAYS);
      assert.strictEqual(nextRetryDate(record), due);
      assert.strictEqual(quarantineRetryDue(record, shiftIsoDays(due, -1)), false);
      assert.strictEqual(quarantineRetryDue(record, due), true);
      assert.strictEqual(quarantineRetryDue(record, shiftIsoDays(due, 30)), true);
    });
  });

  describe("recordAttempts", () => {
    it("reports which records entered and left quarantine", () => {
      const state = new Map();
      const failing = { vendor: "Acme", url: "https://acme.example/pricing", outcome: ATTEMPT_FETCH_FAILED, category: FAILURE_BOT_BLOCK };
      recordAttempts(state, [failing], new Date("2026-08-26T00:00:00Z"));
      recordAttempts(state, [failing], new Date("2026-08-27T00:00:00Z"));
      const third = recordAttempts(state, [failing], new Date("2026-08-28T00:00:00Z"));
      assert.strictEqual(third.entered.length, 1);
      assert.strictEqual(third.left.length, 0);

      const released = recordAttempts(
        state,
        [{ vendor: "Acme", url: "https://acme.example/pricing", outcome: ATTEMPT_CONFIRMED }],
        new Date("2026-09-05T00:00:00Z"),
      );
      assert.strictEqual(released.left.length, 1);
      assert.strictEqual(released.entered.length, 0);
    });

    it("keeps one record per offer, not per vendor", () => {
      const state = new Map();
      recordAttempts(
        state,
        [
          { vendor: "Acme", url: "https://acme.example/a", outcome: ATTEMPT_CONFIRMED },
          { vendor: "Acme", url: "https://acme.example/b", outcome: ATTEMPT_FETCH_FAILED },
        ],
        new Date(`${DAY}T00:00:00Z`),
      );
      assert.strictEqual(state.size, 2);
    });
  });

  describe("the file on disk", () => {
    it("round-trips through read and write, sorted so a diff is readable", () => {
      const dir = mkdtempSync(join(tmpdir(), "verification-state-"));
      const path = join(dir, "verification_state.json");
      try {
        const state = new Map();
        recordAttempts(
          state,
          [
            { vendor: "Zeta", url: "https://zeta.example", outcome: ATTEMPT_CONFIRMED },
            { vendor: "Acme", url: "https://acme.example", outcome: ATTEMPT_FETCH_FAILED, detail: "HTTP 403", category: FAILURE_BOT_BLOCK },
          ],
          new Date(`${DAY}T00:00:00Z`),
        );
        writeVerificationState(state, { path, now: new Date(`${DAY}T00:00:00Z`) });
        const written = JSON.parse(readFileSync(path, "utf-8"));
        assert.strictEqual(written.generated_at, DAY);
        assert.deepStrictEqual(written.records.map((r: any) => r.vendor), ["Acme", "Zeta"]);
        const reread = readVerificationState(path);
        assert.strictEqual(reread.size, 2);
        assert.strictEqual(reread.get("Acme|https://acme.example").last_error, "HTTP 403");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes nothing on a dry run", () => {
      const dir = mkdtempSync(join(tmpdir(), "verification-state-"));
      const path = join(dir, "verification_state.json");
      try {
        const state = new Map();
        recordAttempts(state, [{ vendor: "Acme", url: "https://acme.example", outcome: ATTEMPT_CONFIRMED }], new Date());
        writeVerificationState(state, { path, dryRun: true });
        assert.throws(() => readFileSync(path, "utf-8"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reads a missing or malformed file as nothing recorded", () => {
      const dir = mkdtempSync(join(tmpdir(), "verification-state-"));
      try {
        assert.strictEqual(readVerificationState(join(dir, "absent.json")).size, 0);
        const broken = join(dir, "broken.json");
        writeFileSync(broken, "{not json");
        assert.strictEqual(readVerificationState(broken).size, 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("drops state for offers that have left the index", () => {
      const state = new Map();
      recordAttempts(
        state,
        [
          { vendor: "Kept", url: "https://kept.example", outcome: ATTEMPT_CONFIRMED },
          { vendor: "Gone", url: "https://gone.example", outcome: ATTEMPT_CONFIRMED },
        ],
        new Date(),
      );
      const pruned = pruneToOffers(state, [{ vendor: "Kept", url: "https://kept.example" }]);
      assert.deepStrictEqual([...pruned.keys()], ["Kept|https://kept.example"]);
    });
  });

  describe("backfill from what we already recorded", () => {
    const offers = [
      { vendor: "Readable", url: "https://readable.example", verifiedDate: "2026-08-01", source_check: { checked: DAY, outcome: "ok", detail: "host" } },
      { vendor: "Blocked", url: "https://blocked.example", verifiedDate: "2026-04-05", source_check: { checked: DAY, outcome: "unreadable", detail: "HTTP 403" } },
      { vendor: "NoTerms", url: "https://noterms.example", verifiedDate: "2026-07-05", source_check: { checked: DAY, outcome: "states_no_terms", detail: "the page names NoTerms but states no amount, tier or rate we can read" } },
      { vendor: "Unstamped", url: "https://unstamped.example", verifiedDate: "2026-07-05" },
    ];

    it("leaves records whose source check passed out of the state entirely", () => {
      const state = new Map();
      backfillVerificationState(state, offers);
      assert.strictEqual(state.has("Readable|https://readable.example"), false);
      assert.strictEqual(state.has("Unstamped|https://unstamped.example"), false);
    });

    it("starts a record with no liveness history at one observed failure, not at quarantine", () => {
      const state = new Map();
      backfillVerificationState(state, offers);
      const record = state.get("NoTerms|https://noterms.example");
      assert.strictEqual(record.consecutive_failures, 1);
      assert.strictEqual(isQuarantined(record), false);
      assert.strictEqual(record.failure_category, FAILURE_SOURCE_UNUSABLE);
      assert.strictEqual(record.last_success, "2026-07-05");
    });

    it("quarantines a URL the liveness job has watched fail for days", () => {
      const linkHealth = new Map([
        ["https://blocked.example", { url: "https://blocked.example", checked: "2026-08-27", outcome: "unknown", detail: "GET 403", last_reachable: "2026-04-05", consecutive_unreachable: 0 }],
      ]);
      const state = new Map();
      backfillVerificationState(state, offers, { linkHealth });
      const record = state.get("Blocked|https://blocked.example");
      assert.strictEqual(record.consecutive_failures, QUARANTINE_AFTER_FAILURES);
      assert.strictEqual(isQuarantined(record), true);
      assert.strictEqual(record.failure_category, FAILURE_BOT_BLOCK);
      assert.match(record.last_error, /GET 403/);
    });

    it("does not overwrite a record the job has already written", () => {
      const state = new Map();
      recordAttempts(state, [{ vendor: "NoTerms", url: "https://noterms.example", outcome: ATTEMPT_CONFIRMED }], new Date(`${DAY}T00:00:00Z`));
      const seeded = backfillVerificationState(state, offers);
      assert.strictEqual(seeded.find((r: any) => r.vendor === "NoTerms"), undefined);
      assert.strictEqual(state.get("NoTerms|https://noterms.example").consecutive_failures, 0);
    });

    it("counts a URL still reachable today as a single failure", () => {
      assert.strictEqual(backfillFailureCount(null), 1);
      assert.strictEqual(
        backfillFailureCount({ outcome: "reachable", checked: "2026-08-27", last_reachable: "2026-08-27", consecutive_unreachable: 0 }),
        1,
      );
    });

    it("never seeds more failures than the liveness record can evidence", () => {
      const oneDayDown = { outcome: "unreachable", checked: "2026-08-27", last_reachable: "2026-08-26", consecutive_unreachable: 1 };
      assert.strictEqual(backfillFailureCount(oneDayDown), 1);
      const capped = { outcome: "unreachable", checked: "2026-08-27", last_reachable: "2020-01-01", consecutive_unreachable: 2 };
      assert.strictEqual(backfillFailureCount(capped), QUARANTINE_AFTER_FAILURES);
    });
  });

  describe("what the quarantine list reports", () => {
    it("lists only quarantined records, oldest attempt first", () => {
      const state = new Map();
      const failing = (vendor: string) => ({ vendor, url: `https://${vendor}.example`, outcome: ATTEMPT_FETCH_FAILED, category: FAILURE_BOT_BLOCK });
      for (const day of ["2026-08-01", "2026-08-02", "2026-08-03"]) {
        recordAttempts(state, [failing("Older")], new Date(`${day}T00:00:00Z`));
      }
      for (const day of ["2026-08-10", "2026-08-11", "2026-08-12"]) {
        recordAttempts(state, [failing("Newer")], new Date(`${day}T00:00:00Z`));
      }
      recordAttempts(state, [{ vendor: "Fine", url: "https://fine.example", outcome: ATTEMPT_CONFIRMED }], new Date(`${DAY}T00:00:00Z`));
      const held = quarantinedRecords(state);
      assert.deepStrictEqual(held.map((r: any) => r.vendor), ["Older", "Newer"]);
    });

    it("counts each stuck record under the reason it is stuck for", () => {
      const state = new Map();
      const rows = [
        { vendor: "A", url: "https://a.example", outcome: ATTEMPT_FETCH_FAILED, category: FAILURE_BOT_BLOCK },
        { vendor: "B", url: "https://b.example", outcome: ATTEMPT_FETCH_FAILED, category: FAILURE_UNREACHABLE },
        { vendor: "C", url: "https://c.example", outcome: ATTEMPT_SOURCE_UNUSABLE, category: FAILURE_SOURCE_UNUSABLE },
      ];
      recordAttempts(state, rows, new Date(`${DAY}T00:00:00Z`));
      const counts = failureCategoryCounts([...state.values()]);
      assert.strictEqual(counts.get(FAILURE_BOT_BLOCK), 1);
      assert.strictEqual(counts.get(FAILURE_UNREACHABLE), 1);
      assert.strictEqual(counts.get(FAILURE_SOURCE_UNUSABLE), 1);
      assert.strictEqual(counts.get(FAILURE_TIMEOUT), 0);
    });

    it("does not count a record whose last check succeeded", () => {
      const state = new Map();
      recordAttempts(state, [{ vendor: "A", url: "https://a.example", outcome: ATTEMPT_CONFIRMED }], new Date());
      assert.strictEqual([...failureCategoryCounts([...state.values()]).values()].reduce((a: number, b: number) => a + b, 0), 0);
    });
  });
});
