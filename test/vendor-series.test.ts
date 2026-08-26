import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

const {
  recordVendorRequest,
  flushVendorSeries,
  configureVendorSeries,
  readVendorSeries,
  resetVendorSeries,
  vendorSeriesGauge,
  vendorSeriesKey,
  parseVendorDay,
  mergeVendorDay,
  emptyVendorDay,
  seriesDateRange,
  isSeriesDate,
  takeVendorWrites,
  OVERFLOW_VENDOR_KEY,
  MAX_VENDOR_SLUGS_PER_DAY,
  MAX_CLIENTS_PER_VENDOR_PER_DAY,
  MAX_TRACKED_CLIENT_KEYS,
  VENDOR_SERIES_RETENTION_DAYS,
  VENDOR_SERIES_TTL_SECONDS,
  VENDOR_SERIES_NOTES,
  VENDOR_SERIES_PATH,
  vendorExportAuthorized,
} = await import("../src/vendor-series.ts");

type StoreCall = { key: string; value: any; ttl: number };

function fakeStore(seed: Record<string, any> = {}) {
  const data = new Map<string, any>(Object.entries(seed));
  const writes: StoreCall[] = [];
  let failRead = false;
  let failWrite = false;
  return {
    data,
    writes,
    failRead: (on: boolean) => { failRead = on; },
    failWrite: (on: boolean) => { failWrite = on; },
    store: {
      async get(key: string) {
        if (failRead) return { ok: false, value: null, error: "read-boom" };
        return { ok: true, value: data.has(key) ? data.get(key) : null };
      },
      async mget(keys: string[]) {
        if (failRead) return { ok: false, values: [], error: "read-boom" };
        return { ok: true, values: keys.map(k => (data.has(k) ? data.get(k) : null)) };
      },
      async set(key: string, value: any, ttl: number) {
        if (failWrite) return { ok: false, error: "write-boom" };
        data.set(key, JSON.parse(JSON.stringify(value)));
        writes.push({ key, value, ttl });
        return { ok: true };
      },
    },
  };
}

const DAY = "2026-08-27";

function hit(overrides: Partial<Parameters<typeof recordVendorRequest>[0]> = {}) {
  recordVendorRequest({
    slug: "neon",
    client_class: "ai_agent",
    address: "203.0.113.10",
    status: 200,
    date: DAY,
    ...overrides,
  });
}

