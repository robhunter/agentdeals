// #1038: the risk badge in every vendor page's <h1> counted our own change
// records, all-time, of any type. Railway rendered `caution` for expanding its
// free tier; DigitalOcean rendered `risky` above a recorded 20% price cut.
//
// Two properties are under test here, and they are different properties:
//
//   1. The level is earned. Nothing neutral or favourable to the user can
//      raise it, and the number of records we happen to hold cannot move it.
//   2. The level is checkable. `caution` and `risky` are negative factual
//      claims about a named company, so every surface that publishes one also
//      publishes the dated record behind it — or publishes nothing.
//
// The second is the one that generalises, and it is the one that needs an
// end-to-end test: the computation can be right while a page still renders a
// warning a reader cannot check.

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

type Change = { vendor: string; change_type: string; date: string; summary: string };

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
    // The six the issue names, plus the whole table read back — a type that
    // moves from null to a demotion has to be a deliberate edit here too.
    const favourable = ["limits_increased", "new_free_tier", "new_tier", "startup_program_expanded", "pricing_postponed", "rebranded"];
    for (const change_type of favourable) {
      const assessment = vendorRiskAssessment([
        { vendor: "V", change_type, date: "2026-08-01", summary: "s", previous_state: "", current_state: "", impact: "high", source_url: "", category: "c", alternatives: [] },
      ]);
      assert.strictEqual(assessment.level, "stable", `${change_type} must not demote`);
      assert.strictEqual(assessment.cause, null);
    }
  });

  it("a vendor whose only history is limits_increased renders stable, live", async () => {
    // Railway is the issue's headline example: `caution` in its <h1> because
    // it expanded its free tier after a $100M Series B.
    const { loadDealChanges } = await import("../dist/data.js");
    const railway = changesByVendor(loadDealChanges()).get("railway") ?? [];
    assert.ok(railway.length > 0, "expected Railway to still hold change records");
    assert.ok(
      railway.every((c) => c.change_type === "limits_increased"),
      "this test is anchored on Railway holding only limits_increased; its records have changed, re-anchor it",
    );
    const { text } = await get("/vendor/railway");
    const h1 = text.match(/<h1>[\s\S]*?<\/h1>/)?.[0] ?? "";
    assert.ok(h1.length > 0, "no <h1> on /vendor/railway");
    assert.ok(!/caution|risky/.test(h1), `Railway's <h1> still carries a warning: ${h1}`);
  });

  it("the count of records we hold does not move the level", async () => {
    const { vendorRiskAssessment } = await import("../dist/data.js");
    const rec = (change_type: string, date: string) => ({
      vendor: "V", change_type, date, summary: "s", previous_state: "", current_state: "", impact: "low" as const, source_url: "", category: "c", alternatives: [],
    });
    // Ten favourable records is still stable; one demoting record is not.
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
    // 15 months old — SendGrid's case. `stable` would be a false statement we
    // made ourselves: we hold a record of the free tier being removed.
    assert.strictEqual(vendorRiskAssessment([removed("2025-05-27")], nowMs).level, "caution");
  });

  it("nothing the risk scale demotes is called positive or neutral by the direction table", async () => {
    // The two tables answer different questions — direction is what we call a
    // change, risk is what we publish a warning for — but they may not
    // contradict each other. Before #1038 five drifted copies of the direction
    // idea existed and they did.
    const { RISK_DEMOTION, CHANGE_DIRECTION } = await import("../dist/data.js");
    for (const [type, demotion] of Object.entries(RISK_DEMOTION)) {
      if (!demotion) continue;
      assert.strictEqual(
        CHANGE_DIRECTION[type as keyof typeof CHANGE_DIRECTION],
        "negative",
        `${type} demotes to ${demotion} but the direction table does not call it negative`,
      );
    }
    // And the direction table is exhaustive over the risk table's keys.
    for (const type of Object.keys(RISK_DEMOTION)) {
      assert.ok(type in CHANGE_DIRECTION, `${type} has no direction`);
    }
  });

  it("there is one definition of risk in src/, not four", () => {
    // Before this issue there were four: enrichOffers counted records,
    // vendorRiskLevel read types, and serve.ts carried two more inline — one on
    // the stack checker and one that *ranked* on the cost estimator.
    const sources = ["src/data.ts", "src/serve.ts", "src/stacks.ts", "src/mcp-apps.ts"]
      .map((f) => ({ f, src: readFileSync(path.join(REPO, f), "utf8") }));
    for (const { f, src } of sources) {
      const executable = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*|\*\/)/.test(l)).join("\n");
      // The signature of a hand-rolled definition: a literal list of change
      // types tested inline to produce a level.
      const inline = executable.match(/\[\s*"free_tier_removed"[^\]]*\]\s*\.includes\(/g) ?? [];
      assert.deepStrictEqual(inline, [], `${f} classifies change types inline; risk has one definition and it is vendorRiskAssessment`);
    }
  });
});

