import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, vendorsInTheCatalogue } from "./population-floor.ts";
import { GATE_REASONS } from "../scripts/change-gate.js";
import { SUPPRESSED_SAME_TRANSITION_REGRADED } from "../scripts/change-log.js";
import { REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS } from "../dist/change-refusal.js";
import { enrichOffers, loadChangeRefusals, loadDealChanges, loadOffers } from "../dist/data.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const STABILITY_CLAIMS: Array<{ name: string; pattern: RegExp }> = [
  { name: "zero changes recorded", pattern: /It's stable — zero pricing changes recorded/ },
  { name: "positive stability signal", pattern: /positive stability signal/ },
  { name: "no recorded pricing changes", pattern: /has had no recorded pricing changes/ },
  { name: "rated stable", pattern: /We rate it stable/ },
  { name: "considered stable", pattern: /is considered stable/ },
  { name: "stable badge", pattern: /class="risk-badge"[^>]*>stable</ },
];

const CONFIRMING = new Set<string>(REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS);

const WITHHELD_FOR_A_REFUSAL = /we found a change we could not reconcile with the terms we publish/;

interface Subject {
  slug: string;
  vendor: string;
  reasons: string[];
  unreconciled: boolean;
  confirmingOnly: boolean;
  published: number;
}

let subjects: Subject[] = [];
let serverPort = 0;
let proc: ChildProcess | null = null;
const pages = new Map<string, string>();

function startHttpServer(): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timeout); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