describe("vendor series recording", () => {
  beforeEach(() => {
    resetVendorSeries();
    process.env.VENDOR_SERIES_WRITE_INTERVAL_SECONDS = "1";
  });

  it("counts one client once however many times it asks for the same vendor", () => {
    for (let i = 0; i < 50; i++) hit();
    const writes = takeVendorWrites();
    assert.deepStrictEqual(writes[0].delta.counts, { neon: 1 });
  });

  it("counts two addresses on one vendor as two clients", () => {
    hit({ address: "198.51.100.1" });
    hit({ address: "198.51.100.2" });
    assert.deepStrictEqual(takeVendorWrites()[0].delta.counts, { neon: 2 });
  });

  it("counts one client on two vendors once for each", () => {
    hit({ slug: "neon" });
    hit({ slug: "render" });
    assert.deepStrictEqual(takeVendorWrites()[0].delta.counts, { neon: 1, render: 1 });
  });

  it("excludes the internal class", () => {
    hit({ client_class: "internal" });
    assert.strictEqual(takeVendorWrites().length, 0);
  });

  it("counts every non-internal class, including bots", () => {
    const classes = ["ai_agent", "search_crawler", "browser", "sdk_client", "unknown"];
    classes.forEach((client_class, i) => hit({ client_class, address: `10.0.0.${i}` }));
    assert.strictEqual(takeVendorWrites()[0].delta.counts.neon, 5);
  });

  it("counts only responses we served", () => {
    hit({ status: 404, address: "1.1.1.1" });
    hit({ status: 301, address: "1.1.1.2" });
    hit({ status: 500, address: "1.1.1.3" });
    assert.strictEqual(takeVendorWrites().length, 0);
  });

  it("folds a slug we do not publish into one overflow key", () => {
    hit({ slug: null, address: "2.2.2.1" });
    hit({ slug: null, address: "2.2.2.2" });
    assert.deepStrictEqual(takeVendorWrites()[0].delta.counts, { [OVERFLOW_VENDOR_KEY]: 2 });
  });

  it("caps the day's slug keys and folds the excess into the overflow key", () => {
    for (let i = 0; i < MAX_VENDOR_SLUGS_PER_DAY + 20; i++) {
      hit({ slug: `vendor-${i}`, address: `10.1.${Math.floor(i / 250)}.${i % 250}` });
    }
    const delta = takeVendorWrites()[0].delta;
    assert.strictEqual(Object.keys(delta.counts).length, MAX_VENDOR_SLUGS_PER_DAY + 1);
    assert.strictEqual(delta.counts[OVERFLOW_VENDOR_KEY], 20);
    assert.strictEqual(delta.slug_overflow, 20);
  });

  it("stops counting rather than over-counting when one vendor exceeds the client cap", () => {
    for (let i = 0; i < MAX_CLIENTS_PER_VENDOR_PER_DAY + 30; i++) {
      hit({ address: `10.2.${Math.floor(i / 250)}.${i % 250}` });
    }
    const delta = takeVendorWrites()[0].delta;
    assert.strictEqual(delta.counts.neon, MAX_CLIENTS_PER_VENDOR_PER_DAY);
    assert.strictEqual(delta.dedup_suppressed, 30);
    assert.strictEqual(delta.capped_slugs, 1);
  });

  it("bounds the dedup table so a burst of addresses cannot grow memory without limit", () => {
    const perVendor = MAX_CLIENTS_PER_VENDOR_PER_DAY;
    const vendors = Math.ceil(MAX_TRACKED_CLIENT_KEYS / perVendor) + 5;
    let attempts = 0;
    for (let v = 0; v < vendors; v++) {
      for (let c = 0; c < perVendor; c++) {
        hit({ slug: `vendor-${v}`, address: `10.${v}.${Math.floor(c / 256)}.${c % 256}` });
        attempts++;
      }
    }
    const gauge = vendorSeriesGauge();
    assert.strictEqual(gauge.dedup_tracked, MAX_TRACKED_CLIENT_KEYS);
    assert.strictEqual(gauge.clients_today, MAX_TRACKED_CLIENT_KEYS);
    assert.strictEqual(gauge.dedup_suppressed, attempts - MAX_TRACKED_CLIENT_KEYS);
    const counted = Object.values(takeVendorWrites()[0].delta.counts).reduce((a: any, b: any) => a + b, 0);
    assert.strictEqual(counted, MAX_TRACKED_CLIENT_KEYS);
  });

  it("carries an unwritten day over when the date rolls", () => {
    hit({ date: "2026-08-27", address: "3.3.3.1" });
    hit({ date: "2026-08-28", address: "3.3.3.1" });
    const writes = takeVendorWrites();
    assert.deepStrictEqual(writes.map(w => w.date), ["2026-08-27", "2026-08-28"]);
    assert.deepStrictEqual(writes[0].delta.counts, { neon: 1 });
    assert.deepStrictEqual(writes[1].delta.counts, { neon: 1 });
  });
});

