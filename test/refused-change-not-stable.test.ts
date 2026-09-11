import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, recordsInTheCatalogue, vendorsInTheCatalogue } from "./population-floor.ts";
import { GATE_REASONS, REJECT_MEASURES_NO_CHANGE, REJECT_NULL_COMPARISON, REJECT_STATES_NO_DIFFERENCE } from "../scripts/change-gate.js";
import { SUPPRESSED_SAME_TRANSITION_REGRADED } from "../scripts/change-log.js";
import { refusalsByVendor, refusedReadTheConfirmationSupersedes, refusedReadWithholdingStability, supersededRefusalSentence, REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS, REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE, MEASURED_NO_DIFFERENCE_BADGE_LABEL, UNRECONCILED_READ_BADGE_LABEL } from "../dist/change-refusal.js";
import { checkVendorRisk, enrichOffers, loadChangeRefusals, loadDealChanges, loadOffers, publishedChangeCount } from "../dist/data.js";
import { LEVEL_WITHHOLDING_OUTCOMES } from "../dist/source-check.js";
import { offerEnded } from "../dist/retirement.js";
import { vendorSlugMap } from "../dist/vendor-slug.js";
import { vendorVerdictSentence } from "../dist/vendor-verdict.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const STABILITY_CLAIMS: Array<{ name: string; pattern: RegExp }> = [
  { name: "zero changes recorded", pattern: /It's stable — zero pricing changes recorded/ },
  { name: "positive stability signal", pattern: /positive stability signal/ },
  { name: "no recorded pricing changes", pattern: /has had no recorded pricing changes/ },
  { name: "rated stable", pattern: /We rate it stable/ },
  { name: "considered stable", pattern: /is considered stable/ },
  { name: "stable badge", pattern: /class="risk-badge"[^>]*>stable</ },
  { name: "empty history is a good sign", pattern: /This is a good sign — stable pricing/ },
];

const A_STABLE_HISTORY = /has a stable pricing history/;

const A_BARE_THRESHOLD = /<li>At [^<]*?, you'll need to upgrade\.<\/li>/;
const A_THRESHOLD_WE_CANNOT_CONFIRM = /we cannot confirm that threshold today/;
const AN_EMPTY_HISTORY_ABOUT_OUR_RECORDS =
  /Treat the empty history as a statement about our records, not about this vendor's pricing/;

const growthBlockOf = (html: string): string =>
  html.match(/<div class="section growth-section">[\s\S]*?<\/div>/)?.[0] ?? "";

const emptyHistoryParagraphOf = (html: string): string =>
  html.match(/<p class="no-changes">([\s\S]*?)<\/p>/)?.[1] ?? "";