describe("#1038 — the level is checkable", () => {
  it("every offer carrying a warning carries the record that produced it", async () => {
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const uncaused = enrichOffers(loadOffers())
      .filter((o: { risk_level: string | null; risk_cause: unknown }) => o.risk_level !== "stable" && !o.risk_cause);
    assert.strictEqual(uncaused.length, 0);
  });

  it("the vendor page publishes the dated cause beside the badge in the <h1>", async () => {
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const warned = enrichOffers(loadOffers())
      .filter((o: { risk_level: string | null }) => o.risk_level !== "stable")
      .slice(0, 6);
    assert.ok(warned.length > 0, "expected at least one warned vendor to test");

    for (const offer of warned) {
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
    // Neon's cause is dated 2026-01-15. `recent_change` reaches back 90 days,
    // so before this the page showed a warning and nothing that explained it.
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const neon = enrichOffers(loadOffers().filter((o: { vendor: string }) => o.vendor === "Neon"))[0];
    if (!neon || neon.risk_level === "stable") return; // records changed; nothing to assert
    assert.ok(neon.risk_cause, "Neon carries a warning with no cause");
    assert.strictEqual(neon.recent_change, null, "this test is anchored on Neon's cause being outside the 90-day window");
    const { text } = await get("/vendor/neon");
    assert.ok(text.includes(neon.risk_cause.date), "Neon's cause date is not on the page");
  });

  it("the alternatives surfaces publish the cause too", async () => {
    const { enrichOffers, loadOffers } = await import("../dist/data.js");
    const warned = enrichOffers(loadOffers()).find((o: { risk_level: string | null }) => o.risk_level !== "stable");
    assert.ok(warned, "expected a warned vendor");
    const { text } = await get(`/alternative-to/${toSlug(warned.vendor)}`);
    if (!/Risk Level:/.test(text)) return; // page shape changed
    assert.ok(text.includes(warned.risk_cause.date), `/alternative-to/${toSlug(warned.vendor)} shows a level with no dated cause`);
  });

  it("the alternatives index lists nobody it cannot name a reason for", async () => {
    // This page used to score `+1 per other change`, so a vendor that expanded
    // its free tier earned a row on a page headed "Free Alternatives to
    // Popular Tools" — we recommended leaving a vendor for improving.
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

describe("#1038 — risk does not rank", () => {
  it("src/ranking.ts does not read risk_level or stability", () => {
    const src = readFileSync(path.join(REPO, "src", "ranking.ts"), "utf8");
    const executable = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*|\*\/)/.test(l)).join("\n");
    for (const token of ["risk_level", "vendorRiskLevel", "vendorRiskAssessment", "classifyStability", "stability"]) {
      assert.ok(!executable.includes(token), `src/ranking.ts reads ${token}`);
    }
  });

  it("mutating risk_level and stability does not change the order rankForListing returns", async () => {
    // The stronger form of the same claim: the comment at src/data.ts said the
    // risk bucket had been removed from one sort, and a comment is not a test.
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