describe("vendor series persistence", () => {
  beforeEach(() => {
    resetVendorSeries();
    process.env.VENDOR_SERIES_WRITE_INTERVAL_SECONDS = "1";
  });

  it("writes the day under its own key with a retention TTL", async () => {
    const fake = fakeStore();
    configureVendorSeries(fake.store);
    hit();
    const written = await flushVendorSeries(true, new Date("2026-08-27T10:00:00Z"));
    assert.strictEqual(written, 1);
    assert.strictEqual(fake.writes[0].key, vendorSeriesKey(DAY));
    assert.strictEqual(fake.writes[0].ttl, VENDOR_SERIES_TTL_SECONDS);
    assert.deepStrictEqual(fake.writes[0].value.counts, { neon: 1 });
    assert.strictEqual(fake.writes[0].value.process_starts, 1);
  });

  it("adds to what another process already stored for the day", async () => {
    const fake = fakeStore({
      [vendorSeriesKey(DAY)]: { date: DAY, counts: { neon: 40, render: 7 }, process_starts: 2 },
    });
    configureVendorSeries(fake.store);
    hit();
    hit({ slug: "fly", address: "4.4.4.4" });
    await flushVendorSeries(true, new Date("2026-08-27T10:00:00Z"));
    assert.deepStrictEqual(fake.data.get(vendorSeriesKey(DAY)).counts, { neon: 41, render: 7, fly: 1 });
    assert.strictEqual(fake.data.get(vendorSeriesKey(DAY)).process_starts, 3);
  });

  it("does not re-add a delta that was already written", async () => {
    const fake = fakeStore();
    configureVendorSeries(fake.store);
    hit();
    await flushVendorSeries(true, new Date("2026-08-27T10:00:00Z"));
    await flushVendorSeries(true, new Date("2026-08-27T10:05:00Z"));
    assert.deepStrictEqual(fake.data.get(vendorSeriesKey(DAY)).counts, { neon: 1 });
  });

  it("counts a client once across flushes but again after a restart", async () => {
    const fake = fakeStore();
    configureVendorSeries(fake.store);
    hit();
    await flushVendorSeries(true, new Date("2026-08-27T10:00:00Z"));
    hit();
    await flushVendorSeries(true, new Date("2026-08-27T10:05:00Z"));
    assert.deepStrictEqual(fake.data.get(vendorSeriesKey(DAY)).counts, { neon: 1 });

    resetVendorSeries();
    configureVendorSeries(fake.store);
    hit();
    await flushVendorSeries(true, new Date("2026-08-27T10:10:00Z"));
    const stored = fake.data.get(vendorSeriesKey(DAY));
    assert.strictEqual(stored.counts.neon, 2);
    assert.strictEqual(stored.process_starts, 2);
  });

  it("keeps the delta when the write fails and loses nothing on the retry", async () => {
    const fake = fakeStore();
    configureVendorSeries(fake.store);
    hit({ address: "5.5.5.1" });
    hit({ address: "5.5.5.2" });
    fake.failWrite(true);
    assert.strictEqual(await flushVendorSeries(true, new Date("2026-08-27T10:00:00Z")), 0);
    assert.strictEqual(vendorSeriesGauge().write_failures, 1);

    fake.failWrite(false);
    hit({ address: "5.5.5.3" });
    await flushVendorSeries(true, new Date("2026-08-27T10:01:00Z"));
    assert.deepStrictEqual(fake.data.get(vendorSeriesKey(DAY)).counts, { neon: 3 });
    assert.strictEqual(fake.data.get(vendorSeriesKey(DAY)).process_starts, 1);
  });

  it("keeps the delta when the read fails", async () => {
    const fake = fakeStore();
    configureVendorSeries(fake.store);
    hit();
    fake.failRead(true);
    assert.strictEqual(await flushVendorSeries(true, new Date("2026-08-27T10:00:00Z")), 0);
    fake.failRead(false);
    await flushVendorSeries(true, new Date("2026-08-27T10:01:00Z"));
    assert.deepStrictEqual(fake.data.get(vendorSeriesKey(DAY)).counts, { neon: 1 });
  });

  it("writes a rolled-over day to its own key", async () => {
    const fake = fakeStore();
    configureVendorSeries(fake.store);
    hit({ date: "2026-08-27" });
    hit({ date: "2026-08-28" });
    await flushVendorSeries(true, new Date("2026-08-28T00:01:00Z"));
    assert.deepStrictEqual(fake.data.get(vendorSeriesKey("2026-08-27")).counts, { neon: 1 });
    assert.deepStrictEqual(fake.data.get(vendorSeriesKey("2026-08-28")).counts, { neon: 1 });
  });

  it("waits for the write interval unless forced", async () => {
    process.env.VENDOR_SERIES_WRITE_INTERVAL_SECONDS = "300";
    const fake = fakeStore();
    configureVendorSeries(fake.store);
    hit();
    assert.strictEqual(await flushVendorSeries(false, new Date("2026-08-27T10:00:00Z")), 1);
    hit({ address: "6.6.6.6" });
    assert.strictEqual(await flushVendorSeries(false, new Date("2026-08-27T10:01:00Z")), 0);
    assert.strictEqual(await flushVendorSeries(false, new Date("2026-08-27T10:06:00Z")), 1);
  });

  it("serialises overlapping flushes so neither drops the other's delta", async () => {
    const fake = fakeStore();
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    let firstRead = true;
    const slow = {
      ...fake.store,
      async get(key: string) {
        if (firstRead) {
          firstRead = false;
          await gate;
        }
        return fake.store.get(key);
      },
    };
    configureVendorSeries(slow);
    hit({ address: "7.7.7.1" });
    const a = flushVendorSeries(true, new Date("2026-08-27T10:00:00Z"));
    hit({ address: "7.7.7.2" });
    const b = flushVendorSeries(true, new Date("2026-08-27T10:00:01Z"));
    release();
    await Promise.all([a, b]);
    assert.deepStrictEqual(fake.data.get(vendorSeriesKey(DAY)).counts, { neon: 2 });
  });

  it("writes nothing when no store is configured", async () => {
    hit();
    assert.strictEqual(await flushVendorSeries(true, new Date("2026-08-27T10:00:00Z")), 0);
    assert.strictEqual(vendorSeriesGauge().configured, false);
  });

  it("persists no client identifier and no address", async () => {
    const fake = fakeStore();
    configureVendorSeries(fake.store);
    hit({ address: "203.0.113.77" });
    hit({ address: "2001:db8::1", slug: "render" });
    await flushVendorSeries(true, new Date("2026-08-27T10:00:00Z"));
    const serialized = JSON.stringify(fake.data.get(vendorSeriesKey(DAY)));
    assert.ok(!serialized.includes("203.0.113.77"));
    assert.ok(!serialized.includes("2001:db8"));
    assert.deepStrictEqual(Object.keys(fake.data.get(vendorSeriesKey(DAY)).counts).sort(), ["neon", "render"]);
  });
});

