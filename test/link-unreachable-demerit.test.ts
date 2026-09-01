import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { rankOffers, evaluate, DEMERIT_TABLE } = await import("../dist/ranking.js");
const { withheldStability } = await import("../dist/data.js");

type Offer = import("../src/types.ts").Offer;
type LinkUnreachable = import("../src/types.ts").LinkUnreachable;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const TODAY = "2026-08-25";

function offer(over: Partial<Offer> = {}): Offer {
  return {
    vendor: "Acme",
    category: "Databases",
    description: "A free tier.",
    tier: "Free",
    url: "https://example.com/pricing",
    tags: [],
    verifiedDate: "2026-08-20",
    ...over,
  };
}

function notice(over: Partial<LinkUnreachable> = {}): LinkUnreachable {
  return { last_reachable: "2026-02-01", checked: TODAY, terminal: false, ...over };
}

function lookupFor(map: Record<string, LinkUnreachable>) {
  return (url: string) => map[url] ?? null;
}

const noLinks = lookupFor({});

describe("a confirmed dead pricing page is a fact about the vendor", () => {
  it("costs two points, and is not labelled as a limit of ours", () => {
    const e = evaluate(offer(), {
      date: TODAY,
      changesForVendor: [],
      linkHealth: lookupFor({ "https://example.com/pricing": notice() }),
    });
    assert.deepStrictEqual(e.demerits.map((d) => d.code), ["link_unreachable"]);
    assert.strictEqual(e.demerit_total, 2);
    assert.notStrictEqual(e.demerits[0].about_us, true);
  });

  it("outranks the one-point demerit that measures our own confidence", () => {
    const table = new Map(DEMERIT_TABLE.map((d: { code: string; points: number }) => [d.code, d.points]));
    assert.strictEqual(table.get("link_unreachable"), 2);
    assert.strictEqual(table.get("link_gone"), 3);
    assert.ok(table.get("link_unreachable")! > table.get("stale_verification")!);
    assert.ok(table.get("link_gone")! >= table.get("free_tier_withdrawn")!);
  });

  it("states its trigger on the published table, as the other demerits do", () => {
    for (const code of ["link_unreachable", "link_gone"]) {
      const row = DEMERIT_TABLE.find((d: { code: string }) => d.code === code);
      assert.ok(row, `${code} is missing from the published table`);
      assert.ok(row!.trigger.length > 40, `${code} publishes no trigger`);
    }
  });

  it("names the date the page was last reachable", () => {
    const e = evaluate(offer({ vendor: "Datree" }), {
      date: TODAY,
      changesForVendor: [],
      linkHealth: lookupFor({ "https://example.com/pricing": notice({ last_reachable: "2026-07-10" }) }),
    });
    assert.strictEqual(e.demerits[0].reason, "Datree's pricing page has not resolved for us since 2026-07-10.");
    assert.strictEqual(e.demerits[0].date, TODAY);
  });

  it("carries no date claim when we have never seen the page resolve", () => {
    const e = evaluate(offer({ vendor: "Datree" }), {
      date: TODAY,
      changesForVendor: [],
      linkHealth: lookupFor({ "https://example.com/pricing": notice({ last_reachable: null }) }),
    });
    assert.strictEqual(e.demerits[0].reason, "Datree's pricing page has not resolved for us.");
  });
});

describe("a page the vendor's own server says is permanently gone", () => {
  it("costs three points under its own code", () => {
    const e = evaluate(offer(), {
      date: TODAY,
      changesForVendor: [],
      linkHealth: lookupFor({ "https://example.com/pricing": notice({ terminal: true }) }),
    });
    assert.deepStrictEqual(e.demerits.map((d) => d.code), ["link_gone"]);
    assert.strictEqual(e.demerit_total, 3);
  });
});

