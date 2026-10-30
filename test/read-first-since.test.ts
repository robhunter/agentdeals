import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { offerKey } from "../scripts/change-refusals.js";
import { markedReadFirstLines, placesOnTheReadFirstList } from "../scripts/read-first.js";
import { pickOldestEntries } from "../scripts/reverify-rolling.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-10-30T12:00:00Z");
const SINCE = "2026-10-30";
const offer = (vendor: string, extra = {}) => ({
  vendor, tier: "Free", category: "API", url: `https://${vendor.toLowerCase()}.example/pricing`,
  description: "Free plan includes 100 requests each month.", verifiedDate: "2026-10-22", ...extra,
});
const quoted = (vendor: string, extra = {}) => offer(vendor, {
  free_plan_excerpt: { text: "Free plan includes 100 requests each month.", read_on: "2026-10-22" }, ...extra,
});
const old = offer("Old", { verifiedDate: "2026-01-01" });
const marked = quoted("Marked");
const entry = (item: typeof marked, extra = {}) => ({ vendor: item.vendor, tier: item.tier, ...extra });

function select(offers = [old, marked], listings = [entry(marked, { since: SINCE })], options = {}, limit = 1) {
  const { places, since } = placesOnTheReadFirstList(listings, offers);
  return pickOldestEntries(offers, limit, NOW, { readFirst: places, readFirstSince: since, ...options });
}

const vendors = (result: ReturnType<typeof select>) => result.picked.map(({ offer }: { offer: { vendor: string } }) => offer.vendor);

describe("read-first entries marked for an attempt since a date", () => {
  it("draws a quoted listing before older listings and stops after its next attempt", () => {
    assert.deepEqual(vendors(select()), ["Marked"]);
    const read = quoted("Marked", { verifiedDate: SINCE });
    assert.deepEqual(vendors(select([old, read])), ["Old"]);
    assert.match(markedReadFirstLines(select([old, read]).markedReadFirst).join("\n"), /last attempt 2026-10-30 is on or after 2026-10-30/);
  });

  for (const date of ["2026-10-29", "2026-10-30", "2026-10-31"]) {
    for (const source of ["verified", "source check", "refusal", "verification state"]) {
      it(`uses the ${source} attempt at ${date} with an inclusive day boundary`, () => {
        const item = quoted("Marked", { verifiedDate: "2026-10-20", ...(source === "verified" ? { verifiedDate: date } : {}), ...(source === "source check" ? { source_check: { checked: date } } : {}) });
        const key = offerKey(item.vendor, item.url);
        const options = source === "refusal" ? { refusalHolds: new Map([[key, date]]) }
          : source === "verification state" ? { verificationState: new Map([[key, { last_attempt_at: date, last_outcome: "fetch_failed" }]]) } : {};
        const result = select([old, item], undefined, options);
        assert.deepEqual(vendors(result), [date < SINCE ? "Marked" : "Old"]);
      });
    }
  }

  it("does not repeat a completed mark even when the listing still has no quote", () => {
    const item = offer("Marked", { verifiedDate: SINCE });
    assert.deepEqual(vendors(select([old, item])), ["Old"]);
  });

  it("reports a completed mark selected normally as drawn in age order", () => {
    const item = quoted("Marked", { verifiedDate: SINCE });
    const result = select([item]);
    assert.deepEqual(vendors(result), ["Marked"]);
    assert.match(markedReadFirstLines(result.markedReadFirst).join("\n"), /drawn in age queue — last attempt/);
  });

  it("keeps unmarked quote-only priority and quoted age order", () => {
    assert.deepEqual(vendors(select([old, marked], [entry(marked)])), ["Old"]);
    const item = offer("Marked");
    assert.deepEqual(vendors(select([old, item], [entry(item)])), ["Marked"]);
  });

  it("prioritizes a never-attempted marked listing even when its tier cannot take a quote", () => {
    const item = quoted("Marked", { verifiedDate: null, tier: "Paid" });
    assert.deepEqual(vendors(select([old, item], [entry(item, { since: SINCE })])), ["Marked"]);
  });

  for (const since of [null, 42, "", "2026-02-30", "2026-10-3", "2026-10-31"]) {
    it(`reports the unusable or future mark ${JSON.stringify(since)}`, () => {
      const result = select(undefined, [entry(marked, { since })]);
      assert.deepEqual(vendors(result), ["Old"]);
      assert.match(markedReadFirstLines(result.markedReadFirst).join("\n"), /not drawn — (since must be a valid YYYY-MM-DD date|since 2026-10-31 is in the future)/);
    });
  }

  it("reports every drawn mark and the marks left by a batch limit or quarantine", () => {
    const second = quoted("Second");
    const held = quoted("Held");
    const result = select([old, marked, second, held], [marked, second, held].map(item => entry(item, { since: SINCE })), {
      verificationState: new Map([[offerKey(held.vendor, held.url), { quarantined_since: "2026-10-29", last_attempt_at: "2026-10-29" }]]),
    });
    assert.deepEqual(vendors(result), ["Marked"]);
    const lines = markedReadFirstLines(result.markedReadFirst);
    assert.deepEqual(lines, [
      'Read-first mark: Marked (Free), since "2026-10-30": drawn',
      'Read-first mark: Second (Free), since "2026-10-30": not drawn — batch limit reached',
      'Read-first mark: Held (Free), since "2026-10-30": not drawn — in quarantine',
    ]);
  });

  it("keeps a held corroboration reading and the first occurrence of a duplicate entry", () => {
    const peer = quoted("Peer");
    const list = [entry(marked, { since: SINCE }), entry(marked, { since: "2027-01-01" })];
    const result = select([old, marked, peer], list, { awaitingCorroboration: new Set([offerKey(peer.vendor, peer.url)]) });
    assert.deepEqual(vendors(result), ["Peer", "Marked"]);
    assert.equal(result.markedReadFirst[0].since, SINCE);
  });
});