describe("vendor series export", () => {
  beforeEach(() => {
    resetVendorSeries();
    process.env.VENDOR_SERIES_WRITE_INTERVAL_SECONDS = "1";
  });

  it("returns the days it holds and omits the ones it does not", async () => {
    const fake = fakeStore({
      [vendorSeriesKey("2026-08-25")]: { date: "2026-08-25", counts: { neon: 3 } },
      [vendorSeriesKey("2026-08-27")]: { date: "2026-08-27", counts: { neon: 5 } },
    });
    configureVendorSeries(fake.store);
    const result = await readVendorSeries(["2026-08-25", "2026-08-26", "2026-08-27"]);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.days.map((d: any) => d.date), ["2026-08-25", "2026-08-27"]);
  });

  it("reports a read failure rather than an empty series", async () => {
    const fake = fakeStore();
    fake.failRead(true);
    configureVendorSeries(fake.store);
    const result = await readVendorSeries(["2026-08-25"]);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.days, []);
  });

  it("bounds a requested range to the retention window", () => {
    assert.strictEqual(seriesDateRange("2020-01-01", "2026-08-27").length, VENDOR_SERIES_RETENTION_DAYS);
    assert.deepStrictEqual(seriesDateRange("2026-08-26", "2026-08-27"), ["2026-08-26", "2026-08-27"]);
    assert.deepStrictEqual(seriesDateRange("2026-08-27", "2026-08-26"), []);
  });

  it("accepts only a calendar date", () => {
    assert.strictEqual(isSeriesDate("2026-08-27"), true);
    assert.strictEqual(isSeriesDate("2026-13-01"), false);
    assert.strictEqual(isSeriesDate("yesterday"), false);
    assert.strictEqual(isSeriesDate(20260827), false);
  });

  it("says the counting rule, the dedup limit and the spoofing limit next to the numbers", () => {
    const text = VENDOR_SERIES_NOTES.join(" ");
    assert.match(text, /distinct clients per vendor per day/);
    assert.match(text, /process_starts/);
    assert.match(text, /x-forwarded-for/);
    assert.match(text, /vendors: null/);
  });
});