const verdictParagraphOf = (html: string): string =>
  html.match(/<div class="quick-verdict">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? "";

const badgeLabelOf = (svg: string): string => {
  const title = svg.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
  return (title.split(": ").slice(1).join(": ").split(" · ")[0] ?? "").trim();
};

const CONFIRMING = new Set<string>(REFUSAL_REASONS_THAT_CONFIRM_THE_STORED_TERMS);
const MEASURED_NO_DIFFERENCE = new Set<string>(REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE);

const COULD_NOT_RECONCILE = /we found a change we could not reconcile with the terms we publish/;
const NAMED_NO_FIGURE_THAT_MOVED =
  /we refused the change we considered recording because it named no figure that had moved/;
const WITHHELD_FOR_A_REFUSAL = new RegExp(`${COULD_NOT_RECONCILE.source}|${NAMED_NO_FIGURE_THAT_MOVED.source}`);

interface OfferRead {
  vendor: string;
  tier: string;
  verifiedDate: string;
  last_read_date: string;
  risk_level: string | null;
  gate: { code: string } | null;
  refused_read: { reason: string; refused_date: string } | null;
}

interface Subject {
  slug: string;
  vendor: string;
  reasons: string[];
  refusedRead: { reason: string; refused_date: string } | null;
  gated: boolean;
  confirmedOn: string;
  supersededRefusal: { reason: string; refused_date: string } | null;
  unreconciled: boolean;
  measuredNoDifference: boolean;
  onlyTheRefusal: boolean;
  confirmingOnly: boolean;
  rated: string | null;
  ended: boolean;
  withheldBySourceCheck: boolean;
  published: number;
}

const reasonWePublish = (subject: Subject): RegExp =>
  subject.measuredNoDifference ? NAMED_NO_FIGURE_THAT_MOVED : COULD_NOT_RECONCILE;

const reasonWeMustNotPublish = (subject: Subject): RegExp =>
  subject.measuredNoDifference ? COULD_NOT_RECONCILE : NAMED_NO_FIGURE_THAT_MOVED;

const badgeWeExpect = (subject: Subject): string =>
  subject.measuredNoDifference ? MEASURED_NO_DIFFERENCE_BADGE_LABEL : UNRECONCILED_READ_BADGE_LABEL;

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

  const offers = loadOffers();
  const rowFor = new Map<string, ReturnType<typeof enrichOffers>[number]>();
  for (const row of enrichOffers(offers)) if (!rowFor.has(row.vendor)) rowFor.set(row.vendor, row);

  subjects = [...vendorSlugMap.entries()].map(([slug, vendor]) => {
    const reasons = held.get(vendor.toLowerCase()) ?? [];
    const count = published.get(vendor.toLowerCase()) ?? 0;
    const row = rowFor.get(vendor);
    const refusedRead = row?.refused_read ?? null;
    const unreconciled = refusedRead !== null;
    const otherwiseWithheld = Boolean(
      row?.gate || row?.rating_withheld || row?.link_unreachable
      || (row?.source_check && row.source_check.outcome !== "ok"),
    );
    return {
      slug,
      vendor,
      reasons,
      published: count,
      refusedRead,
      gated: Boolean(row?.gate),
      confirmedOn: row?.verifiedDate ?? "",
      supersededRefusal: refusedRead === null && count === 0
        ? refusedReadTheConfirmationSupersedes(
          refusals.filter(r => r.vendor.toLowerCase() === vendor.toLowerCase()),
          row?.verifiedDate ?? "",
        )
        : null,
      unreconciled,
      measuredNoDifference: refusedRead !== null && MEASURED_NO_DIFFERENCE.has(refusedRead.reason),
      onlyTheRefusal: unreconciled && !otherwiseWithheld,
      confirmingOnly: count === 0 && reasons.length > 0 && reasons.every(r => CONFIRMING.has(r)),
      rated: row?.risk_level ?? null,
      ended: offerEnded(row),
      withheldBySourceCheck: Boolean(
        row?.link_unreachable
        || (row?.source_check && LEVEL_WITHHOLDING_OUTCOMES.includes(row.source_check.outcome)),
      ),
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

async function readResourceOverHttp(uri: string): Promise<string> {
  const base = `http://localhost:${serverPort}/mcp`;
  const accept = "application/json, text/event-stream";
  const init = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: accept },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } }),
  });
  const session = init.headers.get("mcp-session-id") ?? "";
  const headers = { "Content-Type": "application/json", Accept: accept, "Mcp-Session-Id": session };
  await fetch(base, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const res = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
  const payload = JSON.parse(line.replace(/^data: /, "")) as { result?: { contents?: Array<{ text?: string }> } };
  return payload.result?.contents?.[0]?.text ?? "";
}