describe("the rolling CLI with a dated read-first list", () => {
  it("draws the marked quote once, persists the attempt and reports unmatched and completed marks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "read-first-since-"));
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url!);
      res.setHeader("content-type", "text/html");
      res.end(`<h1>${req.url!.slice(1)} pricing</h1><p>Free plan: 100 requests each month.</p>${"<p>Service pricing information for developers.</p>".repeat(30)}`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const today = new Date().toISOString().slice(0, 10);
    const index = join(dir, "index.json");
    const list = join(dir, "read-first.json");
    const state = join(dir, "state.json");
    const holds = join(dir, "refusals.json");
    const corroboration = join(dir, "corroboration.json");
    const health = join(dir, "health.json");
    writeFileSync(index, JSON.stringify({ offers: [old, marked].map(item => ({ ...item, url: `http://127.0.0.1:${address.port}/${item.vendor}` })) }));
    writeFileSync(list, JSON.stringify({ listings: [entry(marked, { since: today }), { vendor: "Ghost", tier: "Free", since: today }] }));
    for (const file of [state, holds, corroboration, health]) writeFileSync(file, "{}");
    const listBytes = readFileSync(list, "utf8");
    const execute = async () => promisify(execFile)(process.execPath, [join(REPO, "scripts/reverify-rolling.js"), "--limit", "1"], {
      cwd: REPO,
      env: { ...process.env, AGENTDEALS_INDEX_PATH: index, AGENTDEALS_READ_FIRST_PATH: list,
        AGENTDEALS_VERIFICATION_STATE_PATH: state, AGENTDEALS_REFUSALS_PATH: holds,
        AGENTDEALS_CORROBORATION_PATH: corroboration, AGENTDEALS_LINK_HEALTH_PATH: health },
      timeout: 30000,
    });
    try {
      const first = await execute();
      assert.match(first.stdout, /Read-first mark: Marked .*: drawn/);
      assert.match(first.stdout, /Read-first mark: Ghost .*not drawn — matches no listing/);
      assert.ok(requests.length > 0);
      assert.ok(requests.every(route => route === "/Marked"));
      const saved = JSON.parse(readFileSync(state, "utf8"));
      assert.equal(saved.records.find((record: { vendor: string }) => record.vendor === "Marked").last_attempt_at, today);
      requests.length = 0;
      const second = await execute();
      assert.match(second.stdout, /Read-first mark: Marked .*not drawn — last attempt/);
      assert.ok(requests.length > 0);
      assert.ok(requests.every(route => route === "/Old"));
      assert.equal(readFileSync(list, "utf8"), listBytes);
      writeFileSync(index, JSON.stringify({ offers: [] }));
      const empty = await execute();
      assert.match(empty.stdout, /Read-first mark: Marked .*not drawn — matches no listing/);
      assert.match(empty.stdout, /No entries to process/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
