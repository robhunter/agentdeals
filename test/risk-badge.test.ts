import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

let serverPort = 0;
let proc: ChildProcess | null = null;

function startHttpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 15000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, text: await res.text() };
};

before(async () => { proc = await startHttpServer(); });
after(() => { if (proc) proc.kill(); });

const toSlug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

type Change = {
  vendor: string;
  change_type: string;
  date: string;
  summary: string;
  resolution?: { state: string; date: string; source_url?: string } | null;
};

function changesByVendor(changes: Change[]): Map<string, Change[]> {
  const m = new Map<string, Change[]>();
  for (const c of changes) {
    const k = c.vendor.toLowerCase();
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(c);
  }
  return m;
}

describe("#1038 — the level is earned", () => {
  it("the demotion table names every change type present in the data", async () => {
    const { RISK_DEMOTION, loadDealChanges } = await import("../dist/data.js");
    const present = new Set(loadDealChanges().map((c: Change) => c.change_type));
    const missing = [...present].filter((t) => !(t in RISK_DEMOTION));
    assert.deepStrictEqual(
      missing,
      [],
      `data/deal_changes.json holds change types the risk table has no entry for: ${missing.join(", ")}. ` +
      `A type left out of the table demotes nothing by accident rather than by decision — add it explicitly, either way.`,
    );
  });

  it("no neutral or favourable change type can raise a risk level", async () => {
    const { vendorRiskAssessment } = await import("../dist/data.js");
    const favourable = ["limits_increased", "new_free_tier", "new_tier", "startup_program_expanded", "pricing_postponed", "rebranded"];
    for (const change_type of favourable) {
      const assessment = vendorRiskAssessment([
        { vendor: "V", change_type, date: "2026-08-01", summary: "s", previous_state: "", current_state: "", impact: "high", source_url: "", category: "c", alternatives: [] },
      ]);
      assert.strictEqual(assessment.level, "stable", `${change_type} must not demote`);
      assert.strictEqual(assessment.cause, null);
    }
  });

  it("every vendor whose only history is limits_increased renders stable, live", async () => {
    const { loadDealChanges, loadOffers } = await import("../dist/data.js");
    const changes = loadDealChanges() as Change[];
    const subjects = new Map<string, string>();
    for (const offer of loadOffers()) {
      const own = changes.filter((c) => c.vendor.toLowerCase() === offer.vendor.toLowerCase());
      if (own.length > 0 && own.every((c) => c.change_type === "limits_increased")) {
        subjects.set(toSlug(offer.vendor), offer.vendor);
      }
    }
    assert.ok(
      subjects.size > 0,
      "no vendor in the catalog holds a limits_increased-only history, so this assertion has no subject",
    );

    const warned: string[] = [];
    for (const [slug, vendor] of subjects) {
      const { status, text } = await get(`/vendor/${slug}`);
      if (status !== 200) {
        warned.push(`${vendor} has a favourable-only history and no page at /vendor/${slug} (${status})`);
        continue;
      }
      const h1 = text.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
      if (h1.length === 0) warned.push(`no <h1> on /vendor/${slug}`);
      else if (/caution|risky/.test(h1)) warned.push(`${vendor}: ${h1.replace(/\s+/g, " ")}`);
    }
    assert.deepStrictEqual(warned, [], `a favourable-only history earned a warning on ${warned.length} of ${subjects.size} pages`);
  });

  it("the count of records we hold does not move the level", async () => {
    const { vendorRiskAssessment } = await import("../dist/data.js");
    const rec = (change_type: string, date: string) => ({
      vendor: "V", change_type, date, summary: "s", previous_state: "", current_state: "", impact: "low" as const, source_url: "", category: "c", alternatives: [],
    });
    const many = Array.from({ length: 10 }, (_, i) => rec("limits_increased", `2026-0${(i % 9) + 1}-01`));
    assert.strictEqual(vendorRiskAssessment(many).level, "stable");
    assert.strictEqual(vendorRiskAssessment([...many, rec("limits_reduced", "2026-08-01")]).level, "caution");
  });

  it("a severe change ages into caution, never into stable", async () => {
    const { vendorRiskAssessment } = await import("../dist/data.js");
    const nowMs = Date.parse("2026-08-25T00:00:00Z");
    const removed = (date: string) => ({
      vendor: "V", change_type: "free_tier_removed", date, summary: "s", previous_state: "", current_state: "", impact: "high" as const, source_url: "", category: "c", alternatives: [],
    });
    assert.strictEqual(vendorRiskAssessment([removed("2026-06-01")], nowMs).level, "risky");
    assert.strictEqual(vendorRiskAssessment([removed("2025-05-27")], nowMs).level, "caution");
  });

  it("nothing the risk scale demotes is called positive or neutral by the direction table", async () => {
    const { RISK_DEMOTION, CHANGE_DIRECTION } = await import("../dist/data.js");
    for (const [type, demotion] of Object.entries(RISK_DEMOTION)) {
      if (!demotion) continue;
      assert.strictEqual(
        CHANGE_DIRECTION[type as keyof typeof CHANGE_DIRECTION],
        "negative",
        `${type} demotes to ${demotion} but the direction table does not call it negative`,
      );
    }
    for (const type of Object.keys(RISK_DEMOTION)) {
      assert.ok(type in CHANGE_DIRECTION, `${type} has no direction`);
    }
  });

  it("there is one definition of risk in src/, not four", () => {
    const sources = ["src/data.ts", "src/serve.ts", "src/stacks.ts", "src/mcp-apps.ts"]
      .map((f) => ({ f, src: readFileSync(path.join(REPO, f), "utf8") }));
    for (const { f, src } of sources) {
      const executable = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*|\*\/)/.test(l)).join("\n");
      const inline = executable.match(/\[\s*"free_tier_removed"[^\]]*\]\s*\.includes\(/g) ?? [];
      assert.deepStrictEqual(inline, [], `${f} classifies change types inline; risk has one definition and it is vendorRiskAssessment`);
    }
  });
});