before(async () => {
  const refusals = loadChangeRefusals();
  const changes = loadDealChanges();
  const published = new Map<string, number>();
  for (const change of changes) {
    const key = change.vendor.toLowerCase();
    published.set(key, (published.get(key) ?? 0) + 1);
  }
  const held = new Map<string, string[]>();
  for (const refusal of refusals) {
    const key = refusal.vendor.toLowerCase();
    const list = held.get(key) ?? [];
    list.push(refusal.reason);
    held.set(key, list);
  }

  subjects = [...vendorSlugMap.entries()].map(([slug, vendor]) => {
    const reasons = held.get(vendor.toLowerCase()) ?? [];
    const count = published.get(vendor.toLowerCase()) ?? 0;
    return {
      slug,
      vendor,
      reasons,
      published: count,
      unreconciled: count === 0 && reasons.some(r => !CONFIRMING.has(r)),
      confirmingOnly: count === 0 && reasons.length > 0 && reasons.every(r => CONFIRMING.has(r)),
    };
  });

  const started = await startHttpServer();
  proc = started.child;
  serverPort = started.port;

  let queue = 0;
  const worker = async () => {
    while (queue < subjects.length) {
      const { slug } = subjects[queue++];
      const res = await fetch(`http://localhost:${serverPort}/vendor/${slug}`);
      assert.strictEqual(res.status, 200, `/vendor/${slug} returned ${res.status}`);
      pages.set(slug, await res.text());
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
});

after(() => { if (proc) proc.kill(); });

const claimsOn = (slug: string): string[] =>
  STABILITY_CLAIMS.filter(c => c.pattern.test(pages.get(slug) ?? "")).map(c => c.name);

describe("a refused change is not a signal that nothing changed", () => {
  it("publishes no stability claim on a vendor whose last read we could not reconcile", () => {
    const claiming: string[] = [];
    let swept = 0;
    for (const subject of subjects) {
      swept++;
      if (!subject.unreconciled) continue;
      const claims = claimsOn(subject.slug);
      if (claims.length > 0) claiming.push(`/vendor/${subject.slug}: ${claims.join(", ")}`);
    }
    assert.deepStrictEqual(claiming.slice(0, 20), [], `stability claimed over a read we refused:\n${claiming.slice(0, 20).join("\n")}`);
    assertCoversPopulation(swept, vendorsInTheCatalogue(), "vendor pages read for a stability claim");
    assertPopulationFloor(subjects.filter(s => s.unreconciled).length, 100, "vendors hold a refused read and no published change");
  });

  it("keeps the rating where the refusal is itself a finding that the terms held", () => {
    const taken: string[] = [];
    for (const subject of subjects.filter(s => s.confirmingOnly)) {
      if (WITHHELD_FOR_A_REFUSAL.test(pages.get(subject.slug) ?? "")) taken.push(`/vendor/${subject.slug}`);
    }
    assert.deepStrictEqual(taken, [], `a refusal that confirms our terms took the rating with it:\n${taken.join("\n")}`);
    for (const slug of ["activepieces", "assemblyai"]) {
      const subject = subjects.find(s => s.slug === slug);
      assert.ok(subject?.confirmingOnly, `/vendor/${slug} no longer holds only refusals that confirm our terms`);
      assert.ok(claimsOn(slug).length > 0, `/vendor/${slug} publishes no rating, and its refusal is a finding that the terms held`);
    }
    assert.ok(
      subjects.some(s => s.confirmingOnly && s.reasons.includes("free_tier_still_offered")),
      "no vendor's free tier was found still on the page, so that half of the exception is untested",
    );
    assert.ok(
      subjects.some(s => s.confirmingOnly && s.reasons.includes("confirmed_unchanged")),
      "no vendor's proposed change was found to restate our terms, so that half of the exception is untested",
    );
  });

  it("stops telling a reader no change was recorded wherever we refused one", () => {
    const asserting: string[] = [];
    for (const subject of subjects.filter(s => s.reasons.length > 0 && s.published === 0)) {
      const page = pages.get(subject.slug) ?? "";
      if (/zero pricing changes recorded/.test(page)) asserting.push(`/vendor/${subject.slug}`);
      if (/has had no recorded pricing changes/.test(page)) asserting.push(`/vendor/${subject.slug} (FAQ)`);
    }
    assert.deepStrictEqual(asserting.slice(0, 20), [], `pages still counting our refusals as nothing:\n${asserting.slice(0, 20).join("\n")}`);
  });

  it("leaves a vendor with a published change and no refusal exactly as it was", () => {
    const unaffected = subjects.filter(s => s.reasons.length === 0 && s.published > 0);
    assert.ok(unaffected.length > 0, "no vendor carries a published change and no refusal, so the control is empty");
    const dub = subjects.find(s => s.slug === "dub-co");
    assert.ok(dub, "the catalogue no longer holds the record this control was written against");
    assert.ok(dub.published > 0, "dub-co no longer carries a published change");
    assert.match(pages.get("dub-co") ?? "", /We rate it caution/);
  });

  it("names the reason on every rating it withholds for a refused read", () => {
    const silent: string[] = [];
    for (const subject of subjects.filter(s => s.unreconciled)) {
      const page = pages.get(subject.slug) ?? "";
      if (!/we found a change we could not reconcile with the terms we publish/.test(page)) {
        silent.push(`/vendor/${subject.slug}`);
      }
    }
    assert.deepStrictEqual(silent.slice(0, 20), [], `ratings withheld with nothing saying why:\n${silent.slice(0, 20).join("\n")}`);
  });

  it("publishes none of the records it refused", () => {
    const published = new Set(
      loadDealChanges().map(c => `${c.vendor.toLowerCase()}|${c.change_type}|${(c.summary ?? "").trim()}`),
    );
    const refusals = loadChangeRefusals().filter(r => r.reason !== SUPPRESSED_SAME_TRANSITION_REGRADED);
    const admitted = refusals
      .filter(r => published.has(`${r.vendor.toLowerCase()}|${r.change_type}|${(r.summary ?? "").trim()}`))
      .map(r => `${r.vendor} (${r.reason})`);
    assert.deepStrictEqual(admitted, [], `a refused record reached the published log:\n${admitted.join("\n")}`);
    assertPopulationFloor(refusals.length, 180, "records were refused and checked against the published log");
    for (const vendor of ["Tavily AI", "Reducto"]) {
      assert.ok(
        refusals.some(r => r.vendor === vendor && r.reason === "removal_read_from_root"),
        `${vendor} no longer holds the refusal this control was written against`,
      );
    }
  });

  it("goes on offering the free tier of a vendor whose removal the absence rule refused", () => {
    const offers = loadOffers();
    const ended: string[] = [];
    for (const vendor of ["Activepieces", "Integrately", "Mergify"]) {
      const own = offers.filter(o => o.vendor === vendor);
      assert.ok(own.length > 0, `${vendor} is no longer in the catalogue this control was written against`);
      assert.ok(
        loadChangeRefusals().some(r => r.vendor === vendor),
        `${vendor} no longer holds the refusal this control was written against`,
      );
      for (const row of enrichOffers(own)) {
        if (row.risk_cause?.change_type === "free_tier_removed") ended.push(vendor);
      }
    }
    assert.deepStrictEqual(ended, [], `a free tier the page still offers is published as removed:\n${ended.join("\n")}`);
  });
});

describe("the refusal log and the rules that write it read the same vocabulary", () => {
  const refusalLog = () =>
    JSON.parse(readFileSync(process.env.AGENTDEALS_REFUSALS_PATH || path.join(REPO, "data", "change_refusals.json"), "utf-8")).refusals as Array<{ reason: string }>;

  const REASONS_A_RULE_CAN_WRITE = new Set<string>([...GATE_REASONS, SUPPRESSED_SAME_TRANSITION_REGRADED]);

  it("holds no refusal under a reason no rule can write", () => {
    const known = REASONS_A_RULE_CAN_WRITE;
    const unknown = [...new Set(refusalLog().map(r => r.reason))].filter(r => !known.has(r));
    assert.deepStrictEqual(unknown, [], `refusal reasons no gate rule writes: ${unknown.join(", ")}`);
  });

  it("draws every reason it treats as a confirmation from that same vocabulary", () => {
    const known = REASONS_A_RULE_CAN_WRITE;
    const stray = REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS.filter(r => !known.has(r));
    assert.deepStrictEqual(stray, [], `reasons kept as confirmations that no gate rule writes: ${stray.join(", ")}`);
  });

  it("treats a reason it has never seen as one it could not reconcile", () => {
    const invented = "a_rule_no_gate_writes";
    assert.ok(!CONFIRMING.has(invented), "an unclassified reason is read as a confirmation");
  });
});