describe("one dead link is charged once", () => {
  it("scores two, not three, when the record is also past the staleness window", () => {
    const stale = offer({ verifiedDate: "2026-01-05" });
    const withoutLink = evaluate(stale, { date: TODAY, changesForVendor: [], linkHealth: noLinks });
    assert.deepStrictEqual(withoutLink.demerits.map((d) => d.code), ["stale_verification"]);

    const withLink = evaluate(stale, {
      date: TODAY,
      changesForVendor: [],
      linkHealth: lookupFor({ "https://example.com/pricing": notice() }),
    });
    assert.deepStrictEqual(withLink.demerits.map((d) => d.code), ["link_unreachable"]);
    assert.strictEqual(withLink.demerit_total, 2);
  });

  it("still charges a recorded free-tier removal alongside it — a different fact", () => {
    const e = evaluate(offer({ tier: "Free Credits" }), {
      date: TODAY,
      changesForVendor: [],
      linkHealth: lookupFor({ "https://example.com/pricing": notice() }),
    });
    assert.deepStrictEqual(e.demerits.map((d) => d.code), ["link_unreachable", "time_limited_offer"]);
    assert.strictEqual(e.demerit_total, 4);
  });
});

describe("being refused is evidence about our checker", () => {
  it("leaves a record in the qualified band, exactly as before", () => {
    const result = rankOffers([offer()], {
      queryKey: "refused",
      changes: [],
      date: TODAY,
      linkHealth: noLinks,
    });
    assert.strictEqual(result.qualified.length, 1);
    assert.strictEqual(result.qualified[0].demerit_total, 0);
  });
});

describe("a record whose pricing page does not resolve", () => {
  it("cannot be in the qualified band", () => {
    const candidates = [offer({ vendor: "Reachable", url: "https://example.com/live" }), offer({ vendor: "Dead" })];
    const result = rankOffers(candidates, {
      queryKey: "qualified-band",
      changes: [],
      date: TODAY,
      linkHealth: lookupFor({ "https://example.com/pricing": notice() }),
    });
    assert.deepStrictEqual(result.qualified.map((e) => e.offer.vendor), ["Reachable"]);
    assert.deepStrictEqual(result.demoted.map((e) => e.offer.vendor), ["Dead"]);
  });

  it("is out of the qualified band of its own category across the whole index", () => {
    const offers: Offer[] = JSON.parse(readFileSync(path.join(REPO, "data", "index.json"), "utf-8")).offers;
    const changes = JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes;
    const health = JSON.parse(readFileSync(path.join(REPO, "data", "link_health.json"), "utf-8"));
    const dead = new Set<string>(
      health.links.filter((l: { outcome: string }) => l.outcome === "unreachable").map((l: { url: string }) => l.url),
    );
    const categories = [...new Set(offers.filter((o) => dead.has(o.url)).map((o) => o.category))];

    const offending: string[] = [];
    for (const category of categories) {
      const result = rankOffers(offers.filter((o) => o.category === category), {
        queryKey: `best-of:${category}`,
        changes,
        date: "2026-09-01",
      });
      for (const entry of result.qualified) {
        if (dead.has(entry.offer.url)) offending.push(`${entry.offer.vendor} (${category})`);
      }
    }
    assert.deepStrictEqual(offending, [], "every record with a dead pricing page must carry a demerit");
    assert.ok(categories.length > 0, "the index holds no dead link, so this assertion has no subject");
  });
});

describe("stability is withheld the way the risk level already is", () => {
  it("withholds a favourable class when the pricing page does not resolve", () => {
    assert.strictEqual(withheldStability(notice(), "stable"), null);
    assert.strictEqual(withheldStability(notice(), "improving"), null);
  });

  it("publishes an adverse class, which the dead link does not soften", () => {
    assert.strictEqual(withheldStability(notice(), "watch"), "watch");
    assert.strictEqual(withheldStability(notice(), "volatile"), "volatile");
  });

  it("leaves a reachable record alone", () => {
    assert.strictEqual(withheldStability(null, "stable"), "stable");
    assert.strictEqual(withheldStability(null, "improving"), "improving");
  });
});

type FixtureOffer = { vendor: string; url: string; category: string };