const stabilityLineOf = (resource: string): string =>
  resource.split("\n").find(l => l.startsWith("**Stability:**")) ?? "";

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

    const history = subjects
      .filter(s => s.onlyTheRefusal && A_STABLE_HISTORY.test(pages.get(s.slug) ?? ""))
      .map(s => `/vendor/${s.slug}`);
    assert.deepStrictEqual(history.slice(0, 20), [], `pages calling it a stable pricing history:\n${history.slice(0, 20).join("\n")}`);
    assertPopulationFloor(subjects.filter(s => s.onlyTheRefusal).length, 80, "vendors have the refused read as the only reason we withhold");
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
    for (const subject of subjects.filter(s => s.onlyTheRefusal)) {
      const verdict = verdictParagraphOf(pages.get(subject.slug) ?? "");
      if (verdict === "") { silent.push(`/vendor/${subject.slug} renders no verdict paragraph`); continue; }
      if (!reasonWePublish(subject).test(verdict)) silent.push(`/vendor/${subject.slug}: ${verdict.slice(0, 120)}`);
    }
    assert.deepStrictEqual(silent.slice(0, 20), [], `verdicts withheld with nothing saying why:\n${silent.slice(0, 20).join("\n")}`);
  });

  it("gives the badge the same reason the page gives", async () => {
    const wrong: string[] = [];
    const withheld = subjects.filter(s => s.onlyTheRefusal);
    let queue = 0;
    const worker = async () => {
      while (queue < withheld.length) {
        const subject = withheld[queue++];
        const { slug } = subject;
        const res = await fetch(`http://localhost:${serverPort}/badge/${slug}.svg`);
        if (res.status !== 200) { wrong.push(`/badge/${slug}.svg returned ${res.status}`); continue; }
        const label = badgeLabelOf(await res.text());
        const expected = badgeWeExpect(subject);
        if (label !== expected) wrong.push(`/badge/${slug}.svg reads "${label}", not "${expected}"`);
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    assert.deepStrictEqual(wrong.slice(0, 20), [], `badges naming the wrong reason:\n${wrong.slice(0, 20).join("\n")}`);
    assertPopulationFloor(withheld.length, 80, "badges were read for the reason they withhold");
  });

  it("answers an agent the way it answers a reader, on either scale", async () => {
    const withheld = subjects.filter(s => s.onlyTheRefusal).slice(0, 6);
    assert.ok(withheld.length >= 3, "too few withheld vendors to read over MCP");
    for (const subject of withheld) {
      const line = stabilityLineOf(await readResourceOverHttp(`agentdeals://vendor/${subject.slug}`));
      assert.ok(line !== "", `agentdeals://vendor/${subject.slug} publishes no stability line at all`);
      assert.doesNotMatch(line, /\*\*Stability:\*\* stable/, `agentdeals://vendor/${subject.slug} calls it stable`);
      assert.match(line, reasonWePublish(subject), `agentdeals://vendor/${subject.slug} withholds without saying why`);
    }
    for (const subject of subjects.filter(s => s.confirmingOnly).slice(0, 3)) {
      const line = stabilityLineOf(await readResourceOverHttp(`agentdeals://vendor/${subject.slug}`));
      assert.doesNotMatch(line, WITHHELD_FOR_A_REFUSAL, `agentdeals://vendor/${subject.slug} lost its rating to a refusal that confirms our terms`);
    }
  });

  it("gives the same answer in the risk summary an agent reads", () => {
    const silent: string[] = [];
    for (const subject of subjects.filter(s => s.unreconciled)) {
      const answer = checkVendorRisk(subject.vendor) as { result?: { risk_level: string | null; summary: string } };
      const result = answer.result;
      if (!result) continue;
      if (result.risk_level !== null) silent.push(`${subject.vendor} answers ${result.risk_level}`);
      if (!subject.onlyTheRefusal) continue;
      if (A_STABLE_HISTORY.test(result.summary)) silent.push(`${subject.vendor}: ${result.summary}`);
      if (!reasonWePublish(subject).test(result.summary)) silent.push(`${subject.vendor} summarises without saying why`);
      if (!/We publish no change we refused to record/.test(result.summary)) {
        silent.push(`${subject.vendor} leaves an agent to read a missing record as nothing having changed`);
      }
    }
    assert.deepStrictEqual(silent.slice(0, 10), [], `the risk summary still reads as a stable history:\n${silent.slice(0, 10).join("\n")}`);
  });

  it("publishes the day of a refused read and none of its prose", async () => {
    const payload = await (await fetch(`http://localhost:${serverPort}/api/offers?limit=2000`)).json() as {
      offers: Array<{ vendor: string; refused_read: Record<string, unknown> | null }>;
      _provenance: { verified_records: number; withheld_records?: number };
    };
    const published = payload.offers.filter(row => row.refused_read);
    assert.ok(published.length > 0, "no row carries a refused read, so the field is untested");
    const fields = new Set(published.flatMap(row => Object.keys(row.refused_read!)));
    assert.deepStrictEqual(
      [...fields].sort(),
      ["reason", "refused_date"],
      "the refusal record reaches the API beyond the day it was refused and the rule that refused it",
    );
    const counted = payload._provenance.verified_records + (payload._provenance.withheld_records ?? 0);
    assert.strictEqual(counted, payload.offers.length, "the provenance block counts a record the response does not return");
  });

  it("withholds on no read older than the one it calls our last", async () => {
    const payload = await (await fetch(`http://localhost:${serverPort}/api/offers?limit=2000`)).json() as {
      offers: Array<OfferRead>;
    };
    const contradicting = payload.offers
      .filter(row => row.refused_read && row.last_read_date > row.refused_read.refused_date)
      .map(row => `${row.vendor} (${row.tier}): withholds on ${row.refused_read!.refused_date}, read ${row.last_read_date}`);
    assert.deepStrictEqual(
      contradicting.slice(0, 20),
      [],
      `records naming two different days as the day we last read the page:\n${contradicting.slice(0, 20).join("\n")}`,
    );
    assertCoversPopulation(payload.offers.length, recordsInTheCatalogue(), "records read for the day their verdict dates itself to");
    assertPopulationFloor(payload.offers.filter(row => row.refused_read).length, 100, "records publish a refused read");
  });

  it("holds the withholding wherever nothing has confirmed the terms since", async () => {
    const payload = await (await fetch(`http://localhost:${serverPort}/api/offers?limit=2000`)).json() as {
      offers: Array<OfferRead>;
    };
    const refused = refusalsByVendor(loadChangeRefusals());
    const stillUnconfirmed = payload.offers.filter(row =>
      publishedChangeCount(row.vendor) === 0
      && (refused.get(row.vendor.toLowerCase()) ?? [])
        .some(r => !CONFIRMING.has(r.reason) && r.refused_date >= row.verifiedDate),
    );
    const released = stillUnconfirmed
      .filter(row => row.risk_level !== null)
      .map(row => `${row.vendor} (${row.tier}) rates ${row.risk_level} over a refusal we have not confirmed past`);
    assert.deepStrictEqual(released.slice(0, 20), [], `ratings restored over a live refusal:\n${released.slice(0, 20).join("\n")}`);
    assertPopulationFloor(stillUnconfirmed.length, 100, "records hold a refusal no later confirmation supersedes");

    for (const vendor of ["pubnub.com", "Typeform.com", "Lokalise"]) {
      const row = payload.offers.find(o => o.vendor === vendor);
      assert.ok(row, `${vendor} has left the catalogue this control was written against`);
      assert.ok(row.refused_read, `${vendor} stopped publishing the refused read it was holding`);
      assert.strictEqual(row.risk_level, null, `${vendor} recovered a rating over a refusal nothing has confirmed past`);
    }
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

describe("an empty history and a recorded threshold are claims a refused read withholds too", () => {
  it("states no threshold as fact on a page whose last read we refused", () => {
    const stating: string[] = [];
    for (const subject of subjects.filter(s => s.unreconciled)) {
      const block = growthBlockOf(pages.get(subject.slug) ?? "");
      if (A_BARE_THRESHOLD.test(block)) stating.push(`/vendor/${subject.slug}: ${block.match(A_BARE_THRESHOLD)?.[0]}`);
    }
    assert.deepStrictEqual(stating.slice(0, 20), [], `thresholds stated as fact over a read we refused:\n${stating.slice(0, 20).join("\n")}`);

    const withheld = subjects.filter(
      s => s.unreconciled && A_THRESHOLD_WE_CANNOT_CONFIRM.test(growthBlockOf(pages.get(s.slug) ?? "")),
    );
    assertPopulationFloor(withheld.length, 25, "vendor pages hold a recorded threshold behind a refused read");
  });

  it("ships the withheld threshold to an agent as well as to a reader", () => {
    const stating: string[] = [];
    for (const subject of subjects.filter(s => s.unreconciled)) {
      const page = pages.get(subject.slug) ?? "";
      if (!A_THRESHOLD_WE_CANNOT_CONFIRM.test(growthBlockOf(page))) continue;
      const answer = page.match(/"name":"When will I outgrow[^"]*","acceptedAnswer":\{"@type":"Answer","text":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
      if (!A_THRESHOLD_WE_CANNOT_CONFIRM.test(answer)) stating.push(`/vendor/${subject.slug}: ${answer.slice(0, 80)}`);
    }
    assert.deepStrictEqual(stating.slice(0, 20), [], `structured data states a threshold the page withholds:\n${stating.slice(0, 20).join("\n")}`);
  });

  it("names the refusal and its date where an empty history is all we hold", () => {
    const silent: string[] = [];
    let named = 0;
    for (const subject of subjects.filter(s => s.onlyTheRefusal && s.published === 0)) {
      const paragraph = emptyHistoryParagraphOf(pages.get(subject.slug) ?? "");
      if (paragraph === "") continue;
      named++;
      if (!AN_EMPTY_HISTORY_ABOUT_OUR_RECORDS.test(paragraph)) silent.push(`/vendor/${subject.slug}: no statement about our records`);
      else if (!reasonWePublish(subject).test(paragraph)) silent.push(`/vendor/${subject.slug}: ${paragraph.slice(0, 120)}`);
      else if (!paragraph.includes(subject.refusedRead?.refused_date ?? "")) silent.push(`/vendor/${subject.slug}: names no date`);
    }
    assert.deepStrictEqual(silent.slice(0, 20), [], `empty histories that do not say why we cannot read them:\n${silent.slice(0, 20).join("\n")}`);
    assertPopulationFloor(named, 80, "vendor pages hold an empty history and a refused read as the only reason");
  });

  it("leaves the empty history of a gated page exactly as the gate leaves it", () => {
    const moved: string[] = [];
    let bare = 0;
    for (const subject of subjects.filter(s => s.gated && !s.withheldBySourceCheck && !s.ended)) {
      const paragraph = emptyHistoryParagraphOf(pages.get(subject.slug) ?? "");
      if (paragraph === "") continue;
      if (WITHHELD_FOR_A_REFUSAL.test(paragraph) || /good sign/.test(paragraph)) {
        moved.push(`/vendor/${subject.slug}: ${paragraph.slice(0, 140)}`);
        continue;
      }
      if (/^No recorded pricing changes for .*\.$/.test(paragraph)) bare++;
    }
    assert.deepStrictEqual(moved.slice(0, 20), [], `a gate's empty history no longer reads as the gate leaves it:\n${moved.slice(0, 20).join("\n")}`);
    assertPopulationFloor(bare, 10, "gated vendor pages publish the bare empty-history sentence");
    assert.ok(
      subjects.some(s => s.gated && s.unreconciled && !s.withheldBySourceCheck),
      "no gated page holds a refused read, so the gate is not what is keeping the refusal off it",
    );
  });

  it("leaves the source check's sentence on a gated page the source check also withholds", () => {
    const moved: string[] = [];
    let read = 0;
    for (const subject of subjects.filter(s => s.gated && s.withheldBySourceCheck && !s.ended)) {
      const paragraph = emptyHistoryParagraphOf(pages.get(subject.slug) ?? "");
      if (paragraph === "" || subject.published > 0) continue;
      read++;
      if (!/so nothing we have read describes these terms/.test(paragraph)) {
        moved.push(`/vendor/${subject.slug}: ${paragraph.slice(0, 140)}`);
      }
    }
    assert.deepStrictEqual(moved.slice(0, 20), [], `a gated page no longer says why nothing we read describes its terms:\n${moved.slice(0, 20).join("\n")}`);
    assertPopulationFloor(read, 60, "gated vendor pages are withheld by the source check as well");
  });

  it("leaves the empty history the source check writes exactly as the source check writes it", () => {
    const moved: string[] = [];
    let read = 0;
    for (const subject of subjects.filter(s => s.withheldBySourceCheck && !s.ended)) {
      const paragraph = emptyHistoryParagraphOf(pages.get(subject.slug) ?? "");
      if (paragraph === "" || !AN_EMPTY_HISTORY_ABOUT_OUR_RECORDS.test(paragraph)) continue;
      read++;
      if (!/so nothing we have read describes these terms/.test(paragraph)) {
        moved.push(`/vendor/${subject.slug}: ${paragraph.slice(0, 140)}`);
      }
    }
    assert.deepStrictEqual(moved.slice(0, 20), [], `the source check's empty-history sentence has changed:\n${moved.slice(0, 20).join("\n")}`);
    assertPopulationFloor(read, 400, "vendor pages carry the empty-history sentence the source check writes");
  });

  it("keeps both sentences on a vendor we rate", () => {
    const lost: string[] = [];
    let claiming = 0;
    for (const subject of subjects.filter(s => s.rated === "stable" && s.published === 0)) {
      const paragraph = emptyHistoryParagraphOf(pages.get(subject.slug) ?? "");
      if (paragraph === "") continue;
      claiming++;
      if (!/This is a good sign — stable pricing/.test(paragraph)) lost.push(`/vendor/${subject.slug}: ${paragraph.slice(0, 120)}`);
    }
    assert.deepStrictEqual(lost.slice(0, 20), [], `a rated vendor lost the sentence its empty history earns:\n${lost.slice(0, 20).join("\n")}`);
    assertPopulationFloor(claiming, 250, "rated vendor pages call an empty history a good sign");

    for (const slug of ["ahasend", "appsmith", "browserless"]) {
      const subject = subjects.find(s => s.slug === slug);
      assert.ok(subject?.rated === "stable", `/vendor/${slug} is no longer the rated control this was written against`);
      assert.match(pages.get(slug) ?? "", /This is a good sign — stable pricing/);
    }
    assert.match(growthBlockOf(pages.get("ahasend") ?? ""), A_BARE_THRESHOLD);
  });
});

describe("a page states the reason we withheld, not a reason its own refusal contradicts", () => {
  it("says no change was unreconcilable wherever every refusal we hold measured the two states as equal", () => {
    const contradicting: string[] = [];
    for (const subject of subjects.filter(s => s.measuredNoDifference)) {
      const page = pages.get(subject.slug) ?? "";
      if (COULD_NOT_RECONCILE.test(page)) {
        contradicting.push(`/vendor/${subject.slug} (${subject.reasons.join(", ")})`);
      }
    }
    assert.deepStrictEqual(
      contradicting.slice(0, 20),
      [],
      `pages reporting an equality finding as a change we could not reconcile:\n${contradicting.slice(0, 20).join("\n")}`,
    );
    assertPopulationFloor(
      subjects.filter(s => s.measuredNoDifference).length,
      20,
      "vendors hold only refusals that measured the two states as equal",
    );
    assertCoversPopulation(subjects.length, vendorsInTheCatalogue(), "vendor pages read for the reason they withhold");
  });

  it("keeps the reason a page gives out of the family it does not belong to", () => {
    const crossed: string[] = [];
    for (const subject of subjects.filter(s => s.onlyTheRefusal)) {
      const page = pages.get(subject.slug) ?? "";
      if (reasonWeMustNotPublish(subject).test(page)) crossed.push(`/vendor/${subject.slug}`);
      if (!reasonWePublish(subject).test(page)) crossed.push(`/vendor/${subject.slug} states neither reason`);
    }
    assert.deepStrictEqual(crossed.slice(0, 20), [], `pages naming the wrong family of refusal:\n${crossed.slice(0, 20).join("\n")}`);
    assert.ok(
      subjects.some(s => s.onlyTheRefusal && s.measuredNoDifference)
      && subjects.some(s => s.onlyTheRefusal && !s.measuredNoDifference),
      "one of the two families is empty, so this control compares nothing",
    );
  });

  it("takes no rating back for a vendor whose refusal only measured the quantities it compared", () => {
    for (const slug of ["pagertree-com", "cloudflare-workers", "aiven", "uptimerobot"]) {
      const subject = subjects.find(s => s.slug === slug);
      assert.ok(subject?.measuredNoDifference, `/vendor/${slug} no longer holds only equality refusals`);
      const page = pages.get(slug) ?? "";
      assert.doesNotMatch(page, COULD_NOT_RECONCILE, `/vendor/${slug} still reports the equality finding as unreconcilable`);
      assert.match(page, NAMED_NO_FIGURE_THAT_MOVED, `/vendor/${slug} states no reason for withholding`);
      assert.deepStrictEqual(claimsOn(slug), [], `/vendor/${slug} publishes a stability claim over a refusal`);
    }
  });

  it("says on every surface why a rating came back, wherever a confirmation cleared a refusal", () => {
    const cleared = subjects.filter(s => s.supersededRefusal && !s.gated);
    assert.ok(cleared.length > 0, "no record was confirmed after a refusal, so this reading is untested");
    const silent: string[] = [];
    for (const subject of cleared) {
      const refusedOn = subject.supersededRefusal!.refused_date;
      const page = pages.get(subject.slug) ?? "";
      const verdict = verdictParagraphOf(page);
      const both = new RegExp(`refused on ${refusedOn}, and we read the page again on ${subject.confirmedOn}`);
      if (!both.test(verdict)) silent.push(`/vendor/${subject.slug}: ${verdict.slice(-160)}`);
      if (/zero pricing changes recorded/.test(page)) silent.push(`/vendor/${subject.slug} counts the refusal as nothing`);
      if (/has had no recorded pricing changes/.test(page)) silent.push(`/vendor/${subject.slug} (FAQ) counts the refusal as nothing`);
      if (!page.includes(supersededRefusalSentence(subject.vendor, refusedOn, subject.confirmedOn))) {
        silent.push(`/vendor/${subject.slug} answers the pricing-change question without naming the refusal`);
      }
      const answer = checkVendorRisk(subject.vendor) as { result?: { summary: string } };
      if (answer.result && !answer.result.summary.includes(`refused the change we last considered recording for ${subject.vendor} on ${refusedOn}`)) {
        silent.push(`${subject.vendor} summarises for an agent without naming the refusal`);
      }
    }
    assert.deepStrictEqual(silent.slice(0, 20), [], `a rating came back with nothing saying why:\n${silent.slice(0, 20).join("\n")}`);
    for (const slug of ["doczilla", "tavily-ai"]) {
      const subject = subjects.find(s => s.slug === slug);
      assert.ok(subject?.supersededRefusal, `/vendor/${slug} no longer holds a refusal its own confirmation supersedes`);
    }
  });

  it("leaves the vendors #1139 was filed on withheld and unrated", () => {
    for (const slug of ["pubnub-com", "typeform-com", "lokalise"]) {
      const subject = subjects.find(s => s.slug === slug);
      assert.ok(subject?.unreconciled, `/vendor/${slug} no longer holds a refusal and no published change`);
      assert.ok(!subject.measuredNoDifference, `/vendor/${slug} is no longer a read we could not reconcile`);
      const page = pages.get(slug) ?? "";
      assert.match(page, COULD_NOT_RECONCILE, `/vendor/${slug} lost the sentence #1139 put on it`);
      assert.deepStrictEqual(claimsOn(slug), [], `/vendor/${slug} regained a stability claim`);
    }
  });

  it("leaves a vendor holding both an equality refusal and a published change on the verdict its records give it", () => {
    const both = subjects.filter(
      s => s.published > 0 && s.reasons.some(r => MEASURED_NO_DIFFERENCE.has(r)),
    );
    assert.ok(both.length > 0, "no vendor holds both an equality refusal and a published change, so the control is empty");
    const moved: string[] = [];
    for (const subject of both) {
      const page = pages.get(subject.slug) ?? "";
      if (WITHHELD_FOR_A_REFUSAL.test(page)) moved.push(`/vendor/${subject.slug} withholds for a refusal`);
      const verdict = verdictParagraphOf(page);
      if (!/We rate it /.test(verdict)) moved.push(`/vendor/${subject.slug}: ${verdict.slice(0, 120)}`);
    }
    assert.deepStrictEqual(moved, [], `a published change stopped setting the verdict:\n${moved.join("\n")}`);
  });

  it("names no single family of refusal on a page that counts both", async () => {
    const bothFamilies = subjects.some(s => s.onlyTheRefusal && s.measuredNoDifference)
      && subjects.some(s => s.onlyTheRefusal && !s.measuredNoDifference);
    assert.ok(bothFamilies, "the withheld population holds one family only, so a page naming it is not yet wrong");
    const narrow: string[] = [];
    for (const route of ["/state-of-free-tiers", "/criteria"]) {
      const page = await (await fetch(`http://localhost:${serverPort}${route}`)).text();
      if (/could not reconcile with the terms we publish/.test(page)) {
        narrow.push(`${route} names only the reads we could not reconcile`);
      }
      if (/named no figure that had moved/.test(page)) narrow.push(`${route} names only the equality findings`);
    }
    assert.deepStrictEqual(narrow, [], `a page counting every refusal describes one kind of them:\n${narrow.join("\n")}`);
  });

  it("does not define stable as a label a refused read takes off for good", async () => {
    const cleared = subjects.filter(s => s.supersededRefusal);
    assert.ok(cleared.length > 0, "no record holds a refusal a confirmation superseded, so the definition is not yet wrong");
    const page = await (await fetch(`http://localhost:${serverPort}/criteria`)).text();
    assert.match(
      page,
      /only a later read that confirms the terms puts it back/,
      "/criteria tells a reader a refused read removes the stable label for good",
    );
  });

  it("gives an agent the same reason on either transport", async () => {
    const oneOfEach = [
      subjects.find(s => s.onlyTheRefusal && s.measuredNoDifference),
      subjects.find(s => s.onlyTheRefusal && !s.measuredNoDifference),
    ];
    for (const subject of oneOfEach) {
      assert.ok(subject, "a family of refused read has no vendor to read over MCP");
      const line = stabilityLineOf(await readResourceOverHttp(`agentdeals://vendor/${subject.slug}`));
      assert.match(line, reasonWePublish(subject), `agentdeals://vendor/${subject.slug} names the wrong reason`);
      assert.doesNotMatch(line, reasonWeMustNotPublish(subject), `agentdeals://vendor/${subject.slug} names the other family`);
    }
  });

  it("draws both families of refusal from the vocabulary the gate writes", () => {
    const overlap = REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE.filter(r => CONFIRMING.has(r));
    assert.deepStrictEqual(overlap, [], `a reason is both a confirmation and an equality finding: ${overlap.join(", ")}`);
    const unseen = REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE.filter(
      r => !subjects.some(s => s.reasons.includes(r)),
    );
    assert.deepStrictEqual(unseen, [], `no vendor holds a refusal under these reasons, so they are untested: ${unseen.join(", ")}`);
  });

  it("reads an equality finding on every rule the gate refuses an equality under", () => {
    const refusedOnAnEquality = [
      REJECT_MEASURES_NO_CHANGE,
      REJECT_STATES_NO_DIFFERENCE,
      REJECT_NULL_COMPARISON,
    ];
    assert.deepStrictEqual(
      [...REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE].sort(),
      [...refusedOnAnEquality].sort(),
      "the pages read a different set of equality findings from the set the gate refuses under",
    );

    const misread: string[] = [];
    const exercised: string[] = [];
    for (const rule of refusedOnAnEquality) {
      const held = subjects.filter(
        s => s.unreconciled && s.reasons.filter(r => !CONFIRMING.has(r)).every(r => r === rule),
      );
      if (held.length > 0) exercised.push(rule);
      for (const subject of held) {
        const page = pages.get(subject.slug) ?? "";
        if (COULD_NOT_RECONCILE.test(page)) misread.push(`/vendor/${subject.slug} (${rule})`);
        if (!NAMED_NO_FIGURE_THAT_MOVED.test(page)) misread.push(`/vendor/${subject.slug} names no equality finding (${rule})`);
      }
    }
    assert.deepStrictEqual(
      misread.slice(0, 20),
      [],
      `an equality the gate measured reaches a reader as a change we could not reconcile:\n${misread.slice(0, 20).join("\n")}`,
    );
    assert.ok(
      exercised.length > 0,
      `no vendor holds any of ${refusedOnAnEquality.join(", ")} as its only reason, so no page exercises this reading`,
    );
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

  it("draws every reason it treats as an equality finding from that same vocabulary", () => {
    const known = REASONS_A_RULE_CAN_WRITE;
    const stray = REFUSAL_REASONS_THAT_MEASURED_NO_DIFFERENCE.filter(r => !known.has(r));
    assert.deepStrictEqual(stray, [], `reasons kept as equality findings that no gate rule writes: ${stray.join(", ")}`);
  });

  it("publishes the reason of the refusal it could not reconcile wherever it holds one of each on the same day", () => {
    const refusals = [
      { reason: "measures_no_change", refused_date: "2026-08-29" },
      { reason: "states_no_terms", refused_date: "2026-08-29" },
    ];
    const published = refusedReadWithholdingStability({ historyLevel: "stable", publishedChanges: 0, termsConfirmedOn: "2026-07-01", refusals });
    assert.strictEqual(
      published?.reason,
      "states_no_terms",
      "an equality finding published its own reason over a refusal of the same day we could not reconcile",
    );
    assert.strictEqual(published?.refused_date, "2026-08-29", "the day published is not the day of the reason published");
  });

  it("publishes the reason of the latest read whenever a later read refused on other grounds", () => {
    const refusals = [
      { reason: "unquantified_limit", refused_date: "2026-08-28" },
      { reason: "states_no_difference", refused_date: "2026-09-11" },
    ];
    const published = refusedReadWithholdingStability({ historyLevel: "stable", publishedChanges: 0, termsConfirmedOn: "2026-07-19", refusals });
    assert.strictEqual(published?.refused_date, "2026-09-11", "the day published is not the day we last read the page");
    assert.strictEqual(published?.reason, "states_no_difference", "the reason published is not the reason of the day published");
  });

  it("leaves a rating the records themselves earned alone", () => {
    const refusals = [{ reason: "unquantified_limit", refused_date: "2026-09-11" }];
    assert.notStrictEqual(
      refusedReadWithholdingStability({ historyLevel: "stable", publishedChanges: 0, termsConfirmedOn: "2026-07-01", refusals }),
      null,
      "a refused read over an otherwise stable history does not withhold",
    );
    for (const historyLevel of ["caution", "risky"]) {
      assert.strictEqual(
        refusedReadWithholdingStability({ historyLevel, publishedChanges: 0, termsConfirmedOn: "2026-07-01", refusals }),
        null,
        `a refused read takes over a ${historyLevel} the records earned`,
      );
    }
  });

  it("stops withholding once the terms have been confirmed since the refusal", () => {
    const refusals = [{ reason: "no_price_signal", refused_date: "2026-08-29" }];
    const stability = (termsConfirmedOn: string) =>
      refusedReadWithholdingStability({ historyLevel: "stable", publishedChanges: 0, termsConfirmedOn, refusals });
    assert.strictEqual(stability("2026-09-10"), null, "a refusal predating the day we confirmed the terms still withholds");
    assert.strictEqual(
      stability("2026-08-29")?.refused_date,
      "2026-08-29",
      "a confirmation dated the same day as the refusal cleared it",
    );
    assert.strictEqual(
      stability("2026-08-01")?.refused_date,
      "2026-08-29",
      "a refusal later than our last confirmation stopped withholding",
    );
    assert.strictEqual(stability("")?.refused_date, "2026-08-29", "a record with no confirmation date cleared its refusal");
  });

  it("names the day it refused before the day it confirmed, on the record it cleared", () => {
    const sentence = vendorVerdictSentence({
      vendor: "Doczilla",
      level: "stable",
      historyLevel: "stable",
      cause: null,
      changes: [],
      levelWithheld: null,
      unconfirmableSince: "",
      termsConfirmedOn: "2026-09-10",
      refusedReads: [{ reason: "no_price_signal", refused_date: "2026-08-29" }],
    });
    assert.strictEqual(
      sentence,
      "It's stable — the change we last considered recording was refused on 2026-08-29, and we read the page again on 2026-09-10 and confirmed the terms above.",
      "the cleared verdict states the day we refused and the day we confirmed in the wrong order",
    );
  });

  it("keeps withholding where the later read is itself a refusal and the earlier one confirmed", () => {
    const refusals = [
      { reason: "confirmed_unchanged", refused_date: "2026-08-28" },
      { reason: "measures_the_opposite", refused_date: "2026-09-09" },
    ];
    const published = refusedReadWithholdingStability({ historyLevel: "stable", publishedChanges: 0, termsConfirmedOn: "2026-07-24", refusals });
    assert.strictEqual(
      published?.reason,
      "measures_the_opposite",
      "a confirming refusal older than the withholding one took the withholding with it",
    );
    assert.strictEqual(
      refusedReadTheConfirmationSupersedes(refusals, "2026-07-24"),
      null,
      "a refusal later than our last confirmation reads as one the confirmation superseded",
    );
  });

  it("treats a reason it has never seen as one it could not reconcile", () => {
    const invented = "a_rule_no_gate_writes";
    assert.ok(!CONFIRMING.has(invented), "an unclassified reason is read as a confirmation");
  });
});