describe("vendor series export authorization", () => {
  const TOKEN = "0123456789abcdef0123";

  beforeEach(() => {
    delete process.env.ANALYTICS_EXPORT_TOKEN;
  });

  it("refuses every request when no token is configured", () => {
    for (const header of [undefined, "", "Bearer ", `Bearer ${TOKEN}`]) {
      assert.strictEqual(vendorExportAuthorized(header), false);
    }
  });

  it("refuses a token shorter than the minimum even when it matches", () => {
    process.env.ANALYTICS_EXPORT_TOKEN = "short";
    assert.strictEqual(vendorExportAuthorized("Bearer short"), false);
  });

  it("accepts the configured token and refuses everything else", () => {
    process.env.ANALYTICS_EXPORT_TOKEN = TOKEN;
    assert.strictEqual(vendorExportAuthorized(`Bearer ${TOKEN}`), true);
    assert.strictEqual(vendorExportAuthorized(`bearer ${TOKEN}`), true);
    assert.strictEqual(vendorExportAuthorized(` Bearer ${TOKEN} `), true);
    assert.strictEqual(vendorExportAuthorized(`Bearer ${TOKEN}x`), false);
    assert.strictEqual(vendorExportAuthorized(`Bearer ${TOKEN.slice(0, -1)}`), false);
    assert.strictEqual(vendorExportAuthorized(TOKEN), false);
    assert.strictEqual(vendorExportAuthorized(`Basic ${TOKEN}`), false);
    assert.strictEqual(vendorExportAuthorized(undefined), false);
  });

  it("reads only the first value when the header arrives more than once", () => {
    process.env.ANALYTICS_EXPORT_TOKEN = TOKEN;
    assert.strictEqual(vendorExportAuthorized([`Bearer ${TOKEN}`, "Bearer nope"]), true);
    assert.strictEqual(vendorExportAuthorized(["Bearer nope", `Bearer ${TOKEN}`]), false);
  });

  it("keeps the export path in the observability list so its own reads are not counted", async () => {
    const { isObservabilityPath } = await import("../src/client-class.ts");
    assert.strictEqual(isObservabilityPath(VENDOR_SERIES_PATH), true);
    assert.strictEqual(isObservabilityPath(`${VENDOR_SERIES_PATH}?from=2026-08-01`), true);
  });
});

describe("the gauge that is published", () => {
  beforeEach(() => {
    resetVendorSeries();
  });

  it("carries counts and never a vendor name", () => {
    hit({ slug: "neon" });
    hit({ slug: "planetscale", address: "9.9.9.9" });
    const serialized = JSON.stringify(vendorSeriesGauge());
    assert.ok(!serialized.includes("neon"));
    assert.ok(!serialized.includes("planetscale"));
    assert.strictEqual(vendorSeriesGauge().slugs_today, 2);
    assert.strictEqual(vendorSeriesGauge().clients_today, 2);
    assert.strictEqual(vendorSeriesGauge().published, false);
  });

  it("keeps reporting what this process counted after a successful write", async () => {
    const fake = fakeStore();
    configureVendorSeries(fake.store);
    hit();
    await flushVendorSeries(true, new Date("2026-08-27T10:00:00Z"));
    assert.strictEqual(vendorSeriesGauge().clients_today, 1);
    assert.strictEqual(vendorSeriesGauge().pending_write, false);
    assert.strictEqual(vendorSeriesGauge().writes, 1);
  });
});

describe("vendor day parsing", () => {
  it("survives a record written by another build", () => {
    const parsed = parseVendorDay({ date: "2026-08-27", counts: { neon: "x", render: 4, fly: -1 }, junk: true }, "2026-08-01");
    assert.deepStrictEqual(parsed.counts, { render: 4 });
    assert.strictEqual(parsed.date, "2026-08-27");
  });

  it("returns an empty day for anything that is not an object", () => {
    for (const raw of [null, undefined, "", 7, "not json"]) {
      assert.deepStrictEqual(parseVendorDay(raw, DAY).counts, {});
    }
  });

  it("sums counts and process starts on merge", () => {
    const base = { ...emptyVendorDay(DAY), counts: { neon: 2 }, process_starts: 1, dedup_suppressed: 3 };
    const delta = { ...emptyVendorDay(DAY), counts: { neon: 5, fly: 1 }, process_starts: 1, dedup_suppressed: 2 };
    const merged = mergeVendorDay(base, delta, "2026-08-27T10:00:00Z");
    assert.deepStrictEqual(merged.counts, { neon: 7, fly: 1 });
    assert.strictEqual(merged.process_starts, 2);
    assert.strictEqual(merged.dedup_suppressed, 5);
    assert.strictEqual(merged.updated_at, "2026-08-27T10:00:00Z");
  });

  it("folds a merge past the slug cap into the overflow key", () => {
    const base = { ...emptyVendorDay(DAY), counts: Object.fromEntries(Array.from({ length: MAX_VENDOR_SLUGS_PER_DAY }, (_, i) => [`v${i}`, 1])) };
    const delta = { ...emptyVendorDay(DAY), counts: { latecomer: 4 } };
    const merged = mergeVendorDay(base, delta, "2026-08-27T10:00:00Z");
    assert.strictEqual(merged.counts.latecomer, undefined);
    assert.strictEqual(merged.counts[OVERFLOW_VENDOR_KEY], 4);
    assert.strictEqual(merged.slug_overflow, 4);
  });
});