function slugOf(vendor: string): string {
  return vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const indexOffers: FixtureOffer[] = JSON.parse(
  readFileSync(path.join(REPO, "data", "index.json"), "utf-8"),
).offers;
const changedVendors = new Set<string>(
  JSON.parse(readFileSync(path.join(REPO, "data", "deal_changes.json"), "utf-8")).changes.map(
    (c: { vendor: string }) => c.vendor.toLowerCase(),
  ),
);
const rowsPerVendor = new Map<string, number>();
for (const o of indexOffers) rowsPerVendor.set(o.vendor, (rowsPerVendor.get(o.vendor) ?? 0) + 1);
const rowsPerUrl = new Map<string, number>();
for (const o of indexOffers) rowsPerUrl.set(o.url, (rowsPerUrl.get(o.url) ?? 0) + 1);

const eligible = indexOffers.filter(
  (o) =>
    !changedVendors.has(o.vendor.toLowerCase()) &&
    slugOf(o.vendor).length > 2 &&
    o.url.startsWith("http") &&
    rowsPerVendor.get(o.vendor) === 1 &&
    rowsPerUrl.get(o.url) === 1,
);
const deadSubject = eligible[0];
const liveSubject = eligible.find((o) => o.category === deadSubject.category && o.vendor !== deadSubject.vendor)!;

let fixtureDir = "";
let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(fixturePath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_LINK_HEALTH_PATH: fixturePath },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, body: await res.text() };
};

before(async () => {
  assert.ok(deadSubject && liveSubject, "the fixture needs two vendors in one category carrying no change records");
  fixtureDir = mkdtempSync(path.join(tmpdir(), "unreachable-demerit-"));
  const fixturePath = path.join(fixtureDir, "link_health.json");
  writeFileSync(fixturePath, JSON.stringify({
    generated_at: "2026-08-25",
    links: [
      { url: deadSubject.url, checked: "2026-08-25", outcome: "unreachable", detail: "GET 404", terminal: false, last_reachable: "2026-01-04", consecutive_unreachable: 6 },
    ],
  }, null, 2));
  proc = await startServer(fixturePath);
});

after(() => {
  if (proc) proc.kill();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe("the listing surfaces that used to drop the fact", () => {
  it("renders it on the category page, in the same words the vendor page uses", async () => {
    const { status, body } = await get(`/category/${slugOf(deadSubject.category)}`);
    assert.strictEqual(status, 200);
    assert.ok(
      body.includes(`${deadSubject.vendor}&#039;s pricing page has not resolved for us since 2026-01-04.`)
        || body.includes(`${deadSubject.vendor}'s pricing page has not resolved for us since 2026-01-04.`),
      "the category listing names no dead link",
    );
    assert.ok(!body.includes(`${liveSubject.vendor}'s pricing page has not resolved`), "a reachable row must be untouched");
  });

  it("publishes both codes on the criteria page with their weights", async () => {
    const { status, body } = await get("/criteria");
    assert.strictEqual(status, 200);
    assert.match(body, /<code>link_unreachable<\/code><\/td><td[^>]*>&minus;2</);
    assert.match(body, /<code>link_gone<\/code><\/td><td[^>]*>&minus;3</);
  });

  it("returns the fact from the detail endpoint in the shape the risk endpoint uses", async () => {
    const detail = JSON.parse((await get(`/api/details/${encodeURIComponent(deadSubject.vendor)}`)).body);
    const risk = JSON.parse((await get(`/api/vendor-risk/${encodeURIComponent(deadSubject.vendor)}`)).body);
    assert.deepStrictEqual(detail.offer.link_unreachable, { last_reachable: "2026-01-04", checked: "2026-08-25", terminal: false });
    assert.deepStrictEqual(detail.offer.link_unreachable, risk.link_unreachable);

    const live = JSON.parse((await get(`/api/details/${encodeURIComponent(liveSubject.vendor)}`)).body);
    assert.strictEqual(live.offer.link_unreachable, null);
  });

  it("withholds the stability class from the offers endpoint", async () => {
    const { body } = await get(`/api/offers?q=${encodeURIComponent(deadSubject.vendor)}&limit=50`);
    const row = JSON.parse(body).offers.find((o: { url: string }) => o.url === deadSubject.url);
    assert.ok(row, "the offer must come back for this assertion to have a subject");
    assert.strictEqual(row.stability, null);
    assert.notStrictEqual(row.link_unreachable, null);
  });
});