describe("#1038 — the level is checkable", () => {
  it("every offer carrying a warning carries the record that produced it", async () => {
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const uncaused = enrichOffers(loadOffers())
      .filter((o: { risk_level: string | null; risk_cause: unknown }) => o.risk_level && o.risk_level !== "stable" && !o.risk_cause);
    assert.strictEqual(uncaused.length, 0);
  });

  it("the vendor page publishes the dated cause beside the badge in the <h1>", async () => {
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const { gateFor, utcDate } = await import("../dist/ranking.js");
    const seen = new Set<string>();
    const warned = enrichOffers(loadOffers())
      .filter((o: { vendor: string }) => {
        if (seen.has(o.vendor)) return false;
        seen.add(o.vendor);
        return true;
      })
      .filter((o: { risk_level: string | null }) => o.risk_level && o.risk_level !== "stable");
    const listed = warned.filter((o: object) => gateFor(o, utcDate()) === null).slice(0, 6);
    const gated = warned.filter((o: object) => gateFor(o, utcDate()) !== null).slice(0, 6);
    assert.ok(listed.length > 0, "expected at least one warned vendor the ranker lists");
    assert.ok(gated.length > 0, "no warned vendor is gated, so the withheld badge is unchecked here");

    for (const offer of gated) {
      const { text } = await get(`/vendor/${toSlug(offer.vendor)}`);
      const h1 = text.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
      assert.ok(
        !new RegExp(offer.risk_level!).test(h1),
        `${offer.vendor}: the <h1> of a ${gateFor(offer, utcDate())!.code} record reads ${offer.risk_level}`,
      );
    }

    for (const offer of listed) {
      const { text } = await get(`/vendor/${toSlug(offer.vendor)}`);
      const h1 = text.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
      assert.ok(new RegExp(offer.risk_level!).test(h1), `${offer.vendor}: expected ${offer.risk_level} in the <h1>`);
      assert.ok(
        text.includes(`Why ${offer.risk_level}:`),
        `${offer.vendor}: <h1> says ${offer.risk_level} and the page never says why`,
      );
      assert.ok(
        text.includes(offer.risk_cause.date),
        `${offer.vendor}: the cause is dated ${offer.risk_cause.date} and that date is nowhere on the page`,
      );
    }
  });

  it("a cause older than the 90-day recent-change window still renders", async () => {
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const neon = enrichOffers(loadOffers().filter((o: { vendor: string }) => o.vendor === "Neon"))[0];
    if (!neon || neon.risk_level === "stable") return;
    assert.ok(neon.risk_cause, "Neon carries a warning with no cause");
    assert.strictEqual(neon.recent_change, null, "this test is anchored on Neon's cause being outside the 90-day window");
    const { text } = await get("/vendor/neon");
    assert.ok(text.includes(neon.risk_cause.date), "Neon's cause date is not on the page");
  });

  it("the alternatives surfaces publish the cause too", async () => {
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const warned = enrichOffers(loadOffers()).find((o: { risk_level: string | null }) => o.risk_level && o.risk_level !== "stable");
    assert.ok(warned, "expected a warned vendor");
    const { text } = await get(`/alternative-to/${toSlug(warned.vendor)}`);
    if (!/Risk Level:/.test(text)) return;
    assert.ok(text.includes(warned.risk_cause.date), `/alternative-to/${toSlug(warned.vendor)} shows a level with no dated cause`);
  });

  it("the alternatives index lists nobody it cannot name a reason for", async () => {
    const { text } = await get("/alternative-to");
    const rows = text.match(/<a href="\/alternative-to\/[^"]+" class="idx-row">[\s\S]*?<\/a>/g) ?? [];
    assert.ok(rows.length > 0, "no rows on /alternative-to");
    for (const row of rows) {
      assert.ok(
        /\d{4}-\d{2}-\d{2}/.test(row),
        `a row on /alternative-to carries a level with no dated cause: ${row.replace(/\s+/g, " ").slice(0, 200)}`,
      );
    }
  });

  it("/api/offers ships risk_cause wherever it ships a non-stable risk_level", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/offers?limit=200`);
    const body = await res.json() as { offers?: Array<{ vendor: string; risk_level?: string; risk_cause?: unknown }> };
    const offers = body.offers ?? [];
    assert.ok(offers.length > 0, "no offers returned");
    const bad = offers.filter((o) => o.risk_level && o.risk_level !== "stable" && !o.risk_cause);
    assert.deepStrictEqual(bad.map((o) => o.vendor), [], "JSON callers got a level they cannot explain to their user");
  });
});

describe("#1147 — a shutdown of the product we list demotes the vendor", () => {
  it("every severe type either demotes flatly or states why it decides per record", async () => {
    const { RISK_DEMOTION, VOLATILE_TYPES, SEVERE_TYPES_WITHOUT_FLAT_DEMOTION } = await import("../dist/data.js");
    const severe = [...VOLATILE_TYPES] as string[];
    assert.ok(severe.length > 0, "the severity set is empty");
    for (const type of severe) {
      if (RISK_DEMOTION[type as keyof typeof RISK_DEMOTION]) continue;
      const reason = SEVERE_TYPES_WITHOUT_FLAT_DEMOTION[type];
      assert.ok(
        typeof reason === "string" && reason.length > 40,
        `${type} is severe enough for the stability scale and demotes nothing, with no reason a reader of this test can check`,
      );
    }
    for (const type of Object.keys(SEVERE_TYPES_WITHOUT_FLAT_DEMOTION)) {
      assert.ok(severe.includes(type), `${type} is excused from demoting but is not in the severity set`);
      assert.strictEqual(
        RISK_DEMOTION[type as keyof typeof RISK_DEMOTION],
        null,
        `${type} demotes flatly, so the excuse recorded for it is stale`,
      );
    }
  });

  it("a vendor whose own product is discontinued cannot publish stable", async () => {
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const enriched = enrichOffers(loadOffers());
    for (const vendor of ["Hypertune", "smartlook.com", "lost-pixel.com"]) {
      const offer = enriched.find((o: { vendor: string }) => o.vendor === vendor);
      assert.ok(offer, `${vendor} has no offer to rate`);
      assert.notStrictEqual(offer.risk_level, "stable", `${vendor} still publishes stable`);
      assert.ok(offer.risk_cause, `${vendor} carries a level with no record behind it`);
      assert.strictEqual(offer.risk_cause.change_type, "product_deprecated");
    }
  });

  it("a vendor that retired one of its other services keeps the level its own record earned", async () => {
    const { enrichOffers, loadOffers, loadDealChanges } = await import("../dist/data.js");
    const { deprecationEndsTheListedProduct } = await import("../dist/product-deprecation.js");
    const enriched = enrichOffers(loadOffers());
    const held = changesByVendor(loadDealChanges() as Change[]);
    let controlled = 0;
    for (const offer of enriched) {
      const deprecations = (held.get(offer.vendor.toLowerCase()) ?? [])
        .filter((c) => c.change_type === "product_deprecated");
      if (deprecations.length === 0 || deprecations.some((c) => deprecationEndsTheListedProduct(c))) continue;
      controlled++;
      assert.notStrictEqual(
        offer.risk_cause?.change_type,
        "product_deprecated",
        `${offer.vendor} was demoted for retiring one of its other products`,
      );
    }
    assert.ok(controlled > 0, "no vendor retired one of its other services, so this asserts nothing");
  });

  it("no offer in the index carries a stable level beside a volatile stability", async () => {
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const contradicting = enrichOffers(loadOffers())
      .filter((o: { risk_level: string | null; stability: string }) => o.risk_level === "stable" && o.stability === "volatile")
      .map((o: { vendor: string }) => o.vendor);
    assert.deepStrictEqual(contradicting, [], "these offers ship two judgements that cannot both be true");
  });

  it("keeps a vendor whose narrowings the risk scale does not act on off both ends of the scale", async () => {
    const { classifyStability, demotionForChange, NEGATIVE_CHANGE_TYPES } = await import("../dist/data.js");
    const retiredElsewhere = (date: string) => ({
      vendor: "V", change_type: "product_deprecated", date, summary: "Widget Pro is discontinued.",
      previous_state: "", current_state: "", impact: "medium" as const, source_url: "", category: "c", alternatives: [],
    });
    const one = retiredElsewhere("2026-01-01");
    assert.ok(NEGATIVE_CHANGE_TYPES.has(one.change_type), "the fixture stopped being a narrowing");
    assert.strictEqual(demotionForChange(one), null, "the risk scale now acts on the fixture");
    const three = [retiredElsewhere("2026-01-01"), retiredElsewhere("2026-04-01"), retiredElsewhere("2026-06-01")];
    assert.strictEqual(classifyStability(three), "watch");
    assert.strictEqual(classifyStability([one]), "watch");
  });

  it("never calls a vendor stable on a scale where it holds a narrowing that still stands", async () => {
    const { classifyStability, loadDealChanges, NEGATIVE_CHANGE_TYPES } = await import("../dist/data.js");
    const { isNoLongerInForce } = await import("../dist/change-resolution.js");
    const held = changesByVendor(loadDealChanges() as Change[]);
    const wrong: string[] = [];
    let checked = 0;
    for (const [vendor, changes] of held) {
      const narrowing = changes.filter(
        (c) => NEGATIVE_CHANGE_TYPES.has(c.change_type) && !isNoLongerInForce(c as never),
      ).length;
      if (narrowing === 0) continue;
      checked++;
      if (classifyStability(changes as never) === "stable") {
        wrong.push(`${vendor} holds ${narrowing} standing narrowing record(s) and reads stable`);
      }
    }
    assert.ok(checked > 0, "no vendor holds a narrowing that still stands, so this asserts nothing");
    assert.deepStrictEqual(wrong, []);
  });

  it("counts a vendor's one standing narrowing, and stops counting the same one withdrawn", async () => {
    const { classifyStability, NEGATIVE_CHANGE_TYPES } = await import("../dist/data.js");
    const { isNoLongerInForce } = await import("../dist/change-resolution.js");
    const standing: Change = {
      vendor: "V", change_type: "free_tier_removed", date: "2026-06-01",
      summary: "The free plan is gone.",
    };
    const counts = (c: Change) => NEGATIVE_CHANGE_TYPES.has(c.change_type) && !isNoLongerInForce(c as never);
    const retracted: Change = {
      ...standing,
      resolution: { state: "retracted", date: "2026-06-10", source_url: "https://example.test/withdrawal" },
    };

    assert.strictEqual(counts(standing), true, "the invariant no longer counts a standing narrowing");
    assert.notStrictEqual(classifyStability([standing] as never), "stable");

    assert.strictEqual(counts(retracted), false, "the invariant still counts a withdrawn narrowing");
    assert.strictEqual(classifyStability([retracted] as never), "stable");
  });

  it("the volatile population is not empty, so that invariant is not vacuous", async () => {
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const enriched = enrichOffers(loadOffers());
    const volatile = enriched.filter((o: { stability: string }) => o.stability === "volatile");
    assert.ok(volatile.length > 0, "nothing in the index is volatile");
    for (const offer of volatile) {
      assert.notStrictEqual(offer.risk_level, "stable", `${offer.vendor} is volatile and rated stable`);
    }
  });
});

describe("#1038 — risk does not rank", () => {
  it("src/ranking.ts does not read risk_level or stability", () => {
    const src = readFileSync(path.join(REPO, "src", "ranking.ts"), "utf8");
    const executable = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*|\*\/)/.test(l)).join("\n");
    for (const token of ["risk_level", "vendorRiskLevel", "vendorRiskAssessment", "classifyStability", "stability"]) {
      assert.ok(!executable.includes(token), `src/ranking.ts reads ${token}`);
    }
  });

  it("mutating risk_level and stability does not change the order rankForListing returns", async () => {
    const { rankForListing } = await import("../dist/ranking.js");
    const { enrichOffers, loadOffers, loadDealChanges } = await import("../dist/data.js");
    const changes = loadDealChanges();
    const candidates = enrichOffers(loadOffers().slice(0, 120));

    const order = (offers: unknown[]) =>
      rankForListing(offers as never, { queryKey: "risk-does-not-rank", changes, date: "2026-08-25" })
        .entries.map((e: { offer: { vendor: string } }) => e.offer.vendor);

    const baseline = order(candidates);
    const flipped = order(candidates.map((o: { risk_level: string; stability: string }) => ({
      ...o,
      risk_level: o.risk_level === "stable" ? "risky" : "stable",
      stability: o.stability === "stable" ? "volatile" : "stable",
    })));
    assert.deepStrictEqual(flipped, baseline, "the ranking moved when risk_level/stability were flipped — risk is ranking");
  });
});
